# Objects being deleted on purpose (README.md "Retiring an app"). prevent_destroy guards every instance of a resource
# block that is still declared, so dropping a key from local.owner_apps or local.d1_databases alone makes the plan fail.
# Each moved block below takes one retired instance to an address no resource block declares: the next plan deletes
# that object (a `delete`), and "Infra apply" still refuses it unless confirm_destructive is delete-replace-forget
# and expect names exactly these deletions. .github/scripts/infra_guard.py accepts such a move only for the exact
# pairs it lists in RETIRED. Remove a block, and its RETIRED pair, after the apply that deleted the object: once the
# state no longer holds the old address, the block does nothing.

# The Access application of a Worker that was deleted first (its hostname no longer serves anything).
moved {
  from = cloudflare_zero_trust_access_application.owner["lab"]
  to   = cloudflare_zero_trust_access_application.retired_lab
}

# That Worker's D1 database, with every row in it.
moved {
  from = cloudflare_d1_database.app["lab"]
  to   = cloudflare_d1_database.retired_lab
}
