# PROTOCOL

Personal 12-week cut tracker: workouts, food log with photo calorie estimates,
weigh-ins, and a grocery list. Built as a customer would build it on AWS.

```
iPhone (index.html on GitHub Pages)
   │  localStorage = fast local copy + offline queue
   │  HTTPS + bearer token
   ▼
Lambda Web Function  (Node 24, Hono)      backend/src
   ├── DynamoDB      one table, PK=U#me SK=KV#<key>, PITR on, retained on delete
   ├── Bedrock       Claude Sonnet 5.5 (US inference profile), photo/text -> JSON via forced tool call
   └── Secrets Mgr   generated API token
```

| Path | What |
| --- | --- |
| `index.html` | The whole app (served by GitHub Pages) |
| `backend/src/` | API: `/health`, `/api/kv` sync, `/api/export`, `/api/import`, `/api/analyze` |
| `backend/template.yaml` | App stack: `AWS::Serverless::WebFunction`, table, secret, role |
| `backend/bootstrap.yaml` | Versioned S3 bucket Web Functions load code from |
| `backend/github-oidc.yaml` | One-time per account: lets GitHub Actions deploy without stored keys |
| `backend/deploy.sh` | `./deploy.sh <env>`: the whole deploy |
| `backend/envs/example.env` | Per-account settings (copy to `envs/<name>.env`, git-ignored) |
| `.github/workflows/deploy-backend.yml` | CI/CD: test, then deploy to the chosen account |
| `backend/FRICTION_LOG.md` | Customer pain points hit while building this |

## Where data lives

- **On the phone:** `localStorage` for this site, read and written by the app on every tap. Keys starting
  with `_` (sync settings, token, queue) never leave the device and are never exported.
- **In AWS (once Cloud sync is set up):** every other key (`log-<date>`, `weigh-<date>`, `meals-<date>`,
  `shop`, `cutStart`) is pushed to DynamoDB right after it changes. Offline changes queue and retry. Each
  key carries a timestamp, and the newest write wins, so two phones stay consistent.

## First deploy (from your laptop)

Prereqs: AWS CLI v2 (recent enough to know Web Functions), Node 24, `zip`, and credentials for the target
account in a named CLI profile (however you normally get them).

```bash
cd backend
cp envs/example.env envs/isengard.env     # edit AWS_PROFILE / AWS_REGION if needed
npm ci                                    # package-lock.json is included
./deploy.sh isengard
```

Before the first photo, check in the Bedrock console that Claude Sonnet 5.5 is usable in your account
(Anthropic models may ask for a one-time use-case form).

The script prints **API URL** and **Token**. On the phone: Today tab → Cloud sync → paste both →
Save & sync. Everything already on the phone uploads.

Test locally without AWS: `npm run dev` (in-memory store, mock analyzer) and point the app at
`http://127.0.0.1:3000` with token `dev`.

## Switching accounts

```bash
cp envs/isengard.env envs/personal.env    # new profile/region
./deploy.sh personal
```

Then paste the new URL + token into the app. Your phone holds a full copy of the data, so connecting
uploads it all to the new account. That is the migration. For a server-to-server copy, use
`GET /api/export` on the old account and `POST /api/import` on the new one.

Nothing in the templates names an account. The DynamoDB table and code bucket are **retained** if you
delete the stacks, so tearing down an account never silently deletes data. Delete them by hand when sure.

## CI/CD with GitHub Actions (optional, after the first deploy works)

1. Once per account:
   ```bash
   aws cloudformation deploy --stack-name protocol-github --template-file backend/github-oidc.yaml \
     --capabilities CAPABILITY_IAM --parameter-overrides GitHubEnvironment=isengard
   ```
   (Set `CreateOidcProvider=false` if the account already has the GitHub OIDC provider.)
2. GitHub repo → Settings → Environments → **isengard** → add variables:
   `AWS_DEPLOY_ROLE_ARN`, `CFN_EXEC_ROLE_ARN` (stack outputs), and `AWS_REGION` (e.g. `us-west-2`).
3. Push changes under `backend/` to main → tests run → deploy. Use Actions → Deploy backend →
   Run workflow to deploy to any other environment (e.g. `personal`).

GitHub gets 1-hour credentials through OIDC. No AWS keys are stored in the repo or in GitHub.

## Costs (rough, single user)

Lambda Web Functions bill active CPU plus memory while an environment lives, and scale to zero when idle.
DynamoDB on-demand and PITR at this size cost pennies. Secrets Manager is about $0.40 per month. Bedrock is
billed per token, and images count as input tokens. Check the pricing pages for your region.

## Security notes

- The endpoint is public (`ApplicationManaged` auth). Every `/api/*` call needs the 48-character
  bearer token, compared in constant time. `/health` reveals only region and model.
- CORS allows only `ALLOWED_ORIGINS` (default `https://tejaktr18.github.io`).
- To rotate the token, change the secret in Secrets Manager. The function picks it up within an hour.
  Then paste the new token in the app.
