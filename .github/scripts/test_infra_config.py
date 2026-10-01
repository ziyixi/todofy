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
- Every Access application gates a Custom Domain its app's wrangler.toml declares (FlowDay's also the retiring F3
  staging host until the follow-up removes it), and every Worker with an ACCESS_AUDIENCE has an application whose
  key is its name, so the access_aud output covers it.
- The D1 databases and R2 buckets are exactly those the production configs bind, and each D1 import id is
  the database_id committed there (ids.tf). The production configs are test_wrangler_configs.py's, minus the Workers
  named in NOT_ADOPTED (none since IaC P4 adopted FlowDay and the links app).
- infra_state.py's lists agree with the rest: WRANGLER_CONFIGS (the outputs check in "Infra drift"/"Infra apply") is
  test_wrangler_configs.py's PRODUCTION, its ALLOWED_TYPES (the apply's allowlist) and FROZEN are the guard's, each
  FROZEN object's id is the id ids.tf records, and its OUTPUTS are the outputs outputs.tf declares.
- RETIRING_HOSTS is exact: each retiring host is still a FlowDay destination and no other application uses one, so the
  commit that drops a host from FlowDay's applications must empty its allowance in the same change.
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
import test_wrangler_configs  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
INFRA = REPO / "infra"
sys.path.insert(0, str(INFRA / "scripts"))
import infra_state  # noqa: E402

# Production Workers whose D1 database and Access applications are not adopted into infra/ yet. Empty since IaC P4
# adopted FlowDay and the links app. A new app's Worker goes here until a change writes its import blocks and, in the
# same commit, moves it into PRODUCTION below (Coverage checks that the two lists together are test_wrangler_configs.py's).
NOT_ADOPTED: dict[str, str] = {}
# Worker name -> production config: the list of test_wrangler_configs.py without NOT_ADOPTED.
PRODUCTION = {
    "mail-hero": "mail-hero/wrangler.toml",
    "todofy-core": "todofy/wrangler.toml",
    "todofy": "todofy/gateway/wrangler.toml",
    "home": "dashboard/wrangler.toml",
    "ziyixi-website": "website/wrangler.toml",
    "ziyixi-notion-publish": "website/relay/wrangler.toml",
    "lab": "lab/wrangler.toml",
    "flowday": "flowday/wrangler.toml",
    "links": "links/wrangler.toml",
}
# Hosts an Access application may still list although no wrangler.toml declares them. Empty since FlowDay's F3
# staging host left both FlowDay applications after the F4 cutover (README.md "FlowDay"); a rollback that adds a host
# back to an application adds it here in the same commit (test_retiring_hosts_are_exact).
RETIRING_HOSTS: set[str] = set()


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


class Coverage(unittest.TestCase):
    def test_the_state_driver_checks_every_production_config(self):
        """infra_state.py compares the outputs with exactly the production configs, and its apply allowlist is the
        guard's boundary."""
        self.assertEqual(sorted(infra_state.WRANGLER_CONFIGS), sorted(test_wrangler_configs.PRODUCTION.values()))
        self.assertEqual(infra_state.ALLOWED_TYPES, infra_guard.ALLOWED_TYPES)
        self.assertEqual(infra_state.FROZEN, infra_guard.FROZEN)

    def test_outputs_are_the_ones_the_state_driver_reads(self):
        outputs = [
            block.labels[0]
            for path in sorted(INFRA.glob("*.tf"))
            for block in infra_guard.parse(path.read_text()).blocks if block.type == "output"
        ]
        self.assertEqual(sorted(outputs), sorted(infra_state.OUTPUTS))

    def test_frozen_addresses_are_declared(self):
        code = "".join(path.read_text() for path in sorted(INFRA.glob("*.tf")))
        for address in infra_state.FROZEN:
            kind, name = address.split(".")
            with self.subTest(address=address):
                self.assertIn(f'resource "{kind}" "{name}" {{', code)

    def test_frozen_ids_are_the_adopted_objects(self):
        """The apply's gate also matches a FROZEN object by id: that id must be the one ids.tf records as adopted (the
        import blocks are gone since the first P4 apply)."""
        ids = (INFRA / "ids.tf").read_text()
        recorded = {"cloudflare_zero_trust_access_application.mail_hero_backup":
                    re.search(r'^\s*mail_hero_backup_app_id\s*=\s*"([^"]+)"', ids, re.MULTILINE).group(1)}
        self.assertEqual(infra_state.FROZEN_OBJECTS, recorded)

    def test_every_production_worker_is_adopted_or_listed_as_not_adopted(self):
        """A Worker added to test_wrangler_configs.PRODUCTION must be either checked here or named in NOT_ADOPTED,
        so a new app's D1 database is never skipped silently by the checks below."""
        self.assertEqual(set(PRODUCTION) & set(NOT_ADOPTED), set())
        self.assertEqual({**PRODUCTION, **NOT_ADOPTED}, test_wrangler_configs.PRODUCTION)


