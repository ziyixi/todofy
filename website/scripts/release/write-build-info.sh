#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

manifest=""
output=""
code_sha="${RELEASE_SHA:-${CODE_SHA:-}}"

while (($#)); do
  case "$1" in
    --manifest) manifest="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --code-sha) code_sha="${2:-}"; shift 2 ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

[[ -n "$manifest" && -n "$output" && -n "$code_sha" ]] ||
  release_die "manifest, output, and code SHA are required"
require_file "$manifest"
require_command jq
[[ "$code_sha" =~ ^[0-9a-f]{40}$ ]] || release_die "code SHA must be a full lowercase commit SHA"

jq -e '
  .complete == true and
  (.contentHash | type == "string" and length >= 16) and
  (.configHash | type == "string" and length >= 16) and
  (.schemaVersion != null)
' "$manifest" >/dev/null || release_die "completed content manifest is invalid"

mkdir -p "$(dirname -- "$output")"
jq -cS --arg codeSha "$code_sha" '{
  codeSha: $codeSha,
  contentHash,
  configHash,
  schemaVersion
}' "$manifest" >"$output"
printf '\n' >>"$output"
assert_build_info_file "$output"
release_note "wrote expected build identity from the completed content manifest"
