#!/usr/bin/env bash
# Bundles the cleanup Lambda (src/jobs/expire-lambda.js) into infra/.build/expire/, which Terraform zips.
# The Node.js Lambda runtime ships the AWS SDK v3; pg-native is an optional pg dependency we do not use.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=infra/.build/expire
rm -rf "$OUT"
mkdir -p "$OUT"
npx --no-install esbuild src/jobs/expire-lambda.js --bundle --platform=node --target=node24 --format=cjs \
  '--external:@aws-sdk/*' --external:pg-native --outfile="$OUT/index.js" --log-level=warning
cp certs/rds-global-bundle.pem "$OUT/rds-global-bundle.pem"
echo "lambda bundled: $OUT ($(du -sh "$OUT" | cut -f1))"
