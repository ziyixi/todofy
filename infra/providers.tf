# The token comes only from the CLOUDFLARE_API_TOKEN environment variable (never a file or a variable here).
# Today: the owner's read-only use of the bootstrap token for local plans. P3: CF_INFRA_READ_TOKEN in CI.
# P4: CF_INFRA_TOKEN for apply on main. See README.md.
provider "cloudflare" {}
