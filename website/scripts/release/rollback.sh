#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${script_dir}/common.sh"

expected_current_id=""
restore_id=""
restore_url=""
restore_build_info=""
target_record=""

while (($#)); do
  case "$1" in
    --expected-current-id) expected_current_id="${2:-}"; shift 2 ;;
    --restore-id) restore_id="${2:-}"; shift 2 ;;
    --restore-url) restore_url="${2:-}"; shift 2 ;;
    --restore-build-info) restore_build_info="${2:-}"; shift 2 ;;
    --target-record) target_record="${2:-}"; shift 2 ;;
    *) release_die "unknown argument: $1" ;;
  esac
done

[[ -n "$expected_current_id" && -n "$restore_id" && -n "$restore_url" && -n "$restore_build_info" && -n "$target_record" ]] ||
  release_die "expected current ID, restore ID/URL/build-info, and target record are required"
[[ "$expected_current_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid expected current deployment ID"
[[ "$restore_id" =~ ^dpl_[A-Za-z0-9]+$ ]] || release_die "invalid restore deployment ID"
[[ "$expected_current_id" != "$restore_id" ]] || release_die "current and restore deployment IDs must differ"
assert_deployment_url "$restore_url"
assert_build_info_file "$restore_build_info"
require_file "$target_record"
require_env SITE_URL
require_env VERCEL_TOKEN
require_env VERCEL_ORG_ID
require_env VERCEL_PROJECT_ID
require_command jq
require_command pnpm

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

# A timed-out promote or rollback keeps running on Vercel. Do not inspect the
# domain, skip recovery, or start a competing mutation until both queues are
# known to be settled.
wait_for_vercel_mutations

# Do not overwrite a concurrent operator's recovery: the canonical domain must
# still resolve to exactly the deployment this rollback was asked to replace.
vercel_deployment_json "$SITE_URL" >"${temp_dir}/current.json"
assert_vercel_deployment "${temp_dir}/current.json" "" production
current_id="$(jq -er '.id' "${temp_dir}/current.json")"
if [[ "$current_id" != "$expected_current_id" && "$current_id" != "$restore_id" ]]; then
  release_die "production changed concurrently; refusing to overwrite deployment ${current_id}"
fi

# The mutation below addresses the deployment by URL, so verify that exact URL
# resolves to the recorded immutable ID before requesting rollback.
vercel_deployment_json "$restore_url" >"${temp_dir}/restore.json"
assert_vercel_deployment "${temp_dir}/restore.json" "$restore_id" production

jq -e \
  --arg restore_id "$restore_id" \
  --arg restore_url "$restore_url" \
  --slurpfile identity "$restore_build_info" '
    ((.payload // .baseline.payload).candidateDeploymentId == $restore_id) and
    ((.payload // .baseline.payload).candidateDeploymentUrl == $restore_url) and
    ((.payload // .baseline.payload).identity.codeSha == $identity[0].codeSha) and
    ((.payload // .baseline.payload).identity.contentHash == $identity[0].contentHash) and
    ((.payload // .baseline.payload).identity.configHash == $identity[0].configHash)
  ' "$target_record" >/dev/null ||
  release_die "rollback target is not the known-good artifact described by its successful record"

if [[ "$current_id" == "$restore_id" ]]; then
  release_note "production already points to the known-good restore target; no rollback mutation needed"
else
  rollback_exit=0
  pnpm exec vercel rollback "$restore_url" \
    --non-interactive \
    --timeout=5m \
    --token "$VERCEL_TOKEN" || rollback_exit=$?
  if ((rollback_exit != 0)); then
    release_note "rollback command exited ${rollback_exit}; result is unknown until status and production identity are reconciled"
  fi
  wait_for_vercel_operation rollback "$restore_id"
fi

vercel_deployment_json "$SITE_URL" >"${temp_dir}/settled-current.json"
assert_vercel_deployment "${temp_dir}/settled-current.json" "$restore_id" production

write_github_output restored_deployment_id "$restore_id"
release_note "rollback settled from ${expected_current_id} to known-good ${restore_id}"
