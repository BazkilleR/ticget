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
