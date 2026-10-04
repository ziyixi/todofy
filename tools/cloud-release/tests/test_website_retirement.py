"""The content-only relay retirement calls only the three approved secret deletions."""

import importlib.util
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, call, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/cloud-release"))
from api import ReleaseError

SPEC = importlib.util.spec_from_file_location(
    "website_relay_retirement", ROOT / "website/relay/deploy/retire-secrets.py"
)
retirement = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retirement)

ACCOUNT = "a" * 32
PATH = f"/accounts/{ACCOUNT}/workers/scripts/ziyixi-notion-publish/secrets"
CONFIG = f'''name = "ziyixi-notion-publish"
account_id = "{ACCOUNT}"
[vars]
DAILY_SYNC_CRON = "17 10 * * *"
'''


class WebsiteSecretRetirement(unittest.TestCase):
    def run_retirement(self, api, config=CONFIG):
        output = io.StringIO()
        with (
            patch.object(retirement, "Api", return_value=api),
            patch.object(retirement.Path, "read_text", return_value=config),
            patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "synthetic-private-token"}),
            redirect_stdout(output),
        ):
            result = retirement.main()
        self.assertNotIn("synthetic-private", output.getvalue())
        return result, json.loads(output.getvalue())

    def test_deletes_only_known_names_and_preserves_dispatch_and_unknown_secrets(self):
        api = Mock()
        api.call.side_effect = [[
            {"name": "NOTION_TOKEN"}, {"name": "NOTION_DATA_SOURCE_ID"},
            {"name": "NOTION_WEBHOOK_SECRET"}, {"name": "GITHUB_DISPATCH_TOKEN"},
            {"name": "NOTION_TOKEN_EXTRA"}, {"name": "OTHER_PRIVATE_SECRET"},
        ], None, None, None]
        result, event = self.run_retirement(api)
        self.assertEqual(result, 0)
        self.assertEqual(event["status"], "complete")
        self.assertEqual(api.call.call_args_list, [
            call(PATH),
            call(PATH + "/NOTION_DATA_SOURCE_ID", method="DELETE"),
            call(PATH + "/NOTION_TOKEN", method="DELETE"),
            call(PATH + "/NOTION_WEBHOOK_SECRET", method="DELETE"),
        ])

    def test_repeated_retirement_and_partial_progress_are_safe(self):
        for names in ([], ["GITHUB_DISPATCH_TOKEN"], ["NOTION_WEBHOOK_SECRET"]):
            with self.subTest(names=names):
                api = Mock()
                api.call.side_effect = [[{"name": name} for name in names], None]
                self.assertEqual(self.run_retirement(api)[0], 0)
                expected = [call(PATH)]
                if "NOTION_WEBHOOK_SECRET" in names:
                    expected.append(call(PATH + "/NOTION_WEBHOOK_SECRET", method="DELETE"))
                self.assertEqual(api.call.call_args_list, expected)

    def test_unknown_worker_or_old_config_stops_before_provider_access(self):
        for config in (
            CONFIG.replace("ziyixi-notion-publish", "another-worker"),
            CONFIG.split("[vars]")[0],
        ):
            with self.subTest(config=config):
                api = Mock()
                result, event = self.run_retirement(api, config)
                self.assertEqual(result, 1)
                self.assertEqual(event["status"], "failed")
                api.call.assert_not_called()

    def test_invalid_inventory_stops_before_any_secret_is_deleted(self):
        for inventory in ({"name": "NOTION_TOKEN"}, [None], [{"name": []}],
                          [{"name": "NOTION_TOKEN"}, {}]):
            with self.subTest(inventory=inventory):
                api = Mock()
                api.call.return_value = inventory
                result, event = self.run_retirement(api)
                self.assertEqual(result, 1)
                self.assertEqual(event["status"], "failed")
                api.call.assert_called_once_with(PATH)

    def test_failed_provider_delete_cannot_report_completed_retirement(self):
        api = Mock()
        api.call.side_effect = [[{"name": "NOTION_TOKEN"}], ReleaseError("PROVIDER_HTTP_403")]
        result, event = self.run_retirement(api)
        self.assertEqual(result, 1)
        self.assertEqual(event["status"], "failed")
        self.assertEqual(api.call.call_args_list, [
            call(PATH), call(PATH + "/NOTION_TOKEN", method="DELETE"),
        ])


if __name__ == "__main__":
    unittest.main()
