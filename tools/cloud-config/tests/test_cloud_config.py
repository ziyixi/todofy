"""Public profile schema and bounded deployment generation on synthetic files."""

import importlib.util
import shutil
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))
import cloud_profile  # noqa: E402

spec = importlib.util.spec_from_file_location("cloud_config_generate", TOOL / "generate.py")
generate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generate)

CLOUD = '''version = 1
zone = "example.test"
repository = "example/personal-cloud"
access_issuer = "https://synthetic.cloudflareaccess.com"
workers_dev_subdomain = "synthetic-workers"
platform_hostname = "fleet.example.test"
[vps]
platform_runtime_host = "platform-runtime.example.test"
namespace = "personal-cloud"
state_root = "/srv/personal-cloud"
observer_node_key = "vps"
expected_daemons = ["k3s", "ssh", "cloudflared_platform"]
'''
RESOURCE = '''version = 1
account_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
zone_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
[access_audiences]
demo = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
[d1_databases]
demo = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
[durable_objects]
demo-state = "cccccccccccccccccccccccccccccccc"
'''
MANIFEST = '''version = 1
id = "demo"
target = "cloudflare"
[[workers]]
config = "demo/wrangler.toml"
hosts = ["demo"]
'''
CONFIG = '''# Synthetic unrelated settings must stay byte-identical.
name = "demo"
account_id = "dddddddddddddddddddddddddddddddd" # retained comment
main = "src/index.ts"
workers_dev = false
routes = [{ pattern = "demo.example.test", custom_domain = true }]
[[d1_databases]]
binding = "DB"
database_name = "demo"
database_id = "dddddddd-dddd-dddd-dddd-dddddddddddd"
migrations_dir = "migrations"
[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "demo-archive"
[vars]
PUBLIC_HOST = "demo.example.test"
ACCESS_ISSUER = "https://old.cloudflareaccess.com"
ACCESS_AUDIENCE = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
ACCOUNT_ID = "dddddddddddddddddddddddddddddddd"
SAFETY_BUDGET = "10"
'''


class CloudConfigurationTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        for directory in ("config", "demo", "dashboard/worker/src", "infra"):
            (root / directory).mkdir(parents=True)
        (root / "config/cloud.toml").write_text(CLOUD)
        (root / "config/resources.toml").write_text(RESOURCE)
        (root / "demo/app.toml").write_text(MANIFEST)
        (root / "demo/wrangler.toml").write_text(CONFIG)
        return root

    def test_generate_only_declared_identity_fields_and_preserve_comments(self):
        root = self.fixture()
        outputs = generate.generated_files(root)
        updated = outputs["demo/wrangler.toml"]
        expected = CONFIG.replace("d" * 64, "b" * 64).replace("d" * 32, "a" * 32)
        expected = expected.replace("dddddddd-dddd-dddd-dddd-dddddddddddd", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        expected = expected.replace("https://old.cloudflareaccess.com", "https://synthetic.cloudflareaccess.com")
        self.assertEqual(updated, expected)
        module = outputs[generate.IDENTITY_MODULE]
        self.assertIn('"demo-db": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"', module)
        self.assertIn('"demo-state": "' + "c" * 32 + '"', module)
        self.assertNotIn("access_issuer", module)
        self.assertNotIn("a" * 32, module)
        infrastructure = outputs[generate.PLATFORM_IDENTITY]
        self.assertIn("e" * 32, infrastructure)
        self.assertIn("platform-runtime.example.test", infrastructure)
        self.assertNotIn("a" * 32, infrastructure)
        self.assertEqual(outputs, generate.generated_files(root))

    def test_tunnel_team_identity_follows_validated_issuer_on_a_fresh_account(self):
        root = self.fixture()
        (root / "config/cloud.toml").write_text(CLOUD.replace("synthetic.cloudflareaccess.com", "new-team.cloudflareaccess.com"))
        outputs = generate.generated_files(root)
        infrastructure = outputs[generate.PLATFORM_IDENTITY]
        self.assertIn('platform_access_team', infrastructure)
        self.assertIn('= "new-team"', infrastructure)
        self.assertNotIn('synthetic', infrastructure)
        self.assertIn('ACCESS_ISSUER = "https://new-team.cloudflareaccess.com"', outputs["demo/wrangler.toml"])

    def test_fleet_host_key_follows_node_alias_without_resetting_epoch(self):
        fleet = '''name = "fleet"
account_id = "dddddddddddddddddddddddddddddddd"
[vars]
HOST_KEY = "vps" # public node alias
HOST_EPOCH = "7" # operator-managed recovery epoch
SAFETY_BUDGET = "10"
'''
        for node_key in ("vps", "replacement-vps"):
            with self.subTest(node_key=node_key):
                root = self.fixture()
                (root / "config/cloud.toml").write_text(CLOUD.replace('observer_node_key = "vps"', f'observer_node_key = "{node_key}"'))
                (root / "fleet").mkdir()
                (root / "fleet/app.toml").write_text(MANIFEST.replace("demo", "fleet").replace('hosts = ["fleet"]', 'hosts = []'))
                (root / "fleet/wrangler.toml").write_text(fleet)
                demo = CONFIG + 'HOST_KEY = "unrelated-host"\n'
                (root / "demo/wrangler.toml").write_text(demo)
                outputs = generate.generated_files(root)
                expected = fleet.replace("d" * 32, "a" * 32).replace('HOST_KEY = "vps"', f'HOST_KEY = "{node_key}"')
                self.assertEqual(outputs["fleet/wrangler.toml"], expected)
                self.assertIn('HOST_KEY = "unrelated-host"', outputs["demo/wrangler.toml"])
                self.assertEqual((root / "fleet/wrangler.toml").read_text(), fleet)

    def test_check_does_not_mutate_and_write_is_idempotent(self):
        root = self.fixture()
        outputs = generate.generated_files(root)
        self.assertEqual(set(generate.check(root, outputs)), {"demo/wrangler.toml", generate.IDENTITY_MODULE, generate.PLATFORM_IDENTITY})
        self.assertEqual((root / "demo/wrangler.toml").read_text(), CONFIG)
        self.assertEqual(len(generate.write(root, outputs)), 3)
        self.assertEqual(generate.check(root, generate.generated_files(root)), [])
        self.assertEqual(generate.write(root, generate.generated_files(root)), [])

    def test_schema_rejects_unknown_secret_and_untrusted_public_values_without_echo(self):
        mutations = [('version = 1', 'version = true'), ('zone = "example.test"', 'zone = "192.168.1.20"'),
                     ('platform_hostname = "fleet.example.test"', 'platform_hostname = "fleet.outside.test"'),
                     ('repository = "example/personal-cloud"', 'repository = "owner@example.test/private"'),
                     ('https://synthetic.cloudflareaccess.com', 'https://synthetic.cloudflareaccess.com/path'),
                     ('namespace = "personal-cloud"', 'namespace = "../private"'),
                     ('state_root = "/srv/personal-cloud"', 'state_root = "/etc"')]
        for old, new in mutations:
            root = self.fixture()
            (root / "config/cloud.toml").write_text(CLOUD.replace(old, new))
            with self.subTest(field=old), self.assertRaises(cloud_profile.ProfileError) as caught:
                generate.generated_files(root)
            self.assertNotIn(new, str(caught.exception))
        root = self.fixture()
        (root / "config/cloud.toml").write_text(CLOUD.replace('version = 1', 'version = 1\ntoken = "synthetic-private"'))
        with self.assertRaises(cloud_profile.ProfileError) as caught:
            generate.generated_files(root)
        self.assertNotIn("synthetic-private", str(caught.exception))

    def test_resource_shape_and_coverage_refuse_missing_extra_zero_and_duplicate_ids(self):
        mutations = [('version = 1', 'version = true'), ('a' * 32, '0' * 32),
                     ('demo = "' + 'b' * 64 + '"', 'other = "' + 'b' * 64 + '"'),
                     ('demo = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"', 'other = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"'),
                     ('[durable_objects]', '[durable_objects]\nother-state = "' + 'c' * 32 + '"'),
                     ('version = 1', 'version = 1\nsecret = "synthetic-private"')]
        for old, new in mutations:
            root = self.fixture()
            (root / 'config/resources.toml').write_text(RESOURCE.replace(old, new))
            with self.subTest(field=old), self.assertRaises(cloud_profile.ProfileError):
                generate.generated_files(root)

    def test_path_escape_and_symlinks_fail_before_any_write(self):
        for relative in ('../demo/wrangler.toml', '/demo/wrangler.toml', 'demo/../demo/wrangler.toml', 'other/wrangler.toml',
                         'demo/.private/wrangler.toml', 'demo//wrangler.toml', 'demo\\wrangler.toml'):
            root = self.fixture()
            (root / 'demo/app.toml').write_text(MANIFEST.replace('demo/wrangler.toml', relative))
            with self.assertRaises(cloud_profile.ProfileError):
                generate.generated_files(root)
            self.assertEqual((root / 'demo/wrangler.toml').read_text(), CONFIG)
        root = self.fixture()
        path = root / 'config/cloud.toml'
        path.rename(root / 'outside.toml')
        path.symlink_to(root / 'outside.toml')
        with self.assertRaises(cloud_profile.ProfileError):
            generate.generated_files(root)

    def test_env_keep_vars_and_ambiguous_fields_are_refused(self):
        for config in (CONFIG + '\n[env.preview]\nname="preview"\n', CONFIG.replace('main =', 'keep_vars = true\nmain ='),
                       CONFIG.replace('account_id =', 'account_id = "' + 'c' * 32 + '"\naccount_id =')):
            root = self.fixture()
            (root / 'demo/wrangler.toml').write_text(config)
            with self.assertRaises(cloud_profile.ProfileError):
                generate.generated_files(root)

    def test_no_env_or_credentials_are_read(self):
        root = self.fixture()
        (root / '.env').write_text('TOKEN=synthetic-private')
        (root / 'demo/.dev.vars').write_text('KEY=synthetic-private')
        outputs = generate.generated_files(root)
        self.assertTrue(all('synthetic-private' not in value for value in outputs.values()))

    def test_expected_daemons_are_exact_and_fresh_hosts_need_no_legacy_connector(self):
        root = self.fixture()
        self.assertEqual(cloud_profile.load_profile(root)['vps']['expected_daemons'],
                         ['k3s', 'ssh', 'cloudflared_platform'])
        for daemons in ('["k3s", "ssh"]', '["k3s", "ssh", "unknown"]',
                        '["k3s", "ssh", "cloudflared_platform", "ssh"]',
                        '["k3s", "ssh", "cloudflared_platform", "secret-unit"]'):
            (root / 'config/cloud.toml').write_text(CLOUD.replace(
                '["k3s", "ssh", "cloudflared_platform"]', daemons))
            with self.subTest(daemons=daemons), self.assertRaises(cloud_profile.ProfileError):
                cloud_profile.load_profile(root)

    def test_managed_ids_allow_only_known_addresses_and_public_nonzero_provider_ids(self):
        root = self.fixture()
        tunnel = 'cloudflare_zero_trust_tunnel_cloudflared.platform'
        config = 'cloudflare_zero_trust_tunnel_cloudflared_config.platform'
        shared_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        inventory = RESOURCE + '[managed_ids]\n"' + tunnel + '" = "' + shared_id + '"\n"' + config + '" = "' + shared_id + '"\n'
        (root / 'config/resources.toml').write_text(inventory)
        self.assertEqual(cloud_profile.load_resources(root)['managed_ids'][tunnel], shared_id)
        for old, new in ((tunnel, 'unknown-resource-secret'), (shared_id, 'private-value'),
                         (shared_id, '0' * 32), (shared_id, '00000000-0000-0000-0000-000000000000')):
            (root / 'config/resources.toml').write_text(inventory.replace(old, new))
            with self.subTest(field=old), self.assertRaises(cloud_profile.ProfileError) as caught:
                cloud_profile.load_resources(root)
            self.assertNotIn('private-value', str(caught.exception))
            self.assertNotIn('unknown-resource-secret', str(caught.exception))

    def test_worker_secret_declarations_are_public_bounded_and_do_not_read_values(self):
        root = self.fixture()
        manifest = MANIFEST + 'personal_secrets = ["ACCESS_OWNER"]\nmanual_secrets = ["API_TOKEN"]\noptional_secrets = ["API_TOKEN"]\n'
        (root / 'demo/app.toml').write_text(manifest)
        self.assertEqual(cloud_profile.worker_secret_specs(root), {
            'demo': {'github_secret': 'DEMO_WORKER_SECRETS', 'required': ['ACCESS_OWNER'], 'optional': ['API_TOKEN']},
        })
        for old, new in (('["API_TOKEN"]', '["private-value"]'),
                         ('manual_secrets = ["API_TOKEN"]', 'manual_secrets = ["ACCESS_OWNER"]'),
                         ('optional_secrets = ["API_TOKEN"]', 'optional_secrets = ["UNKNOWN"]'),
                         ('personal_secrets = ["ACCESS_OWNER"]', 'personal_secrets = ["ACCESS_OWNER", "ACCESS_OWNER"]')):
            (root / 'demo/app.toml').write_text(manifest.replace(old, new))
            with self.subTest(field=old), self.assertRaises(cloud_profile.ProfileError) as caught:
                cloud_profile.worker_secret_specs(root)
            self.assertNotIn('private-value', str(caught.exception))

    def test_infrastructure_inventory_updates_ids_preserving_current_bytes_and_optional_frozen_reference(self):
        source = TOOL.parents[1]
        resources = cloud_profile.load_resources(source)
        original = (source / 'infra/ids.tf').read_text()
        self.assertEqual(generate.infrastructure_ids(original, resources), original)
        changed = resources | {
            'd1_databases': resources['d1_databases'] | {'lab': 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'},
            'standalone_access_app_ids': {key: value for key, value in resources['standalone_access_app_ids'].items()
                                          if key != 'mail-hero-backup'},
        }
        updated = generate.infrastructure_ids(original, changed)
        self.assertIn('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', updated)
        self.assertNotIn(resources['d1_databases']['lab'], updated)
        self.assertIn('mail_hero_backup_app_id = null', updated)
        self.assertIn('# Created by "Infra apply"', updated)
        self.assertEqual((source / 'infra/ids.tf').read_text(), original)
        with self.assertRaises(cloud_profile.ProfileError):
            generate.infrastructure_ids(original, {key: value for key, value in resources.items() if key != 'access_app_ids'})

    def repository_fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        source = TOOL.parents[1]
        for relative in ('config/cloud.toml', 'config/resources.toml', 'dashboard/worker/src/registry.ts',
                         'infra/access.tf', 'infra/ids.tf', 'website/content/site.config.ts'):
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, destination)
        for path in source.glob('*/app.toml'):
            destination = root / path.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            for worker in tomllib.loads(path.read_text()).get('workers', []):
                destination = root / worker['config']
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / worker['config'], destination)
        (root / 'watch/worker/src').mkdir(parents=True)
        (root / 'todofy/worker/todofy').mkdir(parents=True)
        (root / 'fleet/web/src').mkdir(parents=True)
        return root

    def test_bootstrap_hcl_uses_fresh_profile_without_resource_ids_or_public_worker_writes(self):
        root = self.repository_fixture()
        cloud = (root / 'config/cloud.toml').read_text().replace('ziyixi.science', 'example.test')
        cloud = cloud.replace('ziyixi/todofy', 'new-owner/new-cloud').replace(
            'ziyixi.cloudflareaccess.com', 'new-team.cloudflareaccess.com').replace('cloudflare-579', 'new-workers')
        (root / 'config/cloud.toml').write_text(cloud)
        (root / 'config/resources.toml').write_text('''version = 1
account_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
zone_id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
[access_audiences]
[d1_databases]
[durable_objects]
''')
        before = {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob('*') if path.is_file()}
        with self.assertRaises(cloud_profile.ProfileError):
            generate.generated_files(root)
        outputs = generate.bootstrap_infra_files(root)
        self.assertEqual(set(outputs), {'infra/platform-identity.tf', 'infra/ids.tf', 'infra/access.tf'})
        self.assertIn('platform-runtime.example.test', outputs['infra/platform-identity.tf'])
        self.assertIn('= "new-team"', outputs['infra/platform-identity.tf'])
        self.assertIn('mail-hero.example.test', outputs['infra/access.tf'])
        self.assertIn('flowday.example.test/pwa/*', outputs['infra/access.tf'])
        self.assertIn('mail_hero_backup_app_id = null', outputs['infra/ids.tf'])
        self.assertNotRegex(outputs['infra/ids.tf'], r'"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"')
        self.assertEqual(before, {path.relative_to(root).as_posix(): path.read_bytes()
                                  for path in root.rglob('*') if path.is_file()})
        import catalog
        with self.assertRaises(catalog.CatalogError):
            catalog.load_catalog(root)
        loaded = catalog.load_catalog(root, bootstrap=True)
        for config in loaded.configs.values():
            self.assertEqual(config['account_id'], '0' * 32)
            if 'ACCESS_AUDIENCE' in config.get('vars', {}):
                self.assertEqual(config['vars']['ACCESS_AUDIENCE'], '0' * 64)
            for database in config.get('d1_databases', []):
                self.assertEqual(database['database_id'], '00000000-0000-0000-0000-000000000000')
        self.assertEqual(loaded.apps['newsletter']['image'], 'ghcr.io/new-owner/new-cloud-newsletter')

    def test_alternate_profile_changes_routes_policies_images_and_site_without_old_account_probes(self):
        root = self.repository_fixture()
        source = TOOL.parents[1]
        cloud = (root / 'config/cloud.toml').read_text().replace('ziyixi.science', 'example.test')
        cloud = cloud.replace('ziyixi/todofy', 'new-owner/new-cloud').replace(
            'ziyixi.cloudflareaccess.com', 'new-team.cloudflareaccess.com').replace('cloudflare-579', 'new-workers')
        (root / 'config/cloud.toml').write_text(cloud)
        resources = (root / 'config/resources.toml').read_text()
        account = tomllib.loads(resources)['account_id']
        resources = resources.replace(account, 'a' * 32)
        (root / 'config/resources.toml').write_text(resources)
        outputs = generate.generated_files(root)
        generate.write(root, outputs)
        self.assertEqual(generate.check(root, generate.generated_files(root)), [])
        gateway = tomllib.loads(outputs['todofy/gateway/wrangler.toml'])
        self.assertEqual([route['pattern'] for route in gateway['routes']],
                         ['todofy.example.test', 'todofy-hooks.example.test', 'daily.example.test'])
        self.assertEqual(gateway['vars']['TODOFY_HOOKS_HOSTS'], 'todofy-hooks.example.test,daily.example.test')
        relay = tomllib.loads(outputs['website/relay/wrangler.toml'])
        self.assertEqual(relay['vars']['GITHUB_REPOSITORY'], 'new-owner/new-cloud')
        self.assertEqual(relay['vars']['CANONICAL_HOST'], 'www.example.test')
        self.assertIn('https://www.example.test', outputs['website/content/site.config.ts'])
        self.assertNotIn('ziyixi.science', outputs['watch/worker/src/deployment.ts'])
        self.assertNotIn('cloudflare-579', outputs['watch/worker/src/deployment.ts'])
        self.assertIn('new-workers.workers.dev', outputs['watch/worker/src/deployment.ts'])
        self.assertIn('watch.example.test', outputs['todofy/worker/todofy/deployment.py'])
        self.assertIn('https://github.com/new-owner/new-cloud/actions/workflows/personal-cloud-reconcile.yml',
                      outputs['fleet/web/src/deployment.ts'])
        self.assertIn('https://github.com/new-owner/new-cloud/blob/main/docs/rebuild.md#host-recovery',
                      outputs['fleet/web/src/deployment.ts'])
        self.assertEqual(tomllib.loads(outputs['newsletter/app.toml'])['image'], 'ghcr.io/new-owner/new-cloud-newsletter')
        for relative, text in outputs.items():
            if relative.endswith('wrangler.toml'):
                self.assertEqual(tomllib.loads(text)['account_id'], 'a' * 32)
        sys.path.insert(0, str(source / 'tools/service-catalog'))
        import catalog
        loaded = catalog.load_catalog(root)
        for entry in loaded.entries:
            for url in (entry['url'], entry['status'].get('url')):
                if url:
                    self.assertIn('example.test', url)
                    self.assertNotIn('ziyixi.science', url)
        self.assertEqual(cloud_profile.deployment_urls(cloud_profile.load_profile(root)), {
            'website_url': 'https://www.example.test',
            'relay_url': 'https://ziyixi-notion-publish.new-workers.workers.dev',
        })


if __name__ == '__main__':
    unittest.main()
