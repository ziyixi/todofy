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

  # Remote state in the private R2 bucket "infra-state", one object per environment, through the S3 backend
  # with a partial configuration. Not in this file, on purpose:
  # - key: `-backend-config=key=<environment>/terraform.tfstate` (scripts/infra_state.py);
  # - endpoint: AWS_ENDPOINT_URL_S3=https://<account id>.r2.cloudflarestorage.com (it contains the account id);
  # - credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, derived from the Cloudflare API token at runtime
  #   (README.md "Remote state").
  # No lock file: R2's conditional writes (If-None-Match: *) are not proven for this bucket yet, so
  # .github/workflows/infra.yml serialises runs with the GitHub concurrency group infra-production instead.
  # bootstrap_state.py probes conditional writes; enable use_lockfile only in a later change, after it passes.
  backend "s3" {
    bucket                      = "infra-state"
    region                      = "auto"
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  # Client-side state AND plan encryption, enforced: without the passphrase every command that reads or
  # writes state or a plan fails, and there is no fallback block, so nothing is ever read or written
  # unencrypted. The passphrase is the GitHub secret INFRA_STATE_PASSPHRASE (the owner keeps a copy), passed
  # as TF_VAR_state_passphrase. scripts/infra_state.py strips TF_ENCRYPTION from tofu's environment, because
  # that variable could add a fallback behind this file. .github/scripts/infra_guard.py rejects a backend
  # without this block, a fallback, an unencrypted method or a non-sensitive passphrase variable.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
