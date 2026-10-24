# Cloudflare Access for the monorepo apps only. Every other Access application in the account (self-hosted
# services, the Warp login app) is outside the monorepo and is neither declared nor read here.
#
# Changing an application in a way that replaces it issues a new AUD, which every Worker's ACCESS_AUDIENCE
# (and the backup collector) would reject: an outage. Hence prevent_destroy on every application.

# --- Reusable policies -------------------------------------------------------------------------------
# Both policies are ALSO attached to Access applications outside the monorepo (self-hosted services).
# Any change here changes who can reach those too. This prototype never changes their identity rules:
# the include/require values come from sensitive variables holding the live values.

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id = var.account_id
  name       = "Mail Hero owner"
  decision   = "allow"
  include    = [for email in var.access_owner_emails : { email = { email = email } }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "github_owner" {
  account_id = var.account_id
  name       = "Mail Hero GitHub owner"
  decision   = "allow"
  include    = [for email in var.access_github_owner_emails : { email = { email = email } }]
  require    = [{ login_method = { id = local.github_idp } }]

  lifecycle {
    prevent_destroy = true
  }
}

# --- Owner-facing applications -----------------------------------------------------------------------
# Hostnames are the Workers Custom Domains declared in each app's wrangler.toml (wrangler owns the
# domains and their DNS; Access only gates them). The links app gates only its launcher and owner API under /_/ on
# its host; the rest of s.ziyixi.science (the short links) stays outside Access on purpose (links/docs/design.md).
# The watch app's application exists before its Worker's first deploy (W2, watch/docs/design.md section 11): created
# here first, its AUD is then committed as watch/wrangler.toml's ACCESS_AUDIENCE with the Custom Domain (README.md
# "Adding an app"). It gates the whole host, like the other owner apps.
#
# mailsort's application ("mailsort", sort.ziyixi.science) is created the same way, ahead of its Worker's first deploy:
# the apply creates it, then its AUD goes into config/resources.toml (tools/cloud-config/generate.py writes it into
# mailsort/wrangler.toml), its id into ids.tf, and mailsort leaves CHECK_ONLY in .github/scripts/ci_changes.py.
#
# recall's application ("recall", recall.ziyixi.science) is created the same way (recall/docs/design.md section 11),
# with the Bypass application of its three machine routes below.
#
# The brief's application ("brief", brief.ziyixi.science) is created the same way (brief/docs/design.md section 18),
# with the Bypass application of exactly its feedback path below.

# The key is the Worker's name, which is also the key of the access_aud output (outputs.tf). `domain` is the first
# destination; `more` lists any further destinations (the links app also gates the exact path /_).
locals {
  owner_apps = {
    # BEGIN service-catalog owner
    "brief"        = { name = "brief", domain = "brief.ziyixi.science", more = [], session = "24h" }
    "home"         = { name = "Home", domain = "home.ziyixi.science", more = [], session = "24h" }
    "fleet"        = { name = "Fleet", domain = "fleet.ziyixi.science", more = [], session = "24h" }
    "links"        = { name = "links", domain = "s.ziyixi.science/_/*", more = ["s.ziyixi.science/_"], session = "168h" }
    "mail-hero"    = { name = "Mail Hero", domain = "mail-hero.ziyixi.science", more = [], session = "24h" }
    "mailsort"     = { name = "mailsort", domain = "sort.ziyixi.science", more = [], session = "24h" }
    "personal-mcp" = { name = "Personal MCP", domain = "mcp.ziyixi.science", more = [], session = "24h" }
    "recall"       = { name = "recall", domain = "recall.ziyixi.science", more = [], session = "24h" }
    "tasks"        = { name = "tasks", domain = "tasks.ziyixi.science", more = [], session = "168h" }
    "todofy"       = { name = "Todofy", domain = "todofy.ziyixi.science", more = [], session = "24h" }
    "watch"        = { name = "watch", domain = "watch.ziyixi.science", more = [], session = "24h" }
    # END service-catalog owner
  }
}

resource "cloudflare_zero_trust_access_application" "owner" {
  for_each = local.owner_apps

  account_id                 = var.account_id
  name                       = each.value.name
  type                       = "self_hosted"
  domain                     = each.value.domain
  destinations               = [for uri in concat([each.value.domain], each.value.more) : { type = "public", uri = uri }]
  allowed_idps               = local.owner_idps
  app_launcher_visible       = true
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = true
  options_preflight_bypass   = false
  session_duration           = each.value.session

  # Private MCP only; existing applications retain null. Both exact ChatGPT redirects are used by
  # its documented issuer-aware flow and this owner's live connection form. No redirect wildcard.
  oauth_configuration = each.key == "personal-mcp" ? {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = false
      allow_any_on_loopback  = false
      allowed_uris           = ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/FSrczCNZCMHZ"]
    }
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "336h"
    }
  } : null

  policies = [
    { id = cloudflare_zero_trust_access_policy.owner.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.github_owner.id, precedence = 2 },
  ]

  lifecycle {
    prevent_destroy = true
  }
}

