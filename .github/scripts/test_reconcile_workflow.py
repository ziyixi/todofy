"""Prevent automatic sensitive apply or unverified deployment in the reconciliation workflow."""

import ast
import re
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).absolute().parents[2]
sys.path.insert(0, str(REPO / "tools" / "service-catalog"))
from catalog import load_catalog  # noqa: E402

WORKFLOW = REPO / ".github/workflows/personal-cloud-reconcile.yml"


def constant(path, name):
    """A module-level literal, read without importing the tool (its module names are generic)."""
    for node in ast.parse((REPO / path).read_text()).body:
        targets = getattr(node, "targets", None) or [getattr(node, "target", None)]
        if any(isinstance(target, ast.Name) and target.id == name for target in targets):
            if ast.unparse(node.value) == "set()":
                return set()
            return ast.literal_eval(node.value)
    raise AssertionError(f"Missing {name} in {path}")


def job(text, name):
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-z-]+:\n|\Z)",
        text.split("\njobs:\n", 1)[1],
    )
    if match is None:
        raise AssertionError("Missing job " + name)
    return match.group(1)


class ReconcileWorkflow(unittest.TestCase):
    def test_inventory_generates_private_registration_from_the_context_source_without_a_secret_fallback(self):
        block = job(self.text, "inventory")
        self.assertIn("environment: production", block)
        self.assertIn("ref: ${{ needs.context.outputs.source_sha }}", block)
        self.assertIn("uses: ./.github/actions/private-catalog", block)
        self.assertIn("source-root: .", block)
        self.assertIn("private-ssh-key: ${{ secrets.TODOFY_PRIVATE_SSH_KEY }}", block)
        self.assertIn("output-file: ${{ runner.temp }}/private-catalog.json", block)
        self.assertIn('inventory.py --private-catalog-file "$RUNNER_TEMP/private-catalog.json"', block)
        self.assertIn('if: always()\n        run: rm -f "$RUNNER_TEMP/private-catalog.json"', block)
        self.assertNotIn("secrets.PRIVATE_CATALOG", block)
        self.assertNotIn("upload-artifact", block)

    def test_scheduled_inventory_compares_live_private_sources_without_naming_them(self):
        block = job(self.text, "inventory")
        # Deployment records and CI runs on main, read with the job token only.
        self.assertIn("    permissions:\n      contents: read\n      actions: read\n      deployments: read\n    steps:\n",
                      block)
        step = block.split("      - name: Compare the live private sources with the pinned gitlink\n", 1)[1]
        step = step.split("\n      - ", 1)[0]
        self.assertEqual(
            step,
            "        if: ${{ !cancelled() && github.event_name == 'schedule' && "
            "steps.private_catalog.outcome == 'success' }}\n"
            "        env:\n"
            "          GH_TOKEN: ${{ github.token }}\n"
            '        run: python3 .github/scripts/private_revision.py --source-root . '
            '--catalog-file "$RUNNER_TEMP/private-catalog.json"',
        )
        self.assertIn("      - name: Generate registration from the selected private source\n"
                      "        id: private_catalog\n", block)
        # The probe address comes from the generated catalogue at run time; removal still follows every outcome.
        self.assertLess(block.index("private_revision.py"), block.index('rm -f "$RUNNER_TEMP/private-catalog.json"'))
        self.assertNotIn("https://", block)

    def test_explicit_record_operation_reuses_only_the_protected_receipt_job(self):
        block = job(self.text, "record-worker")
        self.assertIn("github.event_name == 'workflow_dispatch'", block)
        self.assertIn("needs.context.outputs.operation == 'record'", block)
        self.assertIn("uses: ./.github/workflows/worker-release.yml", block)
        self.assertIn("record_only: true", block)
        self.assertIn("actions: read", block)
        self.assertIn("contents: read", block)
        self.assertIn("deployments: write", block)
        self.assertIn("app: ${{ inputs.record_app }}", block)
        self.assertIn("deployment_id: ${{ inputs.record_deployment_id }}", block)
        self.assertIn("expected_main_sha: ${{ needs.context.outputs.source_sha }}", block)
        self.assertIn("secrets: inherit", block)
        for name in ("infra", "workers", "vps", "inventory", "infra-result"):
            self.assertIn("needs.context.outputs.operation != 'record'", job(self.text, name))

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()

    def test_only_manual_schedule_or_current_successful_main_can_start(self):
        triggers = self.text.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
        self.assertIn("schedule:", triggers)
        self.assertIn("workflows: [CI and deploy]", triggers)
        self.assertIn("branches: [main]", triggers)
        self.assertIn("types: [completed]", triggers)
        self.assertIn("options: [check, repair, resume, record]", triggers)
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
        self.assertIn("    outputs:\n      state: ${{ steps.reconcile.outputs.state }}\n    steps:\n", block)

    def test_infra_apply_is_the_only_approved_infrastructure_write(self):
        """A plan the routine repair does not cover is applied by "Infra apply" with the expect line the infra job
        prints; the reconcile keeps no saved plan, approval environment or apply job of its own."""
        jobs = re.findall(r"(?m)^  ([a-z-]+):$", self.text.split("\njobs:\n", 1)[1])
        self.assertEqual(jobs, ["context", "infra", "workers", "record-worker", "vps", "inventory", "infra-result"])
        for forbidden in ("reviewed_apply", "infra-review", "approved-apply", "INFRA_REVIEWED_APPLY", "plan_key",
                          "infra_state.py apply"):
            self.assertNotIn(forbidden, self.text)
        self.assertEqual(self.text.count("infra/scripts/infra_state.py"), 1)

    def test_infrastructure_result_runs_after_the_comparison_but_not_during_resume(self):
        block = job(self.text, "infra-result")
        self.assertIn("needs: [context, infra]", block)
        self.assertIn("always()", block)
        self.assertIn("needs.context.outputs.enabled == 'true'", block)
        self.assertIn("needs.context.outputs.operation != 'resume'", block)
        self.assertIn("INFRA_STATE: ${{ needs.infra.outputs.state }}", block)
        for forbidden in ("environment:", "permissions:", "uses:", "secrets.", "gh api"):
            self.assertNotIn(forbidden, block)

    def test_infrastructure_result_rejects_unresolved_or_unknown_states(self):
        block = job(self.text, "infra-result")
        script = textwrap.dedent(block.split("        run: |\n", 1)[1])
        cases = (
            ("in_sync", 0),
            ("repaired", 0),
            ("needs_manual", 1),
            ("repairable", 1),
            ("", 1),
            ("unknown", 1),
            ("$(printf private_marker)", 1),
        )
        for state, expected_exit in cases:
            with (
                self.subTest(state=state),
                tempfile.TemporaryDirectory() as directory,
            ):
                summary = Path(directory) / "summary.md"
                result = subprocess.run(
                    ["bash", "-e", "-o", "pipefail", "-c", script],
                    env={"INFRA_STATE": state, "GITHUB_STEP_SUMMARY": str(summary)},
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, expected_exit, result.stderr)
                message = summary.read_text()
                self.assertTrue(message.strip())
                self.assertNotIn("private_marker", message + result.stdout + result.stderr)
                if expected_exit == 0:
                    self.assertIn("Infrastructure reconciliation verified", message)
                else:
                    self.assertIn("::error::", result.stdout)
                if state == "needs_manual":
                    self.assertIn("有待人工处理的计划", message)
                    self.assertIn("Infra apply", message)
                if state == "repairable":
                    self.assertIn("repair", message)
                    self.assertIn("Infra apply", message)

    def test_worker_repair_reuses_last_good_recipe_and_app_locks(self):
        block = job(self.text, "workers")
        self.assertIn("uses: ./.github/workflows/worker-release.yml", block)
        self.assertIn("permissions:\n      contents: read\n      actions: read\n      deployments: write", block)
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

    def test_worker_comparisons_run_daily_and_on_dispatch_but_not_after_ci(self):
        """CI's release jobs verify each Worker they publish; comparing every Worker after each main CI raced the ones
        still deploying. Infrastructure, VPS and registration still follow each successful main CI."""
        self.assertIn("github.event_name != 'workflow_run'", job(self.text, "workers"))
        for name in ("infra", "vps", "inventory", "infra-result"):
            self.assertNotIn("workflow_run", job(self.text, name))

    def test_every_worker_app_is_compared_from_its_first_deploy_on(self):
        """The matrix covers every release app and excludes only CHECK_ONLY apps. Namespace capture may
        remain FIRST_DEPLOY_PENDING through the first release; it does not disable that app's reconciliation."""
        block = job(self.text, "workers")
        matrix = block.split("      matrix:\n", 1)[1].split("\n    permissions:\n", 1)[0]
        apps = re.search(r"^        app: \[([^\]]+)\]$", matrix, re.MULTILINE).group(1).split(", ")
        # The Worker release units: the catalog's, without the assets-only website and its own release workflow.
        workers = {}
        for worker in load_catalog(REPO).workers:
            workers.setdefault(worker["release"], []).append(worker["config"])
        workers.pop("website")
        self.assertEqual(sorted(apps), sorted(workers))
        options = re.search(r"^        options: \[([^\]]+)\]$", self.text.split("      record_app:\n", 1)[1], re.MULTILINE)
        self.assertEqual(options.group(1).split(", "), apps)
        pending = constant("tools/service-catalog/inventory.py", "FIRST_DEPLOY_PENDING")
        scripts = {app: {tomllib.loads((REPO / path).read_text())["name"] for path in paths}
                   for app, paths in workers.items()}
        self.assertLessEqual(pending, set().union(*scripts.values()))
        excluded = re.findall(r"^          - app: (\S+)$", matrix, re.MULTILINE)
        self.assertEqual(excluded, [])
        self.assertNotIn("        exclude:", matrix)

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
