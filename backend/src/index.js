// Entry point. On a Lambda Web Function, Lambda sets AWS_LAMBDA_HTTP_ENDPOINT
// ("host:port") and the server just listens there. Locally, `npm run dev`
// sets it to 127.0.0.1:3000 and uses an in-memory store + mock analyzer.
import { serve } from '@hono/node-server';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createApp, parseUsers } from './app.js';
import { memoryStore, dynamoStore } from './store.js';
import { bedrockAnalyzer, mockAnalyzer } from './analyze.js';

const env = process.env;
const region = env.APP_REGION || env.AWS_REGION || 'us-west-2';

const store = env.STORE === 'memory'
  ? memoryStore()
  : dynamoStore({ tableName: env.TABLE_NAME, region, endpoint: env.DYNAMODB_ENDPOINT }); // endpoint: local testing only

const analyze = env.MOCK_AI === '1'
  ? mockAnalyzer()
  : bedrockAnalyzer({ region, modelId: env.MODEL_ID });

// Users + tokens. The secret holds JSON: {"teja": "<token>", "friend": "<token>"}.
// A plain (non-JSON) secret is treated as {"me": "<secret>"} - the original
// single-user format, so existing data under user "me" keeps working.
// Local dev: API_USERS='{"me":"dev"}' or API_TOKEN=dev.
// Cached in memory; re-read hourly, or immediately (at most once a minute)
// when a token doesn't match anyone - so new users and rotated tokens work
// without a redeploy.
const USERS_TTL_MS = 3_600_000;
const FORCED_REFRESH_MIN_GAP_MS = 60_000;
const localUsers = env.API_USERS || env.API_TOKEN || '';
let cached = { users: parseUsers(localUsers), at: localUsers ? Infinity : 0 };
let lastForced = 0;
const sm = env.TOKEN_SECRET_ARN ? new SecretsManagerClient({ region }) : null;
async function getUsers({ refresh = false } = {}) {
  if (!sm) return cached.users;
  const now = Date.now();
  const stale = now - cached.at >= USERS_TTL_MS;
  const forced = refresh && now - lastForced >= FORCED_REFRESH_MIN_GAP_MS;
  if (!stale && !forced) return cached.users;
  if (forced) lastForced = now;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: env.TOKEN_SECRET_ARN }));
  cached = { users: parseUsers(r.SecretString), at: now };
  return cached.users;
}

const allowedOrigins = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);

const app = createApp({
  store, analyze, getUsers, allowedOrigins,
  dailyAnalyzeLimit: Number(env.DAILY_ANALYZE_LIMIT || 40),
  info: { region, model: env.MOCK_AI === '1' ? 'mock' : env.MODEL_ID, version: env.APP_VERSION || 'dev' },
});

const endpoint = env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000';
const cut = endpoint.lastIndexOf(':'); // tolerate IPv6 hosts like [::1]:8080
const host = endpoint.slice(0, cut).replace(/^\[|\]$/g, '');
const port = endpoint.slice(cut + 1);
serve({ fetch: app.fetch, hostname: host, port: Number(port) }, () => {
  console.log(JSON.stringify({ level: 'info', event: 'listening', host, port, store: store.kind }));
});
