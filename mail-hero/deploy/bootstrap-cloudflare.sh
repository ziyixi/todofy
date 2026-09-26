#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
Usage: deploy/bootstrap-cloudflare.sh RECEIVE_ADDRESS ACCESS_ISSUER ACCESS_AUDIENCE OWNER_EMAIL

Example:
  deploy/bootstrap-cloudflare.sh hero@in.example.org https://team.cloudflareaccess.com AUDIENCE owner@example.org

This creates local configuration and secrets only. It does not change Cloudflare,
DNS, source mailbox forwarding, or start containers.
EOF
  exit 2
}

[[ $# -eq 4 ]] || usage
receive_address=$1
access_issuer=$2
access_audience=$3
owner_email=$4

[[ $receive_address == *@* && $receive_address != *' '* ]] || usage
local_part=${receive_address%@*}
receive_domain=${receive_address#*@}
[[ $receive_address == "$local_part@$receive_domain" ]] || usage
[[ ${#local_part} -le 64 && $local_part =~ ^[a-z0-9][a-z0-9._+-]*$ && $local_part != *..* && $local_part != *. ]] || usage
[[ ${#receive_domain} -le 253 && $receive_domain == *.* && $receive_domain != .* && $receive_domain != *. && $receive_domain != *..* ]] || usage
IFS=. read -r -a domain_labels <<< "$receive_domain"
for label in "${domain_labels[@]}"; do
  [[ $label =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || usage
done
[[ $access_issuer =~ ^https://[A-Za-z0-9.-]+/?$ ]] || usage
[[ $access_audience =~ ^[A-Za-z0-9_-]+$ ]] || usage
[[ $owner_email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || usage
[[ $(id -u) -ne 0 ]] || { echo 'Run as the non-root deployment user.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
secret_dir="$script_dir/secrets"
runtime_env="$script_dir/runtime.env"

for target in "$runtime_env" "$secret_dir/postgres-password" "$secret_dir/database-url" "$secret_dir/mail-hero-key" "$secret_dir/ingest-token"; do
  [[ ! -e $target ]] || { echo "Refusing to overwrite existing $(basename "$target")." >&2; exit 1; }
done
install -d -m 0700 "$secret_dir"

db_password=$(openssl rand -hex 32)
printf '%s' "$db_password" > "$secret_dir/postgres-password"
printf 'postgres://mailhero:%s@db:5432/mailhero?sslmode=disable' "$db_password" > "$secret_dir/database-url"
openssl rand 32 > "$secret_dir/mail-hero-key"
printf '%s' "$(openssl rand -hex 32)" > "$secret_dir/ingest-token"
chmod 0600 "$secret_dir/postgres-password" "$secret_dir/database-url" "$secret_dir/mail-hero-key" "$secret_dir/ingest-token"
unset db_password

cat > "$runtime_env" <<EOF
MAIL_HERO_RECEIVE_ADDRESS=${receive_address}
MAIL_HERO_ACCESS_ISSUER=${access_issuer%/}
MAIL_HERO_ACCESS_AUDIENCE=${access_audience}
MAIL_HERO_ACCESS_OWNER=${owner_email}
MAIL_HERO_FORCE_SEND_PAUSED=true
MAIL_HERO_ALLOWED_INTERNAL_TARGETS=
MAIL_HERO_UID=$(id -u)
MAIL_HERO_GID=$(id -g)
EOF
chmod 0600 "$runtime_env"

echo 'Created deploy/runtime.env and local deployment secret files.'
echo 'Next: follow docs/cloudflare-setup.md; no Cloudflare account changes were made.'
