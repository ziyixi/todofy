#!/usr/bin/env bash
# Read deployment identity without printing Wrangler's private JSON responses.
set -euo pipefail
worker=${1:?worker required}
config=${2:?config required}
d1=${3:-}
[[ $# -le 3 && "$worker" =~ ^[a-z0-9-]+$ && "$config" == *wrangler.toml ]]
[[ -z "$d1" || "$d1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
test -n "${CLOUDFLARE_API_TOKEN:-}"
test -n "${GITHUB_SHA:-}"
deployment=$(npx --no-install wrangler deployments status --json --config "$config" 2>/dev/null) || {
  echo "Could not read the deployment of the Worker $worker." >&2
  exit 1
}
version=$(jq -er '.versions | select(length == 1 and .[0].percentage == 100) | .[0].version_id' <<<"$deployment" 2>/dev/null) || {
  echo "The deployment does not serve exactly one version at 100%." >&2
  exit 1
}
# An API response cannot become a Wrangler flag or unsafe log text.
[[ "$version" =~ ^[a-zA-Z0-9-]+$ ]] || { echo 'Invalid deployed version identifier.' >&2; exit 1; }
details=$(npx --no-install wrangler versions view "$version" --json --config "$config" 2>/dev/null) || {
  echo "Could not read the deployed version." >&2
  exit 1
}
build=$(jq -er '[.resources.bindings[] | select(.name == "BUILD_SHA" and .type == "plain_text") | .text] | select(length == 1) | .[0]' <<<"$details" 2>/dev/null) || build=''
if [ "$build" != "$GITHUB_SHA" ]; then
  echo "The deployed version $version was not built from $GITHUB_SHA." >&2
  exit 1
fi
echo "The Worker $worker serves version $version at 100%, built from $GITHUB_SHA."
if [ -n "$d1" ]; then
  pending=$(npx --no-install wrangler d1 migrations list "$d1" --remote --config "$config" 2>/dev/null) || {
    echo "Could not list the D1 migrations." >&2
    exit 1
  }
  if ! grep -q 'No migrations to apply' <<<"$pending"; then
    echo 'D1 migrations are still pending.' >&2
    exit 1
  fi
  echo 'No D1 migration is pending.'
fi
