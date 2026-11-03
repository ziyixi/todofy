"""Checks of .github/workflows/infra-apply.yml, the apply of infra/ (infra/README.md "Apply"): python3 -m unittest
discover -s .github/scripts

A manual dispatch only, main only in the production environment and the infra-production concurrency group, one step
that runs `infra_state.py apply` (its backup, gates and saved-plan apply are tested in infra/tests), the dispatch inputs
through the environment only. The drift report is the infra job of personal-cloud-reconcile.yml
(test_reconcile_workflow.py); no other workflow runs the state driver. The apply holds a production token in a public
repository, so its shape is pinned here. The workflows are read as text (no YAML library on the runner's python3).
Standard library only, Python 3.9+.
"""

import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).absolute().parents[2]
sys.path.insert(0, str(REPO / "infra" / "scripts"))
import infra_state  # noqa: E402  (standard library only)

WORKFLOWS = REPO / ".github" / "workflows"
APPLY = WORKFLOWS / "infra-apply.yml"
RECONCILE = WORKFLOWS / "personal-cloud-reconcile.yml"


def code(text: str) -> str:
    """The workflow without comment lines and trailing comments (a `# v7` after a SHA stays out)."""
    lines = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        lines.append(re.sub(r"\s+#.*$", "", line))
    return "\n".join(lines)


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

    def test_actions_are_pinned_by_sha_and_match_the_reconciles_infra_job(self):
        uses = re.findall(r"uses: (\S+)", self.code)
        infra_job = code(RECONCILE.read_text()).split("\n  infra:\n", 1)[1].split("\n  workers:\n", 1)[0]
        shared = re.findall(r"uses: (\S+)", infra_job)
        self.assertEqual(len(shared), 2)
        self.assertEqual(uses[:len(shared)], shared)
        self.assertEqual(uses[len(shared):], ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"] * 2)
        self.assertIn("path: ${{ runner.temp }}/platform-bootstrap.cms", self.code)
        self.assertIn("path: ${{ runner.temp }}/codex-gateway-bootstrap.cms", self.code)
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

    def test_only_this_workflow_and_the_reconcile_run_the_state_driver(self):
        """One drift report (the reconcile's `reconcile`) and one approved write (this workflow's `apply`)."""
        callers = {path.name: re.findall(r"infra/scripts/infra_state\.py (\S+)", code(path.read_text()))
                   for path in sorted(WORKFLOWS.glob("*.yml"))}
        self.assertEqual({name: found for name, found in callers.items() if found},
                         {"infra-apply.yml": ["apply"], "personal-cloud-reconcile.yml": ["reconcile"]})


if __name__ == "__main__":
    unittest.main()
