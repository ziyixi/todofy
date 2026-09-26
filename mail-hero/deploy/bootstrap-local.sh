#!/usr/bin/env bash
set -euo pipefail
umask 077

command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
secret_dir="$script_dir/secrets"
local_env="$script_dir/local.env"

for target in "$local_env" "$secret_dir/local-postgres-password" "$secret_dir/local-database-url" "$secret_dir/local-mail-hero-key"; do
  [[ ! -e $target ]] || { echo "Refusing to overwrite existing $(basename "$target")." >&2; exit 1; }
done
install -d -m 0700 "$secret_dir"
db_password=$(openssl rand -hex 32)
printf '%s' "$db_password" > "$secret_dir/local-postgres-password"
printf 'postgres://mailhero:%s@127.0.0.1:5432/mailhero?sslmode=disable' "$db_password" > "$secret_dir/local-database-url"
openssl rand 32 > "$secret_dir/local-mail-hero-key"
chmod 0600 "$secret_dir/local-postgres-password" "$secret_dir/local-database-url" "$secret_dir/local-mail-hero-key"
unset db_password

cat > "$local_env" <<EOF
MAIL_HERO_RECEIVE_ADDRESS=hero@in.example.test
MAIL_HERO_DATABASE_URL_FILE=./deploy/secrets/local-database-url
MAIL_HERO_SECRET_KEY_FILE=./deploy/secrets/local-mail-hero-key
MAIL_HERO_HTTP_LISTEN=127.0.0.1:8080
MAIL_HERO_SMTP_LISTEN=127.0.0.1:2525
MAIL_HERO_DEV_AUTH_BYPASS=true
MAIL_HERO_ALLOW_INSECURE_SMTP=true
MAIL_HERO_FORCE_SEND_PAUSED=true
EOF
chmod 0600 "$local_env"
echo 'Created local development configuration. Run make local-db, then make local-run.'
