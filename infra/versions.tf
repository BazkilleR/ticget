terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # older providers do not know ap-southeast-7 or the nodejs24.x runtime
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Local state (infra/terraform.tfstate, gitignored): the stack is torn down after every test session.
  # The state holds the generated DB password and JWT secret, so never commit it.
}

provider "aws" {
  region = var.region

  # infra/scripts/destroy.sh looks for leftovers by this tag.
  default_tags {
    tags = { project = local.name }
  }
}
