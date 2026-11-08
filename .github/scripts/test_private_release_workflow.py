"""Exercise the actual publication conditions with synthetic Actions job results."""

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_private_checkout import run_checkout
from workflow_sources import workflow_data

ROOT = Path(__file__).absolute().parents[2]


class PrivateReleaseWorkflow(unittest.TestCase):
    def setUp(self):
        self.jobs = workflow_data(ROOT / ".github/workflows/ci.yml")["jobs"]
        self.context = {
            "github.repository": "ziyixi/todofy",
            "github.ref": "refs/heads/main",
            "github.event_name": "push",
            "github.run_id": "current-run",
            "inputs.app": "all",
            "inputs.resume_vps_release": False,
            "vars.VPS_DEPLOY_ENABLED": "true",
            "needs.changes.result": "success",
            "needs.gate.result": "success",
            "needs.private.result": "success",
            "needs.private.outputs.release_required": "true",
            "needs.changes.outputs.artifact_run_id": "checked-branch-run",
        }

    def condition(self, job, expression=None, *, cancelled=False):
        """Evaluate only the boolean/string expressions these three callers use."""
        expression = (expression or self.jobs[job]["if"]).strip()
        expression = expression.removeprefix("${{").removesuffix("}}").strip()
        results = [self.context.get(f"needs.{name}.result", "skipped")
                   for name in self.jobs[job]["needs"]]
        expression = re.sub(
            r"contains\(needs\.\*\.result, '([^']+)'\)",
            lambda match: repr(match[1] in results), expression,
        )
        expression = expression.replace("cancelled()", repr(cancelled))

        def value(match):
            name = match[0]
            fallback = "skipped" if name.endswith(".result") else "false"
            return repr(self.context.get(name, fallback))

        expression = re.sub(
            r"needs\.[a-z-]+\.(?:result|outputs\.[a-z_]+)|(?:github|inputs|vars)\.[A-Za-z_]+",
            value, expression,
        )
        expression = re.sub(r"!(?!=)", " not ", expression)
        expression = expression.replace("&&", " and ").replace("||", " or ")
        return eval("(" + expression.strip() + ")", {"__builtins__": {}}, {})

    def test_private_release_waits_for_public_services_and_keeps_the_extension_independent(self):
        release = self.jobs["private-deploy"]
        publications = {
            name for name, job in self.jobs.items()
            if name not in {"private-deploy", "recall-extension-release"}
            and ("gate" in job.get("needs", []) or name == "vps-bootstrap-bundle")
        }
        self.assertEqual(set(release["needs"]),
                         {"changes", "gate", "private"} | (publications - {"dashboard-deploy"}))
        self.assertEqual(release["with"], {"revision": "${{ needs.changes.outputs.private_sha }}"})
        publisher = workflow_data(ROOT / ".github/workflows/private-release.yml")
        self.assertEqual(release["permissions"], publisher["permissions"])
        self.assertNotIn("steps", release)
        self.assertNotIn("recall-extension-release", release["needs"])
        self.context["needs.recall-extension-release.result"] = "failure"
        self.context["needs.changes.outputs.recall_extension_publish"] = "true"
        self.assertTrue(self.condition("private-deploy"))
        self.assertEqual(
            [name for name, job in self.jobs.items()
             if job.get("uses") == "./.github/workflows/worker-release.yml"
             and job["with"]["app"] == "dashboard"],
            ["dashboard-deploy"],
        )
        home = self.jobs["dashboard-deploy"]
        self.assertTrue({"private", "private-deploy"} <= set(home["needs"]))

    def test_private_only_selection_builds_home_and_releases_it_once_after_private(self):
        self.assertTrue(self.condition("private-home-artifact"))
        self.assertTrue(self.condition("private-deploy"))
        self.assertFalse(self.condition("dashboard-deploy"))
        for status in ("failure", "cancelled", "skipped"):
            self.context["needs.private-deploy.result"] = status
            self.assertFalse(self.condition("dashboard-deploy"))
        self.context["needs.private-deploy.result"] = "success"
        self.assertTrue(self.condition("dashboard-deploy"))
        artifact = self.jobs["dashboard-deploy"]["with"]["artifact_run_id"]
        self.assertEqual(self.condition("dashboard-deploy", artifact), "current-run")
        upload = self.jobs["private-home-artifact"]["steps"][-1]["with"]
        self.assertEqual(upload["name"], "worker-dashboard-${{ github.sha }}")

    def test_observer_access_precedes_every_selected_vps_publication(self):
        access = self.jobs["observer-access"]
        self.assertEqual(set(access["needs"]), {"changes", "gate", "private"})
        self.assertEqual(access["uses"], "./.github/workflows/private-release.yml")
        self.assertEqual(access["with"], {
            "revision": "${{ needs.changes.outputs.private_sha }}",
            "operation": "k3s-apply",
            "manifests": "platform/k3s/observer-discovery",
        })
        publisher = workflow_data(ROOT / ".github/workflows/private-release.yml")
        self.assertEqual(access["permissions"], publisher["permissions"])
        self.assertEqual(publisher["concurrency"]["cancel-in-progress"], "false")
        self.assertTrue({"fleet-deploy", "observer-access"} <= set(self.jobs["vps-deploy"]["needs"]))
        self.context.update({
            "needs.changes.outputs.platform_deploy": "true",
            "needs.newsletter-deploy.result": "success",
            "needs.platform-image.result": "success",
            "needs.vps-bootstrap-bundle.result": "success",
        })
        self.assertTrue(self.condition("observer-access"))
        for status in ("failure", "cancelled", "skipped"):
            self.context["needs.observer-access.result"] = status
            self.assertFalse(self.condition("vps-deploy"), status)
        self.context["needs.observer-access.result"] = "success"
        self.assertTrue(self.condition("vps-deploy"))
        for prerequisite in ("changes", "gate", "private"):
            self.context[f"needs.{prerequisite}.result"] = "failure"
            self.assertFalse(self.condition("observer-access"), prerequisite)
            self.context[f"needs.{prerequisite}.result"] = "success"
        for field, value in (("github.ref", "refs/heads/codex/synthetic"),
                             ("github.repository", "synthetic/fork"),
                             ("vars.VPS_DEPLOY_ENABLED", "false"),
                             ("needs.changes.outputs.platform_deploy", "false")):
            original = self.context[field]
            self.context[field] = value
            self.assertFalse(self.condition("observer-access"), field)
            self.context[field] = original

    def test_existing_home_selection_keeps_its_checked_artifact(self):
        self.context["needs.changes.outputs.dashboard_deploy"] = "true"
        self.context["needs.private.outputs.release_required"] = "false"
        self.assertFalse(self.condition("private-home-artifact"))
        self.assertFalse(self.condition("private-deploy"))
        self.assertTrue(self.condition("dashboard-deploy"))
        artifact = self.jobs["dashboard-deploy"]["with"]["artifact_run_id"]
        self.assertEqual(self.condition("dashboard-deploy", artifact), "checked-branch-run")
        self.context["needs.private.outputs.release_required"] = "true"
        self.assertFalse(self.condition("private-home-artifact"))
        self.assertFalse(self.condition("dashboard-deploy"))
        self.context["needs.private-deploy.result"] = "success"
        self.assertTrue(self.condition("dashboard-deploy"))
        self.assertEqual(self.condition("dashboard-deploy", artifact), "checked-branch-run")

    def test_native_cluster_operations_skip_unrelated_tool_setup(self):
        publisher = workflow_data(ROOT / ".github/workflows/private-release.yml")
        steps = publisher["jobs"]["release"]["steps"]
        setup = [step for step in steps if step.get("uses", "").startswith((
            "./.github/actions/setup-bazel", "actions/setup-node@", "opentofu/setup-opentofu@",
        ))]
        self.assertEqual(len(setup), 3)
        for operation in ("k3s-check", "k3s-plan", "k3s-apply", "release", "publish",
                          "finish-worker", "verify", "infra-plan", "infra-apply", "data-check", "k3s-future"):
            self.context["inputs.operation"] = operation
            with self.subTest(operation=operation):
                selected = [self.condition("observer-access", step["if"]) if step.get("if") else True
                            for step in setup]
                self.assertEqual(selected, [operation not in {"k3s-check", "k3s-plan", "k3s-apply"}] * 3)
        entry = steps[-1]
        self.assertNotIn("if", entry)
        self.assertIn('python3 private/ci/release.py --operation "$PRIVATE_RELEASE_OPERATION"', entry["run"])

    def test_branch_and_document_only_changes_do_not_publish(self):
        self.context["github.ref"] = "refs/heads/codex/synthetic-review"
        self.assertTrue(self.condition("private-home-artifact"))
        self.assertFalse(self.condition("private-deploy"))
        self.assertFalse(self.condition("dashboard-deploy"))
        self.context["github.ref"] = "refs/heads/main"
        self.context["needs.private.outputs.release_required"] = "false"
        for job in ("private-home-artifact", "private-deploy", "dashboard-deploy"):
            self.assertFalse(self.condition(job), job)

    def test_dispatch_preserves_application_scope_and_excludes_resume(self):
        self.context["github.event_name"] = "workflow_dispatch"
        for app in ("both", "tasks", "dashboard"):
            self.context["inputs.app"] = app
            for job in ("private-home-artifact", "private-deploy", "dashboard-deploy"):
                self.assertFalse(self.condition(job), (app, job))
        self.context["needs.changes.outputs.dashboard_deploy"] = "true"
        self.assertTrue(self.condition("dashboard-deploy"))
        self.context["needs.changes.outputs.dashboard_deploy"] = "false"
        self.context["inputs.app"] = "all"
        self.assertTrue(self.condition("private-deploy"))
        self.assertTrue(self.condition("private-home-artifact"))
        self.context["inputs.resume_vps_release"] = True
        for job in ("private-home-artifact", "private-deploy", "dashboard-deploy"):
            self.assertFalse(self.condition(job), job)

    def test_failed_cancelled_or_skipped_selected_publication_blocks_private(self):
        selected = {
            "observer-access": "platform_deploy",
            "newsletter-deploy": "newsletter_deploy",
            "platform-image": "platform_publish",
            "codex-gateway-image": "codex_gateway_deploy",
            "vps-bootstrap-bundle": "platform_publish",
            "vps-deploy": "platform_deploy",
            "codex-gateway-deploy": "codex_gateway_deploy",
        }
        publications = set(self.jobs["private-deploy"]["needs"]) - {"changes", "gate", "private"}
        initial = self.context.copy()
        for name in publications:
            output = selected.get(name, name.replace("-", "_"))
            self.context = {**initial, f"needs.changes.outputs.{output}": "true"}
            # The image/VPS pair has other selected prerequisites; make those green too.
            for prerequisite in publications:
                self.context[f"needs.{prerequisite}.result"] = "success"
            self.assertTrue(self.condition("private-deploy"), name)
            for status in ("failure", "cancelled", "skipped"):
                self.context[f"needs.{name}.result"] = status
                self.assertFalse(self.condition("private-deploy"), (name, status))
        self.context = initial
        self.assertFalse(self.condition("private-deploy", cancelled=True))
        self.context["needs.gate.result"] = "failure"
        self.assertFalse(self.condition("private-deploy"))

    def test_existing_disabled_vps_switch_allows_other_selected_publications(self):
        self.context["needs.changes.outputs.codex_gateway_deploy"] = "true"
        self.context["needs.codex-gateway-image.result"] = "success"
        self.context["vars.VPS_DEPLOY_ENABLED"] = "false"
        self.assertTrue(self.condition("private-deploy"))
        self.context["vars.VPS_DEPLOY_ENABLED"] = "true"
        self.assertFalse(self.condition("private-deploy"))

    def operate(self, directory, operation, status, output):
        """Run the publisher's real step with a stand-in entry point that prints `output` and exits `status`.

        Returns the step's result, whether the entry point's stdout and stderr were the runner file, and whether
        that file is left behind."""
        publisher = workflow_data(ROOT / ".github/workflows/private-release.yml")
        script = publisher["jobs"]["release"]["steps"][-1]["run"]
        temporary = Path(directory)
        (temporary / "entry-output").write_text(output)
        python = temporary / "python3"
        python.write_text(
            "#!/bin/sh\n"
            '[ "$1" = private/ci/release.py ] && [ "$2" = --operation ] && '
            '[ "$3" = "$PRIVATE_RELEASE_OPERATION" ] || exit 99\n'
            'echo "synthetic-private-runtime" >&2\n'
            'cat "$RUNNER_TEMP/entry-output"\n'
            '"$SYNTHETIC_PYTHON" -c "$SYNTHETIC_CAPTURED"\n'
            'exit "$SYNTHETIC_STATUS"\n'
        )
        python.chmod(0o755)
        log = temporary / "private-operation.log"
        log.unlink(missing_ok=True)
        captured = temporary / "captured"
        captured.unlink(missing_ok=True)
        result = subprocess.run(
            ["bash", "-e", "-c", script],
            env={
                **os.environ,
                "PATH": f"{temporary}{os.pathsep}{os.environ['PATH']}",
                "RUNNER_TEMP": str(temporary),
                "PRIVATE_RELEASE_OPERATION": operation,
                "SYNTHETIC_STATUS": str(status),
                "SYNTHETIC_PYTHON": sys.executable,
                "SYNTHETIC_CAPTURED": (
                    "import os; log = os.stat(os.environ['RUNNER_TEMP'] + '/private-operation.log'); "
                    "same = all(os.path.samestat(os.fstat(fd), log) for fd in (1, 2)); "
                    "open(os.environ['RUNNER_TEMP'] + '/captured', 'w').write(str(same))"
                ),
            },
            capture_output=True, text=True, check=False,
        )
        return result, captured.read_text() == "True", log.exists()

    def test_every_operation_captures_private_output_and_preserves_the_exit_status(self):
        private_output = '{"event":"synthetic","source":"synthetic-private-source"}\n'
        operations = ("release", "publish", "finish-worker", "verify", "data-check", "infra-plan",
                      "infra-apply", "k3s-check", "k3s-plan", "k3s-apply", "not-an-operation")
        with tempfile.TemporaryDirectory() as directory:
            for operation in operations:
                for status in (0, 7):
                    with self.subTest(operation=operation, status=status):
                        result, captured, left = self.operate(directory, operation, status, private_output)
                        self.assertEqual(result.returncode, status)
                        outcome = ("PRIVATE_PUBLICATION" if operation in {"release", "publish", "finish-worker"}
                                   else "PRIVATE_OPERATION")
                        expected = f"::error::{outcome}_FAILED\n" if status else f"::notice::{outcome}_COMPLETE\n"
                        self.assertEqual(result.stdout + result.stderr, expected)
                        # The entry point wrote only to the runner file, which the step then removed.
                        self.assertEqual((captured, left), (True, False))

    def test_only_fixed_shape_plan_results_reach_the_public_log(self):
        fingerprint = "create=1,update=12@0123456789abcdef"
        plan = ("Private infrastructure plan: " + fingerprint + "\n"
                '{"create":1,"update":12}\nsynthetic-private-resource\n')
        k3s = ('{"event":"k3s_operation","operation":"plan","rendered_sha256":"' + "a" * 64
               + '","rendered_bytes":42,"changed":%s}\n')
        cases = [
            ("infra-plan", 0, plan, "::notice::PRIVATE_INFRA_PLAN=" + fingerprint + "\n::notice::PRIVATE_OPERATION_COMPLETE\n"),
            # A refused apply still shows the fresh plan it compared, then fails with the entry point's status.
            ("infra-apply", 7, plan, "::notice::PRIVATE_INFRA_PLAN=" + fingerprint + "\n::error::PRIVATE_OPERATION_FAILED\n"),
            ("infra-plan", 0, "Private infrastructure plan: synthetic-private-name@0123456789abcdef\n",
             "::notice::PRIVATE_OPERATION_COMPLETE\n"),
            ("infra-plan", 0, "Private infrastructure plan: " + fingerprint + " synthetic-private-name\n",
             "::notice::PRIVATE_OPERATION_COMPLETE\n"),
            ("k3s-plan", 0, k3s % "true", "::notice::PRIVATE_K3S_PLAN_CHANGED\n::notice::PRIVATE_OPERATION_COMPLETE\n"),
            ("k3s-plan", 0, k3s % "false", "::notice::PRIVATE_K3S_PLAN_UNCHANGED\n::notice::PRIVATE_OPERATION_COMPLETE\n"),
            ("k3s-plan", 7, k3s % "true", "::error::PRIVATE_OPERATION_FAILED\n"),
            ("k3s-plan", 0, k3s % '"synthetic-private-name"', "::notice::PRIVATE_OPERATION_COMPLETE\n"),
            ("k3s-apply", 0, k3s % "true", "::notice::PRIVATE_OPERATION_COMPLETE\n"),
            ("verify", 0, plan + k3s % "true", "::notice::PRIVATE_OPERATION_COMPLETE\n"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            for operation, status, output, expected in cases:
                with self.subTest(operation=operation, status=status, output=output):
                    result, _, _ = self.operate(directory, operation, status, output)
                    self.assertEqual(result.returncode, status)
                    self.assertEqual(result.stdout + result.stderr, expected)

    def test_failed_publication_exposes_only_reviewed_generic_causes(self):
        cases = (
            ("private_release_failed_bazel_build", True),
            ("private_release_failed_bazel_cquery", True),
            ("private_release_failed_bazel_run", True),
            ("private_release_failed_docker_login", True),
            ("private_release_failed_command", True),
            ("private_worker_bundle_over_budget", True),
            ("private_worker_configuration_mismatch", True),
            ("private_image_visibility_required", True),
            ("private_package_bootstrap_required", True),
            ("release_dependency_http_403", True),
            ("private_synthetic_resource", False),
            ("private_release_failed_bazel_build synthetic-secret", False),
            ("private_release_failed_bazel_build\x1b[0m", False),
            ("release_dependency_http_403 synthetic-secret", False),
            ("release_dependency_http_4033", False),
        )
        with tempfile.TemporaryDirectory() as directory:
            for code, exposed in cases:
                with self.subTest(code=code):
                    result, captured, left = self.operate(directory, "release", 7, code + "\n")
                    expected = (f"::error::PRIVATE_CAUSE={code}\n" if exposed else "")
                    expected += "::error::PRIVATE_PUBLICATION_FAILED\n"
                    self.assertEqual((result.returncode, result.stdout + result.stderr), (7, expected))
                    self.assertEqual((captured, left), (True, False))

    def test_private_history_fetches_only_pinned_ancestries_and_imports_a_divergent_base(self):
        check = workflow_data(ROOT / ".github/workflows/private-check.yml")["jobs"]["check"]
        private_checkouts = [step for step in check["steps"]
                             if step.get("uses") == "./.github/actions/private-checkout"]
        self.assertEqual(len(private_checkouts), 2)
        for step in private_checkouts:
            self.assertEqual(step["with"]["history"], "ancestry")
            self.assertEqual(step["with"]["ssh-key"], "${{ secrets.private_ssh_key }}")
        self.assertEqual(private_checkouts[0]["with"]["revision"], "${{ inputs.revision }}")
        self.assertEqual(private_checkouts[0]["with"]["path"], "private")
        self.assertEqual(private_checkouts[1]["with"]["revision"], "${{ steps.baseline.outputs.revision }}")
        self.assertEqual(private_checkouts[1]["with"]["path"], ".private-baseline")
        importer = next(step for step in check["steps"]
                        if step.get("name") == "Import the pinned baseline ancestry locally")
        self.assertEqual(private_checkouts[1]["if"], importer["if"])
        self.assertEqual(importer["if"],
                         "steps.baseline.outputs.revision != '' && steps.baseline.outputs.revision != inputs.revision")
        baseline = next(step for step in check["steps"] if step.get("id") == "baseline")
        baseline_program = baseline["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            source, parent = temporary / "source", temporary / "parent"
            source.mkdir()
            parent.mkdir()
            environment = {
                **os.environ,
                "GIT_AUTHOR_NAME": "Synthetic",
                "GIT_COMMITTER_NAME": "Synthetic",
                "GIT_AUTHOR_EMAIL": "synthetic@example.invalid",
                "GIT_COMMITTER_EMAIL": "synthetic@example.invalid",
            }

            def git(*args, cwd=source):
                return subprocess.run(["git", *args], cwd=cwd, env=environment,
                                      capture_output=True, text=True, check=True).stdout.strip()

            def commit(text):
                (source / "source.txt").write_text(text)
                git("add", "source.txt")
                git("commit", "--quiet", "-m", "synthetic change")
                return git("rev-parse", "HEAD")

            git("init", "--quiet")
            common = commit("common")
            git("checkout", "--quiet", "-b", "synthetic-baseline")
            base_private = commit("baseline")
            git("tag", "synthetic-unrelated-tag")
            git("checkout", "--quiet", "-b", "synthetic-current", common)
            current_private = commit("current")
            for step, revision in zip(private_checkouts, (current_private, base_private), strict=True):
                # The workflow's own quiet fetch, served from the synthetic source instead of GitHub.
                result, calls, _ = run_checkout(parent, temporary, source, revision=revision,
                                                path=step["with"]["path"], history=step["with"]["history"])
                self.assertEqual((result.returncode, result.stdout + result.stderr, len(calls)), (0, "", 1))
                checkout = parent / step["with"]["path"]
                self.assertEqual(git("rev-parse", "HEAD", cwd=checkout), revision)
                self.assertEqual(git("rev-parse", "--is-shallow-repository", cwd=checkout), "false")
                self.assertEqual(git("for-each-ref", "--format=%(refname)", cwd=checkout), "")
                git("cat-file", "-e", common + "^{commit}", cwd=checkout)
            missing = subprocess.run(["git", "cat-file", "-e", base_private + "^{commit}"],
                                     cwd=parent / "private", capture_output=True, check=False)
            self.assertNotEqual(missing.returncode, 0)
            result = subprocess.run(
                ["bash", "-e", "-c", importer["run"]], cwd=parent,
                env={**environment, "BASE_PRIVATE_REVISION": base_private, "RUNNER_TEMP": str(temporary)},
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout + result.stderr, "")
            git("cat-file", "-e", base_private + "^{commit}", cwd=parent / "private")
            git("cat-file", "-e", current_private + "^{commit}", cwd=parent / "private")
            self.assertEqual(git("for-each-ref", "--format=%(refname)", cwd=parent / "private"), "")

            git("init", "--quiet", cwd=parent)
            git("update-index", "--add", "--cacheinfo", f"160000,{base_private},private", cwd=parent)
            git("commit", "--quiet", "-m", "synthetic baseline", cwd=parent)
            base_parent = git("rev-parse", "HEAD", cwd=parent)
            output = temporary / "output"
            for base, expected, status in ((base_parent, base_private, 0), ("", "", 0), ("not-a-sha", "", 1)):
                output.write_text("")
                result = subprocess.run(
                    [sys.executable, "-c", baseline_program], cwd=parent,
                    env={**environment, "BASE_SHA": base, "GITHUB_OUTPUT": str(output)},
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(output.read_text(), f"revision={expected}\n" if not status else "")
                self.assertEqual(result.stdout + result.stderr, "PRIVATE_BASE_INVALID\n" if status else "")


if __name__ == "__main__":
    unittest.main()
