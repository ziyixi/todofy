"""Static checks of infra/ against the apps' production wrangler.toml files: python3 -m unittest discover -s .github/scripts

They live here, not in infra/, for the reason test_wrangler_configs.py does: they read other apps' folders,
and the Changes job runs this directory on every push, so a wrangler.toml change that infra/ no longer
matches fails at once, not at the next infra/ change. No OpenTofu and no network: a regex reading of the
.tf files is enough for these guards ("Infra checks" also runs `tofu validate`). Needs Python 3.11+
(tomllib), as CI's ubuntu-24.04 python3 has; with an older python3 the module is skipped locally (under
GitHub Actions a missing tomllib is an error):
    uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts

What they keep true (infra/README.md):
- infra/ declares only the four resource types of the monorepo boundary, no data source, no module, no
  provisioner, and every resource has prevent_destroy.
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

REPO = Path(__file__).resolve().parents[2]
INFRA = REPO / "infra"

# The monorepo boundary (owner rule 2026-10-01). Adding a type here is a deliberate scope decision.
ALLOWED_TYPES = {
    "cloudflare_zero_trust_access_application",
    "cloudflare_zero_trust_access_policy",
    "cloudflare_d1_database",
    "cloudflare_r2_bucket",
}
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


def tf_text() -> str:
    return "\n".join(path.read_text() for path in sorted(INFRA.glob("*.tf")))


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
    def test_only_the_monorepo_resource_types(self):
        code = uncommented(tf_text())
        types = set(re.findall(r'^\s*resource\s+"([^"]+)"', code, re.MULTILINE))
        self.assertTrue(types)
        self.assertLessEqual(types, ALLOWED_TYPES)
        self.assertNotRegex(code, r'(?m)^\s*data\s+"', "data sources read objects outside the boundary; none are needed")
        self.assertNotRegex(code, r'(?m)^\s*module\s+"')
        self.assertNotRegex(code, r'(?m)^\s*provisioner\s+"')

    def test_every_resource_is_protected_from_destroy(self):
        code = uncommented(tf_text())
        resources = len(re.findall(r'^resource\s+"', code, re.MULTILINE))
        self.assertEqual(code.count("prevent_destroy = true"), resources)

    def test_one_provider_pinned_exactly_and_locked(self):
        versions = uncommented((INFRA / "versions.tf").read_text())
        pin = re.search(r'source\s*=\s*"cloudflare/cloudflare"\s*\n\s*version\s*=\s*"(\d+\.\d+\.\d+)"', versions)
        self.assertIsNotNone(pin, "the provider must be pinned to an exact version")
        lock = (INFRA / ".terraform.lock.hcl").read_text()
        self.assertEqual(re.findall(r'^provider "([^"]+)"', lock, re.MULTILINE), ["registry.opentofu.org/cloudflare/cloudflare"])
        self.assertIn(f'version     = "{pin.group(1)}"', lock)
        self.assertNotRegex(versions, r'(?m)^\s*backend\s+"', "remote state is not enabled in the prototype")
        self.assertNotRegex(versions, r"(?m)^\s*cloud\s*\{")

    def test_no_account_ids_emails_or_state_committed(self):
        for path in sorted(INFRA.rglob("*")):
            if not path.is_file() or ".terraform" in path.parts or path.suffix == ".pyc":
                continue
            text = path.read_text(errors="replace")
            with self.subTest(path=path.relative_to(REPO).as_posix()):
                self.assertNotRegex(text, r"(?<![0-9a-f-])[0-9a-f]{32}(?![0-9a-f-])")
                self.assertNotRegex(text, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
                self.assertNotRegex(path.name, r"\.tfstate|\.tfplan$|^plan\.(bin|json)$")
                if path.name.endswith(".tfvars") or path.name.endswith(".tfvars.json"):
                    self.fail("tfvars files hold account values and stay outside the repository")


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
