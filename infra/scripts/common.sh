# Shared helpers for infra/scripts/*.sh. Region defaults to Asia Pacific (Thailand).
REGION="${REGION:-ap-southeast-7}"
STACK="${STACK:-TicketBackend}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Reads one CloudFormation output of the stack, e.g. `output ApiUrl`.
output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

# First InService instance of the API auto scaling group.
api_instance() {
  aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$(output ApiAsgName)" \
    --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId | [0]" --output text
}
