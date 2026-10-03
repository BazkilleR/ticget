#!/usr/bin/env bash
# Points the Amplify-hosted web UI at the backend: /api/* is proxied (200 rewrite) to the API Gateway URL of
# the stack, everything else that is not a static file falls back to index.html for client-side routing.
# Run again after every fresh `npm run aws:deploy`, because a new stack gets a new API Gateway URL.
#   AMPLIFY_APP_ID=d1abc2xyz npm run aws:amplify-rewrites
#   AMPLIFY_REGION=us-east-1 ...   if the Amplify app is not in Singapore
set -euo pipefail
source "$(dirname "$0")/common.sh"

: "${AMPLIFY_APP_ID:?set AMPLIFY_APP_ID (Amplify console > App settings > General)}"
# Amplify Hosting is not offered in ap-southeast-7 (Thailand), so the app lives in Singapore, the closest region
# that has it. Visitors are served from CloudFront edges either way.
AMPLIFY_REGION="${AMPLIFY_REGION:-ap-southeast-1}"

API_URL="$(output ApiUrl)"
if [[ -z "$API_URL" || "$API_URL" == "None" ]]; then
  echo "No ApiUrl output on stack $STACK in $REGION. Deploy the backend first." >&2
  exit 1
fi

# Order matters: Amplify applies the first matching rule, so the API proxy must come before the SPA fallback.
RULES="$(node -e '
  const api = process.argv[1].replace(/\/$/, "");
  console.log(JSON.stringify([
    { source: "/api/<*>", target: `${api}/<*>`, status: "200" },
    {
      source: "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
      target: "/index.html",
      status: "200",
    },
  ]));
' "$API_URL")"

aws amplify update-app --region "$AMPLIFY_REGION" --app-id "$AMPLIFY_APP_ID" --custom-rules "$RULES" \
  --query 'app.customRules' --output table
echo "Amplify app $AMPLIFY_APP_ID now proxies /api/* to $API_URL"
