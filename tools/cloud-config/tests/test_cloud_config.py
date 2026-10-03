"""Public profile schema and bounded identity-only generation on synthetic files."""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))
import cloud_profile

spec = importlib.util.spec_from_file_location("cloud_config_generate", TOOL / "generate.py")
generate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generate)

CLOUD = '''version = 1
zone = "example.test"
repository = "example/personal-cloud"
access_issuer = "https://synthetic.cloudflareaccess.com"
platform_hostname = "fleet.example.test"
[vps]
platform_runtime_host = "platform-runtime.example.test"
namespace = "personal-cloud"
state_root = "/srv/personal-cloud"
observer_node_key = "vps"
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
                (root / "fleet/app.toml").write_text(MANIFEST.replace("demo", "fleet"))
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


if __name__ == '__main__':
    unittest.main()
