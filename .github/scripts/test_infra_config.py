"""Static checks of infra/ against the apps' production wrangler.toml files: python3 -m unittest discover -s .github/scripts

They live here, not in infra/, for the reason test_wrangler_configs.py does: they read other apps' folders,
and the Changes job runs this directory on every push, so a wrangler.toml change that infra/ no longer
matches fails at once, not at the next infra/ change. No OpenTofu and no network: infra_guard.py reads the
HCL structure, and regexes read the locals maps ("Infra checks" also runs `tofu validate`). Needs Python 3.11+
(tomllib), as CI's ubuntu-24.04 python3 has; with an older python3 the module is skipped locally (under
GitHub Actions a missing tomllib is an error):
    uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts

What they keep true (infra/README.md):
- infra_guard.py finds nothing: only the four resource types of the monorepo boundary, each with its own
  prevent_destroy; no data source, module, provisioner, other config file kind or state/plan/values file;
  no backend without enforced state and plan encryption (test_infra_guard.py tests the guard itself).
- The state lives in the R2 bucket infra-state through a partial S3 backend (no key, endpoint or credentials
  committed), encrypted with the state_passphrase variable only, no fallback.
- Every owner-facing Access application gates a Custom Domain its app's wrangler.toml declares.
- The D1 databases and R2 buckets are exactly those the production configs bind, and each D1 import id is
  the database_id committed there.
- No account or zone id (32 hex digits) and no email address is committed under infra/.
"""

import os
import re
import sys
import unittest
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise
    raise unittest.SkipTest(
        f"test_infra_config needs Python 3.11+ (tomllib), this is {sys.version.split()[0]}: "
        "uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts"
    ) from None

import infra_guard  # noqa: E402  (same directory; unittest discover puts it on sys.path)

REPO = Path(__file__).resolve().parents[2]
INFRA = REPO / "infra"
# Worker name -> production config (the same list as test_wrangler_configs.py).
PRODUCTION = {
    "mail-hero": "mail-hero/wrangler.toml",
    "todofy-core": "todofy/wrangler.toml",
    "todofy": "todofy/gateway/wrangler.toml",
    "home": "dashboard/wrangler.toml",
    "ziyixi-website": "website/wrangler.toml",
    "ziyixi-notion-publish": "website/relay/wrangler.toml",
    "lab": "lab/wrangler.toml",
}


