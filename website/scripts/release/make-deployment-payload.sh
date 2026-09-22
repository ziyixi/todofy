#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

build_info=""
registry=""
manifest=""
canonical_origin=""
candidate_id=""
candidate_url=""
previous_id=""
operation=""
output=""

while (($#)); do
  case "$1" in
    --build-info) build_info="${2:-}"; shift 2 ;;
    --registry) registry="${2:-}"; shift 2 ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    --canonical-origin) canonical_origin="${2:-}"; shift 2 ;;
    --candidate-id) candidate_id="${2:-}"; shift 2 ;;
    --candidate-url) candidate_url="${2:-}"; shift 2 ;;
    --previous-production-id) previous_id="${2:-}"; shift 2 ;;
    --operation) operation="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

[[ -n "$build_info" && -n "$registry" && -n "$manifest" && -n "$canonical_origin" && -n "$candidate_id" && -n "$candidate_url" && -n "$operation" && -n "$output" ]] ||
  release_die "build-info, registry, manifest, canonical origin, candidate ID/URL, operation, and output are required"
case "$operation" in
  release | bootstrap | recovery | rollback) ;;
  *) release_die "unsupported payload operation: ${operation}" ;;
esac
[[ "$candidate_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid candidate deployment ID"
if [[ -n "$previous_id" ]]; then
  [[ "$previous_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid previous production deployment ID"
fi
assert_deployment_url "$candidate_url"
assert_https_origin "$canonical_origin"
assert_build_info_file "$build_info"
require_file "$registry"
require_file "$manifest"
require_command jq

jq -e 'type == "object" and (.registryVersion != null)' "$registry" >/dev/null ||
  release_die "candidate content registry must be an object with registryVersion"
jq -e '
  .complete == true and
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
' "$manifest" >/dev/null || release_die "completed production manifest has an invalid verification contract"
jq -e --slurpfile registry "$registry" '.candidateRegistry == $registry[0]' "$manifest" >/dev/null ||
  release_die "candidate content registry does not match the completed manifest"
registry_bytes="$(wc -c <"$registry" | tr -d ' ')"
((registry_bytes <= 45000)) || release_die "candidate content registry exceeds the 45 KB payload budget"

if [[ -n "${RELEASE_SHA:-}" ]]; then
  jq -e --arg sha "$RELEASE_SHA" '.codeSha == $sha' "$build_info" >/dev/null ||
    release_die "build-info codeSha does not match the locked release SHA"
fi

mkdir -p "$(dirname -- "$output")"
jq -n \
  --argjson schemaVersion 2 \
  --arg task website-release \
  --arg operation "$operation" \
  --arg canonicalOrigin "$canonical_origin" \
  --arg emptyStateText "Writing will appear here." \
  --arg candidateDeploymentId "$candidate_id" \
  --arg candidateDeploymentUrl "$candidate_url" \
  --arg previousProductionDeploymentId "$previous_id" \
  --arg workflowUrl "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}" \
  --slurpfile identity "$build_info" \
  --slurpfile contentRegistry "$registry" \
  --slurpfile manifest "$manifest" '
    {
      schemaVersion: $schemaVersion,
      task: $task,
      operation: $operation,
      identity: {
        codeSha: $identity[0].codeSha,
        contentHash: $identity[0].contentHash,
        configHash: $identity[0].configHash,
        schemaVersion: $identity[0].schemaVersion
      },
      candidateDeploymentId: $candidateDeploymentId,
      candidateDeploymentUrl: $candidateDeploymentUrl,
      previousProductionDeploymentId: (
        $previousProductionDeploymentId | select(length > 0) // null
      ),
      workflowUrl: $workflowUrl,
      requiredContexts: [],
      requiredContextsReason: "All gates ran sequentially in this locked workflow before record creation.",
      contentRegistry: $contentRegistry[0],
      verificationContract: {
        canonicalOrigin: $canonicalOrigin,
        emptyStateText: $emptyStateText,
        sourceMode: $manifest[0].sourceMode,
        routes: $manifest[0].routes
      }
    }
  ' >"$output"

payload_bytes="$(wc -c <"$output" | tr -d ' ')"
((payload_bytes <= 60000)) || release_die "Deployment payload exceeds the 60 KB safety limit"
release_note "wrote redacted GitHub Deployment payload (${payload_bytes} bytes)"
