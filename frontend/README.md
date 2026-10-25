# Ticget web UI

React SPA (Vite) for the backend in the repo root. It always calls the API at `/api/*` on its own origin,
so the backend needs no CORS:

| Where | Who forwards `/api/*` |
|---|---|
| local (`npm run dev`) | Vite dev proxy → `http://localhost:3000` (prefix stripped) |
| AWS Amplify Hosting | Amplify rewrite rule (200) → API Gateway URL (Terraform output `ApiUrl`) |

## Run locally

```bash
# repo root: backend stack + API + worker
docker compose up -d
npm run migrate && npm run seed
npm run dev:api        # terminal 1
npm run dev:worker     # terminal 2

# frontend
cd frontend
npm install
npm run dev            # http://localhost:5173
```

## Deploy to Amplify Hosting

One-time setup in the Amplify console:

1. **Create app → GitHub** and pick this repo and the branch to deploy (e.g. `main`).
2. Tick **"My app is a monorepo"** and set the root directory to `frontend`. Amplify picks up
   `amplify.yml` from the repo root. Make sure the env var `AMPLIFY_MONOREPO_APP_ROOT=frontend` is set.
3. Region: **`ap-southeast-1` (Singapore)**. Switch region at the top right of the console before you
   create the app. Amplify Hosting is not offered in `ap-southeast-7` (Thailand), where the backend runs.
   Singapore is the closest region that has it. Visitors get the UI from CloudFront edges either way, and
   the `/api` proxy works across regions.

The app stays outside Terraform, so `npm run aws:destroy` keeps it and its `amplifyapp.com` domain. Only the
rewrite rules follow the stack: every `npm run aws:deploy` ends with `aws:amplify-rewrites`, which finds the
Amplify app connected to this repo's GitHub remote and points it at the new API Gateway URL. To run it alone
or pick another app:

```bash
npm run aws:amplify-rewrites
AMPLIFY_APP_ID=<app id> AMPLIFY_REGION=<region> npm run aws:amplify-rewrites
```

It sets two rewrite rules, in this order:

1. `/api/<*>` → `https://<api-id>.execute-api.<region>.amazonaws.com/<*>` (200, proxy)
2. SPA fallback: anything without a static file extension → `/index.html` (200)

### Checks after a deploy

- `https://<branch>.<app-id>.amplifyapp.com/api/health` returns `{ "ok": true, ... }`
- After logging in, **My bookings** loads, which means the `Authorization` header reaches the API through the proxy
- Reloading a deep link such as `/bookings/<id>` does not return a 404

If the proxy ever drops the `Authorization` header, the fallback is to add a `cors_configuration` for the
Amplify domain to `aws_apigatewayv2_api.http` in `infra/api.tf` and build with
`VITE_API_BASE=https://<api-id>.execute-api.<region>.amazonaws.com`.
