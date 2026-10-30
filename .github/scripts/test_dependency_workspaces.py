"""Root workspaces own dependency versions, installation and release reachability."""

import json
import subprocess
import tomllib
import unittest
from collections import defaultdict
from pathlib import Path

import yaml
from workflow_sources import workflow_data

ROOT = Path(__file__).absolute().parents[2]


def tracked_names():
    names = (
        subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT,
        )
        .decode()
        .split("\0")
    )
    return sorted({name for name in names if name and (ROOT / name).is_file()})


class DependencyWorkspaces(unittest.TestCase):
    def test_all_node_members_use_the_root_catalog_and_workspace_links(self):
        names = tracked_names()
        manifests = {
            name: json.loads((ROOT / name).read_text())
            for name in names
            if Path(name).name == "package.json"
        }
        workspace = yaml.safe_load((ROOT / "pnpm-workspace.yaml").read_text())
        members = {str(Path(name).parent) for name in manifests} - {"."}
        self.assertEqual(set(workspace["packages"]), members)
        self.assertEqual(manifests["package.json"]["packageManager"], "pnpm@11.25.0")
        self.assertEqual(manifests["package.json"]["engines"]["node"], "26.x")
        package_names = {data["name"] for data in manifests.values()}
        for name, data in manifests.items():
            for group in (
                "dependencies",
                "devDependencies",
                "optionalDependencies",
                "peerDependencies",
            ):
                for dependency, spec in data.get(group, {}).items():
                    with self.subTest(manifest=name, dependency=dependency):
                        self.assertEqual(
                            spec,
                            "workspace:*"
                            if dependency in package_names
                            else "catalog:",
                        )
                        if spec == "catalog:":
                            self.assertRegex(
                                workspace["catalog"][dependency],
                                r"^\d+\.\d+\.\d+(?:-[\w.-]+)?$",
                            )
        lock = yaml.safe_load((ROOT / "pnpm-lock.yaml").read_text())
        self.assertEqual(set(lock["importers"]), members | {"."})
        self.assertEqual(
            [
                name
                for name in names
                if Path(name).name in {"package-lock.json", "pnpm-lock.yaml"}
            ],
            ["pnpm-lock.yaml"],
        )

    def test_python_members_share_the_root_lock_and_version_constraints(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        uv = project["tool"]["uv"]
        names = tracked_names()
        projects = {name for name in names if Path(name).name == "pyproject.toml"}
        self.assertEqual(
            projects - {"pyproject.toml"},
            {member + "/pyproject.toml" for member in uv["workspace"]["members"]},
        )
        self.assertEqual(
            [name for name in names if Path(name).name == "uv.lock"], ["uv.lock"]
        )
        self.assertEqual(
            [name for name in names if Path(name).name == ".python-version"],
            [".python-version"],
        )
        self.assertRegex(
            (ROOT / ".python-version").read_text().strip(), r"^3\.14\.\d+$"
        )
        pins = {
            pin.split("==", 1)[0].lower().replace("_", "-")
            for pin in uv["constraint-dependencies"]
        }
        sources = {name.lower().replace("_", "-") for name in uv["sources"]}
        for member in uv["workspace"]["members"]:
            data = tomllib.loads((ROOT / member / "pyproject.toml").read_text())
            self.assertTrue(
                data["project"]["requires-python"].startswith(">=3.14"), member
            )
            dependencies = [*data["project"]["dependencies"]]
            for extra in data["project"].get("optional-dependencies", {}).values():
                dependencies.extend(extra)
            for group in data.get("dependency-groups", {}).values():
                dependencies.extend(
                    dependency for dependency in group if isinstance(dependency, str)
                )
            for dependency in dependencies:
                with self.subTest(member=member, dependency=dependency):
                    self.assertRegex(dependency, r"^[\w-]+(?:\[[\w,-]+\])?$")
                    name = dependency.split("[", 1)[0].lower().replace("_", "-")
                    self.assertTrue(name in sources or name in pins)
        versions = defaultdict(set)
        for package in tomllib.loads((ROOT / "uv.lock").read_text())["package"]:
            versions[package["name"]].add(package["version"])
        self.assertFalse(
            {name: values for name, values in versions.items() if len(values) != 1}
        )

    def test_the_node_installer_uses_one_frozen_lock_and_selection_specific_cache(self):
        path = ROOT / ".github/actions/setup-workspace/action.yml"
        action = workflow_data(path)
        steps = action["runs"]["steps"]
        setup_node = next(
            step
            for step in steps
            if step.get("uses", "").startswith("actions/setup-node@")
        )
        self.assertEqual(
            setup_node["with"], {"node-version-file": "${{ inputs.root }}/package.json"}
        )
        setup_pnpm = next(
            step
            for step in steps
            if step.get("uses", "").startswith("pnpm/action-setup@")
        )
        self.assertEqual(
            setup_pnpm["with"]["package_json_file"], "${{ inputs.root }}/package.json"
        )
        cache = next(
            step for step in steps if step.get("uses", "").startswith("actions/cache@")
        )
        for value in ("pnpm-lock.yaml", "inputs.root", "inputs.filters"):
            self.assertIn(value, cache["with"]["key"])
        install = next(
            step
            for step in steps
            if step.get("name") == "Install the locked workspace selection"
        )
        self.assertEqual(install["working-directory"], "${{ inputs.root }}")
        self.assertIn("--filter @ziyixi/personal-cloud", install["run"])
        self.assertIn('pnpm "${args[@]}" install --frozen-lockfile', install["run"])
        self.assertIn("--ignore-scripts", install["run"])
        self.assertNotIn("ensure.mjs", str(steps))
        self.assertNotIn("uv python install", str(steps))

    def test_all_check_installers_use_the_workspace_and_root_uv_lock(self):
        for path in (ROOT / ".github/actions").glob("*/action.yml"):
            with self.subTest(action=path.parent.name):
                self.assertNotIn("npm ci", path.read_text())
        for path in (ROOT / ".github/actions").glob("check-*/action.yml"):
            action = workflow_data(path)
            steps = action["runs"]["steps"]
            with self.subTest(action=path.parent.name):
                if any(
                    "npm " in step.get("run", "")
                    or "npx " in step.get("run", "")
                    or "pnpm " in step.get("run", "")
                    for step in steps
                ):
                    install = next(
                        step
                        for step in steps
                        if step.get("uses") == "./.github/actions/setup-workspace"
                    )
                    self.assertEqual(install["with"]["root"], ".")
                for step in steps:
                    if step.get("uses", "").startswith("astral-sh/setup-uv@"):
                        self.assertEqual(step["with"]["working-directory"], ".")
                        self.assertIn(
                            "uv.lock",
                            step["with"]["cache-dependency-glob"].splitlines(),
                        )
