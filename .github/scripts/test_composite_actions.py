"""Guard native workflow/composite boundaries independently of the flattened safety view."""

import copy
import re
import tempfile
import unittest
from pathlib import Path

import yaml

from workflow_sources import ROOT, expand_actions, workflow_data


class CompositeActions(unittest.TestCase):
    def assert_release_boundaries(self, release):
        self.assertEqual(set(release["jobs"]), {"release"})
        job = release["jobs"]["release"]
        self.assertEqual(job["if"], "github.ref == 'refs/heads/main'")
        self.assertEqual(
            job["concurrency"],
            {
                "group": "${{ inputs.app }}-production",
                "cancel-in-progress": "false",
            },
        )
        self.assertEqual(
            job["timeout-minutes"], "${{ inputs.app == 'website-relay' && 10 || 15 }}"
        )
        self.assertEqual(job["environment"]["name"], "production")
        sequence = job["steps"]
        preflight = next(
            i for i, step in enumerate(sequence) if step.get("id") == "preflight"
        )
        record = next(
            i
            for i, step in enumerate(sequence)
            if "control.py record " in step.get("run", "")
        )
        calls = [
            step
            for step in sequence
            if step.get("uses", "").startswith("./.github/actions/release-")
        ]
        apps = {
            path.parent.name.removeprefix("release-")
            for path in (ROOT / ".github/actions").glob("release-*/action.yml")
        }
        self.assertEqual(len(calls), len(apps))
        for app in apps:
            call = next(
                step
                for step in calls
                if step["uses"] == f"./.github/actions/release-{app}"
            )
            self.assertEqual(
                call["if"],
                f"inputs.app == '{app}' && steps.preflight.outputs.required == 'true'",
            )
            self.assertEqual(
                call["with"]["required"], "${{ steps.preflight.outputs.required }}"
            )
            self.assertLess(preflight, sequence.index(call))
            self.assertLess(sequence.index(call), record)
        self.assertNotIn(
            "secrets.",
            str({key: value for key, value in job.items() if key != "steps"}),
        )
        self.assertNotIn("continue-on-error", job)
        for step in sequence:
            self.assertNotIn("continue-on-error", step)
        self.assertNotIn("always()", sequence[record]["if"])

    def test_worker_calls_expand_one_release_job_not_all_apps(self):
        self.assert_release_boundaries(
            workflow_data(ROOT / ".github/workflows/worker-release.yml")
        )

    def test_release_guards_accept_layout_changes_and_reject_changed_locks_or_gates(
        self,
    ):
        release = workflow_data(ROOT / ".github/workflows/worker-release.yml")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "release.yml"
            for style in ("'", '"'):
                path.write_text(
                    yaml.safe_dump(
                        release, indent=4, sort_keys=True, default_style=style
                    )
                )
                self.assert_release_boundaries(workflow_data(path))
        for field, value in (
            ("if", "always()"),
            ("concurrency", {"group": "unrelated", "cancel-in-progress": "false"}),
            (
                "concurrency",
                {"group": "${{ inputs.app }}-production", "cancel-in-progress": "true"},
            ),
        ):
            changed = copy.deepcopy(release)
            changed["jobs"]["release"][field] = value
            with (
                self.subTest(field=field, value=value),
                self.assertRaises(AssertionError),
            ):
                self.assert_release_boundaries(changed)

    def test_local_actions_have_explicit_context_shell_and_directory(self):
        for path in (ROOT / ".github/actions").glob("*/action.yml"):
            with self.subTest(action=path.parent.name):
                action = workflow_data(path)
                self.assertEqual(action["runs"]["using"], "composite")
                expressions = " ".join(
                    re.findall(r"\$\{\{(.*?)\}\}", path.read_text(), re.S)
                )
                self.assertNotRegex(
                    expressions, r"\b(secrets|needs|matrix|strategy|vars)[.\[]"
                )
                referenced = set(re.findall(r"\binputs\.([a-z0-9-]+)", str(action)))
                self.assertLessEqual(referenced, set(action.get("inputs", {})))
                for step in action["runs"]["steps"]:
                    self.assertNotIn("timeout-minutes", step)
                    if "run" in step:
                        self.assertEqual(step["shell"], "bash -e {0}")
                        self.assertTrue(step["working-directory"])
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"^[\w./-]+@[0-9a-f]{40}$")
                    self.assertNotEqual(
                        step.get("with", {}).get("persist-credentials"), "true"
                    )

    def test_every_call_supplies_exact_declared_inputs(self):
        for filename in ("ci.yml", "worker-release.yml"):
            for job in workflow_data(ROOT / ".github/workflows" / filename)[
                "jobs"
            ].values():
                for step in job.get("steps", []):
                    action_path = step.get("uses", "")
                    if not action_path.startswith("./.github/actions/"):
                        continue
                    action = workflow_data(ROOT / action_path / "action.yml")
                    self.assertEqual(
                        set(step.get("with", {})),
                        set(action.get("inputs", {})),
                        action_path,
                    )

    def test_mailsort_inherits_the_production_mode_from_the_release_job(self):
        job = workflow_data(ROOT / ".github/workflows/worker-release.yml")["jobs"][
            "release"
        ]
        self.assertEqual(
            job["env"]["MAILSORT_MODE"],
            "${{ (inputs.app == 'mailsort' || inputs.app == 'brief') && vars.MAILSORT_MODE || '' }}",
        )
        call = next(
            step for step in job["steps"]
            if step.get("uses") == "./.github/actions/release-mailsort"
        )
        self.assertNotIn("MAILSORT_MODE", call.get("env", {}))
        action = workflow_data(ROOT / ".github/actions/release-mailsort/action.yml")
        # vars is a workflow context; a composite inherits the job's resolved environment.
        expressions = " ".join(re.findall(r"\$\{\{(.*?)\}\}", str(action), re.S))
        self.assertNotRegex(expressions, r"\bvars[.\[]")
        deployments = [
            step for step in action["runs"]["steps"]
            if "deploy-vars.mjs exec" in step.get("run", "")
        ]
        self.assertEqual(len(deployments), 2)
        for step in deployments:
            self.assertEqual(step["env"]["MAILSORT_MODE"], "${{ env.MAILSORT_MODE }}")

    def test_release_switches_inherit_the_resolved_workflow_environment(self):
        job = workflow_data(ROOT / ".github/workflows/worker-release.yml")["jobs"][
            "release"
        ]
        switches = {
            "todofy": (
                "TODOFY_REMINDER_ENABLED", "TODOFY_MAINTENANCE_MODE",
                "TODOFY_PROCESSING_PAUSED", "TODOFY_FORCE_PAUSE_TODOIST",
                "TODOFY_GTD_REVIEW_ENABLED", "TODOFY_PLUS_METADATA",
            ),
            "dashboard": ("DASHBOARD_CANARY_ENABLED",),
            "mail-hero": (
                "MAIL_HERO_FORCE_SEND_PAUSED", "MAIL_HERO_MAINTENANCE_MODE",
                "MAIL_HERO_NATIVE_BACKUP_ENABLED",
            ),
            "brief": ("BRIEF_MODE",),
        }
        for app, names in switches.items():
            call = next(
                step for step in job["steps"]
                if step.get("uses") == f"./.github/actions/release-{app}"
            )
            action = workflow_data(ROOT / f".github/actions/release-{app}/action.yml")
            for name in names:
                with self.subTest(app=app, switch=name):
                    self.assertIn(f"vars.{name}", job["env"][name])
                    self.assertNotIn(name, call.get("env", {}))
                    for step in action["runs"]["steps"]:
                        self.assertNotIn(name, step.get("env", {}))

    def test_runtime_shards_and_resume_are_passed_explicitly(self):
        ci = workflow_data(ROOT / ".github/workflows/ci.yml")["jobs"]
        runtime = next(
            step
            for step in ci["todofy-runtime"]["steps"]
            if step.get("uses") == "./.github/actions/check-todofy-runtime"
        )
        self.assertEqual(runtime["with"]["shard-index"], "${{ strategy.job-index }}")
        self.assertEqual(runtime["with"]["shard-total"], "${{ strategy.job-total }}")
        platform = next(
            step
            for step in ci["platform-checks"]["steps"]
            if step.get("uses") == "./.github/actions/check-platform"
        )
        self.assertEqual(
            platform["with"]["build-image"],
            "${{ !(github.event_name == 'workflow_dispatch' && inputs.resume_vps_release) }}",
        )
        action = workflow_data(ROOT / ".github/actions/check-platform/action.yml")
        self.assertEqual(
            sum(
                step.get("if") == "${{ fromJSON(inputs.build-image) }}"
                for step in action["runs"]["steps"]
            ),
            2,
        )
        for job_name in ("newsletter-deploy", "platform-image"):
            job = ci[job_name]
            self.assertEqual(
                job["outputs"]["image"], "${{ steps.publish.outputs.image }}"
            )
            publish = next(step for step in job["steps"] if step.get("id") == "publish")
            self.assertEqual(
                publish["with"]["artifact-run-id"],
                "${{ needs.changes.outputs.reused_run_id || github.run_id }}",
            )

    def test_smoke_checks_keep_native_step_timeouts_after_ui_build(self):
        ci = workflow_data(ROOT / ".github/workflows/ci.yml")["jobs"]
        for app in ("recall", "mailsort"):
            sequence = ci[app + "-checks"]["steps"]
            check = next(
                i
                for i, step in enumerate(sequence)
                if step.get("uses") == "./.github/actions/check-" + app
            )
            smoke = next(
                i
                for i, step in enumerate(sequence)
                if step.get("run") == "npm run test:smoke"
            )
            dry_run = next(
                i
                for i, step in enumerate(sequence)
                if "wrangler deploy --dry-run" in step.get("run", "")
            )
            self.assertLess(check, smoke)
            self.assertLess(smoke, dry_run)
            self.assertEqual(sequence[smoke]["timeout-minutes"], "5")
            self.assertTrue(any(step.get("if") == "always()" for step in sequence))
            action = workflow_data(ROOT / f".github/actions/check-{app}/action.yml")
            self.assertTrue(
                any(
                    "npm run build" in step.get("run", "")
                    for step in action["runs"]["steps"]
                )
            )

    def test_reader_follows_real_action_commands_and_refuses_missing_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            action = root / ".github/actions/example/action.yml"
            action.parent.mkdir(parents=True)
            action.write_text(
                "runs:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.value }}\n"
            )
            call = "    steps:\n      - name: Example\n        uses: ./.github/actions/example\n        with:\n          value: hello\n"
            self.assertIn("run: echo hello", expand_actions(call, root))
            action.write_text(action.read_text().replace("echo", "printf"))
            self.assertIn("run: printf hello", expand_actions(call, root))
            with self.assertRaisesRegex(ValueError, "Unresolved action input"):
                expand_actions(call.replace("          value: hello\n", ""), root)


if __name__ == "__main__":
    unittest.main()
