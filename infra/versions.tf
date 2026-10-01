terraform {
  # CI installs exactly 1.12.6 (.github/workflows/ci.yml "Infra checks").
  required_version = ">= 1.12.0, < 1.13.0"

  required_providers {
    cloudflare = {
      # registry.opentofu.org/cloudflare/cloudflare, pinned to an exact version with hashes for
      # darwin_arm64 and linux_amd64 in .terraform.lock.hcl. 5.25.0, not 5.26.0: 5.26.0 has open DNS
      # regressions (provider issues #7387, #7396). Upgrade only deliberately, with a zero-diff plan.
      source  = "cloudflare/cloudflare"
      version = "5.25.0"
    }
  }

  # ---------------------------------------------------------------------------------------------------
  # NOT ENABLED YET (P3, README.md "Next steps"). Today the state is local and lives outside the repository.
  #
  # Remote state in a private R2 bucket "infra-state" (to be created in P3), via the S3 backend with a
  # partial configuration: the endpoint (it contains the account id) and the credentials come from
  # `-backend-config=` / AWS_* environment variables in CI, never from this file.
  #
  # backend "s3" {
  #   bucket                      = "infra-state"
  #   key                         = "monorepo/terraform.tfstate"
  #   region                      = "auto"
  #   use_path_style              = true
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_s3_checksum            = true
  #   # use_lockfile = true   # only after a concurrency test proves R2 honours If-None-Match: *
  #   # endpoints = { s3 = "https://<account id>.r2.cloudflarestorage.com" }   # -backend-config, not here
  # }
  #
  # Client-side state AND plan encryption. The passphrase is the GitHub secret INFRA_STATE_PASSPHRASE
  # (the owner keeps an offline copy), passed as TF_VAR_state_passphrase; uncomment the variable
  # "state_passphrase" in variables.tf together with this block. Start the remote state fresh (import
  # again in CI) so no unencrypted fallback is needed.
  #
  # encryption {
  #   key_provider "pbkdf2" "state" {
  #     passphrase = var.state_passphrase
  #   }
  #   method "aes_gcm" "state" {
  #     keys = key_provider.pbkdf2.state
  #   }
  #   state {
  #     method   = method.aes_gcm.state
  #     enforced = true
  #   }
  #   plan {
  #     method   = method.aes_gcm.state
  #     enforced = true
  #   }
  # }
  # ---------------------------------------------------------------------------------------------------
}
