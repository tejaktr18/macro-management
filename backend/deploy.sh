#!/usr/bin/env bash
# Deploy PROTOCOL's backend to one AWS account.
#
#   ./deploy.sh isengard        # reads envs/isengard.env
#   ./deploy.sh personal        # reads envs/personal.env
#
# In CI (GitHub Actions) there is no env file: the same variables come from
# the workflow environment and credentials from OIDC.
#
# Steps: bootstrap bucket -> build bundle -> upload zip (versioned) ->
#        deploy app stack -> print URL + token -> smoke test.
set -euo pipefail
cd "$(dirname "$0")"

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then echo "usage: ./deploy.sh <env>   (env file: envs/<env>.env)"; exit 1; fi
if [[ -f "envs/$ENV_NAME.env" ]]; then
  set -a; source "envs/$ENV_NAME.env"; set +a
elif [[ -z "${CI:-}" ]]; then
  echo "envs/$ENV_NAME.env not found. Copy envs/example.env to envs/$ENV_NAME.env and edit it."; exit 1
fi

: "${AWS_REGION:?set AWS_REGION}"
APP_NAME="${APP_NAME:-protocol}"
MODEL_ID="${MODEL_ID:-us.anthropic.claude-sonnet-5-5}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://tejaktr18.github.io}"
[[ -n "${AWS_PROFILE:-}" ]] && export AWS_PROFILE || unset AWS_PROFILE
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

# Optional: let CloudFormation act through a dedicated execution role (used by CI
# so the GitHub role itself stays narrow).
CFN_ROLE_ARGS=()
[[ -n "${CFN_EXEC_ROLE_ARN:-}" ]] && CFN_ROLE_ARGS=(--role-arn "$CFN_EXEC_ROLE_ARN")

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

say "Account check"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "env=$ENV_NAME account=$ACCOUNT region=$AWS_REGION app=$APP_NAME model=$MODEL_ID"

say "1/5 Bootstrap stack (versioned code bucket)"
aws cloudformation deploy \
  --stack-name "$APP_NAME-bootstrap" \
  --template-file bootstrap.yaml \
  --no-fail-on-empty-changeset ${CFN_ROLE_ARGS[@]+"${CFN_ROLE_ARGS[@]}"}
BUCKET=$(out "$APP_NAME-bootstrap" BucketName)
echo "bucket=$BUCKET"

say "2/5 Build"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm test
rm -rf dist build && npm run build
mkdir -p build && (cd dist && zip -qr ../build/api.zip .)
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo local)
VERSION_LABEL="$(date -u +%Y%m%dT%H%M%SZ)-$GIT_SHA"

say "3/5 Upload code"
KEY="api/$VERSION_LABEL.zip"
CODE_VERSION=$(aws s3api put-object --bucket "$BUCKET" --key "$KEY" --body build/api.zip --query VersionId --output text)
echo "s3://$BUCKET/$KEY (version $CODE_VERSION)"

say "4/5 Deploy app stack (CloudFormation runs the SAM transform server-side)"
aws cloudformation deploy \
  --stack-name "$APP_NAME" \
  --template-file template.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset ${CFN_ROLE_ARGS[@]+"${CFN_ROLE_ARGS[@]}"} \
  --parameter-overrides \
    AppName="$APP_NAME" \
    ArtifactBucket="$BUCKET" \
    CodeKey="$KEY" \
    CodeVersion="$CODE_VERSION" \
    ModelId="$MODEL_ID" \
    AllowedOrigins="$ALLOWED_ORIGINS" \
    AppVersion="$VERSION_LABEL" \
    DailyAnalyzeLimit="${DAILY_ANALYZE_LIMIT:-40}"

API_URL=$(out "$APP_NAME" ApiUrl)
SECRET_ARN=$(out "$APP_NAME" ApiTokenSecretArn)

say "5/5 Smoke test"
for i in 1 2 3 4 5 6; do
  if curl -fsS "$API_URL/health"; then echo; break; fi
  echo "  not ready yet, retrying in 10s"; sleep 10
done

say "Done"
echo "API URL : $API_URL"
if [[ -z "${CI:-}" ]]; then
  TOKEN=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
  echo "Token   : $TOKEN"
  echo
  echo "Paste both into the app: Today tab -> Cloud sync -> Save."
else
  echo "Token   : (not printed in CI) aws secretsmanager get-secret-value --secret-id $SECRET_ARN"
fi
