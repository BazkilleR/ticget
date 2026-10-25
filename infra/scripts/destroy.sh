#!/usr/bin/env bash
# Deletes the whole stack (VPC, EC2, RDS without a final snapshot, Redis, ALB, API Gateway, SQS, Lambda...)
# with `terraform destroy`, then lists anything tagged project=ticget-backend that is still around.
# Works without a local build of the app image; the Lambda bundle is rebuilt if missing (archive_file needs it).
set -euo pipefail
source "$(dirname "$0")/common.sh"

if [ -z "$("${TF[@]}" state list 2>/dev/null)" ]; then
  echo "No Terraform state in infra/. Nothing to delete."
  exit 0
fi

[ -d "$REPO_ROOT/infra/.build/expire" ] || bash "$REPO_ROOT/infra/scripts/build-lambda.sh"

echo "Deleting the stack in $REGION. This takes 10-30 minutes (RDS, and Lambda network interfaces are slow)."
"${TF[@]}" destroy -auto-approve
echo "Stack deleted."

LEFT="$(aws resourcegroupstaggingapi get-resources --region "$REGION" --tag-filters Key=project,Values=ticget-backend \
  --query 'ResourceTagMappingList[].ResourceARN' --output text)"
if [ -n "$LEFT" ]; then
  echo "Still tagged project=ticget-backend (recently deleted resources can linger in this list for a while):"
  echo "$LEFT" | tr '\t' '\n'
fi
