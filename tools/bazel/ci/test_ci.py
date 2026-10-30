"""The CI selector forwards impact calculation and preserves check evidence and CPU semantics."""

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import plan
import run as runner


class GroupsTest(unittest.TestCase):
    def test_language_and_execution_environment_groups(self):
        xml = (
            "<query>"
            + "".join(
                f'<rule name="//a:{name}" class="{kind}"><list name="tags">'
                + "".join(f'<string value="{tag}"/>' for tag in tags)
                + "</list></rule>"
                for name, kind, tags in [
                    ("cpu", "js_test", ["cpu", "workerd"]),
                    ("browser", "js_test", ["browser"]),
                    ("worker", "js_test", ["workerd"]),
                    ("node", "js_test", []),
                    ("python", "py_test", []),
                    ("go", "go_test", []),
                    ("check", "build_test", []),
                    ("manual", "py_test", ["manual"]),
                ]
            )
            + "</query>"
        )
        labels = {
            f"//a:{name}"
            for name in (
                "cpu",
                "browser",
                "worker",
                "node",
                "python",
                "go",
                "check",
                "manual",
            )
        }
        groups = plan.target_groups(xml, labels)
        self.assertEqual(set(groups), set(plan.GROUPS))
        self.assertEqual(groups["cpu"], ["//a:cpu"])
        self.assertEqual(groups["workerd"], ["//a:worker"])
        self.assertNotIn(
            "//a:manual", [label for group in groups.values() for label in group]
        )

    def test_targets_not_selected_by_determinator_are_omitted(self):
        xml = '<query><rule name="//a:one" class="py_test"/><rule name="//a:two" class="py_test"/></query>'
        self.assertEqual(plan.target_groups(xml, {"//a:two"}), {"python": ["//a:two"]})

    def test_only_cpu_group_disables_test_result_caching(self):
        for group in plan.GROUPS:
            command = runner.command(
                "bazel", group, "/tmp/targets.txt", Path("/tmp/cache")
            )
            self.assertEqual(command[:2], ["bazel", "test"])
            self.assertEqual("--nocache_test_results" in command, group == "cpu")
            self.assertIn(
                "--local_test_jobs="
                + ("1" if group in ("workerd", "cpu", "browser") else "4"),
                command,
            )
            self.assertIn("--target_pattern_file=/tmp/targets.txt", command)


class SelectionTest(unittest.TestCase):
    def test_pre_bazel_base_selects_every_current_test_without_calling_determinator(
        self,
    ):
        with (
            patch.object(
                plan.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)
            ),
            patch.object(plan, "run") as run,
        ):
            targets, why = plan.affected_targets(
                "old", "bazel", "target-determinator", [], {"//a:one"}
            )
        self.assertEqual(targets, {"//a:one"})
        self.assertIn("no MODULE.bazel", why)
        run.assert_not_called()

    def test_current_graph_selection_is_delegated_to_the_pinned_binary(self):
        with (
            patch.object(
                plan.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
            ),
            patch.object(plan.shutil, "which", return_value="/bin/bazel"),
            patch.object(
                plan,
                "run",
                side_effect=[plan.TD_VERSION, "//a:two\n//other:unselected"],
            ) as run,
        ):
            targets, why = plan.affected_targets(
                "base",
                "bazel",
                "target-determinator",
                ["--output_user_root=/tmp/cache"],
                {"//a:one", "//a:two"},
            )
        self.assertEqual(targets, {"//a:two"})
        command = run.call_args.args[0]
        self.assertEqual(command[-1], "base")
        self.assertIn("--nocache_results", command)
        self.assertIn("--before-query-error-behavior=ignore-and-build-all", command)
        self.assertIn("--targets=" + plan.QUERY, command)
        self.assertIn("v0.34.0", why)

    def test_wrong_determinator_version_fails(self):
        with (
            patch.object(
                plan.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
            ),
            patch.object(plan, "run", return_value="target-determinator v0.33.2"),
            self.assertRaisesRegex(RuntimeError, "v0.34.0"),
        ):
            plan.affected_targets("base", "bazel", "td", [], set())


class BaselineTest(unittest.TestCase):
    def test_git_order_and_check_gate_evidence_win_over_release_outcome(self):
        def get(path):
            if path.endswith("/runs/99"):
                return {"workflow_id": 7}
            if "/workflows/7/runs?" in path:
                return {
                    "workflow_runs": [
                        {
                            "id": 10,
                            "head_sha": "older",
                            "workflow_id": 7,
                            "head_branch": "main",
                            "event": "push",
                            "conclusion": "success",
                        },
                        {
                            "id": 11,
                            "head_sha": "newer",
                            "workflow_id": 7,
                            "head_branch": "main",
                            "event": "push",
                            "conclusion": "failure",
                        },
                    ]
                }
            return {
                "jobs": [
                    {"name": plan.GATE, "status": "completed", "conclusion": "success"}
                ]
            }

        self.assertEqual(
            plan.last_checked_main(["newer", "older"], "owner/repo", "99", get), "newer"
        )

    def test_failed_or_pending_gate_does_not_establish_a_baseline(self):
        for state in ("failure", "cancelled", None):

            def get(path, state=state):
                if path.endswith("/runs/99"):
                    return {"workflow_id": 7}
                if "/workflows/7/runs?" in path:
                    return {
                        "workflow_runs": [
                            {
                                "id": 11,
                                "head_sha": "newer",
                                "workflow_id": 7,
                                "head_branch": "main",
                                "event": "push",
                            }
                        ]
                    }
                return {
                    "jobs": [
                        {"name": plan.GATE, "status": "completed", "conclusion": state}
                    ]
                }

            self.assertEqual(
                plan.last_checked_main(["newer"], "owner/repo", "99", get), ""
            )


if __name__ == "__main__":
    unittest.main()
