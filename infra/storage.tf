# Existence only: the D1 databases and R2 buckets the monorepo apps bind to. Schemas (D1 migrations), data
# and bindings stay with each app's wrangler.toml and CI. prevent_destroy on all of them: a destroyed
# database or bucket is data loss, and a recreated one has a new id that no wrangler.toml knows.
#
# R2 lifecycle rules are deliberately NOT modelled (README.md "Storage"): each bucket has only Cloudflare's
# default multipart-abort rule, cloudflare_r2_bucket_lifecycle cannot be imported (an apply would PUT the
# whole rule set), and time-based expiry must never be added to these buckets.

locals {
  # name => the app whose wrangler.toml binds it
  d1_databases = {
    "mail-hero" = "mail-hero"
    "todofy"    = "todofy (todofy-core)"
    "lab"       = "lab"
  }
  r2_buckets = {
    "mail-hero-store"   = "mail-hero (MAIL_STORE)"
    "mail-hero-backups" = "mail-hero (BACKUP_STORE)"
    "todofy-backups"    = "todofy-core (BACKUPS)"
  }
}

resource "cloudflare_d1_database" "app" {
  for_each = local.d1_databases

  account_id = var.account_id
  name       = each.key
  # As created; switching read replication on is a deliberate change (Workers Free D1 limits).
  read_replication = { mode = "disabled" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "app" {
  for_each = local.r2_buckets

  account_id = var.account_id
  name       = each.key

  lifecycle {
    prevent_destroy = true
  }
}
