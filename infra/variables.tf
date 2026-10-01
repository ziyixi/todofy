# Every value here comes from a tfvars file outside the repository (locally) or from GitHub secrets and
# variables (CI, P3/P4). Nothing personal or account-specific is committed: see README.md "Variables".

variable "account_id" {
  description = "Cloudflare account that owns the monorepo apps' Access applications, D1 databases and R2 buckets."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hex Cloudflare account id."
  }
}

# Identity rules of the two reusable Access policies. These are the owner's personal addresses: sensitive,
# so plan output shows "(sensitive value)" for every attribute derived from them.
variable "access_owner_emails" {
  description = "Emails included by the reusable Access policy \"Mail Hero owner\" (any login method)."
  type        = list(string)
  sensitive   = true
  validation {
    condition     = length(var.access_owner_emails) > 0
    error_message = "The owner policy must include at least one email."
  }
}

variable "access_github_owner_emails" {
  description = "Emails included by the reusable Access policy \"Mail Hero GitHub owner\" (GitHub login only)."
  type        = list(string)
  sensitive   = true
  validation {
    condition     = length(var.access_github_owner_emails) > 0
    error_message = "The GitHub owner policy must include at least one email."
  }
}

# Opaque identifiers of account objects this configuration references but does not manage (identity
# providers). Not secret, but kept out of the public repository
# with the rest of the account-specific values.
variable "access_allowed_idp_ids" {
  description = "Identity provider ids allowed on the owner-facing Access applications (Mail Hero, Todofy, Home, Lab)."
  type        = set(string)
}

variable "access_github_idp_id" {
  description = "The GitHub identity provider id, required by the \"Mail Hero GitHub owner\" policy."
  type        = string
}

# NOT ENABLED YET (P3): the state/plan encryption passphrase, with the encryption block in versions.tf.
#
# variable "state_passphrase" {
#   description = "OpenTofu state and plan encryption passphrase (GitHub secret INFRA_STATE_PASSPHRASE)."
#   type        = string
#   sensitive   = true
# }
