"""The native graph selects work; the original production locks and ordering still gate writes."""

import hashlib
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from workflow_sources import workflow_data

ROOT = Path(__file__).absolute().parents[2]


class BazelCI(unittest.TestCase):
    def setUp(self):
        self.workflow = workflow_data(ROOT / ".github/workflows/ci.yml")
        self.jobs = self.workflow["jobs"]

    def test_checks_are_one_affected_leaf_matrix(self):
        self.assertEqual(self.jobs["checks"]["needs"], "changes")
        self.assertEqual(
            self.jobs["checks"]["strategy"]["matrix"],
            "${{ fromJSON(needs.changes.outputs.matrix) }}",
        )
        scripts = "\n".join(
            step.get("run", "") for step in self.jobs["changes"]["steps"]
        )
        self.assertIn("tools/bazel/ci/plan.py", scripts)
        self.assertIn('--base "$BASE"', scripts)
        self.assertIn("--release-input-query", scripts)
        self.assertNotIn("ci_changes.py", scripts)
        self.assertFalse(any(name.endswith("-checks") for name in self.jobs))

    def test_gate_requires_selected_checks_and_artifacts(self):
        gate = self.jobs["gate"]
        self.assertEqual(
            set(gate["needs"]),
            {"changes", "checks", "artifacts", "private", "private-home-artifact"},
        )
        script = gate["steps"][0]["run"]
        for checks, artifacts, private, expected in (
            ("success", "success", "success", 0),
            ("failure", "success", "success", 1),
            ("cancelled", "success", "success", 1),
            ("skipped", "success", "success", 1),
            ("success", "failure", "success", 1),
            ("success", "success", "failure", 1),
            ("success", "success", "cancelled", 1),
            ("success", "success", "skipped", 1),
        ):
            with self.subTest(checks=checks, artifacts=artifacts, private=private):
                result = subprocess.run(
                    ["bash", "-e", "-c", script],
                    env={
                        **os.environ,
                        "CHANGES": "success",
                        "CHECKS": checks,
                        "ARTIFACTS": artifacts,
                        "HAS_CHECKS": "true",
                        "HAS_ARTIFACTS": "true",
                        "PRIVATE": private,
                        "HAS_PRIVATE": "true",
                        "PRIVATE_HOME_ARTIFACT": "success",
                        "HAS_PRIVATE_HOME_ARTIFACT": "true",
                    },
                    check=False,
                )
                self.assertEqual(result.returncode, expected)
        self.assertEqual(
            subprocess.run(
                ["bash", "-e", "-c", script],
                env={
                    **os.environ,
                    "CHANGES": "success",
                    "CHECKS": "skipped",
                    "ARTIFACTS": "skipped",
                    "HAS_CHECKS": "false",
                    "HAS_ARTIFACTS": "false",
                    "PRIVATE": "skipped",
                    "HAS_PRIVATE": "false",
                    "PRIVATE_HOME_ARTIFACT": "skipped",
                    "HAS_PRIVATE_HOME_ARTIFACT": "false",
                },
                check=False,
            ).returncode,
            0,
        )
        for status in ("failure", "cancelled", "skipped"):
            with self.subTest(private_home_artifact=status):
                result = subprocess.run(
                    ["bash", "-e", "-c", script],
                    env={
                        **os.environ,
                        "CHANGES": "success",
                        "CHECKS": "success",
                        "ARTIFACTS": "success",
                        "HAS_CHECKS": "true",
                        "HAS_ARTIFACTS": "true",
                        "PRIVATE": "success",
                        "HAS_PRIVATE": "true",
                        "PRIVATE_HOME_ARTIFACT": status,
                        "HAS_PRIVATE_HOME_ARTIFACT": "true",
                    },
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)

    def test_private_sources_are_pinned_and_never_saved_in_a_cache(self):
        caller = self.jobs["private"]
        self.assertIn("github.repository == 'ziyixi/todofy'", caller["if"])
        self.assertEqual(
            caller["with"]["revision"], "${{ needs.changes.outputs.private_sha }}"
        )
        self.assertEqual(caller["with"]["base"], "${{ needs.changes.outputs.base }}")
        self.assertEqual(
            caller["secrets"],
            {"private_ssh_key": "${{ secrets.TODOFY_PRIVATE_SSH_KEY }}"},
        )
        workflow = workflow_data(ROOT / ".github/workflows/private-check.yml")
        self.assertEqual(set(workflow["on"]), {"workflow_call"})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        job = workflow["jobs"]["check"]
        self.assertNotIn("environment", job)
        steps = job["steps"]
        checkout = next(
            step
            for step in steps
            if step.get("with", {}).get("path") == "private"
        )
        # The quiet fetch keeps no credential and prints no private commit subject (test_private_checkout).
        self.assertEqual(checkout["uses"], "./.github/actions/private-checkout")
        self.assertEqual(
            checkout["with"],
            {
                "revision": "${{ inputs.revision }}",
                "path": "private",
                "ssh-key": "${{ secrets.private_ssh_key }}",
                "history": "ancestry",
            },
        )
        self.assertEqual(steps[0]["with"]["fetch-depth"], "0")
        cache_actions = [
            step["uses"].split("@")[0]
            for step in steps
            if "cache" in step.get("uses", "")
        ]
        self.assertEqual(cache_actions, ["actions/cache/restore"] * 2)
        self.assertFalse(
            any("upload-artifact@" in step.get("uses", "") for step in steps)
        )

    def test_private_bazel_output_stays_off_the_public_log(self):
        workflow = workflow_data(ROOT / ".github/workflows/private-check.yml")
        script = next(
            step["run"]
            for step in workflow["jobs"]["check"]["steps"]
            if step.get("name") == "Build and test private targets"
        )
        for failing, code in (
            ("build", "PRIVATE_BUILD_FAILED"),
            ("test", "PRIVATE_TEST_FAILED"),
            ("", ""),
        ):
            with (
                self.subTest(failing=failing),
                tempfile.TemporaryDirectory() as directory,
            ):
                temporary = Path(directory)
                bazel = temporary / "bazel"
                bazel.write_text(
                    "#!/bin/sh\n"
                    'echo "//synthetic-private:target $1"\n'
                    'echo "synthetic private test log" >&2\n'
                    f'[ "$1" != "{failing}" ]\n'
                )
                bazel.chmod(0o755)
                result = subprocess.run(
                    ["bash", "-e", "-c", script],
                    env={
                        **os.environ,
                        "PATH": f"{temporary}{os.pathsep}{os.environ['PATH']}",
                        "RUNNER_TEMP": str(temporary),
                        "HOME": str(temporary),
                    },
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1 if code else 0)
                self.assertEqual(
                    result.stdout + result.stderr, f"::error::{code}\n" if code else ""
                )
                self.assertIn(
                    "synthetic private test log",
                    (temporary / "private-bazel.log").read_text(),
                )

    def test_public_planning_skips_private_submodule_initialization(self):
        step = next(
            step for step in self.jobs["changes"]["steps"] if step.get("id") == "plan"
        )
        self.assertEqual(step["env"]["GIT_CONFIG_COUNT"], "1")
        self.assertEqual(step["env"]["GIT_CONFIG_KEY_0"], "submodule.private.update")
        self.assertEqual(step["env"]["GIT_CONFIG_VALUE_0"], "none")
        self.assertIn("private", (ROOT / ".bazelignore").read_text().splitlines())

    def cache_steps(self):
        private = workflow_data(ROOT / ".github/workflows/private-check.yml")
        jobs = {**self.jobs, "private-check": private["jobs"]["check"]}
        return {
            name: [
                step
                for step in job.get("steps", [])
                if "actions/cache" in step.get("uses", "")
            ]
            for name, job in jobs.items()
        }

    def test_only_main_pushes_save_bazel_caches(self):
        steps = self.cache_steps()
        saves = {}
        for job, cached in steps.items():
            restores = {
                step.get("id"): step for step in cached if "/restore@" in step["uses"]
            }
            for step in cached:
                with self.subTest(job=job, step=step["with"]["path"]):
                    action = step["uses"].split("@")[0]
                    self.assertIn(
                        action, {"actions/cache/restore", "actions/cache/save"}
                    )
                    if action == "actions/cache/save":
                        source = re.fullmatch(
                            r"\$\{\{ steps\.([a-z-]+)\.outputs\.cache-primary-key \}\}",
                            step["with"]["key"],
                        )[1]
                        self.assertEqual(
                            step["with"]["path"], restores[source]["with"]["path"]
                        )
                        self.assertEqual(
                            step["if"],
                            "github.event_name == 'push' && github.ref == 'refs/heads/main' && "
                            f"steps.{source}.outputs.cache-hit != 'true'",
                        )
                        saves.setdefault(job, []).append(step["with"]["path"])
        self.assertEqual(
            saves,
            {
                "changes": ["~/.cache/personal-cloud-bazel/repository"],
                "checks": ["~/.cache/personal-cloud-bazel/actions"],
            },
        )
        script = (ROOT / "tools/bazel/ci/run.py").read_text()
        self.assertLess(
            script.index('"shutdown"]'),
            script.index('collect_garbage(cache / "actions")'),
        )

    def test_restores_reach_main_producers_across_revisions_and_dependency_changes(
        self,
    ):
        steps = self.cache_steps()
        dependencies = {
            name: name.encode()
            for name in (
                "MODULE.bazel",
                "MODULE.bazel.lock",
                "pnpm-lock.yaml",
                "uv.lock",
            )
        }
        changed = {**dependencies, "uv.lock": b"changed dependency graph"}

        def render(template, *, sha, family="", files=dependencies, runner="Linux"):
            values = {"runner.os": runner, "github.sha": sha, "matrix.cache": family}

            def expression(match):
                value = match[1].strip()
                if value.startswith("hashFiles("):
                    names = sorted(re.findall(r"'([^']+)'", value))
                    return hashlib.sha256(
                        b"".join(files[name] for name in names)
                    ).hexdigest()
                return values[value]

            return re.sub(r"\$\{\{(.*?)\}\}", expression, template)

        def first_match(
            consumer, published, *, family="", files=dependencies, runner="Linux"
        ):
            requested = [consumer["key"], *consumer["restore-keys"].splitlines()]
            return next(
                (
                    index
                    for index, key in enumerate(requested)
                    if published.startswith(
                        render(
                            key, sha="next", family=family, files=files, runner=runner
                        )
                    )
                ),
                None,
            )

        def restore(job, path):
            return next(
                step["with"]
                for step in steps[job]
                if "/restore@" in step["uses"] and step["with"]["path"] == path
            )

        repository = "~/.cache/personal-cloud-bazel/repository"
        actions = "~/.cache/personal-cloud-bazel/actions"
        published = render(restore("changes", repository)["key"], sha="previous")
        for job in ("changes", "checks", "artifacts", "private-check"):
            consumer = restore(job, repository)
            with self.subTest(consumer=job, cache="repository"):
                # Unchanged lockfiles hit main's entry exactly, so a new revision uploads no copy;
                # a dependency change still starts warm from the newest entry.
                self.assertEqual(render(consumer["key"], sha="next"), published)
                self.assertEqual(first_match(consumer, published, files=changed), 1)
                self.assertIsNone(first_match(consumer, published, runner="macOS"))
        self.assertNotIn(actions, [step["with"]["path"] for step in steps["artifacts"]])
        producer = restore("checks", actions)
        for family in ("node", "python", "workerd", "check"):
            published = render(producer["key"], sha="previous", family=family)
            with self.subTest(consumer="checks", family=family):
                self.assertEqual(first_match(producer, published, family=family), 1)
                self.assertEqual(
                    first_match(producer, published, family=family, files=changed), 2
                )
                self.assertIsNone(
                    first_match(producer, published, family="cpu", files=changed)
                )
        private = restore("private-check", actions)
        for family in ("node", "python", "workerd"):
            with self.subTest(consumer="private-check", family=family):
                published = render(producer["key"], sha="previous", family=family)
                self.assertIsNotNone(first_match(private, published))
                self.assertIsNone(first_match(private, published, runner="macOS"))

    def test_private_selection_uses_the_pinned_entry_point_and_only_returns_a_boolean(self):
        check = workflow_data(ROOT / ".github/workflows/private-check.yml")
        self.assertEqual(set(check["on"]["workflow_call"]["outputs"]), {"release_required"})
        job = check["jobs"]["check"]
        self.assertEqual(
            check["on"]["workflow_call"]["outputs"]["release_required"]["value"],
            "${{ jobs.check.outputs.release_required }}",
        )
        self.assertEqual(job["outputs"]["release_required"], "${{ steps.plan.outputs.release_required }}")
        plan = job["steps"][-1]
        self.assertEqual(plan["id"], "plan")
        self.assertEqual(plan["env"]["BASE_SHA"], "${{ inputs.base }}")
        self.assertIn('python3 private/ci/plan.py --base "$BASE_SHA" --github-output "$GITHUB_OUTPUT"', plan["run"])
        self.assertIn('> "$RUNNER_TEMP/private-plan.log" 2>&1', plan["run"])
        self.assertIn("PRIVATE_PLAN_FAILED", plan["run"])
        install = next(step["run"] for step in job["steps"]
                       if step.get("name") == "Install fixed Target Determinator")
        public_install = next(step["run"] for step in self.jobs["changes"]["steps"]
                              if step.get("name") == "Install fixed Target Determinator")
        self.assertEqual(install, public_install)

    def test_private_operations_remain_a_separate_recovery_entry_point(self):
        inputs = self.workflow["on"]["workflow_dispatch"]["inputs"]
        self.assertNotIn("private_operation", inputs)
        self.assertEqual(
            [name for name, job in self.jobs.items()
             if job.get("uses") == "./.github/workflows/private-release.yml"],
            ["observer-access", "private-deploy"],
        )

        operations = workflow_data(ROOT / ".github/workflows/private-ops.yml")
        self.assertEqual(set(operations["on"]), {"workflow_dispatch"})
        self.assertIn(
            "data-check",
            operations["on"]["workflow_dispatch"]["inputs"]["operation"]["options"],
        )
        self.assertIn("finish-worker", operations["on"]["workflow_dispatch"]["inputs"]["operation"]["options"])
        jobs = operations["jobs"]
        self.assertEqual(set(jobs), {"context", "operate"})
        context = jobs["context"]
        self.assertIn("github.ref == 'refs/heads/main'", context["if"])
        checkout = next(
            step for step in context["steps"] if "checkout@" in step.get("uses", "")
        )
        self.assertEqual(checkout["with"]["ref"], "${{ github.sha }}")
        self.assertEqual(
            context["outputs"]["revision"], "${{ steps.source.outputs.revision }}"
        )
        operate = jobs["operate"]
        self.assertEqual(operate["needs"], "context")
        self.assertEqual(operate["uses"], "./.github/workflows/private-release.yml")
        self.assertEqual(
            operate["with"]["revision"], "${{ needs.context.outputs.revision }}"
        )
        self.assertEqual(operate["with"]["operation"], "${{ inputs.operation }}")
        self.assertFalse(
            any(
                job.get("uses") == "./.github/workflows/ci.yml" for job in jobs.values()
            )
        )
        publisher = workflow_data(ROOT / ".github/workflows/private-release.yml")
        entry = publisher["jobs"]["release"]["steps"][-1]
        # Every operation, including finish-worker, runs through the pinned private entry point only, once, with its
        # output kept in a runner file. It is passed as an argument: an entry point pinned before an operation
        # existed refuses it rather than defaulting.
        self.assertEqual(entry["run"].count("python3 "), 1)
        self.assertEqual(entry["run"].count(
            'python3 private/ci/release.py --operation "$PRIVATE_RELEASE_OPERATION" > "$log" 2>&1 || status=$?'
        ), 1)
        self.assertEqual(
            entry["env"]["PRIVATE_RELEASE_OPERATION"], "${{ inputs.operation }}"
        )
        self.assertEqual(publisher["concurrency"], {"group": "private-production", "cancel-in-progress": "false"})
        self.assertEqual(publisher["jobs"]["release"]["environment"], "production")
        # The private rollout may wait out its whole startup window before observation and checks begin.
        self.assertEqual(publisher["jobs"]["release"]["timeout-minutes"], "45")

    def test_ci_triggers_are_only_push_and_dispatch(self):
        # With no other trigger, a job that checks for main runs only for a main push or a dispatch on main.
        # A schedule or workflow_run trigger would also run on main, so adding one needs event checks again.
        self.assertEqual(set(self.workflow["on"]), {"push", "workflow_dispatch"})

    def test_worker_publication_uses_checked_sha_artifacts_and_main_gate(self):
        for name, job in self.jobs.items():
            if job.get("uses") != "./.github/workflows/worker-release.yml":
                continue
            with self.subTest(job=name):
                self.assertIn("gate", job["needs"])
                self.assertIn("needs.gate.result == 'success'", job["if"])
                self.assertIn("github.ref == 'refs/heads/main'", job["if"])
                self.assertEqual(job["with"]["source_sha"], "${{ github.sha }}")
                self.assertEqual(
                    job["with"]["artifact_run_id"],
                    "${{ needs.changes.outputs.dashboard_deploy != 'true' && github.run_id || needs.changes.outputs.artifact_run_id || github.run_id }}"
                    if name == "dashboard-deploy"
                    else "${{ needs.changes.outputs.artifact_run_id || github.run_id }}",
                )
                self.assertEqual(job["permissions"]["actions"], "read")
        release = workflow_data(ROOT / ".github/workflows/worker-release.yml")["jobs"][
            "release"
        ]
        self.assertEqual(
            release["concurrency"],
            {"group": "${{ inputs.app }}-production", "cancel-in-progress": "false"},
        )
        self.assertEqual(release["environment"]["name"], "production")

    def test_cluster_identity_is_available_only_in_the_protected_private_publisher(
        self,
    ):
        for name, job in self.jobs.items():
            if name in {"observer-access", "private-deploy"}:
                self.assertEqual(job["permissions"]["id-token"], "write")
                self.assertEqual(job["uses"], "./.github/workflows/private-release.yml")
                self.assertNotIn("steps", job)
                self.assertIn("github.ref == 'refs/heads/main'", job["if"])
                self.assertIn("needs.gate.result == 'success'", job["if"])
            else:
                self.assertNotIn("id-token", job.get("permissions", {}), name)
        publisher = workflow_data(ROOT / ".github/workflows/private-release.yml")
        self.assertEqual(publisher["permissions"]["id-token"], "write")
        job = publisher["jobs"]["release"]
        self.assertIn("github.ref == 'refs/heads/main'", job["if"])
        self.assertEqual(job["environment"], "production")
        environment = job["steps"][-1]["env"]
        self.assertEqual(environment["K3S_CLUSTER_CA"], "${{ vars.K3S_CLUSTER_CA }}")
        self.assertNotIn("KUBECONFIG", environment)
        operations = workflow_data(ROOT / ".github/workflows/private-ops.yml")
        choices = operations["on"]["workflow_dispatch"]["inputs"]["operation"][
            "options"
        ]
        self.assertTrue({"k3s-check", "k3s-plan", "k3s-apply"} <= set(choices))
        self.assertEqual(
            operations["jobs"]["operate"]["permissions"]["id-token"], "write"
        )

    def test_service_binding_predecessors_still_release_first(self):
        for app, predecessors in {
            "todofy-deploy": {"model-router-deploy"},
            "tasks-deploy": {"todofy-deploy"},
            "watch-deploy": {"tasks-deploy"},
            "personal-mcp-deploy": {
                "tasks-deploy",
                "todofy-deploy",
                "watch-deploy",
                "recall-deploy",
            },
            "dashboard-deploy": {
                "todofy-deploy",
                "mail-hero-deploy",
                "links-deploy",
                "watch-deploy",
                "tasks-deploy",
                "mailsort-deploy",
                "recall-deploy",
                "fleet-deploy",
                "personal-mcp-deploy",
                "website-relay-deploy",
            },
        }.items():
            with self.subTest(app=app):
                self.assertLessEqual(predecessors, set(self.jobs[app]["needs"]))
                self.assertIn("!cancelled()", self.jobs[app]["if"])

    def test_resume_never_publishes_new_images(self):
        for name in ("newsletter-deploy", "platform-image", "codex-gateway-image"):
            self.assertIn(
                "!(github.event_name == 'workflow_dispatch' && inputs.resume_vps_release)",
                self.jobs[name]["if"],
            )
        source = (ROOT / ".github/actions/deploy-vps/action.yml").read_text()
        self.assertIn("args+=(--resume)", source)
        self.assertIn("args+=(--gateway-only)", source)

    def test_artifact_producers_have_no_production_permissions(self):
        for name in ("changes", "checks", "artifacts", "private-home-artifact", "gate"):
            with self.subTest(job=name):
                job = self.jobs[name]
                self.assertNotIn("environment", job)
                self.assertNotIn("secrets.", str(job))
                self.assertNotIn("packages", job.get("permissions", {}))
                self.assertNotIn("deployments", job.get("permissions", {}))


if __name__ == "__main__":
    unittest.main()
