"""First-release readiness uses one metadata read and never exposes secret values."""

import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location("router_connections", Path(__file__).resolve().parents[1] / "check_connections.py")
connections = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(connections)
ACCOUNT = "a" * 32
PRIVATE_TOKEN = "synthetic-private-bypass-token-never-print"
NAMES = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_CLIENT_ID", "CODEX_ACCESS_CLIENT_SECRET", "MODEL_ROUTER_NEWSLETTER_TOKEN"]


class ConnectionReadiness(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "model-router").mkdir()
        (self.root / "model-router/wrangler.toml").write_text(f'name = "model-router"\naccount_id = "{ACCOUNT}"\n')
        (self.root / "model-router/app.toml").write_text('[[workers]]\nowner_machine_secrets = ' + repr(NAMES) + '\n')

    def check(self, listed):
        api = Mock()
        api.call.return_value = listed
        output = io.StringIO()
        with redirect_stdout(output):
            code = connections.main(api, self.root)
        api.call.assert_called_once_with(f"/accounts/{ACCOUNT}/workers/scripts/model-router/secrets")
        self.assertNotIn(PRIVATE_TOKEN, output.getvalue())
        return code, output.getvalue()

    def test_one_metadata_read_accepts_all_declared_names_without_printing_values(self):
        code, output = self.check([{"name": name, "type": "secret_text", "value": PRIVATE_TOKEN} for name in NAMES])
        self.assertEqual(code, 0)
        self.assertIn("names are present", output)

    def test_missing_connection_refuses_release_and_reports_only_its_declared_name(self):
        code, output = self.check([{"name": name} for name in NAMES if name != "MODEL_ROUTER_NEWSLETTER_TOKEN"])
        self.assertEqual(code, 1)
        self.assertIn("MODEL_ROUTER_CONNECTIONS_MISSING: MODEL_ROUTER_NEWSLETTER_TOKEN", output)

    def test_invalid_provider_metadata_fails_closed_without_echoing_its_contents(self):
        for listed in ({"value": PRIVATE_TOKEN}, [{"name": PRIVATE_TOKEN}, None], [{"name": PRIVATE_TOKEN}]):
            with self.subTest(shape=type(listed).__name__):
                self.assertEqual(self.check(listed)[0], 1)


if __name__ == "__main__":
    unittest.main()
