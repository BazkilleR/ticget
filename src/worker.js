const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const config = require('./config');
const logger = require('./logger');
const { pool } = require('./db');
const { redis } = require('./redis');
const { sqs } = require('./sqs');
const bookingService = require('./services/booking');

const RECEIVE_DEFAULTS = { waitSeconds: 20, maxMessages: 10, visibilityTimeout: 30 };

// Handles one SQS message. Deletes it only after the booking transaction has committed; on any error the
// message stays on the queue, SQS redelivers it after the visibility timeout, and after 5 failed receives
// the redrive policy moves it to the DLQ.
async function handleMessage(message) {
  let body;
  try {
    body = JSON.parse(message.Body);
  } catch {
    logger.error({ messageId: message.MessageId }, 'message body is not valid JSON');
    return false;
  }

  try {
    await bookingService.processBooking(body);
  } catch (err) {
    logger.error({ err, bookingId: body.bookingId, messageId: message.MessageId }, 'booking processing failed');
    return false;
  }

  try {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: config.sqsBookingQueueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  } catch (err) {
    // The booking is committed; a redelivery will be caught by the idempotency check, so this is harmless.
    logger.warn({ err, bookingId: body.bookingId }, 'delete message failed, it will be redelivered');
  }
  return true;
}

// One receive + process cycle. Messages are handled one at a time, in the order SQS returned them, so each
// zone's requests are served first come, first served. If a message fails, the rest of its group in this
// batch is skipped (left on the queue) so a later request cannot overtake it.
async function pollOnce({ abortSignal, ...opts } = {}) {
  const { waitSeconds, maxMessages, visibilityTimeout } = { ...RECEIVE_DEFAULTS, ...opts };

  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: config.sqsBookingQueueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitSeconds,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: ['MessageGroupId'],
    }),
    { abortSignal },
  );

  const stats = { received: 0, processed: 0, failed: 0, skipped: 0 };
  const failedGroups = new Set();

  for (const message of res.Messages || []) {
    stats.received += 1;
    const group = message.Attributes && message.Attributes.MessageGroupId;
    if (group && failedGroups.has(group)) {
      stats.skipped += 1;
      continue;
    }
    if (await handleMessage(message)) {
      stats.processed += 1;
    } else {
      stats.failed += 1;
      if (group) failedGroups.add(group);
    }
  }
  return stats;
}

async function start() {
  const abort = new AbortController();
  let stopping = false;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping: finishing current batch');
    // Cut the 20s long poll short. Messages already in hand are still processed before the loop exits.
    abort.abort();
    // Hard stop if something hangs; stays under the 30s visibility timeout.
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  logger.info({ queueUrl: config.sqsBookingQueueUrl }, 'worker started');

  while (!stopping) {
    try {
      const stats = await pollOnce({ abortSignal: abort.signal });
      if (stats.received > 0) logger.info(stats, 'batch done');
    } catch (err) {
      if (stopping) break;
      logger.error({ err }, 'receive failed, retrying in 1s');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  sqs.destroy();
  await Promise.allSettled([pool.end(), redis.quit()]);
  logger.info('worker stopped');
  process.exit(0);
}

if (require.main === module) {
  start();
}

module.exports = { pollOnce, handleMessage };