def uncommented(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def config(worker: str) -> dict:
    with open(REPO / PRODUCTION[worker], "rb") as handle:
        return tomllib.load(handle)


def hcl_map(text: str, name: str) -> dict[str, str]:
    """A flat `name = { "key" = "value" ... }` or `name = { "key" = { ... } }` map from a locals block."""
    match = re.search(rf"^\s*{name}\s*=\s*\{{\n(.*?)^\s*\}}\n", text, re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f"locals map {name} not found")
    return dict(re.findall(r'^\s*"([^"]+)"\s*=\s*(.+?)\s*$', match.group(1), re.MULTILINE))


class Boundary(unittest.TestCase):
    def test_the_guard_finds_nothing(self):
        self.assertEqual(infra_guard.check(INFRA), [])

    def test_remote_state_is_the_r2_bucket_with_a_partial_configuration(self):
        """One S3 backend (R2 bucket infra-state, path-style, AWS-only checks skipped). The key, the endpoint (it
        holds the account id) and the credentials are never committed: infra_state.py passes them at runtime.
        No lock file until R2's conditional writes are proven (README.md "Remote state")."""
        backends = [
            (path.name, b)
            for path in sorted(INFRA.glob("*.tf"))
            for block in infra_guard.parse(path.read_text()).blocks if block.type == "terraform"
            for b in block.blocks if b.type in ("backend", "cloud")
        ]
        self.assertEqual([(name, b.type, b.labels) for name, b in backends], [("versions.tf", "backend", ["s3"])])
        backend = backends[0][1]
        self.assertEqual(backend.attrs["bucket"], [("STR", '"infra-state"')])
        self.assertEqual(backend.attrs["region"], [("STR", '"auto"')])
        for flag in ("use_path_style", "skip_credentials_validation", "skip_region_validation",
                     "skip_requesting_account_id", "skip_metadata_api_check", "skip_s3_checksum"):
            with self.subTest(flag=flag):
                self.assertTrue(backend.is_true(flag))
        for name in ("key", "endpoint", "endpoints", "access_key", "secret_key", "token", "profile",
                     "shared_credentials_files", "use_lockfile", "dynamodb_table", "workspace_key_prefix"):
            with self.subTest(attribute=name):
                self.assertNotIn(name, backend.attrs)
                self.assertFalse(backend.children(name))

    def test_state_and_plan_encryption_use_the_passphrase_variable_only(self):
        terraform = [b for path in sorted(INFRA.glob("*.tf")) for b in infra_guard.parse(path.read_text()).blocks
                     if b.type == "terraform"]
        [encryption] = [b for t in terraform for b in t.children("encryption")]
        [provider] = encryption.children("key_provider")
        # The provider's name changes at every passphrase rotation (state, state_2, ...); the method's never does.
        self.assertEqual(provider.labels[0], "pbkdf2")
        self.assertRegex(provider.labels[1], r"^state(_[0-9]+)?$")
        [method] = encryption.children("method")
        self.assertEqual(method.labels, ["aes_gcm", "state"])
        for kind in ("state", "plan"):
            with self.subTest(kind=kind):
                [block] = encryption.children(kind)
                self.assertTrue(block.is_true("enforced"))
                self.assertFalse(block.children("fallback"))
        variables = (INFRA / "variables.tf").read_text()
        block = re.search(r'^variable "state_passphrase" \{\n(.*?)^\}', variables, re.MULTILINE | re.DOTALL).group(1)
        self.assertNotIn("default", block)
        self.assertIn("length(var.state_passphrase) >= 16", block)

    def test_one_provider_pinned_exactly_and_locked(self):
        versions = uncommented((INFRA / "versions.tf").read_text())
        pin = re.search(r'source\s*=\s*"cloudflare/cloudflare"\s*\n\s*version\s*=\s*"(\d+\.\d+\.\d+)"', versions)
        self.assertIsNotNone(pin, "the provider must be pinned to an exact version")
        lock = (INFRA / ".terraform.lock.hcl").read_text()
        self.assertEqual(re.findall(r'^provider "([^"]+)"', lock, re.MULTILINE), ["registry.opentofu.org/cloudflare/cloudflare"])
        self.assertIn(f'version     = "{pin.group(1)}"', lock)

    def test_no_account_ids_or_emails_committed(self):
        for path in sorted(INFRA.rglob("*")):
            if not path.is_file() or ".terraform" in path.parts or path.suffix == ".pyc":
                continue
            text = path.read_text(errors="replace")
            with self.subTest(path=path.relative_to(REPO).as_posix()):
                self.assertNotRegex(text, r"(?<![0-9a-f-])[0-9a-f]{32}(?![0-9a-f-])")
                self.assertNotRegex(text, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
        # State, plan and values files of any name: infra_guard.ALLOWED_FILES (test_the_guard_finds_nothing).


class MatchesTheApps(unittest.TestCase):
    def test_access_applications_gate_the_apps_custom_domains(self):
        code = (INFRA / "access.tf").read_text()
        apps = hcl_map(code, "owner_apps")
        workers = {"mail-hero": "mail-hero", "todofy": "todofy", "home": "home", "lab": "lab"}
        self.assertEqual(set(apps), set(workers))
        for key, value in apps.items():
            domain = re.search(r'domain\s*=\s*"([^"]+)"', value).group(1)
            routes = config(workers[key]).get("routes", [])
            with self.subTest(app=key):
                self.assertIn({"pattern": domain, "custom_domain": True}, routes)
        backup = re.search(r'resource "cloudflare_zero_trust_access_application" "mail_hero_backup" \{(.*?)^\}', code, re.DOTALL | re.MULTILINE)
        self.assertIn('domain                      = "mail-hero.ziyixi.science/api/internal/backup/*"', backup.group(1))

    def test_d1_databases_and_buckets_are_the_ones_the_production_configs_bind(self):
        storage = (INFRA / "storage.tf").read_text()
        imports = (INFRA / "imports.tf").read_text()
        d1_names = set(hcl_map(storage, "d1_databases"))
        buckets = set(hcl_map(storage, "r2_buckets"))
        ids = {name: value.strip('"') for name, value in hcl_map(imports, "d1_database_ids").items()}
        bound_d1, bound_r2 = {}, set()
        for worker in PRODUCTION:
            data = config(worker)
            for database in data.get("d1_databases", []):
                bound_d1[database["database_name"]] = database["database_id"]
            bound_r2.update(bucket["bucket_name"] for bucket in data.get("r2_buckets", []))
        self.assertEqual(d1_names, set(bound_d1))
        self.assertEqual(ids, bound_d1)
        self.assertEqual(buckets, bound_r2)


if __name__ == "__main__":
    unittest.main()
