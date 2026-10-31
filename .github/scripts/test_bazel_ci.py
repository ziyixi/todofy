"""The native graph selects work; the original production locks and ordering still gate writes."""

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
            set(gate["needs"]), {"changes", "checks", "artifacts", "private"}
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
                },
                check=False,
            ).returncode,
            0,
        )

    def test_private_sources_are_pinned_and_never_saved_in_a_cache(self):
        caller = self.jobs["private"]
        self.assertIn("github.repository == 'ziyixi/todofy'", caller["if"])
        self.assertEqual(
            caller["with"]["revision"], "${{ needs.changes.outputs.private_sha }}"
        )
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
            step["with"]
            for step in steps
            if step.get("with", {}).get("path") == "private"
        )
        self.assertEqual(checkout["repository"], "ziyixi/todofy-private")
        self.assertEqual(checkout["ref"], "${{ inputs.revision }}")
        self.assertEqual(checkout["persist-credentials"], "false")
        cache_actions = [
            step["uses"].split("@")[0]
            for step in steps
            if "cache" in step.get("uses", "")
        ]
        self.assertEqual(cache_actions, ["actions/cache/restore"])
        self.assertFalse(
            any("upload-artifact@" in step.get("uses", "") for step in steps)
        )

    def test_public_planning_skips_private_submodule_initialization(self):
        step = next(
            step for step in self.jobs["changes"]["steps"] if step.get("id") == "plan"
        )
        self.assertEqual(step["env"]["GIT_CONFIG_COUNT"], "1")
        self.assertEqual(step["env"]["GIT_CONFIG_KEY_0"], "submodule.private.update")
        self.assertEqual(step["env"]["GIT_CONFIG_VALUE_0"], "none")
        self.assertIn("private", (ROOT / ".bazelignore").read_text().splitlines())

    def test_private_fingerprint_reads_source_and_generated_files_from_the_execution_root(
        self,
    ):
        workflow = workflow_data(ROOT / ".github/workflows/private-check.yml")
        script = next(
            step["run"]
            for step in workflow["jobs"]["check"]["steps"]
            if step.get("id") == "check"
        )
        python = script.split("python3 - <<'PY'\n", 1)[1].split("\nPY", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            execution_root = temporary / "execution"
            names = (
                "external/private/k3s/manifests/kustomization.yaml",
                "bazel-out/generated.txt",
            )
            for name in names:
                source = execution_root / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text("synthetic source")
            (temporary / "private-outputs.txt").write_text("\n".join(names) + "\n")
            (temporary / "private-execution-root.txt").write_text(
                str(execution_root) + "\n"
            )
            output = temporary / "github-output"
            with patch.dict(
                os.environ,
                {"RUNNER_TEMP": str(temporary), "GITHUB_OUTPUT": str(output)},
            ):
                exec(compile(python, "private-fingerprint", "exec"), {})
            expected = hashlib.sha256(
                b"generated.txt\0synthetic sourcekustomization.yaml\0synthetic source"
            ).hexdigest()
            self.assertEqual(output.read_text(), "fingerprint=" + expected + "\n")

    def test_private_operations_do_not_route_through_public_release_selection(self):
        inputs = self.workflow["on"]["workflow_dispatch"]["inputs"]
        self.assertNotIn("private_operation", inputs)
        automatic = self.jobs["private-release"]
        self.assertIn("github.event_name == 'push'", automatic["if"])
        self.assertEqual(automatic["with"]["operation"], "auto")

        operations = workflow_data(ROOT / ".github/workflows/private-ops.yml")
        self.assertEqual(set(operations["on"]), {"workflow_dispatch"})
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
                    "${{ needs.changes.outputs.artifact_run_id || github.run_id }}",
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
        for name in ("changes", "checks", "artifacts", "gate", "private"):
            self.assertNotIn("id-token", self.jobs[name].get("permissions", {}))
        caller = self.jobs["private-release"]
        self.assertEqual(caller["permissions"]["id-token"], "write")
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
        for name in ("changes", "checks", "artifacts", "gate"):
            with self.subTest(job=name):
                job = self.jobs[name]
                self.assertNotIn("environment", job)
                self.assertNotIn("secrets.", str(job))
                self.assertNotIn("packages", job.get("permissions", {}))
                self.assertNotIn("deployments", job.get("permissions", {}))


if __name__ == "__main__":
    unittest.main()
