#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

operation="${RELEASE_OPERATION:-release}"
confirmation="${RELEASE_CONFIRMATION:-}"
allow_empty="${ALLOW_EMPTY:-false}"

case "$operation" in
  release | bootstrap | recovery) ;;
  *) release_die "unsupported release operation: ${operation}" ;;
esac
case "$allow_empty" in
  true | false) ;;
  *) release_die "ALLOW_EMPTY must be true or false" ;;
esac
if [[ "$allow_empty" == "true" && "$operation" == "bootstrap" ]]; then
  release_die "allow-empty is not valid for bootstrap because no non-empty production baseline exists"
fi

[[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] ||
  release_die "production release may run only from workflow_dispatch"
[[ "${GITHUB_REF:-}" == "refs/heads/main" ]] ||
  release_die "production release may run only from refs/heads/main"
[[ "${GITHUB_REF_TYPE:-branch}" == "branch" ]] ||
  release_die "production release must use a branch ref"

require_env SITE_URL
assert_https_origin "$SITE_URL"
expected_confirmation="${operation}:$(origin_host "$SITE_URL")"
if [[ "$allow_empty" == "true" ]]; then
  expected_confirmation="${expected_confirmation}:allow-empty"
fi
[[ "$confirmation" == "$expected_confirmation" ]] ||
  release_die "confirmation must exactly equal ${expected_confirmation}"

require_env GITHUB_TOKEN
require_env GITHUB_REPOSITORY
require_env GITHUB_API_URL
require_env VERCEL_TOKEN
require_env VERCEL_ORG_ID
require_env VERCEL_PROJECT_ID
require_env VERCEL_AUTOMATION_BYPASS_SECRET

case "$VERCEL_PROJECT_ID" in
  prj_*) ;;
  *) release_die "VERCEL_PROJECT_ID must be the immutable prj_ identifier, not a display name" ;;
esac

case "$operation" in
  bootstrap)
    [[ "${BOOTSTRAP_APPROVAL:-}" == "$SITE_URL" ]] ||
      release_die "bootstrap additionally requires the protected production environment variable BOOTSTRAP_APPROVAL=${SITE_URL}"
    ;;
  recovery)
    [[ "${RECOVERY_APPROVAL:-}" == "$SITE_URL" ]] ||
      release_die "recovery additionally requires the protected production environment variable RECOVERY_APPROVAL=${SITE_URL}"
    ;;
esac

require_command curl
require_command git
require_command jq
require_command node
require_command pnpm

project_state_file="$(mktemp)"
trap 'rm -f -- "$project_state_file"' EXIT
if ! vercel_project_json >"$project_state_file"; then
  release_die "could not read the configured Vercel project before production release"
fi
assert_vercel_alias_coordination_project "$project_state_file"

release_note "trusted production context accepted for ${operation}"
