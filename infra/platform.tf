# The authenticated daemon HTTPS API; the Kubernetes API is not routed. This tunnel is independent of the existing SSH tunnel.
# Credentials live only in the encrypted state and the owner's encrypted bootstrap artifact.
resource "cloudflare_zero_trust_access_service_token" "platform_deploy" {
  account_id = var.account_id
  name       = "Todofy namespace deployment"
  duration   = "forever"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "platform_deploy" {
  account_id = var.account_id
  name       = "Todofy namespace deployment only"
  decision   = "non_identity"
  include = [{ service_token = {
    token_id = cloudflare_zero_trust_access_service_token.platform_deploy.id
  } }]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  platform_machine_hosts = {
    "runtime" = local.platform_runtime_hostname
  }
}

resource "cloudflare_zero_trust_access_application" "platform_machine" {
  for_each = local.platform_machine_hosts

  account_id                 = var.account_id
  name                       = "Todofy ${each.key} machine API"
  type                       = "self_hosted"
  domain                     = each.value
  destinations               = [{ type = "public", uri = each.value }]
  app_launcher_visible       = false
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = true
  session_duration           = "24h"
  policies                   = [{ id = cloudflare_zero_trust_access_policy.platform_deploy.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_service_token" "codex_gateway" {
  account_id = var.account_id
  name       = "Codex inference only"
  duration   = "forever"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "codex_gateway" {
  account_id = var.account_id
  name       = "Codex inference service only"
  decision   = "non_identity"
  include = [{ service_token = {
    token_id = cloudflare_zero_trust_access_service_token.codex_gateway.id
  } }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "codex_gateway" {
  account_id                 = var.account_id
  name                       = "Codex inference machine API"
  type                       = "self_hosted"
  domain                     = "${local.platform_runtime_hostname}/api/codex/v1/*"
  destinations               = [{ type = "public", uri = "${local.platform_runtime_hostname}/api/codex/v1/*" }]
  app_launcher_visible       = false
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = true
  session_duration           = "24h"
  policies                   = [{ id = cloudflare_zero_trust_access_policy.codex_gateway.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "platform" {
  account_id = var.account_id
  name       = "todofy-private-platform"
  config_src = "cloudflare"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "platform" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.platform.id
  config = {
    ingress = [
      {
        hostname = local.platform_runtime_hostname
        path     = "/api/codex/v1/.*"
        service  = "http://127.0.0.1:18766"
        origin_request = {
          access = {
            required  = true
            aud_tag   = [cloudflare_zero_trust_access_application.codex_gateway.aud]
            team_name = local.platform_access_team
          }
        }
      },
      # Newsletter's owner read API: the Newsletter console's own owner application (access.tf, its runtime
      # destination) admits the path, and the connector requires that application's audience too.
      {
        hostname = local.platform_runtime_hostname
        path     = "/api/newsletter/v1/.*"
        service  = "http://127.0.0.1:18767"
        origin_request = {
          access = {
            required  = true
            aud_tag   = [cloudflare_zero_trust_access_application.owner["newsletter-console"].aud]
            team_name = local.platform_access_team
          }
        }
      },
      {
        hostname = local.platform_runtime_hostname
        service  = "http://127.0.0.1:18765"
        origin_request = {
          access = {
            required  = true
            aud_tag   = [cloudflare_zero_trust_access_application.platform_machine["runtime"].aud]
            team_name = local.platform_access_team
          }
        }
      },
      { service = "http_status:404" },
    ]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "platform" {
  for_each = local.platform_machine_hosts

  zone_id = local.platform_zone_id
  name    = each.value
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.platform.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
  }
}

# Never print this output. The private exporter encrypts it to a one-time owner certificate.
output "platform_bootstrap" {
  sensitive = true
  value = {
    client_id     = cloudflare_zero_trust_access_service_token.platform_deploy.client_id
    client_secret = cloudflare_zero_trust_access_service_token.platform_deploy.client_secret
    tunnel_id     = cloudflare_zero_trust_tunnel_cloudflared.platform.id
  }
}

output "codex_gateway_bootstrap" {
  sensitive = true
  value = {
    client_id     = cloudflare_zero_trust_access_service_token.codex_gateway.client_id
    client_secret = cloudflare_zero_trust_access_service_token.codex_gateway.client_secret
    app_id        = cloudflare_zero_trust_access_application.codex_gateway.id
    audience      = cloudflare_zero_trust_access_application.codex_gateway.aud
  }
}
