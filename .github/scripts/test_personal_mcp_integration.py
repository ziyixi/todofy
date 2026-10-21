"""The first private MCP gate cannot publish or gain business-service bindings prematurely."""

import re
import tomllib
import unittest
from pathlib import Path

import ci_changes

ROOT = Path(__file__).resolve().parents[2]


class PersonalMcpIntegration(unittest.TestCase):
    def test_first_gate_checks_without_deploying_or_coupling_other_apps(self):
        flags = ci_changes.classify(["personal-mcp/worker/src/index.ts"])
        self.assertTrue(flags["personal_mcp_check"])
        self.assertFalse(flags["personal_mcp_deploy"])
        self.assertFalse(flags["contracts"])
        self.assertFalse(any(value for key, value in flags.items() if key.endswith("_deploy")))
        self.assertNotIn("personal-mcp", ci_changes.HOME_BOUND)

    def test_worker_uses_one_sqlite_object_and_no_business_data_binding(self):
        config = tomllib.loads((ROOT / "personal-mcp/wrangler.toml").read_text())
        self.assertFalse(config["workers_dev"])
        self.assertFalse(config["preview_urls"])
        self.assertEqual(config["durable_objects"]["bindings"], [
            {"name": "SUBSCRIPTIONS", "class_name": "SubscriptionStore"},
        ])
        self.assertEqual(config["migrations"], [
            {"tag": "v1", "new_sqlite_classes": ["SubscriptionStore"]},
        ])
        for key in ("d1_databases", "r2_buckets", "services", "assets", "triggers"):
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
        ])
        self.assertNotIn('*', allowed)
