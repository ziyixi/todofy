"""Release selection follows declared Bazel targets and preserves publication boundaries."""

import unittest

from releases import job_name, outputs, reusable_artifacts, select, successful_main_base


def release(app, kind="worker", target=None):
    return {"app": app, "kind": kind, "target": target or f"//{app}:{app}"}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.catalog = [
            release("tasks"),
            release("recall"),
            release("recall", "extension"),
            release("website", "website"),
            release("website-relay"),
            release("newsletter", "image"),
            release("platform", "image"),
            release("codex-gateway", "image"),
        ]

    def test_worker_and_extension_remain_independent(self):
        extension = self.catalog[2]
        values = outputs(self.catalog, select(self.catalog, [extension]), {})
        self.assertEqual(values["recall_extension_publish"], "true")
        self.assertEqual(values["recall_deploy"], "false")
        self.assertEqual(values["tasks_deploy"], "false")

    def test_newsletter_and_platform_keep_the_existing_paired_release(self):
        result = select(self.catalog, [release("newsletter", "image")])
        self.assertEqual({item["app"] for item in result}, {"newsletter", "platform"})
        self.assertEqual(
            select(self.catalog, [release("codex-gateway", "image")]),
            [release("codex-gateway", "image")],
        )

    def test_dispatch_selects_only_the_requested_release(self):
        self.assertEqual(select(self.catalog, [], "tasks"), [release("tasks")])
        self.assertEqual(
            {item["app"] for item in select(self.catalog, [], "website")},
            {"website", "website-relay"},
        )
        with self.assertRaises(ValueError):
            select(self.catalog, [], "unknown")

    def test_resume_does_not_build_or_publish_new_images(self):
        values = outputs(self.catalog, self.catalog, {}, resume="newsletter")
        self.assertEqual(values["platform_deploy"], "true")
        self.assertEqual(values["platform_publish"], "false")
        self.assertEqual(values["newsletter_deploy"], "false")
        self.assertEqual(values["has_artifacts"], "false")
        self.assertEqual(values["artifact_matrix"], '{"include":[]}')

    def test_reused_artifacts_do_not_skip_deployment_selection(self):
        values = outputs(
            self.catalog,
            [release("tasks")],
            {"id": "42", "url": "https://example.test/run"},
        )
        self.assertEqual(values["tasks_deploy"], "true")
        self.assertEqual(values["has_artifacts"], "false")
        self.assertEqual(values["artifact_run_id"], "42")

    def test_missing_or_skipped_artifact_job_is_not_reused(self):
        artifact = release("tasks")

        def get(path):
            if path.endswith("/runs/99"):
                return {"workflow_id": 7}
            if "/workflows/7/runs?" in path:
                return {
                    "workflow_runs": [
                        {
                            "id": 42,
                            "head_sha": "a" * 40,
                            "head_branch": "codex/test",
                            "event": "push",
                            "workflow_id": 7,
                            "conclusion": "success",
                            "html_url": "https://example.test/run",
                        }
                    ]
                }
            if "/artifacts?" in path:
                return {
                    "artifacts": [
                        {"name": "worker-tasks-" + "a" * 40, "expired": False}
                    ]
                }
            return {
                "jobs": [
                    {"name": "CI gate", "status": "completed", "conclusion": "success"},
                    {
                        "name": job_name(artifact),
                        "status": "completed",
                        "conclusion": "skipped",
                    },
                ]
            }

        self.assertEqual(
            reusable_artifacts("owner/repo", "99", "a" * 40, [artifact], get), {}
        )

    def test_green_exact_revision_branch_artifact_is_reused(self):
        artifact = release("tasks")

        def get(path):
            if path.endswith("/runs/99"):
                return {"workflow_id": 7}
            if "/artifacts?" in path:
                return {
                    "artifacts": [
                        {"name": "worker-tasks-" + "a" * 40, "expired": False}
                    ]
                }
            if "/workflows/7/runs?" in path:
                return {
                    "workflow_runs": [
                        {
                            "id": 41,
                            "head_sha": "b" * 40,
                            "head_branch": "codex/old",
                            "event": "push",
                            "workflow_id": 7,
                            "conclusion": "success",
                            "html_url": "https://example.test/old",
                        },
                        {
                            "id": 42,
                            "head_sha": "a" * 40,
                            "head_branch": "codex/test",
                            "event": "push",
                            "workflow_id": 7,
                            "conclusion": "success",
                            "html_url": "https://example.test/run",
                        },
                    ]
                }
            return {
                "jobs": [
                    {"name": name, "status": "completed", "conclusion": "success"}
                    for name in ("CI gate", job_name(artifact))
                ]
            }

        self.assertEqual(
            reusable_artifacts("owner/repo", "99", "a" * 40, [artifact], get)["id"],
            "42",
        )

        def expired(path):
            result = get(path)
            if "artifacts" in result:
                result["artifacts"][0]["expired"] = True
            return result

        self.assertEqual(
            reusable_artifacts("owner/repo", "99", "a" * 40, [artifact], expired), {}
        )

    def test_failed_publish_remains_in_the_cumulative_main_diff(self):
        def get(path):
            if path.endswith("/runs/99"):
                return {"workflow_id": 7}
            return {
                "workflow_runs": [
                    {
                        "id": 41,
                        "head_sha": "older",
                        "head_branch": "main",
                        "event": "push",
                        "workflow_id": 7,
                        "conclusion": "success",
                    },
                    {
                        "id": 42,
                        "head_sha": "newer",
                        "head_branch": "main",
                        "event": "push",
                        "workflow_id": 7,
                        "conclusion": "failure",
                    },
                ]
            }

        self.assertEqual(
            successful_main_base(["newer", "older"], "owner/repo", "99", get), "older"
        )


if __name__ == "__main__":
    unittest.main()
