#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
Usage: deploy/bootstrap.sh RECEIVE_ADDRESS MX_HOSTNAME ACCESS_ISSUER ACCESS_AUDIENCE OWNER_EMAIL

Example:
  deploy/bootstrap.sh hero@in.example.org mx.in.example.org https://team.cloudflareaccess.com AUDIENCE owner@example.org

This creates local configuration and random secrets only. It does not change
Cloudflare DNS, issue certificates, start containers, or contact email sources.
EOF
  exit 2
}

[[ $# -eq 5 ]] || usage
receive_address=$1
mx_hostname=$2
access_issuer=$3
access_audience=$4
owner_email=$5

[[ $receive_address == *@* && $receive_address != *' '* ]] || usage
local_part=${receive_address%@*}
receive_domain=${receive_address#*@}
[[ $receive_address == "$local_part@$receive_domain" ]] || usage
[[ ${#local_part} -le 64 && $local_part =~ ^[a-z0-9][a-z0-9._+-]*$ && $local_part != *..* && $local_part != *. ]] || usage
for hostname in "$receive_domain" "$mx_hostname"; do
  [[ ${#hostname} -le 253 && $hostname == *.* && $hostname != .* && $hostname != *. && $hostname != *..* ]] || usage
  IFS=. read -r -a domain_labels <<< "$hostname"
  for label in "${domain_labels[@]}"; do
    [[ $label =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || usage
  done
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
install -d -m 0700 "$secret_dir" "$script_dir/certs"

db_password=$(openssl rand -hex 32)
printf '%s' "$db_password" > "$secret_dir/postgres-password"
printf 'postgres://mailhero:%s@db:5432/mailhero?sslmode=disable' "$db_password" > "$secret_dir/database-url"
openssl rand 32 > "$secret_dir/mail-hero-key"
printf '%s' "$(openssl rand -hex 32)" > "$secret_dir/ingest-token"
chmod 0600 "$secret_dir/postgres-password" "$secret_dir/database-url" "$secret_dir/mail-hero-key" "$secret_dir/ingest-token"
unset db_password

cat > "$runtime_env" <<EOF
MAIL_HERO_RECEIVE_ADDRESS=${receive_address}
MAIL_HERO_MX_HOSTNAME=${mx_hostname}
MAIL_HERO_ACCESS_ISSUER=${access_issuer%/}
MAIL_HERO_ACCESS_AUDIENCE=${access_audience}
MAIL_HERO_ACCESS_OWNER=${owner_email}
MAIL_HERO_FORCE_SEND_PAUSED=true
MAIL_HERO_ALLOWED_INTERNAL_TARGETS=
MAIL_HERO_SMTP_PUBLISH_PORT=25
MAIL_HERO_UID=$(id -u)
MAIL_HERO_GID=$(id -g)
EOF
chmod 0600 "$runtime_env"

echo 'Created deploy/runtime.env and deployment secret files.'
echo 'Next: provision DNS, SMTP certificate, Tunnel/Access, then follow docs/setup.md.'
