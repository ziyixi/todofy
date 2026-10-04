"""Checks of the two workflows of infra/: python3 -m unittest discover -s .github/scripts

- .github/workflows/infra.yml, the drift plan (infra/README.md "Drift plan"): plan only (no apply, no import, no state
  command), main only in the production environment, one concurrency group, the redacted summary as the only output,
  nothing uploaded, every action pinned by SHA.
- .github/workflows/infra-apply.yml, the apply (infra/README.md "Apply"): a manual dispatch only, main only in the
  production environment and the same concurrency group, one step that runs `infra_state.py apply` (its backup, gates
  and saved-plan apply are tested in infra/tests), the dispatch inputs through the environment only.
Both hold a production token in a public repository, so their shape is pinned here. The workflows are read as text (no
YAML library on the runner's python3). Standard library only, Python 3.9+.
"""

import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "infra" / "scripts"))
import infra_state  # noqa: E402  (standard library only)

WORKFLOW = REPO / ".github" / "workflows" / "infra.yml"
APPLY = REPO / ".github" / "workflows" / "infra-apply.yml"


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

    def test_triggers_are_main_pushes_to_infra_and_dispatch(self):
        on = self.code.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertRegex(on, r"push:\n\s+branches: \[main\]\n\s+paths:\n\s+- infra/\*\*\n")
        self.assertNotIn("schedule:", on)
        self.assertIn("schedule:", (REPO / ".github/workflows/personal-cloud-reconcile.yml").read_text())
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


class InfraApplyWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = APPLY.read_text()
        cls.code = code(cls.text)

    def test_a_manual_dispatch_only_with_the_two_inputs(self):
        on = self.code.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertTrue(on.startswith("  workflow_dispatch:\n    inputs:\n"), on)
        self.assertEqual(re.findall(r"(?m)^      ([a-z_]+):$", on), ["expect", "confirm_destructive"])
        self.assertRegex(on, r"expect:\n(?:        .+\n)*?        required: true\n")
        self.assertRegex(on, r"confirm_destructive:\n(?:        .+\n)*?        default: ''\n")
        for trigger in ("push", "schedule", "pull_request", "workflow_run", "issue_comment", "repository_dispatch",
                        "workflow_call"):
            with self.subTest(trigger=trigger):
                self.assertNotRegex(on, rf"(?m)^  {trigger}:")

    def test_production_on_main_only_in_the_shared_concurrency_group(self):
        self.assertRegex(self.code, r"\nconcurrency:\n  group: infra-production\n  cancel-in-progress: false\n")
        self.assertIn("    if: github.ref == 'refs/heads/main'\n", self.code)
        self.assertEqual(re.findall(r"environment: (\S+)", self.code), ["production"])
        self.assertRegex(self.code, r"\npermissions:\n  contents: read\n")
        self.assertNotRegex(self.code, r"(?m)^[ \t]+permissions:")
        self.assertEqual(re.findall(r"(?m)^  ([a-z-]+):$", self.code.split("\njobs:\n", 1)[1]), ["apply"])

    def test_one_step_runs_the_gated_apply_and_nothing_else(self):
        runs = re.findall(r"run: (.+)", self.code)
        self.assertEqual(runs, ["python3 infra/scripts/infra_state.py apply --environment production"])
        for word in ("tofu apply", "auto-approve", "tofu import", "tofu state", "tofu show", "destroy", "taint",
                     "force-unlock", "cache@", "GITHUB_OUTPUT", "set -x", "-target"):
            with self.subTest(word=word):
                self.assertNotIn(word, self.code)
        self.assertIn("tofu_wrapper: false", self.code)

    def test_secrets_and_inputs_reach_the_script_through_the_environment_only(self):
        self.assertEqual(
            sorted(set(re.findall(r"secrets\.([A-Z0-9_]+)", self.code))),
            ["CF_API_TOKEN", "INFRA_STATE_PASSPHRASE", "INFRA_TFVARS"],
        )
        self.assertIn("INFRA_APPLY_EXPECT: ${{ inputs.expect }}\n", self.code)
        self.assertIn("INFRA_CONFIRM_DESTRUCTIVE: ${{ inputs.confirm_destructive }}\n", self.code)
        self.assertEqual(len(re.findall(r"inputs\.", self.code)), 2)
        self.assertEqual(set(re.findall(r"vars\.([A-Z0-9_]+)", self.code)), {"VPS_BOOTSTRAP_CERT"})
        self.assertNotRegex(self.code, r"run: .*\$\{\{")

    def test_actions_are_pinned_by_sha_and_match_the_drift_workflow(self):
        uses = re.findall(r"uses: (\S+)", self.code)
        shared = re.findall(r"uses: (\S+)", code(WORKFLOW.read_text()))
        self.assertEqual(uses[:len(shared)], shared)
        self.assertEqual(uses[len(shared):], ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"])
        self.assertIn("path: ${{ runner.temp }}/platform-bootstrap.cms", self.code)
        self.assertIn("retention-days: 1", self.code)
        self.assertIn("if: vars.VPS_BOOTSTRAP_CERT != ''", self.code)
        for action in uses:
            with self.subTest(action=action):
                self.assertRegex(action, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
        self.assertIn("persist-credentials: false", self.code)

    def test_the_script_recognises_this_workflow_by_its_name(self):
        """infra_state.py apply refuses unless GITHUB_WORKFLOW is this workflow's name (and main, workflow_dispatch)."""
        self.assertEqual(re.findall(r"(?m)^name: (.+)$", self.code), [infra_state.APPLY_WORKFLOW])
        self.assertEqual(infra_state.APPLY_EVENT, "workflow_dispatch")
        self.assertEqual(infra_state.APPLY_REF, "refs/heads/main")
        self.assertNotRegex(self.code, r"GITHUB_(REF|EVENT_NAME|WORKFLOW):")  # the runner's own values, never overridden

    def test_the_drift_workflow_never_applies(self):
        drift = code(WORKFLOW.read_text())
        self.assertNotIn("infra_state.py apply", drift)
        self.assertNotIn("workflow_dispatch:\n    inputs", drift)


if __name__ == "__main__":
    unittest.main()
