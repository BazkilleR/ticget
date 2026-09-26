const express = require('express');
const db = require('../db');
const redis = require('../redis');
const sqs = require('../sqs');

const router = express.Router();

async function check(fn) {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'down';
  }
}

router.get('/', async (req, res) => {
  const [dbStatus, redisStatus, sqsStatus] = await Promise.all([
    check(db.ping),
    check(redis.ping),
    check(sqs.ping),
  ]);

  // Redis is only a cache, so the service is still healthy without it.
  const ok = dbStatus === 'ok' && sqsStatus === 'ok';

  res.status(ok ? 200 : 503).json({
    ok,
    checks: { db: dbStatus, redis: redisStatus, sqs: sqsStatus },
  });
});

module.exports = router;
