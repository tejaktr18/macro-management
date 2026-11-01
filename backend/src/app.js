// HTTP API for PROTOCOL. Plain Hono app: runs the same locally and on a
// Lambda Web Function (no event-handler adapter needed).
//
// Users: each person has their own bearer token. getUsers() returns
// { "<user>": "<token>", ... } (from Secrets Manager in AWS). The token alone
// identifies the user; all of their data lives under that user's partition.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validKey, validValue } from './store.js';

const MAX_IMAGE_BYTES = 3_000_000;
export const USER_RE = /^[a-z0-9_-]{1,32}$/;

// Secret format: {"user": "token", ...}. A plain (non-JSON) string is the
// original single-user format and maps to user "me".
export function parseUsers(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  if (s.startsWith('{')) {
    try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch { /* fall through */ }
  }
  return { me: s };
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

// Constant-time lookup: compares against every user's token, no early exit.
export function findUser(users, token) {
  const t = digest(token);
  let found = null;
  for (const [name, tok] of Object.entries(users || {})) {
    if (!tok || !USER_RE.test(name)) continue;
    if (timingSafeEqual(t, digest(tok)) && !found) found = name;
  }
  return found;
}

function today(tzOffsetMin = -480) { // daily limits reset at Pacific midnight
  return new Date(Date.now() + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

export function createApp({
  store, analyze, getUsers, allowedOrigins = ['*'], info = {}, dailyAnalyzeLimit = 40,
}) {
  const app = new Hono();

  app.use('*', cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  }));

  app.onError((err, c) => {
    console.error(JSON.stringify({ level: 'error', path: c.req.path, user: c.get('user'), name: err.name, message: err.message }));
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  // Unauthenticated liveness check (reveals nothing sensitive).
  app.get('/health', (c) => c.json({ ok: true, store: store.kind, ...info }));

  // Everything under /api needs a valid bearer token, which also says WHO you are.
  app.use('/api/*', async (c, next) => {
    const h = c.req.header('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    let user = findUser(await getUsers(), token);
    // New user added / token rotated in Secrets Manager? Re-read once before
    // rejecting. getUsers rate-limits forced refreshes.
    if (!user) user = findUser(await getUsers({ refresh: true }), token);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  app.get('/api/whoami', (c) => c.json({ ok: true, user: c.get('user'), store: store.kind, dailyAnalyzeLimit, ...info }));

  // List records (sync pull). ?prefix=meals-2026-10&since=<epoch ms>
  app.get('/api/kv', async (c) => {
    const prefix = c.req.query('prefix') || '';
    const since = Number(c.req.query('since') || 0);
    if (prefix && !validKey(prefix)) return c.json({ error: 'bad_prefix' }, 400);
    const items = await store.list(c.get('user'), { prefix, since });
    return c.json({ items, now: Date.now() });
  });

  app.get('/api/kv/:key', async (c) => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: 'bad_key' }, 400);
    const rec = await store.get(c.get('user'), key);
    return rec ? c.json(rec) : c.json({ error: 'not_found' }, 404);
  });

  // Upsert (sync push). Body: { value: "<json string>", updatedAt: <epoch ms> }
  app.put('/api/kv/:key', async (c) => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: 'bad_key' }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || !validValue(body.value)) return c.json({ error: 'bad_value' }, 400);
    const updatedAt = Number.isFinite(body.updatedAt) ? body.updatedAt : Date.now();
    const r = await store.put(c.get('user'), key, body.value, updatedAt);
    return c.json(r, r.applied ? 200 : 409);
  });

  app.delete('/api/kv/:key', async (c) => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: 'bad_key' }, 400);
    await store.del(c.get('user'), key);
    return c.json({ ok: true });
  });

  // Full export / import of YOUR data: how you move between AWS accounts.
  app.get('/api/export', async (c) => {
    const items = await store.list(c.get('user'), {});
    return c.json({ app: 'protocol', user: c.get('user'), exported: new Date().toISOString(), items });
  });

  app.post('/api/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items) return c.json({ error: 'expected {items:[{key,value,updatedAt}]}' }, 400);
    const clean = items.filter((r) => validKey(r.key) && validValue(r.value))
      .map((r) => ({ key: r.key, value: r.value, updatedAt: Number(r.updatedAt) || Date.now() }));
    const n = await store.putMany(c.get('user'), clean);
    return c.json({ imported: n, skipped: items.length - clean.length });
  });

  // Photo and/or text -> nutrition estimate. Does NOT save; the app saves
  // after the user confirms or edits portions.
  // Body: { image?: "<base64 jpeg/png/webp>", format?: "jpeg", text?: "..." }
  app.post('/api/analyze', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => null);
    if (!body || (!body.image && !body.text)) return c.json({ error: 'send image and/or text' }, 400);
    let imageBytes;
    if (body.image) {
      imageBytes = Buffer.from(String(body.image).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (!imageBytes.length || imageBytes.length > MAX_IMAGE_BYTES) return c.json({ error: 'image too large or empty (max 3 MB)' }, 413);
    }

    // Per-user daily cap: every estimate is billed to the account owner.
    const day = today();
    const used = await store.incr(user, `analyze#${day}`, { ttlDays: 3 });
    if (dailyAnalyzeLimit > 0 && used > dailyAnalyzeLimit) {
      return c.json({ error: 'daily_limit', message: `Daily limit of ${dailyAnalyzeLimit} estimates reached. Resets at midnight Pacific.` }, 429);
    }

    // Personal context for better estimates, from the user's synced profile.
    let about = '';
    const prof = await store.get(user, 'profile');
    if (prof) { try { about = String(JSON.parse(prof.value).about || '').slice(0, 600); } catch { /* ignore */ } }

    const format = ['jpeg', 'png', 'webp', 'gif'].includes(body.format) ? body.format : 'jpeg';
    const text = body.text ? String(body.text).slice(0, 500) : '';
    const result = await analyze({ imageBytes, imageFormat: format, text, about });
    console.log(JSON.stringify({ level: 'info', event: 'analyze', user, used, image: !!imageBytes, bytes: imageBytes?.length || 0, ms: result.meta?.ms, usage: result.meta?.usage }));
    return c.json({ ...result, usage: { today: used, limit: dailyAnalyzeLimit } });
  });

  return app;
}
