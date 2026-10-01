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
  require    = [{ login_method = { id = var.access_github_idp_id } }]

  lifecycle {
    prevent_destroy = true
  }
}

# --- Owner-facing applications -----------------------------------------------------------------------
# Hostnames are the Workers Custom Domains declared in each app's wrangler.toml (wrangler owns the
# domains and their DNS; Access only gates them).

locals {
  owner_apps = {
    "mail-hero" = { name = "Mail Hero", domain = "mail-hero.ziyixi.science" }
    "todofy"    = { name = "Todofy", domain = "todofy.ziyixi.science" }
    "home"      = { name = "Home", domain = "home.ziyixi.science" }
    "lab"       = { name = "Lab", domain = "lab.ziyixi.science" }
  }
}

resource "cloudflare_zero_trust_access_application" "owner" {
  for_each = local.owner_apps

  account_id                 = var.account_id
  name                       = each.value.name
  type                       = "self_hosted"
  domain                     = each.value.domain
  destinations               = [{ type = "public", uri = each.value.domain }]
  allowed_idps               = var.access_allowed_idp_ids
  app_launcher_visible       = true
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = true
  options_preflight_bypass   = false
  session_duration           = "24h"

  policies = [
    { id = cloudflare_zero_trust_access_policy.owner.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.github_owner.id, precedence = 2 },
  ]

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
