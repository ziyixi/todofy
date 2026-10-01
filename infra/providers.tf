# The token comes only from the CLOUDFLARE_API_TOKEN environment variable (never a file or a variable here).
# Today (owner decision 2026-10-01): the existing deploy token, CF_API_TOKEN in .github/workflows/infra.yml and
# the admin helper's token file for the local bootstrap. Later: CF_INFRA_READ_TOKEN for plans and
# CF_INFRA_TOKEN for P4's apply on main. See README.md "Replacing the token".
provider "cloudflare" {}
