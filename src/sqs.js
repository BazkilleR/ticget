const { SQSClient, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const config = require('./config');

// Credentials come from the default provider chain (env vars locally, IAM role on AWS).
const sqs = new SQSClient({
  region: config.aws.region,
  ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
});

async function ping() {
  await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: config.sqsBookingQueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
}

module.exports = { sqs, ping };
