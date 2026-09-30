#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

mode=""
base_url=""
expected_build_info=""
expected_deployment_id=""
verification_contract=""
identity_only=false
wait_for_identity=false

while (($#)); do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --base-url) base_url="${2:-}"; shift 2 ;;
    --expected-build-info) expected_build_info="${2:-}"; shift 2 ;;
    --expected-deployment-id) expected_deployment_id="${2:-}"; shift 2 ;;
    --verification-contract) verification_contract="${2:-}"; shift 2 ;;
    --identity-only) identity_only=true; shift ;;
    --wait-for-identity) wait_for_identity=true; shift ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

case "$mode" in
  candidate | production) ;;
  *) release_die "--mode must be candidate or production" ;;
esac
[[ -n "$base_url" && -n "$expected_build_info" ]] ||
  release_die "--base-url and --expected-build-info are required"
assert_build_info_file "$expected_build_info"
require_command curl
require_command jq
require_command pnpm
require_env VERCEL_TOKEN
require_env VERCEL_ORG_ID
require_env VERCEL_PROJECT_ID

if [[ "$mode" == "candidate" ]]; then
  assert_deployment_url "$base_url"
  require_env VERCEL_AUTOMATION_BYPASS_SECRET
else
  assert_https_origin "$base_url"
fi
if [[ -n "$expected_deployment_id" ]]; then
  [[ "$expected_deployment_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid expected deployment ID"
fi
if [[ "$wait_for_identity" == true ]]; then
  [[ "$mode" == production && -n "$expected_deployment_id" ]] ||
    release_die "--wait-for-identity requires production mode and an expected deployment ID"
fi
if [[ -n "$verification_contract" ]]; then
  require_file "$verification_contract"
  jq -e '
    (.canonicalOrigin | type == "string" and startswith("https://")) and
    (.emptyStateText | type == "string" and length > 0) and
    (.sourceMode == "empty" or .sourceMode == "notion") and
    (.routes | type == "array") and
    all(.routes[];
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
  ' "$verification_contract" >/dev/null || release_die "invalid deployment verification contract"
  assert_https_origin "$(jq -er '.canonicalOrigin' "$verification_contract")"
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

# Resolve and verify ownership through Vercel's authenticated API before a
# candidate protection-bypass secret is ever sent to the supplied origin.
vercel_deployment_json "$base_url" >"${temp_dir}/deployment.json"
assert_vercel_deployment "${temp_dir}/deployment.json" "$expected_deployment_id" production
resolved_deployment_id="$(jq -er '.id' "${temp_dir}/deployment.json")"

if [[ "$mode" == "candidate" ]]; then
  # A candidate must actually be private. Check this before the first request
  # carrying the bypass secret so a disabled or exempted protection policy
  # fails closed instead of silently promoting a public deployment URL.
  unauthenticated_status="$(curl \
    --silent \
    --show-error \
    --proto '=https' \
    --max-redirs 0 \
    --connect-timeout 10 \
    --max-time 30 \
    --output "${temp_dir}/unauthenticated-body.txt" \
    --write-out '%{http_code}' \
    --header 'Accept: application/json' \
    "${base_url}/build-info.json")"
  case "$unauthenticated_status" in
    401 | 403) ;;
    *)
      release_die "candidate URL is not protected without credentials (HTTP ${unauthenticated_status})"
      ;;
  esac
fi

curl_args=(
  --fail-with-body
  --silent
  --show-error
  --proto '=https'
  --max-redirs 0
  --connect-timeout 10
  --max-time 30
  --dump-header "${temp_dir}/headers.txt"
  --output "${temp_dir}/actual-build-info.json"
  --header 'Accept: application/json'
  --header 'Cache-Control: no-cache'
)
if [[ "$mode" == "candidate" ]]; then
  # The secret is scoped to this already-validated candidate origin. Redirects are
  # deliberately disabled so curl can never forward it to another host.
  curl_args+=(--header "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi
normalize_build_info "$expected_build_info" >"${temp_dir}/expected.normalized.json"
identity_attempts=1
required_identity_matches=1
consecutive_identity_matches=0
if [[ "$wait_for_identity" == true ]]; then
  identity_attempts=12
  required_identity_matches=3
fi
for ((attempt = 1; attempt <= identity_attempts; attempt++)); do
  if ((attempt > 1)); then
    sleep 5
    # An alias can report success before its public routes converge. Before
    # every retry, prove that no other deployment has taken over production.
    vercel_deployment_json "$base_url" >"${temp_dir}/deployment.json"
    assert_vercel_deployment "${temp_dir}/deployment.json" "$expected_deployment_id" production
    resolved_deployment_id="$(jq -er '.id' "${temp_dir}/deployment.json")"
  fi
  curl "${curl_args[@]}" "${base_url}/build-info.json"

  grep -Eiq '^cache-control:([^\r\n]*,)?[[:space:]]*no-store([,;[:space:]]|$)' "${temp_dir}/headers.txt" ||
    release_die "build-info.json did not return an explicit no-store cache policy"
  assert_build_info_file "${temp_dir}/actual-build-info.json"
  normalize_build_info "${temp_dir}/actual-build-info.json" >"${temp_dir}/actual.normalized.json"
  if cmp -s "${temp_dir}/expected.normalized.json" "${temp_dir}/actual.normalized.json"; then
    ((consecutive_identity_matches += 1))
    if [[ "$wait_for_identity" == true ]]; then
      release_note "public identity matched on attempt ${attempt}/${identity_attempts}: ${consecutive_identity_matches}/${required_identity_matches} consecutive matches"
    fi
    if ((consecutive_identity_matches >= required_identity_matches)); then
      break
    fi
    continue
  fi
  consecutive_identity_matches=0

  # Log only commit identifiers, never the response body or credential headers.
  expected_code_sha="$(jq -r '.codeSha | if test("^[0-9a-fA-F]{7,64}$") then . else "<invalid codeSha>" end' "$expected_build_info")"
  actual_code_sha="$(jq -r '.codeSha | if test("^[0-9a-fA-F]{7,64}$") then . else "<invalid codeSha>" end' "${temp_dir}/actual-build-info.json")"
  release_note "build identity mismatch on attempt ${attempt}/${identity_attempts}: expected codeSha=${expected_code_sha}, actual codeSha=${actual_code_sha}"
  response_cache_diagnostics="$(awk -F: '
    tolower($1) ~ /^(cf-cache-status|x-vercel-cache|x-vercel-id)$/ {
      value = substr($0, index($0, ":") + 1)
      gsub(/\r/, "", value)
      if (length(value) <= 160 && value ~ /^[A-Za-z0-9 ._:;=,-]+$/)
        printf "%s=%s; ", tolower($1), value
    }
  ' "${temp_dir}/headers.txt")"
  release_note "identity response cache headers: ${response_cache_diagnostics:-not present}"
done
if ((consecutive_identity_matches < required_identity_matches)); then
  if ((consecutive_identity_matches == 0)); then
    release_die "deployed build identity does not match the locally verified artifact"
  fi
  release_die "deployed build identity did not stabilize: ${consecutive_identity_matches}/${required_identity_matches} consecutive matches after ${identity_attempts} attempts"
fi

write_github_output deployment_id "$resolved_deployment_id"
write_github_output deployment_url "$base_url"

if [[ "$identity_only" == false ]]; then
  export DEPLOYMENT_BASE_URL="$base_url"
  export EXPECTED_BUILD_INFO_PATH="$expected_build_info"
  export DEPLOYMENT_AUTH_MODE="$mode"
  if [[ -n "$verification_contract" ]]; then
    export DEPLOYMENT_CONTRACT_PATH="$verification_contract"
  else
    unset DEPLOYMENT_CONTRACT_PATH
  fi
  if [[ "$mode" == "candidate" ]]; then
    pnpm test:deployment
  else
    env -u VERCEL_AUTOMATION_BYPASS_SECRET \
      pnpm test:deployment
  fi
fi

release_note "verified ${mode} deployment ${resolved_deployment_id} as the expected artifact"
