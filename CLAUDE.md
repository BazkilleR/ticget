# Ticket Booking Backend

ระบบจองตั๋วคอนเสิร์ต/อีเวนต์แบบ **เลือกโซน** (ไม่ระบุเลขที่นั่ง) ทำเฉพาะ **backend** ด้วย Express.js
พัฒนาและทดสอบบน local ทั้งหมดด้วย Docker ก่อน แล้วค่อย deploy ขึ้น AWS ในเฟสสุดท้าย

---

## เป้าหมายหลักของระบบ

1. รับคนกดจองพร้อมกันจำนวนมากตอนเปิดขายได้โดยระบบไม่ล่ม (ใช้คิว)
2. **ห้ามขายเกินความจุของโซนเด็ดขาด** (no overselling) นี่คือ requirement ที่สำคัญที่สุด
3. การจองที่ไม่ชำระเงินภายใน 10 นาทีต้องหมดอายุและคืนโควตา

---

## Tech stack

| ส่วน | เลือกใช้ |
|---|---|
| Runtime | Node.js 20+, JavaScript (CommonJS) |
| Web framework | Express |
| Database | PostgreSQL 16 (ใช้ `pg`) |
| Cache | Redis 7 (ใช้ `ioredis`) |
| Queue | AWS SQS **FIFO** (ใช้ `@aws-sdk/client-sqs`), local ใช้ LocalStack |
| Auth | ทำเอง: username + password, `bcrypt`, `jsonwebtoken` (HS256) |
| Validation | `zod` |
| Test | `jest` + `supertest`, load test ด้วย `k6` |
| Local infra | Docker Compose |

---

## Architecture

```
Client (Postman / Bruno)
   │
   ▼
Express API  (src/api.js)  ── อ่าน/เขียน ──►  PostgreSQL
   │   │                   ── cache ──────►  Redis
   │   └─ POST /bookings ─ SendMessage ─►  SQS FIFO ─(fail ซ้ำ)─► DLQ
   │                                          │
   │                                          ▼ poll
   │                                  Worker (src/worker.js)
   │                                   ├─ ตัดโควตาใน PostgreSQL
   │                                   └─ ลบ cache ใน Redis
   │
Cleanup script (src/jobs/expire.js) ─ รันเป็นระยะ ─► PostgreSQL
```

- **API กับ worker อยู่ใน codebase เดียว** แต่รันเป็น 2 process แยกกัน
- **Redis ใช้เป็น cache อย่างเดียว** ไม่ใช้ล็อก ความถูกต้องทั้งหมดอยู่ที่ PostgreSQL
- **SQS FIFO ใช้ `MessageGroupId = zone-{zoneId}`** เพื่อให้งานของโซนเดียวกันถูกประมวลผลทีละงาน และ `MessageDeduplicationId = requestId`
- ตอน deploy จริง: API Gateway (rate limit) → ALB (internal) → EC2 API ASG, และ EC2 worker ASG แยก, RDS, ElastiCache, SQS FIFO + DLQ, EventBridge Scheduler + Lambda สำหรับ cleanup

---

## โครงสร้างโปรเจกต์

```
ticket-backend/
├─ docker-compose.yml
├─ .env.example
├─ package.json
├─ migrations/
│  └─ 001_init.sql
├─ seeds/
│  └─ seed.sql
├─ scripts/
│  └─ init-localstack.sh        # สร้าง SQS FIFO + DLQ บน LocalStack
├─ src/
│  ├─ config.js                 # อ่านและ validate env
│  ├─ db.js                     # pg Pool
│  ├─ redis.js
│  ├─ sqs.js
│  ├─ middleware/
│  │  ├─ auth.js                # ตรวจ JWT, ใส่ req.userId
│  │  ├─ validate.js            # zod
│  │  └─ error.js
│  ├─ routes/
│  │  ├─ health.js
│  │  ├─ auth.js
│  │  ├─ events.js
│  │  └─ bookings.js
│  ├─ services/
│  │  ├─ cache.js               # cache-aside helper
│  │  └─ booking.js             # logic ตัดโควตา (worker เรียกใช้)
│  ├─ jobs/
│  │  └─ expire.js              # เก็บกวาดการจองหมดเวลา
│  ├─ app.js                    # สร้าง express app (export ไว้ให้ test ใช้)
│  ├─ api.js                    # entry: app.listen()
│  └─ worker.js                 # entry: loop ดึงงานจาก SQS
├─ tests/
│  ├─ auth.test.js
│  ├─ events.test.js
│  └─ booking.test.js
├─ load/
│  └─ booking-rush.js           # k6 script
├─ bruno/ หรือ postman/         # collection สำหรับทดสอบด้วยมือ
├─ amplify.yml                  # build spec ของ Amplify Hosting (appRoot: frontend)
└─ frontend/                    # React SPA (Vite) มี package.json ของตัวเอง เรียก API ผ่าน /api/* เสมอ
   ├─ vite.config.js            # dev proxy /api → localhost:3000
   └─ src/ api/ auth/ pages/ components/
```

