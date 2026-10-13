"""Todoist Plus publishes only a tested browser artifact after its service dependencies."""

import unittest

import ci_changes
from workflow_sources import jobs, workflow_data, ROOT


class TodoistPlusRelease(unittest.TestCase):
    def test_extension_change_checks_and_publishes_no_worker(self):
        result = ci_changes.classify(["todoist-plus/src/PlanView.tsx"])
        self.assertTrue(result["todoist_plus_check"])
        self.assertTrue(result["todoist_plus_publish"])
        self.assertFalse(
            any(value for key, value in result.items() if key.endswith("_deploy"))
        )
        self.assertFalse(result["recall_extension_publish"])

    def test_contract_change_reaches_both_sides(self):
        result = ci_changes.classify(["proto/todofy/ui/v1/plus_service.proto"])
        self.assertTrue(result["todofy_deploy"])
        self.assertTrue(result["todoist_plus_publish"])
        self.assertFalse(result["recall_deploy"])
        self.assertFalse(result["recall_extension_publish"])

    def test_publication_waits_for_backends_and_uses_checked_artifact(self):
        workflow = workflow_data(ROOT / ".github/workflows/ci.yml")
        release = workflow["jobs"]["todoist-plus-release"]
        self.assertEqual(
            set(release["needs"]),
            {
                "changes",
                "todoist-plus-checks",
                "gate",
                "todofy-deploy",
                "flowday-deploy",
            },
        )
        download = release["steps"][0]["with"]
        self.assertEqual(download["name"], "todoist-plus-${{ github.sha }}")
        self.assertEqual(
            download["run-id"],
            "${{ needs.changes.outputs.reused_run_id || github.run_id }}",
        )
        text = jobs((ROOT / ".github/workflows/ci.yml").read_text())[
            "todoist-plus-release"
        ]
        self.assertNotIn("npm ", text)
        self.assertNotIn("secrets.", text)
        self.assertIn('"$sha" == "${GITHUB_SHA:0:7}"', text)
        self.assertIn('--target "$GITHUB_SHA"', text)
        gate = workflow["jobs"]["gate"]
        self.assertIn("todoist-plus-checks", gate["needs"])


if __name__ == "__main__":
    unittest.main()
