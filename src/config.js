require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  SQS_BOOKING_QUEUE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  BOOKING_HOLD_MINUTES: z.coerce.number().positive().default(10),
  MAX_TICKETS_PER_USER: z.coerce.number().int().positive().default(4),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Only print which keys are invalid; never echo values (they may be secrets).
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  console.error(JSON.stringify({ level: 'fatal', msg: 'invalid environment', issues }));
  process.exit(1);
}

const env = parsed.data;

module.exports = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  aws: {
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL,
  },
  sqsBookingQueueUrl: env.SQS_BOOKING_QUEUE_URL,
  jwtSecret: env.JWT_SECRET,
  bookingHoldMinutes: env.BOOKING_HOLD_MINUTES,
  maxTicketsPerUser: env.MAX_TICKETS_PER_USER,
};
