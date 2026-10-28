# ticget: zone-based ticket booking

A ticket booking system for concerts and events that can take a large rush of simultaneous bookings and
**never sells more tickets than a zone holds**. Every booking request goes into a queue (SQS FIFO) first, and
a worker takes seats from the zone in PostgreSQL one request at a time per zone. A booking that is not paid
within 10 minutes expires and its seats are released.

Users search events, book a zone, pay (mocked) and get one QR e-ticket per seat. Admins manage events and
zones, check tickets in at the door and follow sales on a dashboard.

- **Backend:** Node.js + Express, PostgreSQL, Redis (cache only), SQS FIFO
- **Frontend:** React (Vite)
- **Deploy:** AWS with Terraform. The backend runs in `ap-southeast-7` (Thailand), the web UI on Amplify Hosting

## Repository layout

The repo has three parts:

| Part | Where | What |
|---|---|---|
| **Backend** | repo root | API and worker share one codebase but run as two separate processes |
| **Frontend** | [`frontend/`](frontend/) | Single-page web UI that calls the backend through `/api/*` |
| **Infra** | [`infra/`](infra/) | Terraform configuration that builds the whole backend stack |

Backend files at the root:

```
src/
├─ api.js              API entry point (Express)
├─ worker.js           worker entry point (pulls booking requests from SQS)
├─ app.js              builds the Express app (used by the tests)
├─ routes/             thin route handlers, input validated with zod
├─ services/           core logic: booking.js (quota, idempotency), events.js, auth.js, cache.js
├─ middleware/         auth (JWT), validate, error
└─ jobs/expire.js      cleanup of expired holds (a Lambda on AWS)
migrations/            database schema
seeds/                 sample data: 20 events, 51 zones (event 1 holds the 5-seat and k6 zones)
scripts/               migrate, seed, LocalStack and test-database setup
tests/                 jest + supertest integration tests
certs/                 RDS CA bundle for TLS on AWS
Dockerfile             one image for the API, the worker and migrations
```

Tools for the system as a whole:

```
docker-compose.yml     Postgres, Redis and LocalStack (local SQS) for development
load/                  k6 load test: 1,000 users race for 100 seats, plus a no-overselling check
bruno/                 Bruno collection for calling the API by hand (local and aws environments)
amplify.yml            Amplify Hosting build spec (builds frontend/ only)
```

## Architecture

```
Browser ── /api/* ──► Amplify (proxy) ──► API Gateway ──► ALB ──► EC2: Express API ──► PostgreSQL (RDS)
                                                                   │        └────────► Redis (cache)
                                                                   └─ POST /bookings ─► SQS FIFO ─► DLQ
                                                                                          │
                                                       EC2: worker ◄──────────────────────┘
                                                        └─ takes seats in PostgreSQL (one transaction)
```

- `POST /bookings` answers `202 QUEUED` right away. The web UI polls `GET /bookings/:id` until the result
  (`PENDING` or `FAILED`) is in.
- Correctness lives in PostgreSQL alone: a conditional `UPDATE` inside a transaction. Redis is only a cache.
- The frontend always calls the API on its own origin, so the backend needs no CORS (details in
  [frontend/README.md](frontend/README.md)).

The full spec (schema, API, booking flow, hard rules) is in [CLAUDE.md](CLAUDE.md).

## Run locally

Requires Node.js 24 and Docker.

```bash
cp .env.example .env
npm install
docker compose up -d --wait        # Postgres :5433, Redis :6379, LocalStack (SQS) :4566
cd frontend && npm install && cd ..
npm run migrate && npm run seed    # 20 sample events + the admin account from ADMIN_USERNAME / ADMIN_PASSWORD
npm run seed:demo                  # optional: a week of paid bookings for the sales dashboard

npm run dev                        # Docker + migrate, then API :3000, worker and web UI :5173 in one terminal
```

`npm run dev` runs `dev:api`, `dev:worker` and `dev:web` together; they can also run in separate terminals.
To test hold expiry quickly, set `BOOKING_HOLD_MINUTES=0.25` (15 seconds) in `.env`.

### Admin

- The only way to get an admin account is `npm run seed` (on AWS: `aws:seed`) with `ADMIN_PASSWORD` set
  (and optionally `ADMIN_USERNAME`, default `admin`). There is no API route that grants admin.
- Log in as the admin and open **ผู้ดูแลระบบ** in the menu:
  - **ภาพรวม:** sales dashboard and CSV export
  - **งานแสดง:** create and edit events and zones
  - **ตรวจบัตร:** door check-in
- **Check-in:** each e-ticket's QR code holds a link to `/admin/check-in?code=…`. Door staff scan it with any
  phone camera, log in once, pick the event for their gate, and confirm. A ticket gets in once, and only at
  its own event.

## Testing

