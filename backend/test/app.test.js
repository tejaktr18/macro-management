import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, findUser, parseUsers } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { mockAnalyzer, normalize, parseModelOutput, systemPrompt } from '../src/analyze.js';

const USERS = { teja: 'tok-teja', friend: 'tok-friend' };
const mk = (opts = {}) => createApp({ store: memoryStore(), analyze: mockAnalyzer(), getUsers: async () => USERS, ...opts });
const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const app = mk();
const req = (path, init = {}) => app.request(path, init);

test('health is public, api is not', async () => {
  assert.equal((await req('/health')).status, 200);
  assert.equal((await req('/api/kv')).status, 401);
  assert.equal((await req('/api/kv', { headers: H('wrong') })).status, 401);
});

test('whoami tells you who the token belongs to', async () => {
  assert.equal((await (await req('/api/whoami', { headers: H('tok-friend') })).json()).user, 'friend');
});

test('kv put/get/list/delete with last-writer-wins', async () => {
  const a = H('tok-teja');
  let r = await req('/api/kv/meals-2026-11-03', { method: 'PUT', headers: a, body: JSON.stringify({ value: '[1]', updatedAt: 100 }) });
  assert.equal(r.status, 200);
  r = await req('/api/kv/meals-2026-11-03', { method: 'PUT', headers: a, body: JSON.stringify({ value: '[0]', updatedAt: 50 }) });
  assert.equal(r.status, 409, 'older write must be rejected');
  assert.equal((await (await req('/api/kv/meals-2026-11-03', { headers: a })).json()).value, '[1]');
  assert.equal((await (await req('/api/kv?prefix=meals-2026-11', { headers: a })).json()).items.length, 1);
  assert.equal((await (await req('/api/kv?since=100', { headers: a })).json()).items.length, 0);
  assert.equal((await req('/api/kv/bad key!', { headers: a })).status, 400);
  await req('/api/kv/meals-2026-11-03', { method: 'DELETE', headers: a });
  assert.equal((await req('/api/kv/meals-2026-11-03', { headers: a })).status, 404);
});

test("users can't see each other's data", async () => {
  const x = mk();
  await x.request('/api/kv/weigh-2026-11-01', { method: 'PUT', headers: H('tok-teja'), body: JSON.stringify({ value: '{"weight":"74"}', updatedAt: 1 }) });
  assert.equal((await x.request('/api/kv/weigh-2026-11-01', { headers: H('tok-friend') })).status, 404);
  assert.equal((await (await x.request('/api/kv', { headers: H('tok-friend') })).json()).items.length, 0);
  assert.equal((await (await x.request('/api/export', { headers: H('tok-friend') })).json()).items.length, 0);
  assert.equal((await (await x.request('/api/kv', { headers: H('tok-teja') })).json()).items.length, 1);
});

test('export then import round-trips (account migration)', async () => {
  const a = H('tok-teja');
  await req('/api/kv/weigh-2026-11-01', { method: 'PUT', headers: a, body: JSON.stringify({ value: '{"weight":"74.2"}', updatedAt: 1 }) });
  const exp = await (await req('/api/export', { headers: a })).json();
  const other = mk();
  const r = await other.request('/api/import', { method: 'POST', headers: a, body: JSON.stringify(exp) });
  assert.equal((await r.json()).imported, exp.items.length);
  assert.equal((await (await other.request('/api/kv/weigh-2026-11-01', { headers: a })).json()).value, '{"weight":"74.2"}');
});

