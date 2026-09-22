#!/usr/bin/env bash

# Shared fail-closed helpers for the production release scripts.
# This file is sourced; callers are responsible for enabling strict mode.

release_die() {
  printf 'release error: %s\n' "$*" >&2
  exit 1
}

release_note() {
  printf 'release: %s\n' "$*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || release_die "required command is unavailable: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || release_die "required environment variable is unset: ${name}"
}

require_file() {
  [[ -f "$1" ]] || release_die "required file does not exist: $1"
}

assert_safe_identifier() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[A-Za-z0-9._:-]+$ ]] || release_die "${label} contains unsafe characters"
}

assert_https_origin() {
  local origin="$1"
  [[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
    release_die "expected an HTTPS origin without path, query, fragment, or credentials"
}

origin_host() {
  local origin="$1"
  assert_https_origin "$origin"
  printf '%s\n' "${origin#https://}"
}

assert_deployment_url() {
  local url="$1"
  [[ "$url" =~ ^https://[A-Za-z0-9-]+([.][A-Za-z0-9-]+)+$ ]] ||
    release_die "deployment URL must be an HTTPS origin without path, query, fragment, or credentials"
}

assert_build_info_file() {
  local path="$1"
  require_file "$path"
  jq -e '
    type == "object" and
    (.codeSha | type == "string" and length >= 7) and
    (.contentHash | type == "string" and length >= 16) and
    (.configHash | type == "string" and length >= 16) and
    (.schemaVersion != null)
  ' "$path" >/dev/null || release_die "invalid build identity: ${path}"
}

normalize_build_info() {
  jq -cS '{
    codeSha,
    contentHash,
    configHash,
    schemaVersion
  }' "$1"
}

github_api() {
  local method="$1"
  local path="$2"
  local body_path="${3:-}"
  local args=(
    --fail-with-body
    --silent
    --show-error
    --request "$method"
    --header "Accept: application/vnd.github+json"
    --header "Authorization: Bearer ${GITHUB_TOKEN}"
    --header "X-GitHub-Api-Version: 2022-11-28"
  )

  if [[ -n "$body_path" ]]; then
    require_file "$body_path"
    args+=(--header "Content-Type: application/json" --data-binary "@${body_path}")
  fi

  curl "${args[@]}" "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}"
}

github_api_all_pages() {
  local path="$1"
  local separator="?"
  local page=1
  local count temp_dir
  [[ "$path" == *\?* ]] && separator="&"
  temp_dir="$(mktemp -d)"
  printf '[]\n' >"${temp_dir}/combined.json"

  while ((page <= 100)); do
    if ! github_api GET "${path}${separator}per_page=100&page=${page}" >"${temp_dir}/batch.json"; then
      rm -rf -- "$temp_dir"
      return 1
    fi
    if ! jq -e 'type == "array"' "${temp_dir}/batch.json" >/dev/null; then
      rm -rf -- "$temp_dir"
      release_die "GitHub paginated API returned a non-array response"
    fi
    jq -c -s '.[0] + .[1]' "${temp_dir}/combined.json" "${temp_dir}/batch.json" \
      >"${temp_dir}/next.json"
    mv -- "${temp_dir}/next.json" "${temp_dir}/combined.json"
    count="$(jq 'length' "${temp_dir}/batch.json")"
    if ((count < 100)); then
      jq -c . "${temp_dir}/combined.json"
      rm -rf -- "$temp_dir"
      return
    fi
    ((page += 1))
  done
  rm -rf -- "$temp_dir"
  release_die "GitHub paginated API exceeded the 10,000-record safety limit"
}

sort_github_records_newest_first() {
  jq -c '
    if type != "array" then error("expected an array")
    else sort_by(.created_at, (.id | tonumber)) | reverse
    end
  '
}

vercel_scope_query() {
  case "${VERCEL_ORG_ID}" in
    team_*) printf '?teamId=%s' "${VERCEL_ORG_ID}" ;;
    user_*) printf '' ;;
    *) release_die "VERCEL_ORG_ID must start with team_ or user_" ;;
  esac
}

vercel_deployment_json() {
  local locator="$1"
  local path_locator="$locator"
  local query

  if [[ "$path_locator" == https://* ]]; then
    assert_deployment_url "$path_locator"
    path_locator="${path_locator#https://}"
  else
    assert_safe_identifier "$path_locator" "Vercel deployment locator"
  fi

  query="$(vercel_scope_query)"
  curl \
    --fail-with-body \
    --silent \
    --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --header "Authorization: Bearer ${VERCEL_TOKEN}" \
    "https://api.vercel.com/v13/deployments/${path_locator}${query}"
}

assert_vercel_deployment() {
  local json_path="$1"
  local expected_id="${2:-}"
  local expected_target="${3:-production}"

  require_file "$json_path"
  jq -e \
    --arg project_id "$VERCEL_PROJECT_ID" \
    --arg target "$expected_target" '
      (.id | type == "string" and startswith("dpl_")) and
      .projectId == $project_id and
      .target == $target and
      (.readyState == "READY" or .state == "READY")
    ' "$json_path" >/dev/null ||
      release_die "Vercel deployment is not READY, production-targeted, and owned by the configured project"

  if [[ -n "$expected_id" ]]; then
    jq -e --arg expected "$expected_id" '.id == $expected' "$json_path" >/dev/null ||
      release_die "Vercel deployment ID does not match the expected ID"
  fi
}

write_github_output() {
  local name="$1"
  local value="$2"
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  printf '%s=%s\n' "$name" "$value" >>"${GITHUB_OUTPUT}"
}

vercel_project_json() {
  require_env VERCEL_TOKEN
  require_env VERCEL_ORG_ID
  require_env VERCEL_PROJECT_ID
  require_command curl
  [[ "$VERCEL_PROJECT_ID" == prj_* ]] ||
    release_die "VERCEL_PROJECT_ID must be the immutable prj_ identifier"
  local query="?rollbackInfo=true"
  case "$VERCEL_ORG_ID" in
    team_*) query="${query}&teamId=${VERCEL_ORG_ID}" ;;
    user_*) ;;
    *) release_die "VERCEL_ORG_ID must start with team_ or user_" ;;
  esac
  curl \
    --fail-with-body \
    --silent \
    --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --header "Authorization: Bearer ${VERCEL_TOKEN}" \
    "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}${query}"
}