---

## Database schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),  -- 002_user_roles.sql
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  venue      TEXT NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  sale_opens_at TIMESTAMPTZ NOT NULL,
  description TEXT,                                           -- 003_event_details.sql
  CONSTRAINT events_schedule_chk CHECK (sale_opens_at <= starts_at)
);

CREATE TABLE zones (
  id        SERIAL PRIMARY KEY,
  event_id  INT  NOT NULL REFERENCES events(id),
  name      TEXT NOT NULL,
  price     INT  NOT NULL CHECK (price >= 0),
  capacity  INT  NOT NULL CHECK (capacity > 0),
  reserved  INT  NOT NULL DEFAULT 0,          -- นับ PENDING (ยังไม่หมดเวลา) + CONFIRMED
  CHECK (reserved >= 0 AND reserved <= capacity),
  UNIQUE (event_id, name)
);

CREATE TABLE bookings (
  id          UUID PRIMARY KEY,               -- ใช้ค่าเดียวกับ request_id ได้
  request_id  UUID UNIQUE NOT NULL,           -- idempotency key จาก client
  user_id     UUID NOT NULL REFERENCES users(id),
  event_id    INT  NOT NULL REFERENCES events(id),
  zone_id     INT  NOT NULL REFERENCES zones(id),
  quantity    INT  NOT NULL CHECK (quantity BETWEEN 1 AND 4),
  status      TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','EXPIRED','FAILED')),
  fail_reason TEXT,                            -- เช่น SOLD_OUT, USER_LIMIT
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 005_booking_price.sql: bookings.unit_price INT ราคาโซน ณ ตอนจอง (worker อ่านจาก UPDATE zones ... RETURNING price)
-- รายงานยอดขายใช้ unit_price เสมอ admin แก้ราคาภายหลังยอดเดิมไม่เปลี่ยน
-- 004_tickets.sql: bookings.paid_at TIMESTAMPTZ และ e-ticket 1 ใบต่อ 1 ที่นั่ง ออกตอนจ่ายเงินใน statement เดียวกับการ CONFIRMED
CREATE TABLE tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES bookings(id),
  seq           INT  NOT NULL CHECK (seq BETWEEN 1 AND 4),
  code          TEXT UNIQUE NOT NULL,                -- 128 bit สุ่ม (hex 32 ตัว) อยู่ใน QR
  checked_in_at TIMESTAMPTZ,                         -- ตั้งครั้งเดียวด้วย conditional UPDATE
  checked_in_by UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, seq)
);

