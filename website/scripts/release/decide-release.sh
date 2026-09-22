#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

operation=""
expected_build_info=""
gate_state=""
force_build="false"

while (($#)); do
  case "$1" in
    --operation) operation="${2:-}"; shift 2 ;;
    --expected-build-info) expected_build_info="${2:-}"; shift 2 ;;
    --gate-state) gate_state="${2:-}"; shift 2 ;;
    --force-build) force_build="${2:-}"; shift 2 ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

case "$operation" in
  release | bootstrap | recovery) ;;
  *) release_die "operation must be release, bootstrap, or recovery" ;;
esac
case "$force_build" in
  true | false) ;;
  *) release_die "force-build must be true or false" ;;
esac
[[ -n "$expected_build_info" && -n "$gate_state" ]] ||
  release_die "expected build info and gate state are required"
assert_build_info_file "$expected_build_info"
require_file "$gate_state"
require_command jq

deploy_required="true"
reason="identity-changed"
if [[ "$operation" != "release" ]]; then
  reason="${operation}-always-rebuilds"
elif [[ "$force_build" == "true" ]]; then
  reason="explicit-force-build"
else
  jq -e '.baseline != null and (.baseline.payload.identity | type == "object")' "$gate_state" >/dev/null ||
    release_die "a normal release requires a trusted baseline identity"
  if jq -e --slurpfile expected "$expected_build_info" \
    '.baseline.payload.identity == $expected[0]' "$gate_state" >/dev/null; then
    deploy_required="false"
    reason="identity-unchanged"
  fi
fi

write_github_output deploy_required "$deploy_required"
write_github_output reason "$reason"
release_note "deployment decision: required=${deploy_required}, reason=${reason}"
