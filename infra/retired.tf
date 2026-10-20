# Objects being deleted on purpose (README.md "Retiring an app"). prevent_destroy guards every instance of a resource
# block that is still declared, so dropping a key from local.owner_apps or local.d1_databases alone makes the plan fail.
# Each moved block below takes one retired instance to an address no resource block declares: the next plan deletes
# that object (a `delete`), and "Infra apply" still refuses it unless confirm_destructive is delete-replace-forget
# and expect names exactly these deletions. .github/scripts/infra_guard.py accepts such a move only for the exact
# pairs it lists in RETIRED. Remove a block, and its RETIRED pair, after the apply that deleted the object: once the
# state no longer holds the old address, the block does nothing.
#
# FlowDay (retired 2026-10-20; README.md "Retiring an app"): its two Access applications, the two reusable policies only
# they used, and its D1 database. The resource blocks are gone; these moves give each object an address without an
# instance key, so the redacted drift summary names every deletion exactly. Remove them, with their RETIRED pairs in
# .github/scripts/infra_guard.py, in the commit after the apply that deleted the objects.
moved {
  from = cloudflare_zero_trust_access_application.flowday["flowday"]
  to   = cloudflare_zero_trust_access_application.retired_flowday
}

moved {
  from = cloudflare_zero_trust_access_application.flowday["flowday-bypass"]
  to   = cloudflare_zero_trust_access_application.retired_flowday_bypass
}

moved {
  from = cloudflare_zero_trust_access_policy.flowday["flowday"]
  to   = cloudflare_zero_trust_access_policy.retired_flowday
}

moved {
  from = cloudflare_zero_trust_access_policy.flowday["flowday-bypass"]
  to   = cloudflare_zero_trust_access_policy.retired_flowday_bypass
}

moved {
  from = cloudflare_d1_database.app["flowday"]
  to   = cloudflare_d1_database.retired_flowday
}
