#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

candidate_url=""
candidate_id=""
expected_build_info=""
previous_production_id=""
gate_state=""
github_deployment_id=""

while (($#)); do
  case "$1" in
    --candidate-url) candidate_url="${2:-}"; shift 2 ;;
    --candidate-id) candidate_id="${2:-}"; shift 2 ;;
    --expected-build-info) expected_build_info="${2:-}"; shift 2 ;;
    --previous-production-id) previous_production_id="${2:-}"; shift 2 ;;
    --gate-state) gate_state="${2:-}"; shift 2 ;;
    --github-deployment-id) github_deployment_id="${2:-}"; shift 2 ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

[[ -n "$candidate_url" && -n "$candidate_id" && -n "$expected_build_info" && -n "$gate_state" && -n "$github_deployment_id" ]] ||
  release_die "candidate URL/ID, build info, gate state, and GitHub Deployment ID are required"
assert_deployment_url "$candidate_url"
[[ "$candidate_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid candidate deployment ID"
[[ "$github_deployment_id" =~ ^[0-9]+$ ]] || release_die "invalid GitHub Deployment ID"
if [[ -n "$previous_production_id" ]]; then
  [[ "$previous_production_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid previous production deployment ID"
  [[ "$candidate_id" != "$previous_production_id" ]] || release_die "candidate and previous production deployment IDs must differ"
fi
require_file "$gate_state"
assert_build_info_file "$expected_build_info"
require_env RELEASE_SHA
require_env SITE_URL
require_env GITHUB_TOKEN
require_env GITHUB_REPOSITORY
require_env GITHUB_API_URL
require_env VERCEL_TOKEN
require_env VERCEL_ORG_ID
require_env VERCEL_PROJECT_ID
require_command git
require_command jq
require_command pnpm

[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || release_die "RELEASE_SHA must be a full lowercase commit SHA"
[[ "$(git rev-parse HEAD)" == "$RELEASE_SHA" ]] || release_die "checked-out commit changed after the release lock was acquired"
remote_main_sha="$(github_api GET /git/ref/heads/main | jq -er '.object.sha')"
[[ "$remote_main_sha" == "$RELEASE_SHA" ]] ||
  release_die "main advanced after candidate creation; refusing to promote a stale artifact"

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

# Recheck the exact staged production artifact immediately before the alias move.
bash "${script_dir}/verify-deployment.sh" \
  --mode candidate \
  --base-url "$candidate_url" \
  --expected-build-info "$expected_build_info" \
  --expected-deployment-id "$candidate_id" \
  --identity-only

if [[ -n "$previous_production_id" ]]; then
  jq '.baseline.payload.identity' "$gate_state" >"${temp_dir}/previous-build-info.json"
  assert_build_info_file "${temp_dir}/previous-build-info.json"
  bash "${script_dir}/verify-deployment.sh" \
    --mode production \
    --base-url "$SITE_URL" \
    --expected-build-info "${temp_dir}/previous-build-info.json" \
    --expected-deployment-id "$previous_production_id" \
    --identity-only
else
  jq -e '.baseline == null' "$gate_state" >/dev/null ||
    release_die "only a true bootstrap gate may omit the previous production deployment"
fi

github_api GET "/deployments/${github_deployment_id}" >"${temp_dir}/github-deployment.json"
jq '.payload | if type == "string" then fromjson else . end' \
  "${temp_dir}/github-deployment.json" >"${temp_dir}/github-payload.json"
jq -e \
  --arg candidate_id "$candidate_id" \
  --slurpfile identity "$expected_build_info" '
    .candidateDeploymentId == $candidate_id and
    .identity.codeSha == $identity[0].codeSha and
    .identity.contentHash == $identity[0].contentHash and
    .identity.configHash == $identity[0].configHash and
    .identity.schemaVersion == $identity[0].schemaVersion
  ' "${temp_dir}/github-payload.json" >/dev/null ||
  release_die "GitHub Deployment record does not describe this candidate artifact"
latest_state="$(
  github_api_all_pages "/deployments/${github_deployment_id}/statuses" |
    sort_github_records_newest_first |
    jq -er 'if length == 0 then "missing" else .[0].state end'
)"
[[ "$latest_state" == "in_progress" ]] ||
  release_die "GitHub Deployment must be in_progress immediately before promote"

# A CLI timeout does not cancel the platform-side mutation. First ensure no
# earlier mutation is pending, then always reconcile the operation status and
# the canonical domain before treating the request as either success or failure.
wait_for_vercel_mutations
promote_exit=0
pnpm exec vercel promote "$candidate_url" \
  --yes \
  --timeout=5m \
  --token "$VERCEL_TOKEN" || promote_exit=$?
if ((promote_exit != 0)); then
  release_note "promotion command exited ${promote_exit}; result is unknown until status and production identity are reconciled"
fi
wait_for_vercel_operation promote "$candidate_id"

bash "${script_dir}/verify-deployment.sh" \
  --mode production \
  --base-url "$SITE_URL" \
  --expected-build-info "$expected_build_info" \
  --expected-deployment-id "$candidate_id" \
  --identity-only

write_github_output promoted_deployment_id "$candidate_id"
release_note "promotion settled on the verified artifact ${candidate_id}"
