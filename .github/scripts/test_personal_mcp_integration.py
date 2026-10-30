"""The private MCP releases independently and uses explicit private service bindings."""

import re
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).absolute().parents[2]


class PersonalMcpIntegration(unittest.TestCase):
    def test_private_mcp_has_an_independent_bazel_release(self):
        build = (ROOT / "personal-mcp/BUILD.bazel").read_text()
        self.assertIn('"release:worker:personal-mcp"', build)
        self.assertIn('"artifact://personal-mcp:personal-mcp"', build)
        home = tomllib.loads((ROOT / "dashboard/wrangler.toml").read_text())
        self.assertTrue(any(item["service"] == "personal-mcp" for item in home["services"]))

    def test_worker_uses_one_sqlite_object_and_the_private_application_apis(self):
        config = tomllib.loads((ROOT / "personal-mcp/wrangler.toml").read_text())
        self.assertFalse(config["workers_dev"])
        self.assertFalse(config["preview_urls"])
        self.assertEqual(config["durable_objects"]["bindings"], [
            {"name": "SUBSCRIPTIONS", "class_name": "SubscriptionStore"},
        ])
        self.assertEqual(config["migrations"], [
            {"tag": "v1", "new_sqlite_classes": ["SubscriptionStore"]},
        ])
        self.assertEqual(config["services"], [
            {"binding": "TASKS", "service": "tasks", "entrypoint": "TasksApi", "props": {"access": "read-write"}},
            # Todofy's Mail entry, read only: Tasks converts the mail (through TASKS).
            {"binding": "TODOFY_MAIL", "service": "todofy", "entrypoint": "Mail", "props": {"access": "read"}},
            {"binding": "RECALL", "service": "recall", "entrypoint": "RecallApi"},
            {"binding": "HOME", "service": "home", "entrypoint": "HomeApi"},
            {"binding": "WATCH", "service": "watch", "entrypoint": "WatchApi", "props": {"access": "read-write"}},
        ])
        # The one bucket is the store's own daily backup (personal-mcp/docs/backup.md); no D1, assets or cron.
        self.assertEqual(config["r2_buckets"], [{"binding": "BACKUPS", "bucket_name": "personal-mcp-backups"}])
        for key in ("d1_databases", "assets", "triggers"):
            self.assertNotIn(key, config)

    def test_managed_oauth_applies_only_to_the_private_mcp_and_exact_callback(self):
        source = (ROOT / "infra/access.tf").read_text()
        self.assertIn('oauth_configuration = each.key == "personal-mcp" ? {', source)
        block = source.split('oauth_configuration = each.key == "personal-mcp" ? {', 1)[1].split('} : null', 1)[0]
        self.assertIn('enabled = true', block)
        self.assertIn('allow_any_on_localhost = false', block)
        self.assertIn('allow_any_on_loopback  = false', block)
        allowed = re.search(r'allowed_uris\s*=\s*\[([^\]]+)\]', block).group(1)
        self.assertEqual(re.findall(r'"([^"\n]+)"', allowed), [
            'https://chatgpt.com/connector_platform_oauth_redirect',
            'https://chatgpt.com/connector/oauth/FSrczCNZCMHZ',
        ])
        self.assertNotIn('*', allowed)
