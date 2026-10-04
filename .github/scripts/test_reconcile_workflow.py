"""Prevent automatic sensitive apply or unverified deployment in the reconciliation workflow."""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github/workflows/personal-cloud-reconcile.yml"


def job(text, name):
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-z-]+:\n|\Z)",
        text.split("\njobs:\n", 1)[1],
    )
    if match is None:
        raise AssertionError("Missing job " + name)
    return match.group(1)


class ReconcileWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()

    def test_only_manual_schedule_or_current_successful_main_can_start(self):
        triggers = self.text.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
        self.assertIn("schedule:", triggers)
        self.assertIn("workflows: [CI and deploy]", triggers)
        self.assertIn("branches: [main]", triggers)
        self.assertIn("types: [completed]", triggers)
        self.assertIn("options: [check, repair, resume]", triggers)
        self.assertIn("default: check", triggers)
        for forbidden in (
            "pull_request",
            "pull_request_target",
            "repository_dispatch",
            "issue_comment",
        ):
            self.assertNotIn(forbidden, triggers)
        guard = job(self.text, "context")
        for requirement in (
            "github.ref == 'refs/heads/main'",
            "workflow_run.conclusion == 'success'",
            "workflow_run.head_branch == 'main'",
            "head_repository.full_name == github.repository",
        ):
            self.assertIn(requirement, guard)
        self.assertIn('if [ "$EXPECTED_SOURCE" != "$main_sha" ]', guard)
        self.assertIn("enabled=false", guard)
        self.assertNotIn("secrets.", guard)

    def test_default_checks_and_opt_in_repair_never_auto_resume(self):
        guard = job(self.text, "context")
        self.assertIn("operation=check", guard)
        self.assertIn("vars.PERSONAL_CLOUD_AUTO_REPAIR", guard)
        self.assertIn(
            'elif [ "$AUTO_REPAIR" = true ]; then\n            operation=repair', guard
        )
        self.assertIn('if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then', guard)
        self.assertNotIn("operation=resume", guard)
        for name in ("infra", "workers"):
            self.assertIn("outputs.operation != 'resume'", job(self.text, name))

    def test_runtime_jobs_take_the_existing_locks_and_recheck_main(self):
        for name, group in (
            ("infra", "infra-production"),
            ("infra-apply", "infra-production"),
            ("vps", "vps-production"),
        ):
            block = job(self.text, name)
            self.assertIn("group: " + group, block)
            self.assertIn("cancel-in-progress: false", block)
            self.assertIn("ref: ${{ needs.context.outputs.source_sha }}", block)
            self.assertIn('test "$EXPECTED_SOURCE" = "$(gh api', block)
            self.assertNotIn("git pull", block)

    def test_infrastructure_inspection_captures_drift_without_approving_it(self):
        block = job(self.text, "infra")
        self.assertIn(
            'if [ "$RECONCILE_OPERATION" = check ]; then args+=(--check-only); fi',
            block,
        )
        self.assertIn("infra_state.py reconcile --environment production", block)
        self.assertIn('--github-output "$GITHUB_OUTPUT"', block)
        self.assertIn(
            'if [ "$status" != 0 ] && [ "$status" != 2 ]; then exit "$status"; fi',
            block,
        )
        self.assertNotIn("approved-apply", block)
        self.assertNotIn("INFRA_REVIEWED_APPLY", block)

    def test_sensitive_apply_requires_actual_protection_and_this_runs_exact_saved_plan(
        self,
    ):
        protection = job(self.text, "review-protection")
        self.assertIn(
            "github.event_name == 'workflow_dispatch' && inputs.reviewed_apply",
            protection,
        )
        self.assertIn("environments/infra-review", protection)
        self.assertIn("required_reviewers", protection)
        self.assertIn("actions: read", protection)
        self.assertIn('test "$protected" = true', protection)
        review = job(self.text, "infra-review")
        self.assertIn("environment: infra-review", review)
        self.assertIn("needs.review-protection.result == 'success'", review)
        self.assertNotIn("secrets.", review)
        apply = job(self.text, "infra-apply")
        self.assertIn("needs: [context, infra, infra-review]", apply)
        self.assertIn("needs.infra-review.result == 'success'", apply)
        self.assertIn(
            "github.event_name == 'workflow_dispatch' && inputs.reviewed_apply", apply
        )
        self.assertIn("environment: production", apply)
        self.assertIn("actions: read", apply)
        self.assertIn("INFRA_REVIEWED_APPLY: reviewed-plan", apply)
        self.assertIn("PLAN_KEY: ${{ needs.infra.outputs.plan_key }}", apply)
        self.assertIn("PLAN_EXPECT: ${{ needs.infra.outputs.expect }}", apply)
        self.assertIn("approved-apply --environment production", apply)
        self.assertIn('--plan-key "$PLAN_KEY" --expect "$PLAN_EXPECT"', apply)
        self.assertIn('test "$protected" = true', apply)
        self.assertNotIn("tofu apply", apply)

    def test_worker_repair_reuses_last_good_recipe_and_app_locks(self):
        block = job(self.text, "workers")
        self.assertIn("uses: ./.github/workflows/worker-release.yml", block)
        self.assertIn("repair: true", block)
        self.assertIn(
            "check_only: ${{ needs.context.outputs.operation == 'check' }}", block
        )
        self.assertIn(
            "expected_main_sha: ${{ needs.context.outputs.source_sha }}", block
        )
        self.assertNotIn("source_sha:", block)
        self.assertIn("fail-fast: false", block)
        self.assertIn("secrets: inherit", block)
        self.assertIn("website-relay", block)

    def test_vps_uses_only_typed_api_and_records_actual_evidence(self):
        block = job(self.text, "vps")
        self.assertIn("vars.VPS_DEPLOY_ENABLED == 'true'", block)
        self.assertIn("reconcile_id", block)
        self.assertIn("GITHUB_RUN_ATTEMPT", block)
        self.assertIn('if [ "$operation" = check ]; then operation=plan; fi', block)
        self.assertIn(
            'if [ "$operation" = resume ]; then args+=(--release-name "$RESUME_RELEASE"); fi',
            block,
        )
        self.assertIn('--request-id "$request_id"', block)
        self.assertIn('--evidence-file "$RUNNER_TEMP/vps-release-evidence.json"', block)
        self.assertIn('if [ -f "$RUNNER_TEMP/vps-release-evidence.json" ]; then', block)
        self.assertIn("tools/cloud-release/vps_record.py", block)
        for forbidden in (
            "ssh ",
            "sudo ",
            "kubectl",
            "KUBECONFIG",
            "docker ",
            "-i private",
        ):
            self.assertNotIn(forbidden, block)

    def test_normal_ci_requires_a_recovery_bundle_before_accepting_a_vps_release(self):
        text = (REPO / ".github/workflows/ci.yml").read_text()
        block = job(text, "vps-deploy")
        dependencies = re.search(r"needs: \[([^\]]+)\]", block)
        self.assertIsNotNone(dependencies)
        self.assertIn("vps-bootstrap-bundle", dependencies.group(1).split(", "))
        branches = re.search(
            r"&& \(\((.*?)\n      && needs\.gate\.result", block, re.DOTALL
        )
        self.assertIsNotNone(branches)
        resume, publication = branches.group(1).split("||", 1)
        self.assertIn(
            "github.event_name == 'workflow_dispatch' && inputs.resume_vps_release",
            resume,
        )
        self.assertIn("needs.vps-bootstrap-bundle.result == 'skipped'", resume)
        self.assertNotIn("needs.vps-bootstrap-bundle.result == 'success'", resume)
        self.assertIn(
            "!(github.event_name == 'workflow_dispatch' && inputs.resume_vps_release)",
            publication,
        )
        self.assertIn("needs.vps-bootstrap-bundle.result == 'success'", publication)
        self.assertNotIn("needs.vps-bootstrap-bundle.result == 'skipped'", publication)
        self.assertEqual(block.count("needs.vps-bootstrap-bundle.result"), 2)
        bundle = job(text, "vps-bootstrap-bundle")
        self.assertIn("needs.newsletter-deploy.result == 'success'", bundle)
        self.assertIn("needs.platform-image.result == 'success'", bundle)
        self.assertNotIn("VPS_DEPLOY_ENABLED", bundle)

    def test_inputs_never_reach_shell_code_and_actions_stay_pinned(self):
        in_run = False
        for line in self.text.splitlines():
            if re.match(r"\s+run:", line):
                in_run = True
                self.assertNotIn("${{", line)
            elif in_run and re.match(r"\s+(- name:|- uses:|[a-z_]+:)", line):
                in_run = False
            elif in_run:
                self.assertNotIn("${{ inputs.", line)
        for action in re.findall(r"uses: (\S+)", self.text):
            if action.startswith("./"):
                continue
            self.assertRegex(action, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")
        self.assertNotIn("persist-credentials: true", self.text)
        self.assertNotIn("set -x", self.text)
        self.assertNotRegex(self.text, r"(?m)^\s+GITHUB_(REF|SHA|EVENT_NAME|WORKFLOW):")
