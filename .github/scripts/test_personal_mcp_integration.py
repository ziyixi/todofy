"""The private MCP releases independently and uses explicit private service bindings."""

import re
import tomllib
import unittest
from pathlib import Path

import ci_changes

ROOT = Path(__file__).resolve().parents[2]


class PersonalMcpIntegration(unittest.TestCase):
    def test_private_mcp_source_checks_and_publishes_only_its_own_worker(self):
        flags = ci_changes.classify(["personal-mcp/worker/src/index.ts"])
        self.assertTrue(flags["personal_mcp_check"])
        self.assertTrue(flags["personal_mcp_deploy"])
        self.assertTrue(flags["contracts"])
        self.assertEqual({key for key, value in flags.items() if key.endswith("_deploy") and value},
                         {"personal_mcp_deploy"})
        self.assertIn("personal-mcp", ci_changes.HOME_BOUND)

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
            {"binding": "TODOFY_MAIL", "service": "todofy", "entrypoint": "MailApi"},
            {"binding": "RECALL", "service": "recall", "entrypoint": "RecallApi"},
            {"binding": "HOME", "service": "home", "entrypoint": "HomeApi"},
        ])
        for key in ("d1_databases", "r2_buckets", "assets", "triggers"):
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
