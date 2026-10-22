#!/usr/bin/env bash
# Points the Amplify-hosted web UI at the backend: /api/* is proxied (200 rewrite) to the API Gateway URL of
# the stack, everything else that is not a static file falls back to index.html for client-side routing.
# The Amplify app is created once in the console and kept out of Terraform (like the ECR repo), so its domain
# survives `aws:destroy`; only these rules follow the stack. `npm run aws:deploy` runs this after every apply,
# because a new stack gets a new API Gateway URL.
#   npm run aws:amplify-rewrites                            finds the app connected to this repo's GitHub remote
#   AMPLIFY_APP_ID=d1abc2xyz npm run aws:amplify-rewrites   or names it
#   AMPLIFY_REGION=us-east-1 ...                            if the Amplify app is not in Singapore
#   --if-found    skip (exit 0) when no Amplify app is connected to this repo, for deploys without the web UI
set -euo pipefail
source "$(dirname "$0")/common.sh"

IF_FOUND=false
[[ "${1:-}" == "--if-found" ]] && IF_FOUND=true

# Amplify Hosting is not offered in ap-southeast-7 (Thailand), so the app lives in Singapore, the closest region
# that has it. Visitors are served from CloudFront edges either way.
AMPLIFY_REGION="${AMPLIFY_REGION:-ap-southeast-1}"

if [[ -z "${AMPLIFY_APP_ID:-}" ]]; then
  # owner/repo from either https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
  REPO="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  if [[ -n "$REPO" ]]; then
    AMPLIFY_APP_ID="$(aws amplify list-apps --region "$AMPLIFY_REGION" --query 'apps[].[appId,repository]' \
      --output text | awk -v repo="/$REPO" '{
        url = tolower($2); sub(/\.git$/, "", url)
        if (substr(url, length(url) - length(repo) + 1) == tolower(repo)) print $1
      }')"
  fi
  if [[ -z "$AMPLIFY_APP_ID" ]]; then
    MSG="No Amplify app in $AMPLIFY_REGION is connected to ${REPO:-this repo}. Set AMPLIFY_APP_ID or AMPLIFY_REGION."
    if $IF_FOUND; then
      echo "$MSG Skipping the web UI rewrites."
      exit 0
    fi
    echo "$MSG" >&2
    exit 1
  fi
  if [[ "$AMPLIFY_APP_ID" == *[[:space:]]* ]]; then
    echo "Several Amplify apps in $AMPLIFY_REGION are connected to $REPO ($(echo $AMPLIFY_APP_ID))." \
      "Pick one with AMPLIFY_APP_ID." >&2
    exit 1
  fi
fi

API_URL="$(output ApiUrl)"
if [[ -z "$API_URL" || "$API_URL" == "None" ]]; then
  echo "No ApiUrl Terraform output in infra/. Deploy the backend first." >&2
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
