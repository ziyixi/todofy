#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

gate_state=""
baseline_out=""

while (($#)); do
  case "$1" in
    --gate-state) gate_state="${2:-}"; shift 2 ;;
    --baseline-out) baseline_out="${2:-}"; shift 2 ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

[[ -n "$gate_state" && -n "$baseline_out" ]] ||
  release_die "--gate-state and --baseline-out are required"
require_file "$gate_state"
require_env SITE_URL
require_env GITHUB_TOKEN
require_env GITHUB_REPOSITORY
require_env GITHUB_API_URL
require_env VERCEL_TOKEN
require_env VERCEL_ORG_ID
require_env VERCEL_PROJECT_ID
require_command jq
require_command pnpm
assert_https_origin "$SITE_URL"

jq -e '
  .schemaVersion == 1 and
  (.blocking | type == "object") and
  (.blocking.deploymentId | type == "string" and length > 0) and
  (.blocking.state | type == "string") and
  (.blocking.payload | type == "object") and
  (.baseline == null or
    ((.baseline.deploymentId | type == "string" and length > 0) and
     (.baseline.payload | type == "object")))
' "$gate_state" >/dev/null || release_die "recovery gate state is incomplete"

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

# The recovery decision must be made only after all earlier asynchronous alias
# changes have settled. A status timeout leaves the gate blocked for an operator.
wait_for_vercel_mutations
vercel_deployment_json "$SITE_URL" >"${temp_dir}/current.json"
assert_vercel_deployment "${temp_dir}/current.json" "" production
current_id="$(jq -er '.id' "${temp_dir}/current.json")"

blocking_state="$(jq -er '.blocking.state' "$gate_state")"
blocking_candidate_id="$(jq -er '.blocking.payload.candidateDeploymentId' "$gate_state")"
baseline_candidate_id="$(jq -r '.baseline.payload.candidateDeploymentId // empty' "$gate_state")"

verify_recorded_production() {
  local payload_filter="$1"
  local expected_id="$2"
  jq "${payload_filter}.identity" "$gate_state" >"${temp_dir}/expected-build-info.json"
  jq "${payload_filter}.verificationContract" "$gate_state" >"${temp_dir}/verification-contract.json"
  assert_build_info_file "${temp_dir}/expected-build-info.json"
  bash "${script_dir}/verify-deployment.sh" \
    --mode production \
    --base-url "$SITE_URL" \
    --expected-build-info "${temp_dir}/expected-build-info.json" \
    --expected-deployment-id "$expected_id" \
    --verification-contract "${temp_dir}/verification-contract.json"
}

if [[ "$current_id" == "$blocking_candidate_id" ]]; then
  case "$blocking_state" in
    in_progress | error | failure) ;;
    *) release_die "production serves a blocked candidate with unsupported recovery state ${blocking_state}" ;;
  esac
  if [[ -n "$baseline_candidate_id" ]]; then
    jq -e --arg baseline_id "$baseline_candidate_id" '
      .blocking.payload.previousProductionDeploymentId == $baseline_id
    ' "$gate_state" >/dev/null ||
      release_die "blocked candidate does not descend from the trusted recovery baseline"
  else
    jq -e '.blocking.payload.previousProductionDeploymentId == null' "$gate_state" >/dev/null ||
      release_die "blocked candidate unexpectedly names a previous production deployment"
  fi

  # A failed production check can leave the candidate live, particularly on
  # bootstrap when no earlier trusted deployment exists. After the underlying
  # problem is repaired, prove its immutable ID, complete identity, and recorded
  # route contract before establishing it as the recovery baseline.
  verify_recorded_production '.blocking.payload' "$blocking_candidate_id"
  blocking_deployment_id="$(jq -er '.blocking.deploymentId' "$gate_state")"
  bash "${script_dir}/deployment-record.sh" status \
    --deployment-id "$blocking_deployment_id" \
    --state success \
    --environment-url "$SITE_URL" \
    --description "Recovered after production identity and routes were reverified"

  jq '
    .blocking.state = "success" |
    .baseline = {
      deploymentId: .blocking.deploymentId,
      payload: .blocking.payload
    }
  ' "$gate_state" >"${temp_dir}/reconciled-gate-state.json"
  mv -- "${temp_dir}/reconciled-gate-state.json" "$gate_state"
  mkdir -p "$(dirname -- "$baseline_out")"
  jq '.baseline.payload.contentRegistry' "$gate_state" >"$baseline_out"
  write_github_output reconciled_existing true
  release_note "reconciled verified production candidate ${blocking_candidate_id} with its existing GitHub Deployment record"
elif [[ -n "$baseline_candidate_id" && "$current_id" == "$baseline_candidate_id" ]]; then
  verify_recorded_production '.baseline.payload' "$baseline_candidate_id"
  mkdir -p "$(dirname -- "$baseline_out")"
  jq '.baseline.payload.contentRegistry' "$gate_state" >"$baseline_out"
  write_github_output reconciled_existing false
  release_note "confirmed that production still serves the earlier trusted recovery baseline ${baseline_candidate_id}"
else
  release_die "production deployment ${current_id} matches neither the blocked candidate nor the trusted recovery baseline"
fi

previous_id="$(jq -er '.baseline.payload.candidateDeploymentId' "$gate_state")"
previous_url="$(jq -er '.baseline.payload.candidateDeploymentUrl' "$gate_state")"
baseline_deployment_id="$(jq -er '.baseline.deploymentId' "$gate_state")"
write_github_output previous_production_id "$previous_id"
write_github_output previous_production_url "$previous_url"
write_github_output baseline_deployment_id "$baseline_deployment_id"