class MatchesTheApps(unittest.TestCase):
    def flowday_apps(self, code: str) -> dict[str, list[str]]:
        block = re.search(r"^  flowday_apps = \{\n(.*?)^  \}\n", code, re.MULTILINE | re.DOTALL).group(1)
        entries = re.findall(r'^    "([a-z-]+)" = \{\n(.*?)^    \}', block, re.MULTILINE | re.DOTALL)
        return {key: re.findall(r'"([^"]+)"', re.search(r"destinations = \[(.*?)\]", body).group(1))
                for key, body in entries}

    def test_access_applications_gate_the_apps_custom_domains(self):
        """Each application's key is its Worker's name, and each destination's host is one of that Worker's Custom
        Domains (or a retiring host)."""
        code = (INFRA / "access.tf").read_text()
        owner = hcl_map(code, "owner_apps")
        destinations = {
            key: [re.search(r'domain\s*=\s*"([^"]+)"', value).group(1)]
            + re.findall(r'"([^"]+)"', re.search(r"more\s*=\s*\[(.*?)\]", value).group(1))
            for key, value in owner.items()
        }
        flowday = self.flowday_apps(code)
        self.assertEqual(set(flowday), {"flowday", "flowday-bypass"})
        destinations.update({key: value for key, value in flowday.items()})
        self.assertEqual(set(owner), {"mail-hero", "todofy", "home", "lab", "links"})
        for key, uris in destinations.items():
            worker = "flowday" if key.startswith("flowday") else key
            hosts = {route["pattern"] for route in config(worker).get("routes", []) if route.get("custom_domain")}
            with self.subTest(app=key):
                self.assertTrue(uris)
                self.assertIn(uris[0].split("/")[0], hosts, "the first destination is the app's own host")
                for uri in uris:
                    self.assertIn(uri.split("/")[0], hosts | RETIRING_HOSTS)
        backup = re.search(r'resource "cloudflare_zero_trust_access_application" "mail_hero_backup" \{(.*?)^\}', code, re.DOTALL | re.MULTILINE)
        self.assertIn('domain                      = "mail-hero.ziyixi.science/api/internal/backup/*"', backup.group(1))

    def test_retiring_hosts_are_exact(self):
        """An allowance in RETIRING_HOSTS exists only while a FlowDay application still lists the host, and no other
        application may use it: dropping the host from local.flowday_apps without emptying the set fails here."""
        code = (INFRA / "access.tf").read_text()
        flowday_hosts = {uri.split("/")[0] for uris in self.flowday_apps(code).values() for uri in uris}
        other_hosts = {re.search(r'domain\s*=\s*"([^"/]+)', value).group(1) for value in hcl_map(code, "owner_apps").values()}
        other_hosts |= {uri.split("/")[0] for value in hcl_map(code, "owner_apps").values()
                        for uri in re.findall(r'"([^"]+)"', re.search(r"more\s*=\s*\[(.*?)\]", value).group(1))}
        for host in sorted(RETIRING_HOSTS):
            with self.subTest(host=host):
                self.assertIn(host, flowday_hosts, "a stale allowance: empty RETIRING_HOSTS in the commit that drops it")
                self.assertNotIn(host, other_hosts)
                self.assertNotIn(host, code.split("# --- FlowDay")[0], "only FlowDay's applications may list it")

    def test_every_worker_that_checks_access_has_an_application_of_its_name(self):
        """The access_aud output is keyed by Worker name; a Worker whose ACCESS_AUDIENCE no application key matches
        would fail the outputs check in "Infra drift"."""
        code = (INFRA / "access.tf").read_text()
        keys = set(hcl_map(code, "owner_apps")) | set(self.flowday_apps(code))
        for worker in PRODUCTION:
            if "ACCESS_AUDIENCE" in config(worker).get("vars", {}):
                with self.subTest(worker=worker):
                    self.assertIn(config(worker)["name"], keys)

    def test_d1_databases_and_buckets_are_the_ones_the_production_configs_bind(self):
        storage = (INFRA / "storage.tf").read_text()
        imports = (INFRA / "ids.tf").read_text()
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
