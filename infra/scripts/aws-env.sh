#!/usr/bin/env bash
# Prints `export` lines that point the local npm scripts (migrate, seed, load:prepare, load:verify) at the
# AWS database and Redis through `npm run aws:tunnel`. Secrets come from Secrets Manager and are only
# printed to your terminal, never written to a file.
#   eval "$(npm run -s aws:env)"
set -euo pipefail
source "$(dirname "$0")/common.sh"

secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

DB_SECRET="$(secret "$(output DbSecretArn)")"
JWT_SECRET="$(secret "$(output JwtSecretArn)")"
DB_USER="$(node -pe 'encodeURIComponent(JSON.parse(process.argv[1]).username)' "$DB_SECRET")"
DB_PASS="$(node -pe 'encodeURIComponent(JSON.parse(process.argv[1]).password)' "$DB_SECRET")"

# Through the tunnel the host is localhost, so verify the certificate chain against the RDS CA but not the
# hostname (verify-ca). On AWS itself the app uses verify-full.
CA="$REPO_ROOT/certs/rds-global-bundle.pem"
echo "export DATABASE_URL='postgres://$DB_USER:$DB_PASS@localhost:15432/tickets?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=$CA'"
echo "export REDIS_URL='redis://localhost:16379'"
echo "export JWT_SECRET='$JWT_SECRET'"
echo "export AWS_REGION='$REGION'"
echo "export SQS_BOOKING_QUEUE_URL='$(output QueueUrl)'"
# Do not export AWS_ENDPOINT_URL: the AWS CLI and SDKs apply it to every service. .env's LocalStack value
# still gets loaded inside node, but the scripts run through the tunnel never call SQS.
echo "export API_URL='$(output ApiUrl)'"
echo "echo 'Environment now points at AWS ($STACK in $REGION). Open a new terminal to go back to local.'"