| What | Command | Needs |
|---|---|---|
| Integration tests | `npm test` | only `docker compose up -d`; tests use their own database, Redis DB and queue |
| Load test (k6) | `npm run load:prepare` → `cd load && k6 run booking-rush.js` → `npm run load:verify` | API and worker running, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed |
| Manual / API | open the `bruno/` folder in Bruno, or `cd bruno && npx @usebruno/cli run --env local` | API and worker running; set `adminPassword` in the environment |

`npm run load:run` runs k6 in Docker instead of a local install. Avoid it on WSL2 + Docker Desktop: the
container cannot reach the API on WSL's localhost, and through `host.docker.internal` Docker's port relay drops
part of the requests, which looks like a failed load test when the API never saw them. Run k6 natively there.

### Load test on AWS

`load:prepare` and `load:verify` talk to the database directly, so they go through a tunnel; k6 calls the
public API URL.

```bash
npm run aws:tunnel                                # terminal 1, keep it open: RDS on :15432, Redis on :16379
eval "$(npm run -s aws:env)"                      # terminal 2: point the scripts at AWS, also sets API_URL
npm run load:prepare
(cd load && k6 run -e BASE_URL="$API_URL" booking-rush.js)
npm run load:verify                               # 100 PENDING, the rest SOLD_OUT, zones.reserved = 100
```

For Bruno on AWS, set `baseUrl` in [`bruno/environments/aws.bru`](bruno/environments/aws.bru) to the API URL
without the trailing `/` (it changes with every fresh stack), then `cd bruno && npx @usebruno/cli run --env aws`.

## Deploy to AWS

Before the first deploy:

- Install Terraform ≥ 1.9, Docker and AWS CLI v2, and sign the CLI in to the account (`aws sts get-caller-identity`
  should work).
- `ap-southeast-7` (Thailand) is an opt-in region: enable it under **Account → AWS Regions** first, or the
  deploy fails.
- Set an AWS Budget alert in the Billing console, so a forgotten stack does not run up costs.

```bash
npm run aws:init                                        # once: download the Terraform providers
ADMIN_PASSWORD='<long password>' npm run aws:deploy     # push image to ECR, bundle Lambda, terraform apply,
                                                        # Amplify rewrites, seed sample data + admin (~15–25 min)
npm run aws:destroy                                     # delete the stack when done, to stop the costs
```

- The seed runs on an API instance over EC2 Instance Connect, so no tunnel is needed. It only happens when
  `ADMIN_PASSWORD` is set and the database has no users yet, so redeploying a running stack keeps its data.
  Add `SEED_DEMO=1` for a week of paid bookings on the sales dashboard.
- To seed by hand: `ADMIN_PASSWORD=... npm run aws:seed` (`-- --demo` adds demo sales, `-- --force` wipes a
  database that has data, `-- --demo-only` just adds demo sales).
- The app image goes to the ECR repository `ticget-backend`, created on the first deploy and kept by
  `aws:destroy`, so later deploys only push the layers that changed. EC2 pulls it through VPC endpoints (no NAT).
- The stack survives the loss of one AZ: RDS Multi-AZ (synchronous standby, automatic failover), VPC endpoints
  in both AZs, and an API instance in each AZ (2–4). The worker runs 1–4 instances: if its AZ fails, bookings
  wait in SQS until the ASG replaces it in the other AZ. Redis is one node: the app falls back to the database
  when it is gone.
- The API URL is printed at the end of the deploy as `ApiUrl`; later, `terraform -chdir=infra output -raw ApiUrl`.
  `<ApiUrl>/health` should answer `{ "ok": true, ... }`.
- State is kept locally in `infra/terraform.tfstate` (gitignored, holds the generated secrets): deploy and
  destroy from the same machine.
- Create the Amplify app once in the console (Singapore region). Steps are in [frontend/README.md](frontend/README.md).
- Every fresh stack gets a new API URL. `aws:deploy` points the Amplify app connected to this repo's GitHub
  remote at it (skipped if there is none); set `AMPLIFY_APP_ID` / `AMPLIFY_REGION` to pick another app.
- `npm run aws:ssh` opens a shell on an API instance for logs.

## Common npm scripts

| Script | What it does |
|---|---|
| `dev` | start Docker, migrate, then run API + worker + web UI together (Ctrl+C stops all) |
| `dev:api` / `dev:worker` / `dev:web` | run the API, worker or web UI with auto-reload |
| `migrate` / `seed` | update the schema, load sample data and the admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (**seed wipes every table first**) |
| `seed:demo` | add a week of paid bookings (with e-tickets) so the admin sales dashboard has data |
| `expire` | run the expired-hold cleanup once |
| `test` | integration tests |
| `load:prepare` / `load:run` / `load:verify` | load test |
| `aws:deploy` / `aws:destroy` | create or delete the AWS stack (`aws:plan` previews the changes) |
| `aws:seed` | load sample data + admin into the AWS database (`aws:deploy` already runs it on an empty database) |
| `aws:tunnel` / `aws:ssh` / `aws:env` | reach the AWS database, Redis and EC2 from your machine |
| `aws:amplify-rewrites` | set Amplify's `/api/*` proxy to the current API URL (`aws:deploy` already runs it) |
