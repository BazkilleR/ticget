#!/usr/bin/env bash
# Loads the sample data and the admin account into the AWS database without a tunnel: SSHes into a healthy API
# instance (EC2 Instance Connect) and runs scripts/seed.js in the app image with the instance's own env files.
# seed.js truncates every table, so this refuses to run when the database already has users (unless --force).
#   ADMIN_PASSWORD='<8-72 bytes>' npm run aws:seed               sample data + admin (ADMIN_USERNAME, default admin)
#   ADMIN_PASSWORD=... npm run aws:seed -- --demo                 also a week of paid bookings for the dashboard
#   ADMIN_PASSWORD=... npm run aws:seed -- --force                wipe and reseed a database that has data
#   npm run aws:seed -- --demo-only                               only add demo sales (no wipe, no password)
#   --if-empty    for aws:deploy: skip (exit 0) without ADMIN_PASSWORD or when the database has users
#   SEED_DEMO=1   same as --demo
set -euo pipefail
source "$(dirname "$0")/common.sh"

SEED=true DEMO=false FORCE=false IF_EMPTY=false
[[ "${SEED_DEMO:-}" == 1 ]] && DEMO=true
for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=true ;;
    --demo-only) SEED=false DEMO=true ;;
    --force) FORCE=true ;;
    --if-empty) IF_EMPTY=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if $SEED; then
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    if $IF_EMPTY; then
      echo "ADMIN_PASSWORD not set. Skipping the seed (run: ADMIN_PASSWORD=... npm run aws:seed)."
      exit 0
    fi
    echo "Set ADMIN_PASSWORD for the admin account." >&2
    exit 1
  fi
  # Same rule as registerSchema in src/routes/auth.js. Checked here because seed.js only validates it after
  # the tables are already wiped and reloaded.
  BYTES="$(printf %s "$ADMIN_PASSWORD" | wc -c)"
  if (( BYTES < 8 || BYTES > 72 )); then
    echo "ADMIN_PASSWORD must be 8-72 bytes (bcrypt ignores anything past 72)." >&2
    exit 1
  fi
fi

ASG="$(output ApiAsgName)"
if [[ -z "$ASG" ]]; then
  echo "No ApiAsgName Terraform output in infra/. Deploy the backend first." >&2
  exit 1
fi
TG_ARN="$(aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].TargetGroupARNs[0]' --output text)"

# A target that passes the ALB health check has finished booting, and migrations run before the app starts.
for ((i = 0; ; i++)); do
  INSTANCE_ID="$(aws elbv2 describe-target-health --region "$REGION" --target-group-arn "$TG_ARN" \
    --query "TargetHealthDescriptions[?TargetHealth.State=='healthy'].Target.Id | [0]" --output text)"
  [[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != "None" ]] && break
  if (( i >= 80 )); then
    echo "No healthy API instance after 20 minutes. Check /var/log/app-boot.log with npm run aws:ssh." >&2
    exit 1
  fi
  (( i == 0 )) && echo "Waiting for an API instance to pass the ALB health check (boot + migrate, a few minutes)..."
  sleep 15
done

eic_ssh "$INSTANCE_ID"
echo "Seeding through $INSTANCE_ID..."

# The script goes over stdin, so the admin password never shows up in a command line on either machine.
{
  printf 'SEED=%q DEMO=%q FORCE=%q IF_EMPTY=%q\n' "$SEED" "$DEMO" "$FORCE" "$IF_EMPTY"
  printf 'export ADMIN_USERNAME=%q ADMIN_PASSWORD=%q\n' "$ADMIN_USERNAME" "$ADMIN_PASSWORD"
  cat <<'REMOTE'
set -euo pipefail
IMAGE="$(docker inspect --format '{{.Config.Image}}' app)"
# The image sets NODE_ENV=production, which the seed scripts refuse. This stack is a test environment, and the
# empty-database check below is what keeps a seed from wiping real data.
run() {
  docker run --rm --network host --env-file /etc/ticget/base.env --env-file /etc/ticget/secrets.env \
    -e NODE_ENV=development -e ADMIN_USERNAME -e ADMIN_PASSWORD "$IMAGE" "$@"
}

if [[ "$SEED" == true ]]; then
  USERS="$(run node -e "require('./src/db').pool.query('SELECT count(*)::int AS n FROM users')
    .then((r) => { console.log(r.rows[0].n); process.exit(0); })" | tail -n 1)"
  if (( USERS > 0 )) && [[ "$FORCE" != true ]]; then
    if [[ "$IF_EMPTY" == true ]]; then
      echo "The database already has $USERS users. Skipping the seed."
      exit 3
    fi
    echo "The database already has $USERS users and seeding wipes every table. Add --force to do it anyway." >&2
    exit 1
  fi
  run node scripts/seed.js
fi
if [[ "$DEMO" == true ]]; then
  run node scripts/seed-demo-sales.js
fi
REMOTE
} | ssh "${SSH_OPTS[@]}" "ec2-user@$INSTANCE_ID" sudo bash -s || STATUS=$?

case "${STATUS:-0}" in
  0) if $SEED; then echo "Seed done. Admin account: $ADMIN_USERNAME"; else echo "Demo sales added."; fi ;;
  3) exit 0 ;; # skipped, the remote side said why
  *) exit "$STATUS" ;;
esac
