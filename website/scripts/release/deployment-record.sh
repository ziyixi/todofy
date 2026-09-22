#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

require_env GITHUB_TOKEN
require_env GITHUB_REPOSITORY
require_env GITHUB_API_URL
require_command curl
require_command jq

task_name="website-release"
environment_name="production"

usage() {
  cat >&2 <<'EOF'
Usage:
  deployment-record.sh gate --operation release|bootstrap|recovery \
    --baseline-out PATH --state-out PATH [--bootstrap-baseline PATH]
  deployment-record.sh create --payload PATH --ref SHA
  deployment-record.sh status --deployment-id ID --state STATE \
    [--environment-url HTTPS_ORIGIN] [--description TEXT]
  deployment-record.sh find-candidate --candidate-id dpl_ID --state-out PATH
EOF
  exit 2
}

deployment_payload() {
  jq -c '.payload | if type == "string" then fromjson else . end' <<<"$1" 2>/dev/null ||
    release_die "GitHub Deployment payload is not valid JSON"
}

validate_payload_file() {
  local path="$1"
  require_file "$path"
  local bytes
  bytes="$(wc -c <"$path" | tr -d ' ')"
  ((bytes <= 60000)) || release_die "GitHub Deployment payload exceeds the 60 KB safety limit"
  jq -e \
    --arg task "$task_name" '
      type == "object" and
      .schemaVersion == 2 and
      .task == $task and
      (.identity.codeSha | type == "string" and length >= 7) and
      (.identity.contentHash | type == "string" and length >= 16) and
      (.identity.configHash | type == "string" and length >= 16) and
      (.identity.schemaVersion != null) and
      (.candidateDeploymentId | type == "string" and startswith("dpl_")) and
      (.candidateDeploymentUrl | type == "string" and startswith("https://")) and
      (.contentRegistry | type == "object") and
      (.verificationContract.canonicalOrigin | type == "string" and startswith("https://")) and
      (.verificationContract.emptyStateText | type == "string" and length > 0) and
      (.verificationContract.sourceMode == "empty" or .verificationContract.sourceMode == "notion") and
      (.verificationContract.routes | type == "array") and
      all(.verificationContract.routes[];
        (.path | type == "string" and startswith("/")) and
        (.expectedStatus | type == "number") and
        (.kind | type == "string") and
        (if .kind == "redirect" then
          .expectedStatus == 308 and
          (.expectedLocation | type == "string" and startswith("/") and (startswith("//") | not))
        elif .kind == "asset" then
          .expectedStatus == 200 and
          (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
          (.sizeBytes | type == "number" and . >= 0) and
          (.mimeType | type == "string" and test("^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$"))
        elif .kind == "absent" then .expectedStatus == 404
        else .expectedStatus == 200
        end)
      )
    ' "$path" >/dev/null || release_die "invalid website-release Deployment payload"
  assert_https_origin "$(jq -er '.verificationContract.canonicalOrigin' "$path")"
}

latest_status_json() {
  local deployment_id="$1"
  github_api_all_pages "/deployments/${deployment_id}/statuses" |
    sort_github_records_newest_first
}

latest_status_name() {
  local deployment_id="$1"
  latest_status_json "$deployment_id" | jq -er 'if length == 0 then "missing" else .[0].state end'
}

fetch_deployments() {
  github_api_all_pages "/deployments?environment=${environment_name}&task=${task_name}" |
    sort_github_records_newest_first
}

write_gate_state() {
  local state_out="$1"
  local blocking_deployment="$2"
  local blocking_state="$3"
  local baseline_deployment="$4"
  local payload_path="$5"
  local blocking_payload_path="${6:-}"
  local blocking_payload="null"

  if [[ -n "$blocking_payload_path" ]]; then
    require_file "$blocking_payload_path"
    blocking_payload="$(jq -c . "$blocking_payload_path")"
  fi

  mkdir -p "$(dirname -- "$state_out")"
  if [[ -n "$payload_path" ]]; then
    jq -n \
      --argjson schemaVersion 1 \
      --arg blockingDeploymentId "$blocking_deployment" \
      --arg blockingState "$blocking_state" \
      --arg baselineDeploymentId "$baseline_deployment" \
      --argjson blockingPayload "$blocking_payload" \
      --slurpfile baselinePayload "$payload_path" '
        {
          schemaVersion: $schemaVersion,
          blocking: {
            deploymentId: $blockingDeploymentId,
            state: $blockingState,
            payload: $blockingPayload
          },
          baseline: {
            deploymentId: $baselineDeploymentId,
            payload: $baselinePayload[0]
          }
        }
      ' >"$state_out"
  else
    jq -n \
      --argjson schemaVersion 1 \
      --arg blockingDeploymentId "$blocking_deployment" \
      --arg blockingState "$blocking_state" \
      --argjson blockingPayload "$blocking_payload" '
        {
          schemaVersion: $schemaVersion,
          blocking: {
            deploymentId: ($blockingDeploymentId | select(length > 0) // null),
            state: $blockingState,
            payload: $blockingPayload
          },
          baseline: null
        }
      ' >"$state_out"
  fi
}

gate_command() {
  local operation=""
  local baseline_out=""
  local state_out=""
  local bootstrap_baseline=""

  while (($#)); do
    case "$1" in
      --operation) operation="${2:-}"; shift 2 ;;
      --baseline-out) baseline_out="${2:-}"; shift 2 ;;
      --state-out) state_out="${2:-}"; shift 2 ;;
      --bootstrap-baseline) bootstrap_baseline="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done

  case "$operation" in
    release | bootstrap | recovery) ;;
    *) usage ;;
  esac
  [[ -n "$baseline_out" && -n "$state_out" ]] || usage

  local temp_dir deployments count latest_row latest_id latest_state
  temp_dir="$(mktemp -d)"
  trap "rm -rf -- '$temp_dir'" EXIT
  deployments="$(fetch_deployments)"
  jq -e 'type == "array"' <<<"$deployments" >/dev/null ||
    release_die "GitHub Deployments API returned an unexpected response"
  count="$(jq 'length' <<<"$deployments")"

  if [[ "$operation" == "bootstrap" ]]; then
    ((count == 0)) || release_die "bootstrap is allowed only when no website-release Deployment record exists"
    [[ -n "$bootstrap_baseline" ]] || release_die "bootstrap requires --bootstrap-baseline"
    require_file "$bootstrap_baseline"
    mkdir -p "$(dirname -- "$baseline_out")"
    cp -- "$bootstrap_baseline" "$baseline_out"
    write_gate_state "$state_out" "" "none" "" ""
    write_github_output baseline_deployment_id ""
    write_github_output previous_production_id ""
    release_note "bootstrap gate accepted: no prior website-release record exists"
    return
  fi

  ((count > 0)) || release_die "no website-release record exists; use the explicit bootstrap operation"
  latest_row="$(jq -c '.[0]' <<<"$deployments")"
  latest_id="$(jq -er '.id | tostring' <<<"$latest_row")"
  latest_state="$(latest_status_name "$latest_id")"

  if [[ "$operation" == "recovery" ]]; then
    deployment_payload "$latest_row" >"${temp_dir}/latest-payload.json"
    validate_payload_file "${temp_dir}/latest-payload.json"
  fi

  local baseline_row=""
  local baseline_id=""
  local blocking_payload_path=""
  if [[ "$operation" == "release" ]]; then
    [[ "$latest_state" == "success" ]] ||
      release_die "latest website-release state is ${latest_state}; only recovery may cross this gate"
    baseline_row="$latest_row"
    baseline_id="$latest_id"
  else
    [[ "$latest_state" != "success" ]] ||
      release_die "recovery requires a failed, errored, missing, or stuck latest record; use release for a healthy state"

    local index candidate_row candidate_id candidate_state
    for ((index = 1; index < count; index++)); do
      candidate_row="$(jq -c ".[$index]" <<<"$deployments")"
      candidate_id="$(jq -er '.id | tostring' <<<"$candidate_row")"
      candidate_state="$(latest_status_name "$candidate_id")"
      if [[ "$candidate_state" == "success" ]]; then
        baseline_row="$candidate_row"
        baseline_id="$candidate_id"
        break
      fi
    done
    if [[ -z "$baseline_row" ]]; then
      if jq -e '
        (.operation == "bootstrap" or .operation == "recovery") and
        .previousProductionDeploymentId == null
      ' "${temp_dir}/latest-payload.json" >/dev/null; then
        [[ -n "$bootstrap_baseline" ]] ||
          release_die "failed-bootstrap recovery requires --bootstrap-baseline"
        require_file "$bootstrap_baseline"
        mkdir -p "$(dirname -- "$baseline_out")"
        cp -- "$bootstrap_baseline" "$baseline_out"
        write_gate_state "$state_out" "$latest_id" "$latest_state" "" "" "${temp_dir}/latest-payload.json"
        write_github_output baseline_deployment_id ""
        write_github_output previous_production_id ""
        write_github_output previous_production_url ""
        release_note "recovery gate accepted for a failed bootstrap lineage without a trusted production deployment"
        return
      fi
      release_die "recovery could not find an earlier successful website-release baseline"
    fi
  fi

  deployment_payload "$baseline_row" >"${temp_dir}/payload.json"
  validate_payload_file "${temp_dir}/payload.json"
  mkdir -p "$(dirname -- "$baseline_out")"
  jq '.contentRegistry' "${temp_dir}/payload.json" >"$baseline_out"
  blocking_payload_path=""
  if [[ "$operation" == "recovery" ]]; then
    blocking_payload_path="${temp_dir}/latest-payload.json"
  fi
  write_gate_state \
    "$state_out" \
    "$latest_id" \
    "$latest_state" \
    "$baseline_id" \
    "${temp_dir}/payload.json" \
    "$blocking_payload_path"

  write_github_output baseline_deployment_id "$baseline_id"
  write_github_output previous_production_id "$(jq -er '.candidateDeploymentId' "${temp_dir}/payload.json")"
  write_github_output previous_production_url "$(jq -er '.candidateDeploymentUrl' "${temp_dir}/payload.json")"
  release_note "${operation} gate accepted with baseline GitHub Deployment ${baseline_id}"
}

