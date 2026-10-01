"""Checks of .github/workflows/infra.yml, the drift plan of infra/: python3 -m unittest discover -s .github/scripts

The workflow holds a production token in a public repository, so its shape is pinned here (infra/README.md
"Drift plan"): plan only (no apply, no import, no state command), main only in the production environment, one
concurrency group, the redacted summary as the only output, nothing uploaded, every action pinned by SHA.
The workflow is read as text (no YAML library on the runner's python3). Standard library only, Python 3.9+.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "infra.yml"


def code(text: str) -> str:
    """The workflow without comment lines and trailing comments (a `# v7` after a SHA stays out)."""
    lines = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        lines.append(re.sub(r"\s+#.*$", "", line))
    return "\n".join(lines)


class InfraWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.code = code(cls.text)

    def test_triggers_are_main_pushes_to_infra_a_schedule_and_dispatch(self):
        on = self.code.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertRegex(on, r"push:\n\s+branches: \[main\]\n\s+paths:\n\s+- infra/\*\*\n")
        self.assertIn("schedule:\n    - cron: ", on)
        self.assertIn("workflow_dispatch:", on)
        for trigger in ("pull_request", "pull_request_target", "workflow_run", "issue_comment", "repository_dispatch"):
            with self.subTest(trigger=trigger):
                self.assertNotIn(trigger, self.code)

    def test_production_on_main_only_in_one_concurrency_group(self):
        self.assertRegex(self.code, r"\nconcurrency:\n  group: infra-production\n  cancel-in-progress: false\n")
        self.assertIn("    if: github.ref == 'refs/heads/main'\n", self.code)
        self.assertEqual(re.findall(r"environment: (\S+)", self.code), ["production"])
        self.assertRegex(self.code, r"\npermissions:\n  contents: read\n")
        self.assertNotRegex(self.code, r"(?m)^[ \t]+permissions:")  # no job widens them

    def test_plan_only_and_only_the_redacted_summary(self):
        runs = re.findall(r"run: (.+)", self.code)
        self.assertEqual(runs, ["python3 infra/scripts/infra_state.py plan --environment production"])
        for word in ("apply", "import", "tofu state", "tofu show", "destroy", "taint", "force-unlock", "upload-artifact",
                     "cache@", "GITHUB_OUTPUT", "set -x"):
            with self.subTest(word=word):
                self.assertNotIn(word, self.code)
        self.assertIn("tofu_wrapper: false", self.code)

    def test_secrets_are_the_token_the_passphrase_and_the_values(self):
        self.assertEqual(
            sorted(set(re.findall(r"secrets\.([A-Z0-9_]+)", self.code))),
            ["CF_API_TOKEN", "INFRA_STATE_PASSPHRASE", "INFRA_TFVARS"],
        )
        self.assertNotRegex(self.code, r"vars\.")
        self.assertNotRegex(self.code, r"run: .*\$\{\{")

    def test_actions_are_pinned_by_sha(self):
        uses = re.findall(r"uses: (\S+)", self.code)
        self.assertEqual(len(uses), 2)
        for action in uses:
            with self.subTest(action=action):
                self.assertRegex(action, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
        self.assertIn("persist-credentials: false", self.code)


if __name__ == "__main__":
    unittest.main()
