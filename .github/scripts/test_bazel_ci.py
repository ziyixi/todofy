"""The native graph selects work; the original production locks and ordering still gate writes."""

import os
import subprocess
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
        self.assertEqual(set(gate["needs"]), {"changes", "checks", "artifacts"})
        script = gate["steps"][0]["run"]
        for checks, artifacts, expected in (
            ("success", "success", 0),
            ("failure", "success", 1),
            ("cancelled", "success", 1),
            ("skipped", "success", 1),
            ("success", "failure", 1),
        ):
            with self.subTest(checks=checks, artifacts=artifacts):
                result = subprocess.run(
                    ["bash", "-e", "-c", script],
                    env={
                        **os.environ,
                        "CHANGES": "success",
                        "CHECKS": checks,
                        "ARTIFACTS": artifacts,
                        "HAS_CHECKS": "true",
                        "HAS_ARTIFACTS": "true",
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
                },
                check=False,
            ).returncode,
            0,
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
