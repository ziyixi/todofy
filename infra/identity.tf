# Account IdPs used by these owner applications. Other account IdPs remain outside this state.
resource "cloudflare_zero_trust_access_identity_provider" "github" {
  count      = nonsensitive(var.access_github_oauth == null) ? 0 : 1
  account_id = var.account_id
  name       = var.access_github_oauth.name
  type       = "github"
  config = {
    client_id     = var.access_github_oauth.client_id
    client_secret = var.access_github_oauth.client_secret
  }
  lifecycle {
    prevent_destroy = true
    # Cloudflare does not return this field. Import must preserve the existing OAuth secret.
    ignore_changes = [config.client_secret]
  }
}

resource "cloudflare_zero_trust_access_identity_provider" "email" {
  count      = nonsensitive(var.access_github_oauth == null) ? 0 : 1
  account_id = var.account_id
  name       = var.access_email_idp_name
  type       = "onetimepin"
  config     = {}
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  owner_idps = nonsensitive(var.access_github_oauth == null) ? var.access_allowed_idp_ids : toset([
    cloudflare_zero_trust_access_identity_provider.github[0].id,
    cloudflare_zero_trust_access_identity_provider.email[0].id,
  ])
  github_idp = nonsensitive(var.access_github_oauth == null) ? var.access_github_idp_id : cloudflare_zero_trust_access_identity_provider.github[0].id
}
