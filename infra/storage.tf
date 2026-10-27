# Existence only: the D1 databases and R2 buckets the monorepo apps bind to. Schemas (D1 migrations), data
# and bindings stay with each app's wrangler.toml and CI. prevent_destroy on all of them: a destroyed
# database or bucket is data loss, and a recreated one has a new id that no wrangler.toml knows.
#
# Existing mail, archive and backup buckets keep their own retention contracts. Only the new Model Router body
# bucket has the explicitly approved seven-day lifecycle below; it contains no application source of record.

locals {
  # name => the app whose wrangler.toml binds it
  d1_databases = {
    "mail-hero"    = "mail-hero"
    "todofy"       = "todofy (todofy-core)"
    "links"        = "links"
    "tasks"        = "tasks"
    "model-router" = "model-router"
  }
  r2_buckets = {
    "mail-hero-store"             = "mail-hero (MAIL_STORE)"
    "mail-hero-backups"           = "mail-hero (BACKUP_STORE)"
    "todofy-backups"              = "todofy-core (BACKUPS)"
    "recall-store"                = "recall (STORE)"
    "tasks-backups"               = "tasks (BACKUPS)"
    "watch-evidence"              = "watch (EVIDENCE_STORE)"
    "model-router-request-bodies" = "model-router (REQUEST_BODIES)"
    "model-router-backups"        = "model-router (BACKUPS)"
  }
}

# Seven daily copies of history and retained request bodies, as requested by the owner.
resource "cloudflare_r2_bucket_lifecycle" "model_router_backups" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.app["model-router-backups"].name
  rules = [
    {
      id                                 = "Default Multipart Abort Rule"
      enabled                            = true
      conditions                         = { prefix = "" }
      abort_multipart_uploads_transition = { condition = { type = "Age", max_age = 604800 } }
    },
    {
      id                        = "Expire daily inference backups after seven days"
      enabled                   = true
      conditions                = { prefix = "" }
      delete_objects_transition = { condition = { type = "Age", max_age = 604800 } }
    },
  ]
  lifecycle {
    prevent_destroy = true
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

# Pinned provider 5.25.0: ages are seconds. This complete rule set belongs only to the new private body bucket.
resource "cloudflare_r2_bucket_lifecycle" "model_router_request_bodies" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.app["model-router-request-bodies"].name
  rules = [
    {
      id                                 = "Default Multipart Abort Rule"
      enabled                            = true
      conditions                         = { prefix = "" }
      abort_multipart_uploads_transition = { condition = { type = "Age", max_age = 604800 } }
    },
    {
      id                        = "Expire private inference bodies after seven days"
      enabled                   = true
      conditions                = { prefix = "" }
      delete_objects_transition = { condition = { type = "Age", max_age = 604800 } }
    },
  ]
  lifecycle {
    prevent_destroy = true
  }
}
