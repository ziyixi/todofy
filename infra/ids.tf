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
    "owner"                  = "018f1a13-1a1b-4cf6-a470-c865c4577851"
    "github_owner"           = "eea00ced-7de7-4094-a705-c9741d835b7c"
    "fleet_receipt"          = "fb3608f4-bf0e-4db8-8983-5fb1340f20d5"
    "recall_machine"         = "dcd778e7-e901-4638-8ced-bfe119a470c6"
    "model_router_inference" = "097fe721-2615-4cfa-847b-9f0d0448dd79"
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
    "watch"              = "7d5134ca-1362-4fa3-9c84-d2ee9afb656c"
    "mailsort"           = "3d8f08e0-1327-4408-99c8-2431abed5892"
    "recall"             = "abe1f041-0786-4a3d-9ce5-72ce418627a5"
    "tasks"              = "1cf91393-a308-4b4a-bcb0-962bc2840ea3"
    "personal-mcp"       = "0ae92f11-d672-4c2c-b511-83fb3e73b68e"
    "model-router"       = "fef4b5c4-d15d-47f7-b8c0-69ac89db7bf0"
    "newsletter-console" = "dca06c66-01f2-4d04-a61a-c4ba0b8ac174"
  }
  d1_database_ids = {
    "mail-hero"    = "6c13e4c3-e239-42fb-a7a4-96810fa8d7dc"
    "todofy"       = "151c1306-3885-4679-9592-08887b30ae68"
    "links"        = "2f8c5331-06ce-4347-8c0a-90fe51c82260"
    "tasks"        = "79a1f345-1183-46c3-bc6a-651be106f90c"
    "model-router" = "79388b2a-1d62-49ad-9536-fb4cacd6c777"
  }
}
