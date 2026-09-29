#!/usr/bin/env bash
# Deletes the whole stack (VPC, EC2, RDS without a final snapshot, Redis, ALB, API Gateway, SQS, Lambda...)
# and waits until it is gone, then lists anything tagged project=ticket-backend that is still around.
# Uses CloudFormation directly, so it works even without a local build of the app image.
set -euo pipefail
source "$(dirname "$0")/common.sh"

if ! aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1; then
  echo "Stack $STACK does not exist in $REGION. Nothing to delete."
  exit 0
fi

echo "Deleting $STACK in $REGION. This takes 10-30 minutes (RDS, and Lambda network interfaces are slow)."
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"
echo "Stack deleted."

LEFT="$(aws resourcegroupstaggingapi get-resources --region "$REGION" --tag-filters Key=project,Values=ticket-backend \
  --query 'ResourceTagMappingList[].ResourceARN' --output text)"
if [ -n "$LEFT" ]; then
  echo "Still tagged project=ticket-backend (secrets stay 'pending deletion' for a few days; these cost ~nothing):"
  echo "$LEFT" | tr '\t' '\n'
fi
