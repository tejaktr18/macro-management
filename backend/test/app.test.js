import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { mockAnalyzer, normalize, parseModelOutput } from '../src/analyze.js';

const app = createApp({ store: memoryStore(), analyze: mockAnalyzer(), getToken: async () => 'secret' });
const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
const req = (path, init = {}) => app.request(path, init);

test('health is public, api is not', async () => {
  assert.equal((await req('/health')).status, 200);
  assert.equal((await req('/api/kv')).status, 401);
  assert.equal((await req('/api/kv', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('kv put/get/list/delete with last-writer-wins', async () => {
  let r = await req('/api/kv/meals-2026-11-03', { method: 'PUT', headers: auth, body: JSON.stringify({ value: '[1]', updatedAt: 100 }) });
  assert.equal(r.status, 200);
  r = await req('/api/kv/meals-2026-11-03', { method: 'PUT', headers: auth, body: JSON.stringify({ value: '[0]', updatedAt: 50 }) });
  assert.equal(r.status, 409, 'older write must be rejected');
  r = await req('/api/kv/meals-2026-11-03', { headers: auth });
  assert.equal((await r.json()).value, '[1]');
  r = await req('/api/kv?prefix=meals-2026-11', { headers: auth });
  assert.equal((await r.json()).items.length, 1);
  r = await req('/api/kv?since=100', { headers: auth });
  assert.equal((await r.json()).items.length, 0);
  assert.equal((await req('/api/kv/bad key!', { headers: auth })).status, 400);
  await req('/api/kv/meals-2026-11-03', { method: 'DELETE', headers: auth });
  assert.equal((await req('/api/kv/meals-2026-11-03', { headers: auth })).status, 404);
});

test('export then import round-trips (account migration)', async () => {
  await req('/api/kv/weigh-2026-11-01', { method: 'PUT', headers: auth, body: JSON.stringify({ value: '{"weight":"74.2"}', updatedAt: 1 }) });
  const exp = await (await req('/api/export', { headers: auth })).json();
  const other = createApp({ store: memoryStore(), analyze: mockAnalyzer(), getToken: async () => 'secret' });
  const r = await other.request('/api/import', { method: 'POST', headers: auth, body: JSON.stringify(exp) });
  assert.equal((await r.json()).imported, exp.items.length);
  const got = await (await other.request('/api/kv/weigh-2026-11-01', { headers: auth })).json();
  assert.equal(got.value, '{"weight":"74.2"}');
});

test('analyze validates input and returns normalized items', async () => {
  assert.equal((await req('/api/analyze', { method: 'POST', headers: auth, body: '{}' })).status, 400);
  const r = await req('/api/analyze', { method: 'POST', headers: auth, body: JSON.stringify({ text: '2 roti + dal' }) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.items.length > 0 && typeof j.items[0].kcal === 'number' && 'p' in j.items[0]);
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

test('rotated token is accepted immediately (one forced refresh)', async () => {
  let secret = 'old', refreshes = 0;
  const getToken = async ({ refresh = false } = {}) => { if (refresh) { refreshes++; secret = 'new'; } return secret; };
  const rot = createApp({ store: memoryStore(), analyze: mockAnalyzer(), getToken });
  const call = (t) => rot.request('/api/whoami', { headers: { Authorization: 'Bearer ' + t } });
  assert.equal((await call('old')).status, 200);
  assert.equal(refreshes, 0, 'valid token must not trigger a refresh');
  assert.equal((await call('new')).status, 200, 'new token works after rotation');
  assert.equal(refreshes, 1);
  assert.equal((await call('old')).status, 401, 'old token stops working');
  assert.equal((await rot.request('/api/whoami')).status, 401, 'missing token never triggers a refresh');
});