CREATE INDEX bookings_zone_pending_idx ON bookings (zone_id, expires_at) WHERE status = 'PENDING';
CREATE INDEX bookings_user_idx ON bookings (user_id, event_id);
```

---

## API spec

ทุก response เป็น JSON, error ใช้รูปแบบ `{ "error": "<code>", "message": "<text>" }`

### Public

| Method | Path | คำอธิบาย |
|---|---|---|
| GET | `/health` | health check สำหรับ ALB |
| POST | `/auth/register` | `{ username, password }` → `201 { id, username }` |
| POST | `/auth/login` | `{ username, password }` → `200 { token }` (JWT อายุ 1 ชม., payload `{ sub: userId }`) |
| GET | `/events` | รายการ event ที่ยังไม่เริ่ม `[{ id, name, venue, startsAt, saleOpensAt, minPrice }]` (cache 60 วินาที) |
| GET | `/events?q&from&to&sale&maxPrice&sort&limit` | ค้นหา: `q` ค้นชื่อหรือสถานที่, `from`/`to` เป็นวันที่ตามเวลาไทย (รวมวันสุดท้าย), `sale=open\|upcoming`, `maxPrice` = มีโซนราคาไม่เกินนี้, `sort=date\|price`, `limit` ≤ 50 ถ้ามีตัวกรองจะไม่ cache |
| GET | `/events/:id` | `{ id, name, venue, description, startsAt, saleOpensAt, minPrice }` (cache 60 วินาที) |
| GET | `/events/:id/zones` | `[{ zoneId, name, price, available }]` (cache 3 วินาที) |

### ต้องมี `Authorization: Bearer <token>`

| Method | Path | คำอธิบาย |
|---|---|---|
| POST | `/bookings` | `{ eventId, zoneId, quantity, requestId }` → `202 { bookingId, status: "QUEUED" }` |
| GET | `/bookings/:id` | สถานะการจอง ถ้ายังไม่มีใน DB ตอบ `{ status: "QUEUED" }` |
| GET | `/me` | `{ id, username, role }` ของตัวเอง (frontend ใช้ตัดสินว่าจะแสดงเมนู admin) |
| GET | `/me/bookings` | ประวัติการจองของตัวเอง |

### Admin: ต้องมี token และ `users.role = 'admin'`

ทุก route ใต้ `/admin` ใช้ `requireAuth` + `requireAdmin` (`src/middleware/admin.js`) ซึ่งอ่าน role จาก DB ทุกครั้ง ไม่ใส่ role ใน JWT เพื่อให้ถอดสิทธิ์มีผลทันที ไม่มีสิทธิ์ตอบ `403 forbidden`
บัญชี admin สร้างได้ทางเดียวคือ `npm run seed` ด้วย env `ADMIN_USERNAME` / `ADMIN_PASSWORD` ไม่มี HTTP route ที่ให้สิทธิ์ admin

| Method | Path | คำอธิบาย |
|---|---|---|
| GET | `/admin/events?include=past` | ทุก event พร้อม `zoneCount, capacity, sold, held, bookingCount` |
| POST | `/admin/events` | `{ name, venue, description?, startsAt, saleOpensAt, zones: [{ name, price, capacity }] }` (1–10 zones) → `201` สร้าง event + zones ใน transaction เดียว |
| GET | `/admin/events/:id` | event + zones พร้อม `reserved, available, sold, held, bookingCount` |
| PATCH | `/admin/events/:id` | แก้ฟิลด์ใดก็ได้ของ event, `invalid_schedule` ถ้าวันเปิดขายเลยวันแสดง |
| DELETE | `/admin/events/:id` | `204` หรือ `409 event_has_bookings` (มี booking แม้แต่ FAILED ก็ลบไม่ได้) |
| POST | `/admin/events/:id/zones` | เพิ่มโซน, `409 zone_name_taken` |
| PATCH | `/admin/zones/:id` | แก้ name/price/capacity, ลด capacity ต่ำกว่า reserved ได้ `409 capacity_below_reserved` |
| DELETE | `/admin/zones/:id` | `204` หรือ `409 zone_has_bookings` |
| GET | `/admin/tickets/:code` | ดูบัตรก่อนให้เข้างาน (ผู้จอง, โซน, ใบที่, ใช้แล้วหรือยัง) |
| GET | `/admin/dashboard` | `{ revenue, ticketsSold, ticketsHeld, upcomingEvents, bookingsByStatus, failReasons, topEvents, recentSales, daily }` (`daily` = 14 วันล่าสุดตามเวลาไทย) |
| GET | `/admin/events/:id/sales` | `{ event, totals, zones: [{ ..., sold, held, available, revenue, sellThrough }], daily }` |
| GET | `/admin/reports/sales.csv?from&to&eventId` | CSV ของการจองที่ชำระแล้ว (UTF-8 + BOM, กัน CSV injection) |
| POST | `/admin/tickets/check-in` | `{ code, eventId }` → `200` หรือ `409 ticket_already_used` / `409 ticket_wrong_event` / `404 ticket_not_found` |

- วันเวลาต้องมี offset เสมอ (`Z` หรือ `+07:00`)
- ลด capacity: ใน transaction เดียว `releaseExpired` → `SELECT ... FOR UPDATE` → ตรวจ → `UPDATE` โดยมี `CHECK (reserved <= capacity)` กันอีกชั้น
- ลบ: พึ่ง foreign key ของ bookings ไม่ตรวจก่อนแล้วค่อยลบ จึงไม่มี race กับ worker
- เปลี่ยนราคามีผลกับการจองใหม่เท่านั้น
- ยอดขาย: sold/revenue = CONFIRMED เท่านั้น, held = PENDING ที่ยังไม่หมดเวลา, PENDING ที่หมดเวลาแล้วนับเป็น EXPIRED (กฎข้อ 6)
- ทุกการแก้ไขล้าง `events:list`, `event:{id}`, `event:{id}:zones` และ log `admin_event_change` พร้อม `adminId`
| POST | `/bookings/:id/pay` | **mock** ชำระเงิน → `CONFIRMED` (ถ้ายังไม่หมดเวลา) และออก e-ticket ตามจำนวนที่นั่ง |
| GET | `/bookings/:id/tickets` | `{ bookingId, status, quantity, paidAt, event, zone, tickets: [{ ticketId, seq, code, checkedInAt }] }` ว่างจนกว่าจะจ่าย, ของคนอื่นได้ `404 booking_not_found` |

---

## กฎที่ต้องปฏิบัติ (ห้ามละเมิด)

1. **ห้ามรับ `userId` จาก request body** ให้ใช้จาก JWT (`req.userId`) เท่านั้น
2. **ทุก query ที่อ่านการจองต้องมีเงื่อนไข `user_id`** กันไม่ให้ดูการจองของคนอื่น
   ข้อยกเว้นเดียว: `src/services/admin*.js` ที่รวมยอดของทุกคน ใช้ได้เฉพาะผ่าน `src/routes/admin` ซึ่งบังคับ `requireAuth` + `requireAdmin` ทั้ง router
3. **รหัสผ่านเก็บเป็น bcrypt hash (cost 12)** ห้ามเก็บหรือ log รหัสผ่านตรง ๆ
4. Login ผิดให้ตอบข้อความเดียวกันเสมอ: `invalid_credentials` ไม่บอกว่าผิดที่ username หรือ password
5. **การตัดโควตาต้องทำใน transaction ด้วย conditional UPDATE** (ดูหัวข้อ Worker) ห้ามใช้วิธี SELECT แล้วค่อย UPDATE แยกกัน
6. **ความถูกต้องห้ามขึ้นกับ cron job** การจองที่หมดเวลาต้องถูกคืนโควตาทันทีเมื่อ worker ประมวลผลโซนนั้น และ query ทุกตัวต้องถือว่า `PENDING` ที่ `expires_at < now()` ไม่นับ
7. **Worker ต้อง idempotent** SQS อาจส่ง message ซ้ำหรือ worker อาจ crash กลางทาง การประมวลผลซ้ำต้องไม่ทำให้ตัดโควตาซ้ำ
8. Secret ทั้งหมด (`JWT_SECRET`, DB password) อ่านจาก env เท่านั้น ห้าม hardcode
9. Validate input ทุก route ด้วย zod

---

## Flow การจอง

### ฝั่ง API: `POST /bookings`
1. ตรวจ JWT → ได้ `userId`
2. Validate body: `quantity` 1–4, `requestId` เป็น UUID
3. ตรวจว่า zone อยู่ใน event นั้นจริง และเปิดขายแล้ว (`sale_opens_at <= now()`)
4. `SendMessage` เข้า SQS FIFO:
   ```json
   { "bookingId": "<requestId>", "requestId": "<requestId>", "userId": "...",
     "eventId": 42, "zoneId": 1, "quantity": 2, "requestedAt": "ISO-8601" }
   ```
   - `MessageGroupId = "zone-" + zoneId`
   - `MessageDeduplicationId = requestId`
5. ตอบ `202 { bookingId, status: "QUEUED" }`

### ฝั่ง Worker: ประมวลผล 1 message
ทำทั้งหมดใน transaction เดียว:

```sql
BEGIN;