create_command() {
  local payload_path=""
  local ref=""
  while (($#)); do
    case "$1" in
      --payload) payload_path="${2:-}"; shift 2 ;;
      --ref) ref="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$payload_path" && -n "$ref" ]] || usage
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || release_die "Deployment ref must be a full lowercase commit SHA"
  validate_payload_file "$payload_path"

  local temp_dir response deployment_id
  temp_dir="$(mktemp -d)"
  trap "rm -rf -- '$temp_dir'" EXIT
  jq -n \
    --arg ref "$ref" \
    --arg task "$task_name" \
    --arg environment "$environment_name" \
    --slurpfile payload "$payload_path" '
      {
        ref: $ref,
        task: $task,
        auto_merge: false,
        required_contexts: [],
        environment: $environment,
        description: "Verified staged production artifact awaiting promotion",
        transient_environment: false,
        production_environment: true,
        payload: $payload[0]
      }
    ' >"${temp_dir}/request.json"
  response="$(github_api POST /deployments "${temp_dir}/request.json")"
  deployment_id="$(jq -er '.id | tostring' <<<"$response")"

  bash "$0" status \
    --deployment-id "$deployment_id" \
    --state in_progress \
    --environment-url "$(jq -er '.candidateDeploymentUrl' "$payload_path")" \
    --description "Candidate verified; promotion in progress"

  write_github_output deployment_id "$deployment_id"
  printf '%s\n' "$deployment_id"
}

