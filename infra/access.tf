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
# domains and their DNS; Access only gates them). The links app gates only its launcher and owner API under /_/ on
# its host; the rest of s.ziyixi.science (the short links) stays outside Access on purpose (links/docs/design.md).

# The key is the Worker's name, which is also the key of the access_aud output (outputs.tf). `domain` is the first
# destination; `more` lists any further destinations (the links app also gates the exact path /_).
locals {
  owner_apps = {
    "mail-hero" = { name = "Mail Hero", domain = "mail-hero.ziyixi.science", more = [], session = "24h" }
    "todofy"    = { name = "Todofy", domain = "todofy.ziyixi.science", more = [], session = "24h" }
    "home"      = { name = "Home", domain = "home.ziyixi.science", more = [], session = "24h" }
    "lab"       = { name = "Lab", domain = "lab.ziyixi.science", more = [], session = "24h" }
    "links"     = { name = "links", domain = "s.ziyixi.science/_/*", more = ["s.ziyixi.science/_"], session = "168h" }
  }
}

resource "cloudflare_zero_trust_access_application" "owner" {
  for_each = local.owner_apps

  account_id                 = var.account_id
  name                       = each.value.name
  type                       = "self_hosted"
  domain                     = each.value.domain
  destinations               = [for uri in concat([each.value.domain], each.value.more) : { type = "public", uri = uri }]
  allowed_idps               = var.access_allowed_idp_ids
  app_launcher_visible       = true
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = true
  options_preflight_bypass   = false
  session_duration           = each.value.session

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

# --- FlowDay -----------------------------------------------------------------------------------------
# The two Access applications FlowDay brought with it when it moved into the monorepo (flowday/docs/design.md): the
# host, and its exact PWA files under /pwa/* (manifest, service worker, icons), which must load without a login. The
# F3 staging host flowday-next.ziyixi.science left both after the F4 cutover (an in-place update, never a replacement:
# README.md "FlowDay").
#
# Each application uses its own reusable policy that FlowDay created before the move and that no other application
# uses. Those policies are referenced by id only and their rules are not managed here (README.md "FlowDay"), like the
# backup app's policy above.

locals {
  flowday_apps = {
    "flowday" = {
      destinations = ["flowday.ziyixi.science"]
      session      = "168h"
      policy_id    = "841d2527-c836-4c76-a3dd-40e64247947d"
    }
    "flowday-bypass" = {
      destinations = ["flowday.ziyixi.science/pwa/*"]
      session      = "6h"
      policy_id    = "a8aa0aa2-d3dd-4d25-8b41-3b570a1ab83f"
    }
  }
}

resource "cloudflare_zero_trust_access_application" "flowday" {
  for_each = local.flowday_apps

  account_id                 = var.account_id
  name                       = each.key
  type                       = "self_hosted"
  domain                     = each.value.destinations[0]
  destinations               = [for uri in each.value.destinations : { type = "public", uri = uri }]
  app_launcher_visible       = true
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = false
  options_preflight_bypass   = false
  session_duration           = each.value.session

  policies = [
    { id = each.value.policy_id, precedence = 1 },
  ]

  lifecycle {
    prevent_destroy = true
  }
}
