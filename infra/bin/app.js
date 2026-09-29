#!/usr/bin/env node
const cdk = require('aws-cdk-lib');
const { TicketStack } = require('../lib/ticket-stack');

const app = new cdk.App();

new TicketStack(app, 'TicketBackend', {
  description: 'Ticket booking backend (zone-based, SQS FIFO worker)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Asia Pacific (Thailand). Override with: cdk deploy -c region=ap-southeast-1
    region: app.node.tryGetContext('region') || 'ap-southeast-7',
  },
});
