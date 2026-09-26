#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime_env="$script_dir/runtime.env"
[[ $# -eq 1 && -s $1 ]] || { echo 'Usage: deploy/restore-empty.sh PATH_TO_CUSTOM_PGDUMP' >&2; exit 2; }
[[ -r $runtime_env ]] || { echo 'Missing deploy/runtime.env.' >&2; exit 1; }
grep -Eq '^MAIL_HERO_FORCE_SEND_PAUSED=true$' "$runtime_env" || {
  echo 'Set MAIL_HERO_FORCE_SEND_PAUSED=true in deploy/runtime.env before restore.' >&2
  exit 1
}
command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 1; }

dump=$1
compose=(docker compose --env-file "$runtime_env" -f "$script_dir/compose.yaml")
"${compose[@]}" stop app > /dev/null
"${compose[@]}" up -d db > /dev/null
"${compose[@]}" exec -T db pg_restore --list < "$dump" > /dev/null

tables=$("${compose[@]}" exec -T db psql -U mailhero -d mailhero -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[[ $tables == 0 ]] || {
  echo 'Target database is not empty. Restore into a new empty database; existing content was not changed.' >&2
  exit 1
}

"${compose[@]}" exec -T db pg_restore --clean --if-exists --exit-on-error --single-transaction \
  --no-owner --no-acl -U mailhero -d mailhero < "$dump"

echo 'Restore completed into an empty database. Sending remains forced paused.'
echo 'Check credentials, event history and consumer deduplication before starting the app.'
