"""The retired extension keeps shared UI regressions without publishing new builds."""

import unittest

import ci_changes
from workflow_sources import ROOT, workflow_data


class TodoistPlusRetirement(unittest.TestCase):
    def test_extension_change_checks_but_publishes_nothing(self):
        result = ci_changes.classify(["todoist-plus/src/PlanView.tsx"])
        self.assertTrue(result["todoist_plus_check"])
        self.assertFalse(result["todoist_plus_publish"])
        self.assertFalse(
            any(value for key, value in result.items() if key.endswith("_deploy"))
        )
        self.assertFalse(result["recall_extension_publish"])

    def test_contract_changes_still_check_shared_ui_and_native_consumers(self):
        result = ci_changes.classify(["proto/todofy/ui/v1/plus_service.proto"])
        self.assertTrue(result["todofy_deploy"])
        self.assertTrue(result["tasks_deploy"])
        self.assertTrue(result["todoist_plus_check"])
        self.assertFalse(result["todoist_plus_publish"])
        self.assertFalse(result["recall_extension_publish"])

    def test_no_release_or_artifact_is_published_but_browser_regressions_remain(self):
        workflow = workflow_data(ROOT / ".github/workflows/ci.yml")
        self.assertNotIn("todoist-plus-release", workflow["jobs"])
        self.assertIn("todoist-plus-checks", workflow["jobs"]["gate"]["needs"])
        action = workflow_data(ROOT / ".github/actions/check-todoist-plus/action.yml")
        commands = "\n".join(step.get("run", "") for step in action["runs"]["steps"])
        self.assertIn("npm test", commands)
        self.assertIn("npm run build", commands)
        self.assertIn("npm run test:browser", commands)
        self.assertFalse(
            any(
                "upload-artifact" in step.get("uses", "")
                for step in action["runs"]["steps"]
            )
        )
        for result in (
            ci_changes.everything(),
            ci_changes.classify(["todoist-plus/package.json"]),
        ):
            self.assertFalse(result["todoist_plus_publish"])


if __name__ == "__main__":
    unittest.main()
