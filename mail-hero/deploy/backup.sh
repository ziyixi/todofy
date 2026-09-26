#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime_env="$script_dir/runtime.env"
[[ -r $runtime_env ]] || { echo 'Missing deploy/runtime.env; run deploy/bootstrap.sh first.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }

local_only=false
if [[ ${1:-} == --local-only && $# -eq 1 ]]; then
  local_only=true
elif [[ $# -ne 0 ]]; then
  echo 'Usage: deploy/backup.sh [--local-only]' >&2
  exit 2
fi
if [[ $local_only == false ]]; then
  command -v restic >/dev/null || { echo 'restic is required for off-host backup.' >&2; exit 1; }
  [[ -n ${RESTIC_REPOSITORY:-} && -r ${RESTIC_PASSWORD_FILE:-/nonexistent} ]] || {
    echo 'Set RESTIC_REPOSITORY and a readable RESTIC_PASSWORD_FILE before off-host backup.' >&2
    exit 1
  }
  [[ ${MAIL_HERO_OFFSITE_CONFIRMED:-} == true ]] || {
    echo 'Set MAIL_HERO_OFFSITE_CONFIRMED=true only after checking the restic repository is independent of this host.' >&2
    exit 1
  }
fi

backup_dir=${MAIL_HERO_BACKUP_DIR:-"$script_dir/backups"}
install -d -m 0700 "$backup_dir"
temp_dump=$(mktemp "$backup_dir/.mail-hero.XXXXXX")
trap 'rm -f "$temp_dump"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
final_dump="$backup_dir/mail-hero-$stamp-$(openssl rand -hex 4).pgdump"
compose=(docker compose --env-file "$runtime_env" -f "$script_dir/compose.yaml")

"${compose[@]}" exec -T db pg_dump -U mailhero -d mailhero -Fc > "$temp_dump"
"${compose[@]}" exec -T db pg_restore --list < "$temp_dump" > /dev/null
mv "$temp_dump" "$final_dump"
trap - EXIT

if [[ $local_only == true ]]; then
  echo "Local database dump created: $final_dump"
  echo 'This is not an off-host backup; the UI backup timestamp was not changed.'
  exit 0
fi

restic backup --tag mail-hero -- "$final_dump" "$runtime_env" > /dev/null
"${compose[@]}" exec -T db psql -U mailhero -d mailhero -X -q -v ON_ERROR_STOP=1 -c \
  'UPDATE app_settings SET last_backup_at = now() WHERE id = 1' > /dev/null
rm -f "$final_dump"

# Paths contain a timestamped dump name, so grouping by tags is required for
# the daily/weekly policy to treat all Mail Hero snapshots as one series.
restic forget --tag mail-hero --group-by tags --keep-daily 7 --keep-weekly 4 --prune > /dev/null
echo 'Encrypted off-host Mail Hero backup completed.'
