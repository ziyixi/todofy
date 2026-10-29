# Objects being deleted on purpose (README.md "Retiring an app"). prevent_destroy guards every instance of a resource
# block that is still declared, so dropping a key from local.owner_apps or local.d1_databases alone makes the plan fail.
# Each moved block below takes one retired instance to an address no resource block declares: the next plan deletes
# that object (a `delete`), and "Infra apply" still refuses it unless confirm_destructive is delete-replace-forget
# and expect names exactly these deletions. .github/scripts/infra_guard.py accepts such a move only for the exact
# pairs it lists in RETIRED. Remove a block, and its RETIRED pair, after the apply that deleted the object: once the
# state no longer holds the old address, the block does nothing.
#
# A reusable Access policy never moves: an application's state records that it depends on its policies, and OpenTofu
# does not rewrite that record on a move, so moving the policy would let the apply delete it before or alongside the
# application that still uses it, which Cloudflare refuses. A policy only the retired app used leaves with its whole
# resource block, keeps its old address, and is deleted after the application.
#
# No app is being retired now: Brief's two Access applications and the policy only its feedback application used
# were deleted by the apply of 2026-10-29.