status_command() {
  local deployment_id=""
  local state=""
  local environment_url=""
  local description=""
  while (($#)); do
    case "$1" in
      --deployment-id) deployment_id="${2:-}"; shift 2 ;;
      --state) state="${2:-}"; shift 2 ;;
      --environment-url) environment_url="${2:-}"; shift 2 ;;
      --description) description="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "$deployment_id" =~ ^[0-9]+$ ]] || release_die "invalid GitHub Deployment ID"
  case "$state" in
    in_progress | success | failure | error | inactive) ;;
    *) release_die "unsupported GitHub Deployment status: ${state}" ;;
  esac
  ((${#description} <= 140)) || release_die "Deployment status description exceeds 140 characters"
  if [[ -n "$environment_url" ]]; then
    assert_https_origin "$environment_url"
  fi

  local temp_dir
  temp_dir="$(mktemp -d)"
  trap "rm -rf -- '$temp_dir'" EXIT
  jq -n \
    --arg state "$state" \
    --arg description "$description" \
    --arg environment_url "$environment_url" \
    --arg log_url "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-}" '
      {
        state: $state,
        description: ($description | select(length > 0) // null),
        environment_url: ($environment_url | select(length > 0) // null),
        log_url: $log_url,
        auto_inactive: false
      } | with_entries(select(.value != null))
    ' >"${temp_dir}/request.json"
  github_api POST "/deployments/${deployment_id}/statuses" "${temp_dir}/request.json" >/dev/null
  release_note "GitHub Deployment ${deployment_id} marked ${state}"
}

find_candidate_command() {
  local candidate_id=""
  local state_out=""
  while (($#)); do
    case "$1" in
      --candidate-id) candidate_id="${2:-}"; shift 2 ;;
      --state-out) state_out="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "$candidate_id" =~ ^dpl_[A-Za-z0-9]+$ && -n "$state_out" ]] || usage

  local deployments count index row payload status deployment_id temp_dir
  temp_dir="$(mktemp -d)"
  trap "rm -rf -- '$temp_dir'" EXIT
  deployments="$(fetch_deployments)"
  count="$(jq 'length' <<<"$deployments")"
  for ((index = 0; index < count; index++)); do
    row="$(jq -c ".[$index]" <<<"$deployments")"
    if ! deployment_payload "$row" >"${temp_dir}/payload.json" 2>/dev/null; then
      continue
    fi
    if jq -e --arg id "$candidate_id" '.candidateDeploymentId == $id' "${temp_dir}/payload.json" >/dev/null; then
      deployment_id="$(jq -er '.id | tostring' <<<"$row")"
      status="$(latest_status_name "$deployment_id")"
      [[ "$status" == "success" ]] || release_die "requested rollback target does not have a success status"
      validate_payload_file "${temp_dir}/payload.json"
      mkdir -p "$(dirname -- "$state_out")"
      jq -n \
        --arg deploymentId "$deployment_id" \
        --arg state "$status" \
        --slurpfile payload "${temp_dir}/payload.json" '
          {deploymentId: $deploymentId, state: $state, payload: $payload[0]}
        ' >"$state_out"
      return
    fi
  done
  release_die "no successful website-release record matches candidate ${candidate_id}"
}

command_name="${1:-}"
[[ -n "$command_name" ]] || usage
shift
case "$command_name" in
  gate) gate_command "$@" ;;
  create) create_command "$@" ;;
  status) status_command "$@" ;;
  find-candidate) find_candidate_command "$@" ;;
  *) usage ;;
esac
