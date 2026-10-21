#!/usr/bin/env bash
# Builds the app image and pushes it to ECR, then writes its digest URI to infra/image.auto.tfvars for
# `terraform apply`. A new digest makes a new launch template version, which rolls the instances.
#
# The repository lives outside Terraform: it is created here on the first run and survives `aws:destroy`,
# so later pushes only upload the layers that changed (usually just src/). Tags are immutable and named
# after the image ID, so the same build is never pushed twice.
set -euo pipefail
source "$(dirname "$0")/common.sh"

REPO=ticket-backend
LOCAL_TAG=ticket-backend:aws

if ! aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1; then
  aws ecr create-repository --region "$REGION" --repository-name "$REPO" \
    --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true >/dev/null
  # Untagged images go after a day; only the 10 newest builds are kept.
  aws ecr put-lifecycle-policy --region "$REGION" --repository-name "$REPO" --lifecycle-policy-text '{"rules":[
    {"rulePriority":1,"description":"untagged","selection":{"tagStatus":"untagged","countType":"sinceImagePushed","countUnit":"days","countNumber":1},"action":{"type":"expire"}},
    {"rulePriority":2,"description":"keep 10","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}
  ]}' >/dev/null
  echo "created ECR repository $REPO in $REGION"
fi

docker build --platform linux/amd64 -t "$LOCAL_TAG" "$REPO_ROOT"
TAG="img-$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG" | cut -d: -f2 | cut -c1-12)"

describe() {
  aws ecr describe-images --region "$REGION" --repository-name "$REPO" --image-ids imageTag="$TAG" \
    --query 'imageDetails[0].imageDigest' --output text
}

REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com"
if describe >/dev/null 2>&1; then
  echo "$REPO:$TAG is already in ECR, nothing to push"
else
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
  docker tag "$LOCAL_TAG" "$REGISTRY/$REPO:$TAG"
  docker push "$REGISTRY/$REPO:$TAG"
fi

IMAGE_URI="$REGISTRY/$REPO@$(describe)"
echo "image_uri = \"$IMAGE_URI\"" > "$REPO_ROOT/infra/image.auto.tfvars"
echo "image: $IMAGE_URI"
