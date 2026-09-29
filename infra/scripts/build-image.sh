#!/usr/bin/env bash
# Builds the app image and saves it as infra/.build/image.tar.gz. CDK uploads that file as an S3 asset and
# the EC2 instances `docker load` it: no ECR, so no ECR VPC endpoints to pay for.
set -euo pipefail
cd "$(dirname "$0")/../.."

docker build --platform linux/amd64 -t ticket-backend:aws .
mkdir -p infra/.build
docker save ticket-backend:aws | gzip -1 > infra/.build/image.tar.gz
echo "image saved: infra/.build/image.tar.gz ($(du -h infra/.build/image.tar.gz | cut -f1))"
