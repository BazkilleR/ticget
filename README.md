# ticget: zone-based ticket booking

A ticket booking system for concerts and events that can take a large rush of simultaneous bookings and
**never sells more tickets than a zone holds**. Every booking request goes into a queue (SQS FIFO) first, and
a worker takes seats from the zone in PostgreSQL one request at a time per zone. A booking that is not paid
within 10 minutes expires and its seats are released.

- **Backend:** Node.js + Express, PostgreSQL, Redis (cache only), SQS FIFO
- **Frontend:** React (Vite)
- **Deploy:** AWS with CDK. The backend runs in `ap-southeast-7` (Thailand), the web UI on Amplify Hosting

## Repository layout

The repo has three parts, each with its own `package.json`:

| Part | Where | What |
|---|---|---|
| **Backend** | repo root | API and worker share one codebase but run as two separate processes |
| **Frontend** | [`frontend/`](frontend/) | Single-page web UI that calls the backend through `/api/*` |
| **Infra** | [`infra/`](infra/) | AWS CDK app that builds the whole backend stack |

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
npm run migrate && npm run seed

npm run dev:api                    # terminal 1: http://localhost:3000
npm run dev:worker                 # terminal 2

cd frontend && npm install && cd ..
npm run dev:web                    # terminal 3: http://localhost:5173
```

To test hold expiry quickly, start the API and the worker with `BOOKING_HOLD_MINUTES=0.25` (15 seconds).

## Testing

| What | Command | Needs |
|---|---|---|
| Integration tests | `npm test` | only `docker compose up -d`; tests use their own database, Redis DB and queue |
| Load test (k6) | `npm run load:prepare` → `npm run load:run` → `npm run load:verify` | API and worker running |
| Manual | open the `bruno/` folder in Bruno | API and worker running |

## Deploy to AWS

```bash
npm run aws:deploy                                      # create the backend stack (~15–25 min)
npm run aws:tunnel                                      # separate terminal: tunnel to RDS and Redis
eval "$(npm run -s aws:env)" && npm run seed            # load the sample data
AMPLIFY_APP_ID=<app id> npm run aws:amplify-rewrites    # point the web UI at the new API URL
npm run aws:destroy                                     # delete the stack when done, to stop the costs
```

- Create the Amplify app once in the console (Singapore region). Steps are in [frontend/README.md](frontend/README.md).
- Every fresh stack gets a new API URL, so run `aws:amplify-rewrites` again after each deploy.
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
| `aws:deploy` / `aws:destroy` | create or delete the AWS stack |
| `aws:tunnel` / `aws:ssh` / `aws:env` | reach the AWS database, Redis and EC2 from your machine |
| `aws:amplify-rewrites` | set Amplify's `/api/*` proxy to the current API URL |
