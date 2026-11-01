// Entry point. On a Lambda Web Function, Lambda sets AWS_LAMBDA_HTTP_ENDPOINT
// ("host:port") and the server just listens there. Locally, `npm run dev`
// sets it to 127.0.0.1:3000 and uses an in-memory store + mock analyzer.
import { serve } from '@hono/node-server';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createApp } from './app.js';
import { memoryStore, dynamoStore } from './store.js';
import { bedrockAnalyzer, mockAnalyzer } from './analyze.js';

const env = process.env;
const region = env.APP_REGION || env.AWS_REGION || 'us-west-2';

const store = env.STORE === 'memory'
  ? memoryStore()
  : dynamoStore({ tableName: env.TABLE_NAME, region });

const analyze = env.MOCK_AI === '1'
  ? mockAnalyzer()
  : bedrockAnalyzer({ region, modelId: env.MODEL_ID });

// Token: API_TOKEN for local dev, otherwise read from Secrets Manager and
// cached in memory. Re-read when the cache is an hour old, or immediately
// (at most once a minute) when a request's token doesn't match - so a
// rotated token works right away, without a redeploy.
const TOKEN_TTL_MS = 3_600_000;
const FORCED_REFRESH_MIN_GAP_MS = 60_000;
let cached = { value: env.API_TOKEN || '', at: env.API_TOKEN ? Infinity : 0 };
let lastForced = 0;
const sm = env.TOKEN_SECRET_ARN ? new SecretsManagerClient({ region }) : null;
async function getToken({ refresh = false } = {}) {
  if (!sm) return cached.value;
  const now = Date.now();
  const stale = now - cached.at >= TOKEN_TTL_MS;
  const forced = refresh && now - lastForced >= FORCED_REFRESH_MIN_GAP_MS;
  if (!stale && !forced) return cached.value;
  if (forced) lastForced = now;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: env.TOKEN_SECRET_ARN }));
  cached = { value: r.SecretString, at: now };
  return cached.value;
}

const allowedOrigins = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);

const app = createApp({
  store, analyze, getToken, allowedOrigins,
  info: { region, model: env.MOCK_AI === '1' ? 'mock' : env.MODEL_ID, version: env.APP_VERSION || 'dev' },
});

const endpoint = env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000';
const cut = endpoint.lastIndexOf(':'); // tolerate IPv6 hosts like [::1]:8080
const host = endpoint.slice(0, cut).replace(/^\[|\]$/g, '');
const port = endpoint.slice(cut + 1);
serve({ fetch: app.fetch, hostname: host, port: Number(port) }, () => {
  console.log(JSON.stringify({ level: 'info', event: 'listening', host, port, store: store.kind }));
});