assert_vercel_alias_coordination_project() {
  local json_path="$1"
  require_file "$json_path"

  jq -e --arg project_id "$VERCEL_PROJECT_ID" '
    .id == $project_id and
    (.lastAliasRequest == null or (.lastAliasRequest | type == "object"))
  ' "$json_path" >/dev/null ||
    release_die "Vercel project response did not contain a trustworthy alias-operation status"

  # The pinned Vercel CLI coordinates an enabled Rolling Release through a
  # separate active-stage API instead of lastAliasRequest. This release system
  # deliberately supports only atomic alias moves; accepting a rolling project
  # here could let recovery declare the alias queue settled while traffic is
  # still advancing between deployments.
  jq -e '(.rollingRelease == null or .rollingRelease == false)' "$json_path" >/dev/null ||
    release_die "Vercel Rolling Releases must be disabled for atomic production coordination"
}

duration_seconds() {
  local duration="$1"
  [[ "$duration" =~ ^([1-9][0-9]*)([smh])$ ]] ||
    release_die "Vercel operation timeout must be a positive duration such as 5m"
  local amount="${BASH_REMATCH[1]}"
  case "${BASH_REMATCH[2]}" in
    s) printf '%s\n' "$amount" ;;
    m) printf '%s\n' "$((amount * 60))" ;;
    h) printf '%s\n' "$((amount * 3600))" ;;
  esac
}

wait_for_vercel_operation() {
  local expected_operation="${1:-}"
  local expected_target_id="${2:-}"
  local timeout="${VERCEL_OPERATION_STATUS_TIMEOUT:-5m}"
  local poll_seconds="${VERCEL_OPERATION_STATUS_POLL_SECONDS:-2}"
  local timeout_seconds deadline temp_file job_status operation target_id
  if [[ -n "$expected_operation" ]]; then
    case "$expected_operation" in
      promote | rollback) ;;
      *) release_die "unsupported Vercel operation status: ${expected_operation}" ;;
    esac
    [[ "$expected_target_id" =~ ^dpl_[A-Za-z0-9]+$ ]] ||
      release_die "expected Vercel operation target must be an immutable deployment ID"
  elif [[ -n "$expected_target_id" ]]; then
    release_die "a Vercel operation target requires an operation type"
  fi
  [[ "$poll_seconds" =~ ^[0-9]+$ ]] ||
    release_die "VERCEL_OPERATION_STATUS_POLL_SECONDS must be a non-negative integer"
  timeout_seconds="$(duration_seconds "$timeout")"
  deadline="$((SECONDS + timeout_seconds))"
  temp_file="$(mktemp)"

  while true; do
    if ! vercel_project_json >"$temp_file"; then
      rm -f -- "$temp_file"
      release_die "could not read Vercel project alias-operation status"
    fi
    if ! (assert_vercel_alias_coordination_project "$temp_file"); then
      rm -f -- "$temp_file"
      return 1
    fi
    job_status="$(jq -r '.lastAliasRequest.jobStatus // "none"' "$temp_file")"
    operation="$(jq -r '.lastAliasRequest.type // "none"' "$temp_file")"
    target_id="$(jq -r '.lastAliasRequest.toDeploymentId // "none"' "$temp_file")"

    case "$job_status" in
      pending | in-progress)
        if [[ -n "$expected_operation" && ("$operation" != "$expected_operation" || "$target_id" != "$expected_target_id") ]]; then
          rm -f -- "$temp_file"
          release_die "a different Vercel alias mutation is pending (${operation} to ${target_id})"
        fi
        if ((SECONDS >= deadline)); then
          rm -f -- "$temp_file"
          release_die "Vercel alias mutation remained ${job_status}; production state is still unknown"
        fi
        sleep "$poll_seconds"
        ;;
      none)
        if [[ -z "$expected_operation" ]]; then
          rm -f -- "$temp_file"
          return
        fi
        if ((SECONDS >= deadline)); then
          rm -f -- "$temp_file"
          release_die "Vercel did not record the requested ${expected_operation} to ${expected_target_id}"
        fi
        sleep "$poll_seconds"
        ;;
      succeeded)
        rm -f -- "$temp_file"
        if [[ -n "$expected_operation" && ("$operation" != "$expected_operation" || "$target_id" != "$expected_target_id") ]]; then
          release_die "Vercel settled a different alias mutation (${operation} to ${target_id})"
        fi
        return
        ;;
      failed | skipped)
        rm -f -- "$temp_file"
        if [[ -n "$expected_operation" && "$operation" == "$expected_operation" && "$target_id" == "$expected_target_id" ]]; then
          release_die "Vercel ${expected_operation} to ${expected_target_id} settled as ${job_status}"
        fi
        return
        ;;
      *)
        rm -f -- "$temp_file"
        release_die "unknown Vercel alias mutation status: ${job_status}"
        ;;
    esac
  done
}

wait_for_vercel_mutations() {
  wait_for_vercel_operation
}
