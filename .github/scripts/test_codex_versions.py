"""The executor owns the pinned Codex runtime; Newsletter calls the shared Router client."""

from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).absolute().parents[2]


class CodexVersions(unittest.TestCase):
    def test_the_executor_owns_the_pinned_runtime(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        specs = [
            value
            for value in project["tool"]["uv"]["constraint-dependencies"]
            if value.startswith("openai-codex==")
        ]
        self.assertEqual(len(specs), 1)
        expected = specs[0].split("==", 1)[1]
        lock = tomllib.loads((ROOT / "uv.lock").read_text())
        packages = {package["name"]: package for package in lock["package"]}
        self.assertEqual(packages["openai-codex"]["version"], expected)
        self.assertEqual(packages["openai-codex-cli-bin"]["version"], expected)
        gateway = tomllib.loads((ROOT / "codex-gateway/pyproject.toml").read_text())
        self.assertIn("openai-codex", gateway["project"]["dependencies"])

    def test_newsletter_uses_router_without_embedding_a_codex_runtime(self):
        project = tomllib.loads((ROOT / "newsletter/pyproject.toml").read_text())
        dependencies = project["project"]["dependencies"]
        self.assertIn("ziyixi-model-router-client", dependencies)
        self.assertNotIn("openai-codex", dependencies)
        self.assertFalse((ROOT / "newsletter/src/newsletter/codex_runtime.py").exists())


if __name__ == "__main__":
    unittest.main()