# --- Fleet machine receipt ---------------------------------------------------------------------------
# Only the exact receipt path bypasses interactive Access. The Worker independently verifies the
# content-free signed POST receipt and rejects every other method/path; no owner API is bypassed.
resource "cloudflare_zero_trust_access_policy" "fleet_receipt" {
  account_id = var.account_id
  name       = "Fleet signed receipt only"
  decision   = "bypass"
  include    = [{ everyone = {} }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "fleet_receipt" {
  account_id                  = var.account_id
  name                        = "Fleet machine receipt"
  type                        = "self_hosted"
  domain                      = "${local.fleet_hostname}/api/internal/fleet/v1/receipt"
  destinations                = [{ type = "public", uri = "${local.fleet_hostname}/api/internal/fleet/v1/receipt" }]
  allow_authenticate_via_warp = false
  app_launcher_visible        = false
  auto_redirect_to_identity   = false
  enable_binding_cookie       = false
  http_only_cookie_attribute  = true
  options_preflight_bypass    = false
  session_duration            = "24h"
  policies                    = [{ id = cloudflare_zero_trust_access_policy.fleet_receipt.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}

# --- recall machine routes ---------------------------------------------------------------------------
# Exactly recall's three machine routes bypass interactive Access (recall/docs/design.md section 2.1): the browser
# extension's uploads, and the archive consumers' change feed and blobs. Each route has its own bearer token, which the
# Worker compares by its SHA-256 digest before anything else, answering every other method and path under
# /api/machine/ itself (404, 405); the owner API and the UI stay behind the application "recall". Exact paths as
# Fleet's receipt has, and a wildcard only where the path carries a blob's archive path.
resource "cloudflare_zero_trust_access_policy" "recall_machine" {
  account_id = var.account_id
  name       = "recall machine routes only"
  decision   = "bypass"
  include    = [{ everyone = {} }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "recall_machine" {
  account_id = var.account_id
  name       = "recall machine routes"
  type       = "self_hosted"
  domain     = "recall.ziyixi.science/api/machine/v1/batches"
  destinations = [
    { type = "public", uri = "recall.ziyixi.science/api/machine/v1/batches" },
    { type = "public", uri = "recall.ziyixi.science/api/machine/v1/changes" },
    { type = "public", uri = "recall.ziyixi.science/api/machine/v1/blobs/*" },
  ]
  allow_authenticate_via_warp = false
  app_launcher_visible        = false
  auto_redirect_to_identity   = false
  enable_binding_cookie       = false
  http_only_cookie_attribute  = true
  options_preflight_bypass    = false
  session_duration            = "24h"
  policies                    = [{ id = cloudflare_zero_trust_access_policy.recall_machine.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}

# --- brief feedback -----------------------------------------------------------------------------------
# Exactly the brief's feedback path bypasses interactive Access (brief/docs/design.md section 10): the vote links of
# the daily email, opened from a phone's mail client. Each link carries an HMAC-signed token (issue, item, vote, expiry
# in 30 days) that the Worker verifies before anything else, answering a bad token and every other path below
# /feedback itself (404); a GET only shows a confirmation page and the vote is its form's POST, so a link scanner
# records nothing. The owner API and the archive stay behind the application "brief". The exact path, as Fleet's
# receipt has.
resource "cloudflare_zero_trust_access_policy" "brief_feedback" {
  account_id = var.account_id
  name       = "brief feedback only"
  decision   = "bypass"
  include    = [{ everyone = {} }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "brief_feedback" {
  account_id = var.account_id
  name       = "brief-feedback"
  type       = "self_hosted"
  domain     = "brief.ziyixi.science/feedback"
  destinations = [
    { type = "public", uri = "brief.ziyixi.science/feedback" },
  ]
  allow_authenticate_via_warp = false
  app_launcher_visible        = false
  auto_redirect_to_identity   = false
  enable_binding_cookie       = false
  http_only_cookie_attribute  = true
  options_preflight_bypass    = false
  session_duration            = "24h"
  policies                    = [{ id = cloudflare_zero_trust_access_policy.brief_feedback.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}

# --- Mail Hero backup API ----------------------------------------------------------------------------
# A path-scoped application in front of /api/internal/backup/* for the backup collector's machine
# identity (mail-hero/AGENTS.md §7). Its only policy is application-scoped (not reusable) and includes a
# service token. Neither that policy's rules nor the service token are managed here: a token created or
# replaced by OpenTofu would put its client secret in state, and replacing it silently breaks backups.

resource "cloudflare_zero_trust_access_application" "mail_hero_backup" {
  count                       = var.legacy_mail_hero_backup ? 1 : 0
  account_id                  = var.account_id
  name                        = "Mail Hero backup API"
  type                        = "self_hosted"
  domain                      = "mail-hero.ziyixi.science/api/internal/backup/*"
  destinations                = [{ type = "public", uri = "mail-hero.ziyixi.science/api/internal/backup/*" }]
  allow_authenticate_via_warp = false
  app_launcher_visible        = false
  auto_redirect_to_identity   = false
  enable_binding_cookie       = false
  http_only_cookie_attribute  = true
  options_preflight_bypass    = false
  session_duration            = "24h"

  # The application-scoped policy "Mail Hero backup collector only" (decision non_identity, includes the
  # backup collector's service token). The provider reads application-scoped policies back as an id
  # reference only, so the reference is what OpenTofu tracks; the policy's rules and the service token
  # are not managed here (README.md "Import notes").
  policies = [
    { id = "e97edddb-7b26-4712-b8ee-67483bc59e70", precedence = 1 },
  ]

  lifecycle {
    prevent_destroy = true
  }
}

# A state-address change only. Existing account policy/credentials stay frozen.
moved {
  from = cloudflare_zero_trust_access_application.mail_hero_backup
  to   = cloudflare_zero_trust_access_application.mail_hero_backup[0]
}

# Only these two machine POST routes bypass interactive login. The Worker verifies
# CLASSIFICATION_TOKEN_SHA256 before reading a body; the owner application keeps its policies.
resource "cloudflare_zero_trust_access_policy" "mailsort_machine" {
  account_id = var.account_id
  name       = "mailsort classification routes only"
  decision   = "bypass"
  include    = [{ everyone = {} }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "mailsort_machine" {
  account_id = var.account_id
  name       = "mailsort machine classification"
  type       = "self_hosted"
  domain     = "${local.owner_apps["mailsort"].domain}/api/machine/v1/classification:claim"
  destinations = [
    { type = "public", uri = "${local.owner_apps["mailsort"].domain}/api/machine/v1/classification:claim" },
    { type = "public", uri = "${local.owner_apps["mailsort"].domain}/api/machine/v1/classification:report" },
  ]
  allow_authenticate_via_warp = false
  app_launcher_visible        = false
  auto_redirect_to_identity   = false
  enable_binding_cookie       = false
  http_only_cookie_attribute  = true
  options_preflight_bypass    = false
  session_duration            = "24h"
  policies                    = [{ id = cloudflare_zero_trust_access_policy.mailsort_machine.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}
