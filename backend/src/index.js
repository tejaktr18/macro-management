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

// Token: API_TOKEN for local dev, otherwise read once from Secrets Manager
// and cache for the life of the execution environment (refresh hourly so a
// rotated secret is picked up without a redeploy).
let cached = { value: env.API_TOKEN || '', at: env.API_TOKEN ? Infinity : 0 };
const sm = env.TOKEN_SECRET_ARN ? new SecretsManagerClient({ region }) : null;
async function getToken() {
  if (Date.now() - cached.at < 3_600_000) return cached.value;
  if (!sm) return cached.value;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: env.TOKEN_SECRET_ARN }));
  cached = { value: r.SecretString, at: Date.now() };
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
