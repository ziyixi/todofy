#!/usr/bin/env bash
# Verify Access's login redirect; never follow it or print the response/location.
set -euo pipefail
issuer=${ACCESS_ISSUER:?Access issuer required}
host=${PUBLIC_HOST:?public host required}
test $# -gt 0
for path in "$@"; do
  [[ "$path" == /* && "$path" != //* && "$path" != *$'\n'* ]]
  for attempt in $(seq 1 10); do
    answer=$(curl -sS -o /dev/null --max-time 15 --proto '=https' -w '%{http_code} %{redirect_url}' "https://$host$path" 2>/dev/null) || true
    code=${answer%% *}
    location=${answer#* }
    case "$code" in
      302)
        login="$issuer/cdn-cgi/access/login/$host"
        case "$location" in
          "$login"|"$login?"*|"$login/"*)
            echo "Access answered $path with 302 to its login page for this host (attempt $attempt)."
            continue 2
            ;;
        esac
        echo "$path: 302 to somewhere other than the Access login page for this host." >&2
        exit 1
        ;;
      ''|000|5??) sleep 15 ;;
      *)
        echo "$path was answered with $code without Access." >&2
        exit 1
        ;;
    esac
  done
  echo "$path never reached Access (last status ${code:-none})." >&2
  exit 1
done
