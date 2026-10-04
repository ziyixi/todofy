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

# Legacy selected-IdP references. Bootstrap imports these exact objects and then uses managed IDs;
# null access_github_oauth preserves older private inputs during that transition.
variable "access_allowed_idp_ids" {
  description = "Identity provider ids allowed on the owner-facing Access applications (Mail Hero, Todofy, Home, Lab, links)."
  type        = set(string)
  default     = []
}

variable "access_github_idp_id" {
  description = "The GitHub identity provider id, required by the \"Mail Hero GitHub owner\" policy."
  type        = string
  default     = ""
}

# Null preserves an existing account's external IdP references. Fresh bootstrap supplies the GitHub
# OAuth application once; API reads never return its secret after creation.
variable "access_github_oauth" {
  type      = object({ client_id = string, client_secret = optional(string, ""), name = optional(string, "GitHub") })
  sensitive = true
  default   = null
}

variable "access_email_idp_name" {
  type    = string
  default = "One-time PIN"
}

variable "flowday_policy_names" {
  type    = map(string)
  default = { flowday = "FlowDay owner", flowday-bypass = "FlowDay PWA files" }
}

variable "flowday_policy_options" {
  type = map(object({
    session_duration = optional(string)
    connection_rules = optional(object({
      rdp = optional(object({
        allowed_clipboard_local_to_remote_formats = optional(list(string))
        allowed_clipboard_remote_to_local_formats = optional(list(string))
      }))
    }))
  }))
  default = { flowday = { session_duration = "24h" }, flowday-bypass = {} }
}

variable "legacy_mail_hero_backup" {
  type    = bool
  default = true
}

variable "mail_route_ready" {
  type    = bool
  default = false
}

variable "mail_receive_address" {
  type      = string
  sensitive = true
  default   = ""
}

variable "mail_route_name" {
  type      = string
  sensitive = true
  default   = "Mail Hero inbox"
}

# The state and plan encryption passphrase (versions.tf "encryption"). No default: a run without it fails.
variable "state_passphrase" {
  description = "OpenTofu state and plan encryption passphrase (GitHub secret INFRA_STATE_PASSPHRASE)."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "The state passphrase must have at least 16 characters."
  }
}
