"""All VPS Codex consumers use one matching, locked SDK/runtime version."""

import ast
from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CodexVersions(unittest.TestCase):
    def test_newsletter_and_gateway_share_the_pinned_runtime(self):
        versions = {}
        for app, runtime in (
            ("newsletter", "src/newsletter/codex_runtime.py"),
            ("codex-gateway", "src/codex_gateway/runtime.py"),
        ):
            with self.subTest(app=app):
                project = tomllib.loads((ROOT / app / "pyproject.toml").read_text())
                dependencies = project["project"].get("dependencies", [])
                for extra in project["project"].get("optional-dependencies", {}).values():
                    dependencies = [*dependencies, *extra]
                specs = [value for value in dependencies if value.startswith("openai-codex==")]
                self.assertEqual(len(specs), 1)
                expected = specs[0].split("==", 1)[1]
                versions[app] = expected
                lock = tomllib.loads((ROOT / app / "uv.lock").read_text())
                packages = {package["name"]: package for package in lock["package"]}
                self.assertEqual(packages["openai-codex"]["version"], expected)
                self.assertEqual(packages["openai-codex-cli-bin"]["version"], expected)
                constants = {
                    node.targets[0].id: ast.literal_eval(node.value)
                    for node in ast.parse((ROOT / app / runtime).read_text()).body
                    if isinstance(node, ast.Assign)
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == "SDK_VERSION"
                }
                self.assertEqual(constants["SDK_VERSION"], expected)
        self.assertEqual(versions["newsletter"], versions["codex-gateway"])


if __name__ == "__main__":
    unittest.main()