test('analyze: validates, uses profile context, enforces per-user daily limit', async () => {
  const x = mk({ dailyAnalyzeLimit: 2 });
  const a = H('tok-teja');
  assert.equal((await x.request('/api/analyze', { method: 'POST', headers: a, body: '{}' })).status, 400);
  await x.request('/api/kv/profile', { method: 'PUT', headers: a, body: JSON.stringify({ value: JSON.stringify({ about: 'Eats South Indian food' }), updatedAt: 1 }) });
  const r1 = await x.request('/api/analyze', { method: 'POST', headers: a, body: JSON.stringify({ text: '2 roti + dal' }) });
  const j1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.ok(j1.items.length > 0 && typeof j1.items[0].kcal === 'number');
  assert.match(j1.notes, /South Indian/, 'profile about reaches the analyzer');
  assert.deepEqual(j1.usage, { today: 1, limit: 2 });
  assert.equal((await x.request('/api/analyze', { method: 'POST', headers: a, body: JSON.stringify({ text: 'x' }) })).status, 200);
  assert.equal((await x.request('/api/analyze', { method: 'POST', headers: a, body: JSON.stringify({ text: 'x' }) })).status, 429);
  assert.equal((await x.request('/api/analyze', { method: 'POST', headers: H('tok-friend'), body: JSON.stringify({ text: 'x' }) })).status, 200, 'limit is per user');
  assert.ok(!(await (await x.request('/api/kv', { headers: a })).json()).items.some((i) => /analyze/.test(i.key)), 'counters never sync to the app');
});

test('new user / rotated token works immediately (one forced refresh)', async () => {
  let users = { teja: 'old' }, refreshes = 0;
  const getUsers = async ({ refresh = false } = {}) => { if (refresh) { refreshes++; users = { teja: 'new', sam: 'tok-sam' }; } return users; };
  const rot = createApp({ store: memoryStore(), analyze: mockAnalyzer(), getUsers });
  const call = (t) => rot.request('/api/whoami', { headers: { Authorization: 'Bearer ' + t } });
  assert.equal((await call('old')).status, 200);
  assert.equal(refreshes, 0, 'valid token must not trigger a refresh');
  assert.equal((await (await call('tok-sam')).json()).user, 'sam', 'newly added user works');
  assert.equal(refreshes, 1);
  assert.equal((await call('new')).status, 200, 'rotated token works');
  assert.equal((await call('old')).status, 401, 'old token stops working');
  assert.equal((await rot.request('/api/whoami')).status, 401);
});

test('parseUsers + findUser', () => {
  assert.deepEqual(parseUsers('plainsecret'), { me: 'plainsecret' }, 'legacy single-token secret -> user "me"');
  assert.deepEqual(parseUsers('{"teja":"a","b":"c"}'), { teja: 'a', b: 'c' });
  assert.deepEqual(parseUsers(''), {});
  assert.equal(findUser({ teja: 'a', friend: 'b' }, 'b'), 'friend');
  assert.equal(findUser({ 'Bad Name!': 'x' }, 'x'), null, 'invalid user names are ignored');
  assert.equal(findUser({ teja: '' }, ''), null);
});

test('normalize tolerates sloppy model output', () => {
  const n = normalize({ items: [{ name: 'x', grams: '100.4', kcal: '200.6', protein_g: 10 }], confidence: 'weird' });
  assert.deepEqual([n.items[0].grams, n.items[0].kcal, n.items[0].p, n.items[0].c], [100, 201, 10, 0]);
  assert.equal(n.confidence, 'medium');
});

test('parseModelOutput: tool call, fenced JSON, prose + JSON, garbage', () => {
  assert.equal(parseModelOutput([{ toolUse: { input: { meal_name: 'a', items: [] } } }]).meal_name, 'a');
  assert.equal(parseModelOutput([{ text: '```json\n{"meal_name":"b","items":[]}\n```' }]).meal_name, 'b');
  assert.equal(parseModelOutput([{ text: 'Here you go: {"meal_name":"c","items":[]} enjoy' }]).meal_name, 'c');
  assert.equal(parseModelOutput([{ text: 'no json here' }]), null);
});

test('systemPrompt adds the user context only when given', () => {
  assert.ok(!/About this user/.test(systemPrompt('')));
  assert.match(systemPrompt('Vegetarian, Gujarati food'), /About this user[\s\S]*Gujarati/);
});
