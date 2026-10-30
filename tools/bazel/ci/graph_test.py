"""Exercise public-root closure and affected leaves with real Bazel, Git and Target Determinator."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import plan


def capture(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def verify(bazel: str, determinator: str) -> dict:
    if capture([bazel, "--version"], Path.cwd()) != "bazel 9.3.1":
        raise RuntimeError("The integration fixture requires Bazel 9.3.1")
    if capture([determinator, "--version"], Path.cwd()) != plan.TD_VERSION:
        raise RuntimeError(
            "The integration fixture requires Target Determinator v0.34.0"
        )
    with tempfile.TemporaryDirectory(prefix="bazel-root-scope-") as temporary:
        root = Path(temporary)
        fixture = root / "repo"
        fixture.mkdir()
        files = {
            "MODULE.bazel": 'module(name = "root_scope_fixture")\n',
            "BUILD.bazel": 'exports_files(["package.json"])\n',
            "package.json": '{"name":"synthetic-root-scope","private":true}\n',
            ".gitignore": "bazel-*\nMODULE.bazel.lock\n",
            "test_rule.bzl": """def _test_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, "#!/bin/sh\\nexit 0\\n", is_executable = True)
    return [DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = ctx.files.data))]

fixture_test = rule(implementation = _test_impl, test = True, attrs = {"data": attr.label_list(allow_files = True)})
""",
            "app/BUILD.bazel": """load("//:test_rule.bzl", "fixture_test")
fixture_test(name = "covered_test", data = ["source.txt"])
fixture_test(name = "orphan_test", data = ["orphan.txt"])
test_suite(name = "check", tests = [":covered_test"], visibility = ["//visibility:public"])
""",
            "app/source.txt": "before\n",
            "app/orphan.txt": "not in the public facade\n",
            "app/internal/BUILD.bazel": """load("//:test_rule.bzl", "fixture_test")
fixture_test(name = "private_test", data = ["source.txt"])
test_suite(name = "check", tests = [":private_test"], visibility = ["//app:__subpackages__"])
""",
            "app/internal/source.txt": "private check\n",
        }
        for package in ["packages/new-lib", "proto", "tools", "infra"]:
            files[
                package + "/BUILD.bazel"
            ] = """load("//:test_rule.bzl", "fixture_test")
fixture_test(name = "leaf_test", data = ["source.txt"])
test_suite(name = "check", tests = [":leaf_test"], visibility = ["//visibility:public"])
"""
            files[package + "/source.txt"] = "unchanged\n"
        for name, contents in files.items():
            path = fixture / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8")

        def git(*args: str) -> str:
            return capture(
                [
                    "git",
                    "-c",
                    "user.name=Bazel graph fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    *args,
                ],
                fixture,
            )

        startup = [
            "--nosystem_rc",
            "--nohome_rc",
            "--output_user_root=" + str(root / "bazel"),
            "--max_idle_secs=5",
        ]

        def query(expression: str) -> set[str]:
            return set(
                capture(
                    [
                        bazel,
                        *startup,
                        "query",
                        expression,
                        "--output=label",
                        "--lockfile_mode=off",
                    ],
                    fixture,
                ).splitlines()
            )

        def changed(base: str, expression: str) -> set[str]:
            command = [
                determinator,
                "--bazel=" + bazel,
                "--working-directory=" + str(fixture),
                "--targets=" + expression,
                "--nocache_results",
                "--before-query-error-behavior=ignore-and-build-all",
                "--analysis-cache-clear-strategy=shutdown",
                "--delete-cached-worktree",
                "--cache-dir=" + str(root / "determinator"),
                "--bazel-opts=--lockfile_mode=off",
            ]
            command += ["--bazel-startup-opts=" + option for option in startup]
            return set(capture(command + [base], fixture).splitlines())

        try:
            git("init", "-q")
            git("add", ".")
            git("commit", "-qm", "Synthetic baseline")
            baseline = git("rev-parse", "HEAD")
            roots = query(plan.ROOTS_QUERY)
            expected_roots = {
                "//app:check",
                "//packages/new-lib:check",
                "//proto:check",
                "//tools:check",
                "//infra:check",
            }
            if roots != expected_roots:
                raise AssertionError(f"Unexpected public roots: {sorted(roots)}")
            scope = plan.leaf_query(sorted(roots))
            leaves = query(scope)
            expected_leaves = {
                "//app:covered_test",
                "//packages/new-lib:leaf_test",
                "//proto:leaf_test",
                "//tools:leaf_test",
                "//infra:leaf_test",
            }
            if leaves != expected_leaves:
                raise AssertionError(f"Unexpected check leaves: {sorted(leaves)}")

            (fixture / "app/source.txt").write_text("after\n", encoding="utf-8")
            git("add", "app/source.txt")
            git("commit", "-qm", "Synthetic source change")
            source_head = git("rev-parse", "HEAD")
            selected_source = changed(baseline, scope)
            if selected_source != {"//app:covered_test"}:
                raise AssertionError(
                    f"Wrong affected source leaves: {sorted(selected_source)}"
                )

            (fixture / "notes.md").write_text(
                "Unconsumed documentation only.\n", encoding="utf-8"
            )
            git("add", "notes.md")
            git("commit", "-qm", "Synthetic documentation change")
            selected_doc = changed(source_head, scope)
            if selected_doc:
                raise AssertionError(
                    f"Documentation selected work: {sorted(selected_doc)}"
                )
            return {
                "public_check_roots": sorted(roots),
                "private_root_and_orphan_leaf_excluded": True,
                "source_change_leaves": sorted(selected_source),
                "doc_only_leaves": sorted(selected_doc),
            }
        finally:
            subprocess.run(
                [bazel, *startup, "shutdown"],
                cwd=fixture,
                check=False,
                capture_output=True,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", required=True)
    parser.add_argument("--determinator", required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            verify(
                str(Path(args.bazel).absolute()),
                str(Path(args.determinator).absolute()),
            ),
            indent=2,
        )
    )
