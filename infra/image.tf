# The app image lives in ECR (repository ticget-backend, created and pushed by `npm run aws:build-image`,
# outside this stack so it survives `aws:destroy`). The instances pull it through the ecr.api / ecr.dkr
# interface endpoints, and the layers come from S3 through the gateway endpoint: no NAT needed.

variable "image_uri" {
  description = "App image by digest, e.g. <account>.dkr.ecr.<region>.amazonaws.com/ticget-backend@sha256:... Written to image.auto.tfvars by build-image.sh."
  type        = string
  default     = "" # empty is fine for `terraform destroy`; the launch template precondition guards apply
}

data "aws_caller_identity" "current" {}

locals {
  ecr_repository_arn = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/${local.name}"
}
