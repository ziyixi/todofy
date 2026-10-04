# One exact address on the dedicated inbox subdomain. Its DNS is enabled once in the official UI.
# No Email Routing DNS/settings resource is used: the root domain's existing MX/TXT/DKIM stays outside IaC.
resource "cloudflare_email_routing_rule" "mail_hero" {
  count    = var.mail_route_ready ? 1 : 0
  zone_id  = local.platform_zone_id
  name     = var.mail_route_name
  enabled  = true
  priority = 0
  source   = "api"
  matchers = [{ type = "literal", field = "to", value = var.mail_receive_address }]
  actions  = [{ type = "worker", value = ["mail-hero"] }]
  lifecycle {
    prevent_destroy = true
  }
}
