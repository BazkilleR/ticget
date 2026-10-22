# Shared helpers for infra/scripts/*.sh.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF=(terraform -chdir="$REPO_ROOT/infra")

# Reads one Terraform output of the stack, e.g. `output ApiUrl`. Empty if it does not exist (not deployed).
output() {
  "${TF[@]}" output -raw "$1" 2>/dev/null || true
}

# Region the stack was deployed to. Defaults to Asia Pacific (Thailand).
REGION="${REGION:-$(output Region)}"
REGION="${REGION:-ap-southeast-7}"

# First InService instance of the API auto scaling group.
api_instance() {
  aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$(output ApiAsgName)" \
    --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId | [0]" --output text
}

# Fills SSH_OPTS for `ssh "${SSH_OPTS[@]}" ec2-user@<instance id>` through the EC2 Instance Connect Endpoint
# (no public IPs, no bastion) with a one-off key pair. EC2 Instance Connect accepts the public key for 60 seconds.
eic_ssh() {
  local instance_id="$1"
  KEY_DIR="$(mktemp -d)"
  trap 'rm -rf "$KEY_DIR"' EXIT
  ssh-keygen -q -t ed25519 -N '' -f "$KEY_DIR/key"
  aws ec2-instance-connect send-ssh-public-key --region "$REGION" --instance-id "$instance_id" \
    --instance-os-user ec2-user --ssh-public-key "file://$KEY_DIR/key.pub" >/dev/null
  SSH_OPTS=(
    -i "$KEY_DIR/key"
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30
    -o "ProxyCommand=aws ec2-instance-connect open-tunnel --region $REGION --instance-id %h"
  )
}
