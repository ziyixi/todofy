# No DNS record is managed here, deliberately (infra/README.md "DNS"). Checked against the live zone on
# 2026-10-01: every record a monorepo app depends on is already owned by something else.
#
# - The apps' hostnames (mail-hero, todofy, todofy-hooks, daily, home, lab, www and the apex) are Workers
#   Custom Domains: wrangler creates their read-only AAAA records from each app's wrangler.toml.
# - Mail Hero's receive subdomain: its MX, DKIM and SPF records belong to Email Routing (created by it,
#   read-only or Email-Routing-managed), which stays out of OpenTofu.
# - Everything else in the zone (the apex mailbox records, third-party verification TXT records, the
#   self-hosted services' tunnel hostnames) is outside the monorepo and must not be declared or read here.
#
# Add a cloudflare_dns_record only for a record that a monorepo app needs AND that neither wrangler nor
# Email Routing owns (for example a future sending-domain DKIM record), with its value from a variable,
# and extend ALLOWED_TYPES in .github/scripts/test_infra_config.py in the same change.