-- ① Idempotency: ถ้ามี request_id นี้แล้ว → COMMIT, DeleteMessage, จบ
SELECT 1 FROM bookings WHERE request_id = $requestId;

-- ② คืนโควตาจากการจองที่หมดเวลาในโซนนี้
WITH expired AS (
  UPDATE bookings SET status = 'EXPIRED', updated_at = now()
   WHERE zone_id = $zoneId AND status = 'PENDING' AND expires_at < now()
  RETURNING quantity
)
UPDATE zones
   SET reserved = reserved - COALESCE((SELECT SUM(quantity) FROM expired), 0)
 WHERE id = $zoneId;

-- ③ จำกัดต่อ user: รวม PENDING (ยังไม่หมดเวลา) + CONFIRMED ใน event นี้ต้องไม่เกิน 4
--    ถ้าเกิน → INSERT FAILED (USER_LIMIT) → COMMIT → จบ

-- ④ ตัดโควตาแบบมีเงื่อนไข
UPDATE zones SET reserved = reserved + $qty
 WHERE id = $zoneId AND reserved + $qty <= capacity
RETURNING reserved;
--    0 แถว → INSERT FAILED (SOLD_OUT) → COMMIT → จบ

-- ⑤ บันทึกการจอง
INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, expires_at)
VALUES (..., 'PENDING', now() + interval '10 minutes');

