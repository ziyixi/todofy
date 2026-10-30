"""The CI selector forwards impact calculation and preserves check evidence and CPU semantics."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
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
                    ("container", "py_test", ["container"]),
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
                "container",
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
                + ("1" if group in ("workerd", "cpu", "browser", "container") else "4"),
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
                "old",
                "bazel",
                "target-determinator",
                [],
                {"//a:one"},
                "tests(//a:check)",
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
                "tests(//a:check)",
            )
        self.assertEqual(targets, {"//a:two"})
        command = run.call_args.args[0]
        self.assertEqual(command[-1], "base")
        self.assertIn("--nocache_results", command)
        self.assertIn("--before-query-error-behavior=ignore-and-build-all", command)
        self.assertIn("--targets=tests(//a:check)", command)
        self.assertIn("v0.34.0", why)

    def test_wrong_determinator_version_fails(self):
        with (
            patch.object(
                plan.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
            ),
            patch.object(plan, "run", return_value="target-determinator v0.33.2"),
            self.assertRaisesRegex(RuntimeError, "v0.34.0"),
        ):
            plan.affected_targets("base", "bazel", "td", [], set(), "tests(//a:check)")

    def test_no_affected_leaves_produces_no_runner_work(self):
        xml = '<query><rule name="//new-app:leaf_test" class="js_test"/></query>'
        with (
            patch.object(
                plan.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
            ),
            patch.object(plan.shutil, "which", return_value="/bin/bazel"),
            patch.object(plan, "run", side_effect=[plan.TD_VERSION, ""]),
        ):
            selected, _ = plan.affected_targets(
                "base",
                "bazel",
                "td",
                [],
                {"//new-app:leaf_test"},
                "tests(//new-app:check)",
            )
        self.assertEqual(plan.target_groups(xml, selected), {})


class ScopeTest(unittest.TestCase):
    def test_new_public_app_and_package_roots_drive_the_leaf_scope(self):
        roots = [
            "//new-service:check",
            "//packages/new-lib:check",
            "//proto:check",
            "//tools:check",
            "//infra:check",
        ]
        xml = '<query><rule name="//new-service/private:leaf_test" class="js_test"/></query>'
        with patch.object(plan, "run", side_effect=["\n".join(roots), xml]) as run:
            found, query, result = plan.check_scope("bazel", [])
        self.assertEqual(found, sorted(roots))
        self.assertEqual(result, xml)
        self.assertIn(plan.ROOTS_QUERY, run.call_args_list[0].args[0])
        self.assertIn(query, run.call_args_list[1].args[0])
        for root in roots:
            self.assertIn(root, query)
        self.assertNotIn("visible(", query)
        self.assertNotIn("//tasks/...", query)

    def test_missing_facades_fail_instead_of_reporting_a_vacuous_green(self):
        with (
            patch.object(plan, "run", return_value=""),
            self.assertRaisesRegex(RuntimeError, "No public :check"),
        ):
            plan.check_scope("bazel", [])


class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.catalog = {
            "//" + app + ":release": {
                "app": app,
                "kind": kind,
                "target": "//" + app + ":artifact",
            }
            for app, kind in [
                ("tasks", "worker"),
                ("todofy", "worker"),
                ("mail-hero", "worker"),
                ("newsletter", "image"),
                ("platform", "image"),
                ("codex-gateway", "image"),
            ]
        }
        self.common = [
            "//proto:check",
            "//contracts:check",
            "//packages/new-lib:check",
            "//tools/bazel/ci:check",
            "//.github/scripts:check",
            "//infra:check",
        ]
        self.roots = self.common + [
            "//" + app + ":check"
            for app in [
                "tasks",
                "todofy",
                "mail-hero",
                "newsletter",
                "platform",
                "codex-gateway",
            ]
        ]

    def roots_for(self, app, resume=False):
        return plan.dispatch_check_roots(
            self.roots, plan.dispatch_releases(self.catalog, app), app, resume
        )

    def test_worker_dispatch_keeps_common_checks_and_only_that_application(self):
        self.assertEqual(set(self.roots_for("tasks")), {*self.common, "//tasks:check"})
        chosen = plan.dispatch_releases(self.catalog, "tasks")
        self.assertEqual(set(chosen), {"//tasks:release"})
        query = plan.selection_query(plan.leaf_query(self.roots_for("tasks")), chosen)
        self.assertNotIn("//newsletter", query)
        self.assertNotIn("//platform", query)
        self.assertNotIn("//codex-gateway", query)

    def test_both_means_todofy_and_mail_hero_and_all_keeps_all_roots(self):
        self.assertEqual(
            set(self.roots_for("both")),
            {*self.common, "//todofy:check", "//mail-hero:check"},
        )
        self.assertEqual(self.roots_for("all"), self.roots)

    def test_newsletter_and_platform_checks_follow_the_existing_image_pair(self):
        for app in ("newsletter", "platform"):
            with self.subTest(app=app):
                self.assertEqual(
                    set(self.roots_for(app)),
                    {*self.common, "//newsletter:check", "//platform:check"},
                )

    def test_gateway_resume_checks_platform_source_without_a_container_scope(self):
        roots = self.roots_for("codex-gateway", resume=True)
        self.assertEqual(
            set(roots), {*self.common, "//codex-gateway:check", "//platform:check"}
        )
        self.assertIn('except attr("tags", "container",', plan.leaf_query(roots, True))
        self.assertNotIn('"container"', plan.leaf_query(roots))

    def test_unknown_application_and_missing_public_facade_fail(self):
        with self.assertRaisesRegex(ValueError, "no release target"):
            self.roots_for("missing")
        with self.assertRaisesRegex(ValueError, "no public :check"):
            plan.dispatch_check_roots(
                self.common, plan.dispatch_releases(self.catalog, "tasks"), "tasks"
            )

    def test_resume_removes_images_before_the_single_td_call_but_keeps_the_catalog(
        self,
    ):
        xml = '<query><rule name="//newsletter:source_test" class="py_test"/></query>'
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "plan.json"
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "plan.py",
                        "--base",
                        "base",
                        "--app",
                        "newsletter",
                        "--resume-vps-release",
                        "--release-input-query",
                        "--output",
                        str(output),
                    ],
                ),
                patch.dict(plan.os.environ, {"GITHUB_OUTPUT": ""}),
                patch.object(plan, "release_scope", return_value=self.catalog),
                patch.object(plan, "run", side_effect=["\n".join(self.roots), xml]),
                patch.object(
                    plan,
                    "affected_targets",
                    return_value=({"//newsletter:source_test"}, "native TD"),
                ) as affected,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                plan.main()
            result = json.loads(output.read_text())
        affected.assert_called_once()
        candidates, query = affected.call_args.args[4:]
        self.assertEqual(candidates, {"//newsletter:source_test"})
        self.assertNotIn(":release", query)
        self.assertEqual(query, "set(//newsletter:source_test)")
        self.assertEqual(result["groups"], {"python": ["//newsletter:source_test"]})
        self.assertEqual(len(result["release_catalog"]), len(self.catalog))
        self.assertEqual(result["releases"], [])

    def test_normal_changed_selection_keeps_container_checks(self):
        xml = '<query><rule name="//newsletter:image_test" class="py_test"><list name="tags"><string value="container"/></list></rule></query>'
        selected, _ = plan.affected_targets(
            "",
            "bazel",
            "td",
            [],
            {"//newsletter:image_test"},
            plan.leaf_query(self.roots),
        )
        self.assertEqual(
            plan.target_groups(xml, selected),
            {"container": ["//newsletter:image_test"]},
        )


class ReleaseTest(unittest.TestCase):
    def metadata_xml(self, entries):
        root = ET.Element("query")
        for label, tags, kind in entries:
            rule = ET.SubElement(root, "rule", name=label, **{"class": kind})
            values = ET.SubElement(rule, "list", name="tags")
            for tag in tags:
                ET.SubElement(values, "string", value=tag)
        return ET.tostring(root, encoding="unicode")

    def test_native_metadata_declares_worker_image_extension_and_website(self):
        entries = [
            (
                "//tasks:release",
                ["release:worker:tasks", "artifact://tasks:tasks"],
                "filegroup",
            ),
            (
                "//newsletter:release",
                ["release:image:newsletter", "artifact://newsletter:newsletter"],
                "filegroup",
            ),
            (
                "//recall:release_extension",
                ["release:extension:recall", "artifact://recall:extension_artifact"],
                "filegroup",
            ),
            (
                "//website:release_site",
                ["release:website:website", "artifact://website:website"],
                "filegroup",
            ),
            (
                "//website:release_relay",
                ["release:worker:website-relay", "artifact://website:relay"],
                "filegroup",
            ),
        ]
        records = plan.release_metadata(self.metadata_xml(entries))
        self.assertEqual(
            {record["kind"] for record in records.values()}, plan.RELEASE_KINDS
        )
        self.assertEqual(
            records["//website:release_relay"],
            {"app": "website-relay", "kind": "worker", "target": "//website:relay"},
        )

    def test_missing_ambiguous_or_cross_app_tags_fail(self):
        cases = [
            ("//tasks:release", ["release:worker:tasks"], "filegroup"),
            ("//tasks:release", ["artifact://tasks:tasks"], "filegroup"),
            (
                "//tasks:release",
                [
                    "release:worker:tasks",
                    "release:image:tasks",
                    "artifact://tasks:tasks",
                ],
                "filegroup",
            ),
            (
                "//tasks:release",
                ["release:unknown:tasks", "artifact://tasks:tasks"],
                "filegroup",
            ),
            (
                "//tasks:release",
                ["release:worker:bad_app", "artifact://tasks:tasks"],
                "filegroup",
            ),
            (
                "//tasks:release",
                ["release:worker:tasks", "artifact://other:other"],
                "filegroup",
            ),
            (
                "//tasks:release",
                ["release:worker:tasks", "artifact://tasks/worker:bundle"],
                "filegroup",
            ),
            (
                "//tasks/worker:release",
                ["release:worker:tasks", "artifact://tasks:tasks"],
                "filegroup",
            ),
            (
                "//tasks:release",
                ["release:worker:tasks", "artifact://tasks:tasks"],
                "genrule",
            ),
        ]
        for entry in cases:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                plan.release_metadata(self.metadata_xml([entry]))

    def test_duplicate_release_identity_fails(self):
        entries = [
            (
                "//tasks:release_one",
                ["release:worker:tasks", "artifact://tasks:one"],
                "filegroup",
            ),
            (
                "//tasks:release_two",
                ["release:worker:tasks", "artifact://tasks:two"],
                "filegroup",
            ),
        ]
        with self.assertRaisesRegex(ValueError, "duplicate release"):
            plan.release_metadata(self.metadata_xml(entries))

    def test_test_and_release_candidates_use_one_determinator_comparison(self):
        records = {
            "//tasks:release": {
                "app": "tasks",
                "kind": "worker",
                "target": "//tasks:tasks",
            }
        }
        query = plan.selection_query("tests(//tasks:check)", records)
        with (
            patch.object(
                plan.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
            ),
            patch.object(plan.shutil, "which", return_value="/bin/bazel"),
            patch.object(
                plan,
                "run",
                side_effect=[
                    plan.TD_VERSION,
                    "//tasks/private:leaf_test\n//tasks:release",
                ],
            ) as run,
        ):
            selected, _ = plan.affected_targets(
                "base",
                "bazel",
                "td",
                [],
                {"//tasks/private:leaf_test", "//tasks:release"},
                query,
            )
        self.assertEqual(selected, {"//tasks/private:leaf_test", "//tasks:release"})
        self.assertEqual(run.call_count, 2)  # version check and one native comparison
        self.assertIn("--targets=" + query, run.call_args.args[0])

    def test_release_only_change_schedules_no_test_group(self):
        records = {
            "//tasks:release": {
                "app": "tasks",
                "kind": "worker",
                "target": "//tasks:tasks",
            }
        }
        xml = '<query><rule name="//tasks/private:leaf_test" class="js_test"/></query>'
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "plan.json"
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "plan.py",
                        "--base",
                        "base",
                        "--release-input-query",
                        "--output",
                        str(output),
                    ],
                ),
                patch.dict(plan.os.environ, {"GITHUB_OUTPUT": ""}),
                patch.object(
                    plan,
                    "check_scope",
                    return_value=(["//tasks:check"], "tests(//tasks:check)", xml),
                ),
                patch.object(plan, "release_scope", return_value=records),
                patch.object(
                    plan,
                    "affected_targets",
                    return_value=({"//tasks:release"}, "native TD"),
                ) as affected,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                plan.main()
            result = json.loads(output.read_text())
        affected.assert_called_once()
        self.assertEqual(result["groups"], {})
        self.assertEqual(result["releases"], [records["//tasks:release"]])


class BaselineTest(unittest.TestCase):
    def test_main_and_dispatch_without_explicit_base_check_the_complete_graph(self):
        for env in (
            {"GITHUB_REF": "refs/heads/main"},
            {"GITHUB_EVENT_NAME": "workflow_dispatch"},
        ):
            with (
                patch.dict(plan.os.environ, env, clear=True),
                patch.object(plan.subprocess, "run") as git,
            ):
                self.assertEqual(plan.baseline()[0], "")
            git.assert_not_called()

    def test_local_branch_uses_its_merge_base(self):
        with (
            patch.dict(plan.os.environ, {"GITHUB_SHA": "head"}, clear=True),
            patch.object(
                plan.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, "base\n"),
            ) as git,
        ):
            self.assertEqual(plan.baseline()[0], "base")
        self.assertEqual(
            git.call_args.args[0], ["git", "merge-base", "origin/main", "head"]
        )


if __name__ == "__main__":
    unittest.main()
