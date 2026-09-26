#!/bin/bash
# Runs inside the LocalStack container once it is ready.
# Creates the booking FIFO queue and its dead-letter queue (redrive after 5 failed receives).
set -euo pipefail

REGION=ap-southeast-1

DLQ_URL=$(awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name booking-queue-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name booking-queue.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

echo "SQS queues ready: booking-queue.fifo -> booking-queue-dlq.fifo"
