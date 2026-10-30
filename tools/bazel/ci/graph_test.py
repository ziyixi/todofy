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
filegroup(name = "artifact", srcs = ["source.txt"], visibility = ["//visibility:public"])
filegroup(name = "release", srcs = [":artifact", "deploy.txt"], visibility = ["//visibility:public"], tags = ["release:worker:app", "artifact://app:artifact"])
""",
            "app/source.txt": "before\n",
            "app/deploy.txt": "before deploy input\n",
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
        for app in ["newsletter", "platform"]:
            files[app + "/BUILD.bazel"] = f"""load("//:test_rule.bzl", "fixture_test")
fixture_test(name = "source_test", data = ["source.txt"])
genrule(name = "image", srcs = ["source.txt"], outs = ["image.txt"], cmd = "exit 99")
fixture_test(name = "container_test", data = [":image"], tags = ["container"])
test_suite(name = "check", tests = [":source_test", ":container_test"], visibility = ["//visibility:public"])
filegroup(name = "artifact", srcs = [":image"], visibility = ["//visibility:public"])
filegroup(name = "release", srcs = [":artifact"], visibility = ["//visibility:public"], tags = ["release:image:{app}", "artifact://{app}:artifact"])
"""
            files[app + "/source.txt"] = "unchanged image source\n"
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
                "//newsletter:check",
                "//platform:check",
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
                "//newsletter:source_test",
                "//newsletter:container_test",
                "//platform:source_test",
                "//platform:container_test",
            }
            if leaves != expected_leaves:
                raise AssertionError(f"Unexpected check leaves: {sorted(leaves)}")
            release_xml = capture(
                [
                    bazel,
                    *startup,
                    "query",
                    plan.RELEASES_QUERY,
                    "--output=xml",
                    "--lockfile_mode=off",
                ],
                fixture,
            )
            releases = plan.release_metadata(release_xml)
            expected_releases = {
                "//app:release": {
                    "app": "app",
                    "kind": "worker",
                    "target": "//app:artifact",
                },
                **{
                    "//" + app + ":release": {
                        "app": app,
                        "kind": "image",
                        "target": "//" + app + ":artifact",
                    }
                    for app in ["newsletter", "platform"]
                },
            }
            if releases != expected_releases:
                raise AssertionError(f"Wrong native release metadata: {releases}")
            scope = plan.selection_query(
                "set(" + " ".join(sorted(leaves)) + ")", releases
            )

            (fixture / "app/source.txt").write_text("after\n", encoding="utf-8")
            git("add", "app/source.txt")
            git("commit", "-qm", "Synthetic source change")
            source_head = git("rev-parse", "HEAD")
            selected_source = changed(baseline, scope)
            if selected_source != {"//app:covered_test", "//app:release"}:
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
            doc_head = git("rev-parse", "HEAD")
            (fixture / "app/deploy.txt").write_text(
                "after deploy input\n", encoding="utf-8"
            )
            git("add", "app/deploy.txt")
            git("commit", "-qm", "Synthetic release-input-only change")
            selected_release = changed(doc_head, scope)
            if selected_release != {"//app:release"}:
                raise AssertionError(
                    f"Wrong release-only selection: {sorted(selected_release)}"
                )
            image_base = git("rev-parse", "HEAD")
            (fixture / "newsletter/source.txt").write_text(
                "changed image source\n", encoding="utf-8"
            )
            git("add", "newsletter/source.txt")
            git("commit", "-qm", "Synthetic image source change")
            image_selected = changed(image_base, scope)
            if image_selected != {
                "//newsletter:source_test",
                "//newsletter:container_test",
                "//newsletter:release",
            }:
                raise AssertionError(
                    f"Normal image change lost checks/artifact: {sorted(image_selected)}"
                )

            worker_releases = plan.dispatch_releases(releases, "app")
            worker_roots = plan.dispatch_check_roots(
                sorted(roots), worker_releases, "app"
            )
            worker_leaves = query(plan.leaf_query(worker_roots))
            if worker_leaves != expected_leaves - {
                "//newsletter:source_test",
                "//newsletter:container_test",
                "//platform:source_test",
                "//platform:container_test",
            }:
                raise AssertionError(
                    f"Worker dispatch selected unrelated image checks: {sorted(worker_leaves)}"
                )

            resumed = plan.dispatch_releases(releases, "newsletter")
            resume_roots = plan.dispatch_check_roots(
                sorted(roots), resumed, "newsletter", True
            )
            resume_leaves = query(plan.leaf_query(resume_roots, True))
            resume_scope = "set(" + " ".join(sorted(resume_leaves)) + ")"
            if any("container" in label for label in resume_leaves):
                raise AssertionError(
                    f"Resume selected container checks: {sorted(resume_leaves)}"
                )
            resume_selected = changed(image_base, resume_scope)
            if resume_selected != {"//newsletter:source_test"}:
                raise AssertionError(
                    f"Resume did not retain its changed source check: {sorted(resume_selected)}"
                )
            # Each image action exits 99. These real tests can pass only when no image is built.
            capture(
                [
                    bazel,
                    *startup,
                    "test",
                    *sorted(resume_leaves),
                    "--lockfile_mode=off",
                    "--local_test_jobs=2",
                ],
                fixture,
            )
            return {
                "public_check_roots": sorted(roots),
                "private_root_and_orphan_leaf_excluded": True,
                "source_change_leaves": sorted(selected_source),
                "doc_only_leaves": sorted(selected_doc),
                "release_only_candidates": sorted(selected_release),
                "release_catalog": list(releases.values()),
                "normal_image_change_candidates": sorted(image_selected),
                "worker_dispatch_leaves": sorted(worker_leaves),
                "resume_source_change_leaves": sorted(resume_selected),
                "resume_images_built": False,
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
