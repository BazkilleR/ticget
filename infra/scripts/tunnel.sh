#!/usr/bin/env bash
# SSH into an API instance through the EC2 Instance Connect Endpoint (no public IPs, no bastion).
#   npm run aws:tunnel   localhost:15432 -> RDS PostgreSQL, localhost:16379 -> ElastiCache Redis
#                        Keep it open in its own terminal; Ctrl+C closes it. EIC tunnels last up to 1 hour.
#   npm run aws:ssh      interactive shell (sudo docker logs app, /var/log/app-boot.log)
set -euo pipefail
source "$(dirname "$0")/common.sh"

INSTANCE_ID="$(api_instance)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "No InService API instance yet. Check: aws autoscaling describe-auto-scaling-groups --region $REGION" >&2
  exit 1
fi

# One-off key pair; EC2 Instance Connect accepts the public key for 60 seconds.
KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$KEY_DIR/key"
aws ec2-instance-connect send-ssh-public-key --region "$REGION" --instance-id "$INSTANCE_ID" \
  --instance-os-user ec2-user --ssh-public-key "file://$KEY_DIR/key.pub" >/dev/null

SSH_OPTS=(
  -i "$KEY_DIR/key"
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30
  -o "ProxyCommand=aws ec2-instance-connect open-tunnel --region $REGION --instance-id %h"
)

if [ "${1:-}" = "shell" ]; then
  exec ssh "${SSH_OPTS[@]}" "ec2-user@$INSTANCE_ID"
fi

echo "Tunnel via $INSTANCE_ID: localhost:15432 -> PostgreSQL, localhost:16379 -> Redis. Ctrl+C to close."
exec ssh "${SSH_OPTS[@]}" -N -L "15432:$(output DbEndpoint):5432" -L "16379:$(output RedisEndpoint):6379" \
  "ec2-user@$INSTANCE_ID"
