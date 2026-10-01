# Adopt the existing objects. With local or (later) remote state, a plan that still contains these blocks
# reports them as "import" until an apply records them; after the first P4 apply they are no-ops and may be
# deleted. The ids are opaque ids of the objects infra/ manages, committed on purpose (README.md
# "Variables": D1 ids are already public in each wrangler.toml); the account id comes from a variable. Written by hand from the read-only API inventory (cf-terraforming was not needed
# for 13 objects); README.md "Import notes" records each one.

locals {
  access_app_ids = {
    "mail-hero" = "ebd92116-4d51-4d90-923a-068b05b7e05a"
    "todofy"    = "d4010b0b-c50e-487b-992e-6e30a392f603"
    "home"      = "f190b413-241d-428d-8680-53eebe7f672d"
    "lab"       = "208a0a3b-6654-4b1f-9b1d-821493171f4d"
  }
  d1_database_ids = {
    "mail-hero" = "6c13e4c3-e239-42fb-a7a4-96810fa8d7dc"
    "todofy"    = "151c1306-3885-4679-9592-08887b30ae68"
    "lab"       = "f20238dc-93a4-4d1a-91c4-c013f01cbdc9"
  }
}

import {
  to = cloudflare_zero_trust_access_policy.owner
  id = "${var.account_id}/018f1a13-1a1b-4cf6-a470-c865c4577851"
}

import {
  to = cloudflare_zero_trust_access_policy.github_owner
  id = "${var.account_id}/eea00ced-7de7-4094-a705-c9741d835b7c"
}

import {
  for_each = local.access_app_ids
  to       = cloudflare_zero_trust_access_application.owner[each.key]
  id       = "accounts/${var.account_id}/${each.value}"
}

import {
  to = cloudflare_zero_trust_access_application.mail_hero_backup
  id = "accounts/${var.account_id}/dafc6e08-7b1b-461f-8735-2cfa668a0ce0"
}

import {
  for_each = local.d1_database_ids
  to       = cloudflare_d1_database.app[each.key]
  id       = "${var.account_id}/${each.value}"
}

import {
  for_each = local.r2_buckets
  to       = cloudflare_r2_bucket.app[each.key]
  id       = "${var.account_id}/${each.key}/default"
}
