// HTTP API for PROTOCOL. Plain Hono app: runs the same locally and on a
// Lambda Web Function (no event-handler adapter needed).
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validKey, validValue } from './store.js';

const USER = 'me'; // single-user app; the data model already keys by user
const MAX_IMAGE_BYTES = 3_000_000;

function sameToken(a, b) {
  // hash first so lengths always match for timingSafeEqual
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function createApp({ store, analyze, getToken, allowedOrigins = ['*'], info = {} }) {
  const app = new Hono();

  app.use('*', cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  }));

  app.onError((err, c) => {
    console.error(JSON.stringify({ level: 'error', path: c.req.path, name: err.name, message: err.message }));
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  // Unauthenticated liveness check (reveals nothing sensitive).
  app.get('/health', (c) => c.json({ ok: true, store: store.kind, ...info }));

  // Everything under /api needs the bearer token.
  app.use('/api/*', async (c, next) => {
    const h = c.req.header('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    let expected = await getToken();
    let ok = !!expected && sameToken(token, expected);
    // Token rotated in Secrets Manager? Re-read it once before rejecting.
    // getToken rate-limits forced refreshes, so bad tokens can't hammer Secrets Manager.
    if (!ok) {
      expected = await getToken({ refresh: true });
      ok = !!expected && sameToken(token, expected);
    }
    if (!ok) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/api/whoami', (c) => c.json({ ok: true, store: store.kind, ...info }));

  // List records (sync pull). ?prefix=meals-2026-10&since=<epoch ms>
  app.get('/api/kv', async (c) => {
    const prefix = c.req.query('prefix') || '';
    const since = Number(c.req.query('since') || 0);
    if (prefix && !validKey(prefix)) return c.json({ error: 'bad_prefix' }, 400);
    const items = await store.list(USER, { prefix, since });
    return c.json({ items, now: Date.now() });
  });

  app.get('/api/kv/:key', async (c) => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: 'bad_key' }, 400);
    const rec = await store.get(USER, key);
    return rec ? c.json(rec) : c.json({ error: 'not_found' }, 404);
  });

  // Upsert (sync push). Body: { value: "<json string>", updatedAt: <epoch ms> }
  app.put('/api/kv/:key', async (c) => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: 'bad_key' }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || !validValue(body.value)) return c.json({ error: 'bad_value' }, 400);
    const updatedAt = Number.isFinite(body.updatedAt) ? body.updatedAt : Date.now();
    const r = await store.put(USER, key, body.value, updatedAt);
    return c.json(r, r.applied ? 200 : 409);
  });

  app.delete('/api/kv/:key', async (c) => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: 'bad_key' }, 400);
    await store.del(USER, key);
    return c.json({ ok: true });
  });

  // Full export / import: how you move between AWS accounts.
  app.get('/api/export', async (c) => {
    const items = await store.list(USER, {});
    return c.json({ app: 'protocol', exported: new Date().toISOString(), items });
  });

  app.post('/api/import', async (c) => {
    const body = await c.req.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items) return c.json({ error: 'expected {items:[{key,value,updatedAt}]}' }, 400);
    const clean = items.filter((r) => validKey(r.key) && validValue(r.value))
      .map((r) => ({ key: r.key, value: r.value, updatedAt: Number(r.updatedAt) || Date.now() }));
    const n = await store.putMany(USER, clean);
    return c.json({ imported: n, skipped: items.length - clean.length });
  });

  // Photo and/or text -> nutrition estimate. Does NOT save; the app saves
  // after the user confirms or edits portions.
  // Body: { image?: "<base64 jpeg/png/webp>", format?: "jpeg", text?: "..." }
  app.post('/api/analyze', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || (!body.image && !body.text)) return c.json({ error: 'send image and/or text' }, 400);
    let imageBytes;
    if (body.image) {
      imageBytes = Buffer.from(String(body.image).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (!imageBytes.length || imageBytes.length > MAX_IMAGE_BYTES) return c.json({ error: 'image too large or empty (max 3 MB)' }, 413);
    }
    const format = ['jpeg', 'png', 'webp', 'gif'].includes(body.format) ? body.format : 'jpeg';
    const text = body.text ? String(body.text).slice(0, 500) : '';
    const result = await analyze({ imageBytes, imageFormat: format, text });
    console.log(JSON.stringify({ level: 'info', event: 'analyze', image: !!imageBytes, bytes: imageBytes?.length || 0, ms: result.meta?.ms, usage: result.meta?.usage }));
    return c.json(result);
  });

  return app;
}
