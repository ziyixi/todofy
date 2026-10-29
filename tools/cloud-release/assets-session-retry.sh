#!/usr/bin/env bash
# Runs a production `wrangler deploy` and repeats it only when the Workers Assets API failed to open the asset
# upload session with its generic internal error (HTTP 500, code 10013). wrangler sends that request before any
# asset, Worker version, secret or route reaches Cloudflare and never retries it itself, so production is unchanged
# and the identical deploy is safe to repeat. Every other failure, and this one a third time, fails as before.
set -u
(( $# > 0 )) || { echo 'usage: assets-session-retry.sh <deploy command...>' >&2; exit 2; }
output=$(mktemp)
trap 'rm -f "$output"' EXIT
for pause in 60 180 ''; do
  "$@" 2>&1 | tee "$output"
  status=${PIPESTATUS[0]}
  if (( status == 0 )) || [ -z "$pause" ] \
    || ! grep -F -A 2 '/assets-upload-session) failed.' "$output" | grep -qF '[code: 10013]'; then
    exit "$status"
  fi
  echo "Cloudflare did not open the asset upload session (code 10013); nothing was deployed. Retrying in ${pause}s." >&2
  sleep "$pause"
done
