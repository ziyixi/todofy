# The ids of the objects infra/ manages, committed on purpose (README.md "Variables": D1 ids are already public in
# each wrangler.toml). No configuration reads them: the objects are in the remote state since the first P4 apply, and
# the import {} blocks that adopted them were removed afterwards (README.md "Removing the import blocks";
# `git show <that commit>~1:infra/imports.tf` restores them for a rebuild by import). They stay as the record of what
# each address adopted, and .github/scripts/test_infra_config.py compares the D1 ids with the wrangler.toml files on
# every push. README.md "Import notes" records each import.

# Fleet's owner and exact receipt application/policy were created by gated IaC before its first Worker deploy.
# Their actual IDs were verified with exact-name/domain Access reads and recorded in config/resources.toml.
locals {
  access_policy_ids = {
    "owner"         = "018f1a13-1a1b-4cf6-a470-c865c4577851"
    "github_owner"  = "eea00ced-7de7-4094-a705-c9741d835b7c"
    "fleet_receipt" = "fb3608f4-bf0e-4db8-8983-5fb1340f20d5"
  }
  mail_hero_backup_app_id = "dafc6e08-7b1b-461f-8735-2cfa668a0ce0"
  fleet_receipt_app_id    = "e468db67-b8aa-4be4-9961-6965a5fced5d"
  access_app_ids = {
    "fleet"     = "03c9b2a9-05c5-49fa-9ffa-8ece99952894"
    "mail-hero" = "ebd92116-4d51-4d90-923a-068b05b7e05a"
    "todofy"    = "d4010b0b-c50e-487b-992e-6e30a392f603"
    "home"      = "f190b413-241d-428d-8680-53eebe7f672d"
    "links"     = "a6e2a6e3-b432-4093-ac20-0211ca180dce"
    # Created by "Infra apply", not imported (README.md "Adding an app"); the id read in step 4, with the AUD in
    # watch/wrangler.toml.
    "watch" = "7d5134ca-1362-4fa3-9c84-d2ee9afb656c"
  }
  flowday_app_ids = {
    "flowday"        = "3d956afb-07ea-4b5e-802e-27fd29ca4587"
    "flowday-bypass" = "d63df372-28d1-4a88-a7b4-b31449d1592b"
  }
  d1_database_ids = {
    "mail-hero" = "6c13e4c3-e239-42fb-a7a4-96810fa8d7dc"
    "todofy"    = "151c1306-3885-4679-9592-08887b30ae68"
    "flowday"   = "df104e83-7183-47e3-b2f9-638dc7502c13"
    "links"     = "2f8c5331-06ce-4347-8c0a-90fe51c82260"
  }
}