COMMIT;
```

หลัง COMMIT:
- `DEL event:{eventId}:zones` ใน Redis
- `DeleteMessage` จาก SQS

ถ้าเกิด error ระหว่างทาง: `ROLLBACK` และ **ไม่ลบ message** ปล่อยให้ SQS ส่งกลับมาใหม่ (redrive ไป DLQ หลัง fail 5 ครั้ง)

Worker loop:
- `ReceiveMessage` ด้วย `WaitTimeSeconds=20`, `MaxNumberOfMessages=10`, `VisibilityTimeout=30`
- รองรับ graceful shutdown (SIGTERM): ทำงานที่ค้างให้เสร็จก่อนปิด

### ชำระเงิน (mock): `POST /bookings/:id/pay`
```sql
UPDATE bookings SET status = 'CONFIRMED', updated_at = now()
 WHERE id = $1 AND user_id = $2 AND status = 'PENDING' AND expires_at > now();
```
- 1 แถว → `200 { status: "CONFIRMED" }`
- 0 แถว → `409 { error: "booking_not_payable" }`
- `zones.reserved` ไม่ต้องเปลี่ยน เพราะนับไว้ตั้งแต่ PENDING แล้ว

### e-Ticket และตรวจบัตร
- จ่ายเงินแล้ว CONFIRMED + INSERT tickets ใน statement เดียว (CTE) จ่ายซ้ำหรือจ่ายพร้อมกันไม่ออกบัตรซ้ำ
- QR เก็บ URL `/admin/check-in?code=<code>` ให้เจ้าหน้าที่สแกนด้วยกล้องมือถือแล้วเปิดหน้าตรวจบัตรได้เลย
- เข้างาน: `UPDATE tickets ... WHERE code = $1 AND event_id ตรง AND CONFIRMED AND checked_in_at IS NULL` สแกนพร้อมกันหลายประตูผ่านได้ครั้งเดียว

### Cleanup: `src/jobs/expire.js`
ทำแบบเดียวกับข้อ ② แต่ทุกโซน แล้วลบ cache ของ event ที่ได้รับผลกระทบ
เป็นแค่งานเก็บกวาด รันทุก 15 นาทีได้ (บน AWS ย้ายไปเป็น Lambda + EventBridge Scheduler)

---

## Cache (Redis)

ใช้แบบ cache-aside: อ่าน Redis ก่อน ถ้าไม่มีให้ query DB แล้ว `SET key value EX ttl`

| Key | TTL | ล้างเมื่อ |
|---|---|---|
| `events:list` | 60s | admin แก้ event/zone |
| `event:{id}` | 60s | admin แก้ event/zone |
| `event:{id}:zones` | 3s | worker ตัดโควตา, cleanup คืนโควตา |

ถ้า Redis ใช้ไม่ได้ ระบบต้องยังทำงานต่อได้โดยอ่านจาก DB ตรง (log warning)

---

## Environment variables

```
PORT=3000
NODE_ENV=development
DATABASE_URL=postgres://app:app@localhost:5433/tickets   # host port 5433 (native Windows Postgres owns 5432)
REDIS_URL=redis://localhost:6379
AWS_REGION=ap-southeast-1
AWS_ENDPOINT_URL=http://localhost:4566     # local เท่านั้น (LocalStack)
AWS_ACCESS_KEY_ID=test                     # local เท่านั้น
AWS_SECRET_ACCESS_KEY=test                 # local เท่านั้น
SQS_BOOKING_QUEUE_URL=http://localhost:4566/000000000000/booking-queue.fifo
JWT_SECRET=change-me-to-a-long-random-string
BOOKING_HOLD_MINUTES=10
MAX_TICKETS_PER_USER=4
ADMIN_USERNAME=admin                       # ใช้โดย npm run seed เท่านั้น
ADMIN_PASSWORD=change-me-admin-password    # ห้าม commit ค่าจริง บน AWS ส่งผ่าน shell ตอน seed
```

---

## แผนการทำงาน (ทำทีละเฟส)

> **Claude Code: ทำทีละเฟสเท่านั้น เมื่อจบแต่ละเฟสให้รันเช็กตาม "เสร็จเมื่อ" สรุปสิ่งที่ทำ แล้วหยุดรอให้ผู้ใช้สั่งเฟสถัดไป**

### เฟส 0: ตั้งโปรเจกต์บน local
- `package.json`, `docker-compose.yml` (postgres, redis, localstack), `.env.example`
- `scripts/init-localstack.sh` สร้าง `booking-queue-dlq.fifo` และ `booking-queue.fifo` (redrive หลัง 5 ครั้ง)
- `src/config.js`, `db.js`, `redis.js`, `sqs.js`, `app.js`, `api.js`, route `/health`
- npm scripts: `dev:api`, `dev:worker`, `migrate`, `seed`, `test`
- ✅ เสร็จเมื่อ: `docker compose up -d` แล้ว `GET /health` ตอบ `{ ok: true }` และต่อ DB, Redis, SQS ได้

### เฟส 1: Database
- `migrations/001_init.sql` ตาม schema ด้านบน และสคริปต์ migrate
- `seeds/seed.sql`: 2 events, event ละ 3 zones (มีโซนหนึ่งจุแค่ 5 ใบไว้ทดสอบ sold out)
- ✅ เสร็จเมื่อ: `npm run migrate && npm run seed` ได้ข้อมูลครบ

### เฟส 2: Auth
- `/auth/register`, `/auth/login`, `middleware/auth.js`
- ✅ เสร็จเมื่อ: test ผ่าน: สมัครซ้ำได้ 409, login ผิดได้ 401 `invalid_credentials`, ไม่มี token เรียก route ป้องกันได้ 401

### เฟส 3: API อ่านข้อมูล
- `/events`, `/events/:id/zones` พร้อม cache
- ✅ เสร็จเมื่อ: test ผ่าน และ `available = capacity - reserved` ถูกต้อง

### เฟส 4: รับคำขอจอง
- `POST /bookings`, `GET /bookings/:id`, `GET /me/bookings`
- ✅ เสร็จเมื่อ: ส่งจองแล้วเห็น message ในคิว LocalStack และ `GET /bookings/:id` ตอบ `QUEUED`

### เฟส 5: Worker
- `src/services/booking.js` (logic ตาม Flow) และ `src/worker.js` (loop + graceful shutdown)
- ✅ เสร็จเมื่อ:
  - จองแล้ว poll ได้ `PENDING`
  - จองโซนที่จุ 5 ใบจนเต็ม คำขอถัดไปได้ `FAILED` / `SOLD_OUT`
  - ส่ง message เดิมซ้ำ ไม่เกิดการจองซ้ำ
  - จองเกิน 4 ใบต่อ event ได้ `FAILED` / `USER_LIMIT`

### เฟส 6: ชำระเงิน (mock) และหมดเวลา
- `POST /bookings/:id/pay`, `src/jobs/expire.js`
- ✅ เสร็จเมื่อ: จ่ายก่อนหมดเวลาได้ `CONFIRMED`, หลังหมดเวลาได้ 409, และโควตาคืนหลังหมดเวลา (ทดสอบโดยตั้ง `BOOKING_HOLD_MINUTES` ให้สั้น)

### เฟส 7: ทดสอบ
- Integration test ครอบคลุม flow หลักด้วย jest + supertest
- `load/booking-rush.js` (k6): โซนจุ 100 ใบ, 1,000 virtual users จองพร้อมกันคนละ 1 ใบ
- สคริปต์ตรวจผล: จำนวนตั๋ว `PENDING` + `CONFIRMED` ของโซนต้องเท่ากับ 100 พอดี และ `zones.reserved = 100`
- Bruno/Postman collection ครบทุก endpoint
- ✅ เสร็จเมื่อ: test ผ่านทั้งหมด และ load test ไม่มีการขายเกิน

### เฟส 8: Deploy ขึ้น AWS
- Dockerfile เดียว ใช้รันได้ทั้ง `node src/api.js` และ `node src/worker.js`
- IaC (AWS CDK หรือ Terraform): VPC 2 AZ, RDS PostgreSQL, ElastiCache Redis, SQS FIFO + DLQ, ALB (internal) + EC2 ASG สำหรับ API, EC2 ASG สำหรับ worker (scale ตามจำนวน message ในคิว), API Gateway + VPC Link, Lambda + EventBridge Scheduler สำหรับ cleanup, Secrets Manager, VPC Endpoints สำหรับ SQS และ Secrets Manager
- ตั้ง AWS Budget alert ก่อน deploy
- ✅ เสร็จเมื่อ: รัน integration test และ load test กับ URL บน AWS แล้วผ่าน

### เฟส 9: Frontend (Vite + React) บน Amplify Hosting
- `frontend/` เป็น SPA: login/register, รายการ event, เลือกโซน + จำนวน, หน้าสถานะการจอง (poll จนพ้น `QUEUED`, นับถอยหลัง, ปุ่มจ่าย mock), การจองของฉัน
- เรียก API แบบ same-origin ที่ `/api/*` เสมอ backend ไม่ต้องเปิด CORS: local ใช้ Vite proxy ส่วนบน Amplify ใช้ rewrite 200 ไปที่ `ApiUrl` (`npm run aws:amplify-rewrites` ต้องรันใหม่ทุกครั้งที่ deploy stack ใหม่)
- `requestId` สร้างครั้งเดียวต่อการจอง 1 ครั้ง ถ้า retry ด้วยโซน/จำนวนเดิมให้ใช้ค่าเดิม (idempotency)
- token เก็บใน `sessionStorage` และไม่ส่ง `userId` ไปกับ request
- ✅ เสร็จเมื่อ: `npm --prefix frontend run build` ผ่าน ไล่ flow ครบบน local (PENDING → CONFIRMED, SOLD_OUT, USER_LIMIT, หมดเวลาแล้วจ่ายได้ 409) และบน Amplify `/api/health` กับ deep link ใช้งานได้

---

### เฟส 10–15: ฟีเจอร์ที่เหลือตาม use case diagram (ไม่รวม tier สมาชิก, email, payment gateway จริง)
- **เฟส 10** role admin (`users.role`, `requireAdmin` อ่านจาก DB), `GET /me`, สร้าง admin ตอน seed
- **เฟส 11** ค้นหางานแสดง (`GET /events?q&from&to&sale&maxPrice&sort`), `GET /events/:id`, หน้า `/search`
- **เฟส 12** admin จัดการงานแสดงและโซน (`/admin/events`, `/admin/zones`)
- **เฟส 13** e-ticket + QR ออกตอนจ่ายเงิน, หน้าตรวจบัตร (`/admin/tickets/check-in`)
- **เฟส 14** dashboard ยอดขาย, ยอดขายรายงาน, CSV (`unit_price` เก็บราคาตอนจอง), `npm run seed:demo`
- **เฟส 15** Bruno ครบทุก endpoint, รัน load test ซ้ำ, เอกสาร, deploy
- ✅ เสร็จเมื่อ: test ผ่านทั้งหมด, Bruno ผ่าน, load test ไม่ขายเกิน และไล่ flow ผู้ใช้ + admin บน AWS ได้

## Coding conventions

- ใช้ `async/await` ทั้งหมด ไม่ใช้ callback
- SQL ใช้ parameterized query (`$1, $2`) เสมอ ห้ามต่อ string
- Route handler บาง ๆ ย้าย logic ไปไว้ใน `services/`
- Log เป็น JSON (เช่น `pino`) มี `requestId`/`bookingId` ในทุก log ที่เกี่ยวข้อง
- ไม่ log token, password หรือ password hash
- ตั้งชื่อ error code เป็น snake_case เช่น `invalid_credentials`, `sold_out`, `booking_not_payable`
