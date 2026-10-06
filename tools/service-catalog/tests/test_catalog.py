"""Catalog invariants, synthetic failure cases, and the pre-P5 public metadata contract."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog

DEMO = '''version = 1
id = "demo"
target = "cloudflare"
[[workers]]
config = "demo/wrangler.toml"
hosts = ["demo"]
entry = "demo"
role = "Synthetic Worker"
position = 1
[[entries]]
id = "demo"
name = "Demo"
description = "Synthetic catalog fixture"
group = "apps"
icon = "mail"
accent = "blue"
worker = "demo"
url_path = "/"
access = false
app_only_signals = []
order = 1
position = 1
[entries.status]
type = "none"
'''
CONFIG = '''name = "demo"
[[routes]]
pattern = "demo.ziyixi.science"
custom_domain = true
[vars]
PUBLIC_HOST = "demo.ziyixi.science"
'''
PROFILE = '''version = 1
zone = "ziyixi.science"
repository = "ziyixi/todofy"
access_issuer = "https://ziyixi.cloudflareaccess.com"
workers_dev_subdomain = "cloudflare-579"
platform_hostname = "fleet.ziyixi.science"
[vps]
platform_runtime_host = "platform-runtime.ziyixi.science"
namespace = "personal-cloud"
state_root = "/srv/todofy"
observer_node_key = "vps"
expected_daemons = ["k3s", "ssh", "cloudflared_platform"]
'''


class CatalogTests(unittest.TestCase):
    def fixture(self, manifest=DEMO, config=CONFIG):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        (root / "config").mkdir()
        (root / "config/cloud.toml").write_text(PROFILE)
        (root / "demo").mkdir()
        (root / "demo/app.toml").write_text(manifest)
        (root / "demo/wrangler.toml").write_text(config)
        return root

    def test_existing_public_metadata_is_unchanged_except_new_ops_monitors(self):
        loaded = catalog.load_catalog()
        before = json.loads((Path(__file__).parent / "home-before-p5.json").read_text())
        keys = ("id", "name", "description", "group", "icon", "accent", "url", "access", "status", "tile_metric", "app_only_signals", "order")
        existing = [entry for entry in before["entries"] if entry["id"] not in {"self-hosted", "newsletter", "notion-publish"}]
        existing_ids = {entry["id"] for entry in existing}
        entries = [{key: entry[key] for key in keys} for entry in loaded.entries if entry["id"] in existing_ids]
        self.assertEqual(entries, existing)
        sync = next(entry for entry in loaded.entries if entry["id"] == "notion-publish")
        self.assertEqual(sync["name"], "网站同步")
        self.assertEqual(sync["status"], {"type": "ops_v1", "binding": "WEBSITE_SYNC", "guard": False})
        workers = [{key: worker[key] for key in ("script", "entry", "role")} for worker in loaded.workers]
        self.assertEqual([worker for worker in workers if worker["script"] != "fleet"], before["workers"])

    def test_generated_regions_are_fresh_and_deterministic(self):
        loaded = catalog.load_catalog()
        self.assertEqual(catalog.check_generated(loaded), [])
        self.assertEqual(catalog.generated_files(loaded), catalog.generated_files(catalog.load_catalog()))

    def test_all_production_configs_and_consumer_maps_are_covered(self):
        loaded = catalog.load_catalog()
        self.assertEqual(set(loaded.worker_configs().values()), catalog.production_configs(catalog.REPO))
        self.assertGreaterEqual(len(loaded.workers), 10)
        self.assertEqual({app for app, data in loaded.apps.items() if data["target"] == "cloudflare"},
                         {"todofy", "mail-hero", "dashboard", "website", "flowday", "links", "watch"}
                         | ({"fleet"} if "fleet" in loaded.apps else set()))
        self.assertEqual(loaded.apps["newsletter"]["image"], "ghcr.io/ziyixi/todofy-newsletter")
        self.assertEqual(loaded.apps["newsletter"]["target"], "vps")
        self.assertNotIn("newsletter", loaded.worker_configs())

    def test_access_values_are_unchanged_and_paths_are_derived(self):
        rules = {r["key"]: r for r in catalog.load_catalog().access}
        self.assertEqual(rules["links"]["destinations"], ["s.ziyixi.science/_/*", "s.ziyixi.science/_"])
        self.assertEqual(rules["flowday-bypass"]["destinations"], ["flowday.ziyixi.science/pwa/*"])
        self.assertEqual(rules["flowday"]["session"], "168h")
        self.assertEqual(rules["mail-hero"]["name"], "Mail Hero")

    def test_unknown_fields_fail_at_every_level(self):
        mutations = [DEMO.replace('version = 1', 'version = 1\nsecret = "synthetic"'),
                     DEMO.replace('role = "Synthetic Worker"', 'role = "Synthetic Worker"\nextra = 1'),
                     DEMO.replace('name = "Demo"', 'name = "Demo"\nextra = 1'),
                     DEMO.replace('type = "none"', 'type = "none"\nextra = 1'),
                     DEMO + '\n[entries.tile_metric]\nkind = "latency"\nextra = 1\n',
                     DEMO + '\n[[access]]\nkey = "demo"\nkind = "owner"\nworker = "demo"\nname = "Demo"\npaths = [""]\nsession = "24h"\nextra = 1\n']
        for manifest in mutations:
            with self.subTest(level=mutations.index(manifest)), self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(manifest))

    def test_identity_and_scalar_types_fail_closed(self):
        for old, new in [('version = 1', 'version = true'), ('id = "demo"', 'id = "other"'),
                         ('target = "cloudflare"', 'target = ["cloudflare"]'), ('position = 1', 'position = true'),
                         ('access = false', 'access = 1'), ('order = 1', 'order = 0'),
                         ('group = "apps"', 'group = []'), ('type = "none"', 'type = []'),
                         ('worker = "demo"', 'worker = []')]:
            with self.subTest(field=old), self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(DEMO.replace(old, new)))

    def test_private_values_are_rejected_without_echoing_them(self):
        for value in ['owner@example.test', '192.168.1.20', 'a' * 32, '${var.owner}', '%{ if true }']:
            root = self.fixture(DEMO.replace('name = "Demo"', 'name = ' + json.dumps(value)))
            with self.assertRaises(catalog.CatalogError) as caught:
                catalog.load_catalog(root)
            self.assertNotIn(value, str(caught.exception))

    def test_path_escape_absolute_cross_app_and_symlink_are_refused(self):
        for path in ['../demo/wrangler.toml', '/demo/wrangler.toml', 'other/wrangler.toml',
                     'demo/../demo/wrangler.toml', 'demo//wrangler.toml',
                     'demo/.private/wrangler.toml', 'demo/node_modules/wrangler.toml']:
            with self.subTest(path=path), self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(DEMO.replace('demo/wrangler.toml', path)))
        root = self.fixture()
        config = root / 'demo/wrangler.toml'
        external = root / 'outside.toml'
        config.rename(external)
        config.symlink_to(external)
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)

    def test_missing_manifest_and_unregistered_production_config_fail(self):
        root = self.fixture()
        (root / 'demo/app.toml').unlink()
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)
        root = self.fixture()
        (root / 'forgotten').mkdir()
        (root / 'forgotten/wrangler.toml').write_text('name = "forgotten"')
        with self.assertRaisesRegex(catalog.CatalogError, 'coverage'):
            catalog.load_catalog(root)

    def test_unregistered_config_in_build_or_dependencies_is_ignored(self):
        root = self.fixture()
        for directory in ['node_modules', '.wrangler', '.git', 'uiassets']:
            (root / directory).mkdir()
            (root / directory / 'wrangler.toml').write_text('name = "not-production"')
        self.assertEqual(catalog.load_catalog(root).worker_configs(), {'demo': 'demo/wrangler.toml'})

    def test_manifest_symlink_is_refused(self):
        root = self.fixture()
        manifest = root / 'demo/app.toml'
        manifest.rename(root / 'outside.toml')
        manifest.symlink_to(root / 'outside.toml')
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)

    def test_host_and_link_source_cannot_be_overridden(self):
        for manifest, config in [(DEMO + '\nurl = "https://elsewhere.test"\n', CONFIG),
                                 (DEMO, CONFIG.replace('PUBLIC_HOST = "demo.ziyixi.science"', 'PUBLIC_HOST = "other.ziyixi.science"')),
                                 (DEMO, CONFIG.replace('demo.ziyixi.science', '127.0.0.1'))]:
            with self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(manifest, config))
        root = self.fixture(manifest=DEMO.replace('hosts = ["demo"]', 'hosts = ["new-demo"]'),
                            config=CONFIG.replace('demo.ziyixi.science', 'new-demo.ziyixi.science'))
        self.assertEqual(catalog.load_catalog(root).entries[0]['url'], 'https://new-demo.ziyixi.science/')

    def test_query_traversal_and_network_path_probes_are_refused(self):
        for path in ['//elsewhere.test', '/a/../b', '/x?q=private', '/x#private', '/%2e%2e/secret', '/x\\y',
                     '/x${var.owner}', '/space here', '/tab\there', '/control\x00']:
            with self.subTest(path=path), self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(DEMO.replace('url_path = "/"', 'url_path = ' + json.dumps(path))))

    def test_probe_fields_are_typed_and_same_origin(self):
        manifest = DEMO.replace('type = "none"', 'type = "public_http"\npath = "/health"\nexpect = [200]\nenabled = true')
        root = self.fixture(manifest)
        self.assertEqual(catalog.load_catalog(root).entries[0]['status']['url'], 'https://demo.ziyixi.science/health')
        for mutation in [manifest.replace('expect = [200]', 'expect = [302]'),
                         manifest.replace('enabled = true', 'enabled = "true"'),
                         manifest.replace('path = "/health"', 'path = "https://elsewhere.test/health"')]:
            with self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(mutation))

    def test_an_audience_requires_catalog_access_application(self):
        root = self.fixture(config=CONFIG + 'ACCESS_AUDIENCE = "synthetic-audience"\n')
        with self.assertRaisesRegex(catalog.CatalogError, 'Access application coverage'):
            catalog.load_catalog(root)

    def test_no_env_or_credential_file_is_read(self):
        root = self.fixture()
        (root / 'demo/.env').write_text('not-a-catalog-value')
        original = Path.read_text
        reads = []
        def read(path, *args, **kwargs):
            reads.append(path.name)
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, 'read_text', read):
            catalog.load_catalog(root)
        self.assertEqual(set(reads), {'cloud.toml', 'app.toml', 'wrangler.toml'})

    def test_domain_allowlist_comes_from_exact_public_profile(self):
        root = self.fixture(config=CONFIG.replace('ziyixi.science', 'example.test'))
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)
        profile = PROFILE.replace('ziyixi.science', 'example.test')
        (root / 'config/cloud.toml').write_text(profile)
        self.assertEqual(catalog.load_catalog(root).entries[0]['url'], 'https://demo.example.test/')
        (root / 'demo/wrangler.toml').write_text(CONFIG.replace('ziyixi.science', 'outside.example.test.invalid'))
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)

    def test_vps_monitor_requires_exact_provider_entrypoint_and_no_guard(self):
        root = self.fixture()
        (root / 'dashboard').mkdir()
        (root / 'dashboard/wrangler.toml').write_text('[[services]]\nbinding = "NEWSLETTER"\nservice = "fleet"\nentrypoint = "NewsletterOps"\n')
        # This synthetic binding fixture is not a production config discovered by the catalog.
        (root / 'dashboard/wrangler.toml').rename(root / 'dashboard/bindings.toml')
        original = catalog.read_toml
        def read(path):
            return original(path.parent / 'bindings.toml' if path == root / 'dashboard/wrangler.toml' else path)
        (root / 'newsletter').mkdir()
        manifest = '''version = 1
id = "newsletter"
target = "vps"
image = "ghcr.io/ziyixi/todofy-newsletter"
[[entries]]
id = "newsletter"
name = "Newsletter"
description = "Synthetic VPS receipt"
group = "services"
icon = "newspaper"
accent = "amber"
access = false
app_only_signals = []
order = 2
position = 2
[entries.status]
type = "ops_v1"
provider = "fleet"
binding = "NEWSLETTER"
guard = false
'''
        path = root / 'newsletter/app.toml'
        path.write_text(manifest)
        with mock.patch.object(catalog, 'read_toml', read):
            loaded = catalog.load_catalog(root)
            self.assertEqual(loaded.entries[-1]['status']['provider'], 'fleet')
            for old, new in [('provider = "fleet"', 'provider = "other"'), ('guard = false', 'guard = true'),
                             ('binding = "NEWSLETTER"', 'binding = "FLEET"'), ('ghcr.io/ziyixi/', 'ghcr.io/other/')]:
                path.write_text(manifest.replace(old, new))
                with self.assertRaises(catalog.CatalogError):
                    catalog.load_catalog(root)
            path.write_text(manifest)
            (root / 'dashboard/bindings.toml').write_text('[[services]]\nbinding = "NEWSLETTER"\nservice = "fleet"\nentrypoint = "Ops"\n')
            with self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(root)

    def test_duplicate_configs_entry_positions_and_names_are_refused(self):
        root = self.fixture()
        content = (root / 'demo/app.toml').read_text()
        # Add a second Worker with the same path using valid TOML.
        duplicate_worker = '\n[[workers]]\nconfig = "demo/wrangler.toml"\nentry = "demo"\nrole = "Duplicate"\nposition = 2\n'
        (root / 'demo/app.toml').write_text(content + duplicate_worker)
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)
        entry = '\n[[entries]]' + DEMO.split('[[entries]]', 1)[1]
        for changed in [entry.replace('position = 1', 'position = 2'),
                        entry.replace('id = "demo"', 'id = "second"')]:
            with self.subTest(kind='entry id or position'), self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(self.fixture(DEMO + changed))
        for name, position in [('demo', 2), ('second', 1)]:
            root = self.fixture()
            (root / 'demo/core').mkdir()
            (root / 'demo/core/wrangler.toml').write_text(CONFIG.replace('name = "demo"', 'name = ' + json.dumps(name)))
            second = '\n[[workers]]\nconfig = "demo/core/wrangler.toml"\nentry = "demo"\nrole = "Duplicate"\nposition = ' + str(position) + '\n'
            (root / 'demo/app.toml').write_text(DEMO + second)
            with self.subTest(kind='worker name or position'), self.assertRaises(catalog.CatalogError):
                catalog.load_catalog(root)

    def test_generated_region_diagnostics_do_not_rewrite_missing_boundaries(self):
        for original in ['unmarked', '// BEGIN service-catalog x\nmissing end']:
            with self.assertRaises(catalog.CatalogError):
                catalog.replace_region(original, 'x', 'safe', '//')
        original = '# BEGIN service-catalog flowday\na\n# END service-catalog flowday\n# BEGIN service-catalog flowday-bypass\nb\n# END service-catalog flowday-bypass\n'
        result = catalog.replace_region(original, 'flowday', 'new', '#')
        self.assertIn('\nb\n# END service-catalog flowday-bypass', result)


if __name__ == '__main__':
    unittest.main()
