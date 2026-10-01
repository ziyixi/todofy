"""Tests for infra_guard.py on synthetic configurations: python3 -m unittest discover -s .github/scripts

Each case is a way to slip something past a line-regex guard (bare block labels, a .tofu file, a nested
data source, a borrowed prevent_destroy, an unencrypted backend, a plan file under an unusual name). The
guard must report every one. No OpenTofu, no network, any python3 (3.9+).
"""

import tempfile
import textwrap
import unittest
from pathlib import Path

import infra_guard

BASE = {
    "versions.tf": """
        terraform {
          required_providers {
            cloudflare = { source = "cloudflare/cloudflare", version = "5.25.0" }
          }
        }
    """,
    "storage.tf": """
        # A comment with resource "terraform_data" "x" { provisioner "local-exec" {} } in it is fine.
        resource "cloudflare_r2_bucket" "app" {
          name = "x-${var.y}-\\"quoted\\" {"
          lifecycle {
            prevent_destroy = true
          }
        }
        resource cloudflare_d1_database app {
          name = <<-EOT
            resource "terraform_data" "in_a_heredoc" {}
          EOT
          lifecycle { prevent_destroy = true }
        }
    """,
}
TERRAFORM_DATA = """
    resource terraform_data run {
      provisioner local-exec {
        command = "echo hi"
      }
      lifecycle { prevent_destroy = true }
    }
"""
OUTSIDE_RECORD = """
    resource "cloudflare_dns_record" "outside" {
      name = "outside"
    }
"""


def run(extra=None, drop=()):
    files = {name: text for name, text in BASE.items() if name not in drop}
    files.update(extra or {})
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(textwrap.dedent(text))
        return infra_guard.check(root)


class Guard(unittest.TestCase):
    def assert_flags(self, extra, needle, drop=()):
        problems = run(extra, drop)
        self.assertTrue(any(needle in problem for problem in problems), problems)

    def test_the_base_fixture_passes(self):
        self.assertEqual(run(), [])

    def test_bare_labels_are_read_like_quoted_ones(self):
        self.assert_flags({"extra.tf": TERRAFORM_DATA}, "resource type outside the monorepo boundary")
        self.assert_flags({"extra.tf": TERRAFORM_DATA}, "nested provisioner block")
        self.assert_flags({"extra.tf": TERRAFORM_DATA.replace("run {", '"run" {')}, "nested provisioner block")

    def test_an_out_of_scope_resource_without_prevent_destroy(self):
        self.assert_flags({"extra.tf": OUTSIDE_RECORD}, "resource type outside the monorepo boundary")
        self.assert_flags({"extra.tf": OUTSIDE_RECORD.replace('"cloudflare_dns_record" "outside"', "cloudflare_dns_record outside")},
                          "without its own lifecycle")

    def test_prevent_destroy_cannot_be_borrowed(self):
        borrowed = """
            resource "cloudflare_r2_bucket" "two" {
              name        = "two"
              description = "prevent_destroy = true"
              lifecycle {
                prevent_destroy = false
              }
            }
        """
        self.assert_flags({"extra.tf": borrowed}, "without its own lifecycle")

    def test_other_config_file_kinds(self):
        for name in ("extra.tofu", "extra.tf.json", "extra.tofu.json"):
            with self.subTest(name=name):
                self.assert_flags({name: TERRAFORM_DATA}, "OpenTofu would load this file")

    def test_data_sources_modules_and_checks(self):
        cases = {
            'data "http" "x" { url = "https://example.invalid" }': "top-level block data",
            "data external x { program = [] }": "top-level block data",
            'module "m" { source = "./m" }': "top-level block module",
            'check "c" {\n  data "http" "x" { url = "u" }\n}': "nested data block",
            'ephemeral "x" "y" {}': "top-level block ephemeral",
            'removed {\n  from = a.b\n}': "top-level block removed",
            'provider "null" {}': "only the cloudflare provider",
        }
        for text, needle in cases.items():
            with self.subTest(text=text.split("{")[0]):
                self.assert_flags({"extra.tf": text + "\n"}, needle)

    def test_dynamic_provisioner(self):
        dynamic = """
            resource "cloudflare_r2_bucket" "d" {
              dynamic "provisioner" {
                for_each = []
                content {}
              }
              lifecycle { prevent_destroy = true }
            }
        """
        self.assert_flags({"extra.tf": dynamic}, "nested provisioner block")

    def test_unreadable_text_fails_closed(self):
        self.assert_flags({"extra.tf": 'resource "cloudflare_r2_bucket" "x" {\n  name = "x"\n'}, "cannot be read")
        self.assert_flags({"extra.tf": 'resource "cloudflare_r2_bucket" "x" {\n  name = "x\n}\n'}, "cannot be read")

    def test_state_plans_and_logs_of_any_name(self):
        for name in ("tfplan", "plan.out", "plan", "plan.log", "terraform.tfstate", "x.tfplan", "local.tfvars", "override.tofu", "notes.txt"):
            with self.subTest(name=name):
                self.assert_flags({name: "x\n"}, f"{name}: not a file kind")

    def test_a_backend_needs_enforced_state_and_plan_encryption(self):
        backend = 'terraform {\n  backend "s3" {\n    bucket = "infra-state"\n  }\n}\n'
        variable = 'variable "state_passphrase" {\n  type      = string\n  sensitive = true\n}\n'
        encryption = textwrap.dedent("""
            terraform {
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
                  enforced = PLAN
                }
              }
            }
        """)
        # A backend in any file, without encryption.
        self.assert_flags({"backend.tf": backend}, "without one encryption block")
        self.assert_flags({"backend.tf": backend}, "sensitive state_passphrase")
        self.assert_flags({"backend.tf": backend.replace('backend "s3" {', "cloud {")}, "without one encryption block")
        # Plan encryption not enforced.
        self.assert_flags({"backend.tf": backend, "enc.tf": encryption.replace("PLAN", "false"), "var.tf": variable},
                          "without one encryption block")
        # A passphrase variable that is not sensitive.
        self.assert_flags({"backend.tf": backend, "enc.tf": encryption.replace("PLAN", "true"),
                           "var.tf": variable.replace("true", "false")}, "sensitive state_passphrase")
        # The complete pair passes.
        self.assertEqual(run({"backend.tf": backend, "enc.tf": encryption.replace("PLAN", "true"), "var.tf": variable}), [])


class TheRealConfiguration(unittest.TestCase):
    def test_infra_is_within_the_boundary(self):
        self.assertEqual(infra_guard.check(Path(__file__).resolve().parents[2] / "infra"), [])


if __name__ == "__main__":
    unittest.main()
