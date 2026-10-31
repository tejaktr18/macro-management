# Friction log: building PROTOCOL as an AWS customer

Goal: experience AWS the way an external developer does. Work backwards from what slowed us down, using
public docs and tools only. Log every snag *as it happens*, even small ones. Two minutes of confusion
is data.

Severity: **S1** blocked · **S2** needed a workaround or extra infra · **S3** slowed me down · **S4** papercut

## Found while designing (from public docs, Oct 2026, before first deploy)

| # | Sev | Area | What happened | Workaround used | What would delight |
| --- | --- | --- | --- | --- | --- |
| 1 | S2 | SAM / Web Functions | `AWS::Serverless::WebFunction` requires `CodeUri` in S3. `sam build` / `sam package` don't support local paths for it, so the usual `sam build && sam deploy` loop doesn't work. | Separate `bootstrap.yaml` stack for a code bucket. `deploy.sh` zips, uploads, captures `VersionId`, and passes it as a parameter. | `CodeUri: ./src` just works, like `AWS::Serverless::Function`. |
| 2 | S2 | Web Functions / S3 | The code bucket must have versioning **and** a bucket policy granting `lambda.amazonaws.com` `s3:GetObject` + `s3:GetObjectVersion`. The AWS-managed `aws/s3` KMS key is not supported. Three ways to fail before your first request. | Encoded all of it in `bootstrap.yaml` (SSE-S3, versioning, scoped policy). | A managed bootstrap bucket, like `cdk bootstrap` / `sam --resolve-s3`, that already meets the rules. |
| 3 | S3 | SAM | `AWS::Serverless::WebFunction` has no `Policies` shorthand. Without `ExecutionRoleArn` you get only basic logging permissions. | Hand-wrote an `AWS::IAM::Role` for DynamoDB, Secrets Manager and Bedrock. | Same `Policies:` / policy templates (`DynamoDBCrudPolicy`) as `AWS::Serverless::Function`. |
| 4 | S3 | Runtime choice | Web Functions run Node.js only at launch (Node 24 / arm64). I'd have preferred Python. | Wrote the backend in Node + Hono. | Python (FastAPI/Flask) support. Most "photo → AI → JSON" sample code customers find is Python. |
| 5 | S3 | CDK | CDK has only L1 `CfnWebFunction` (FunctionName + Tags; revision and endpoint are separate L1s). No L2 construct yet. | Used SAM instead of CDK. | An L2 `WebFunction` construct with `grant*` helpers and `.url`. |
| 6 | S3 | Docs | Couldn't find documented request-body size limits, memory settings, or endpoint-level CORS in the pages I read. These pages had them split across ~15 subpages, several without examples. | Resized photos on the phone (≤1024 px JPEG, ~150–300 KB). Did CORS in app code. Left memory at default. | One "limits & quotas" table on the Web Functions overview page. |
| 7 | S3 | Bedrock | Claude Sonnet 5.5 can't be invoked by bare model ID on-demand, only through an inference profile (`us.` / `global.`). IAM then needs **both** the profile ARN **and** the foundation-model ARNs in every Region the profile routes to. | Two resources in the Bedrock IAM statement (`template.yaml`). | The console's model page offers a copy-paste IAM snippet for the profile. |
| 8 | S4 | Web Functions | Revisions are immutable, and every new revision must re-specify **all** env vars and settings (omitted = reset to default) when using the CLI. Easy to wipe config on a hotfix. | SAM template owns all settings, so each deploy re-sends them. | `--copy-from-revision` on `create-web-function-revision`. |
| 9 | S4 | Web Functions | `aws lambda-web deploy` docs don't show a way to set env vars, so the one-command path stops working once you need a table name. | Used SAM / CloudFormation instead of the one-command deploy. | `--env KEY=VALUE` on `deploy`. |

Sources: [Web Functions launch blog](https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/) ·
[SAM `AWS::Serverless::WebFunction`](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-webfunction.md) ·
[CFN `AWS::Lambda::WebFunction`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-webfunction.html) ·
[Web Function revisions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html) ·
[Execution role](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-permissions.html) ·
[Bedrock: Claude Sonnet 5.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html)

## Fill in during the real deploy

Track time from `git clone` to the first photo estimate working on the phone.

| # | Sev | Step | Time lost | What happened (exact error text) | Workaround | What would delight |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | | Credentials / profile | | | | |
| 11 | | `deploy.sh` step 1 (bootstrap) | | | | |
| 12 | | Step 4 (SAM transform of WebFunction server-side) | | | | |
| 13 | | Bedrock model access | | | | |
| 14 | | First `/api/analyze` latency (cold vs warm) | | | | |
| 15 | | GitHub OIDC setup | | | | |
| 16 | | Logs: finding them, reading them | | | | |

## Questions to answer from the customer seat

- How long did it take to get from zero to a working URL? Where did the time go?
- Which step needed knowledge I only have because I work at AWS? (That's a gap for every other customer.)
- Where would a customer have given up or switched to another platform (Vercel, Cloudflare, Fly)?
- What did the error messages tell me, and what did I actually need them to say?
- Cost: could I predict the bill before deploying? After a week, does it match?
- Which one change would have saved the most time? Write it as a one-line customer quote.
