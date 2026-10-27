"""Root workspaces own dependency versions, installation and release reachability."""

import json
import re
import subprocess
import tempfile
import tomllib
import unittest
from collections import defaultdict
from pathlib import Path

import yaml

import ci_changes
from workflow_sources import workflow_data

ROOT = Path(__file__).resolve().parents[2]


def tracked_names():
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode().split("\0")
    return sorted({name for name in names if name and (ROOT / name).is_file()})


class DependencyWorkspaces(unittest.TestCase):
    def test_all_node_members_use_the_root_catalog_and_workspace_links(self):
        names = tracked_names()
        manifests = {name: json.loads((ROOT / name).read_text()) for name in names if Path(name).name == "package.json"}
        workspace = yaml.safe_load((ROOT / "pnpm-workspace.yaml").read_text())
        members = {str(Path(name).parent) for name in manifests} - {"."}
        self.assertEqual(set(workspace["packages"]), members)
        self.assertEqual(manifests["package.json"]["packageManager"], "pnpm@11.25.0")
        self.assertEqual(manifests["package.json"]["engines"]["node"], "26.x")
        package_names = {data["name"] for data in manifests.values()}
        for name, data in manifests.items():
            for group in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
                for dependency, spec in data.get(group, {}).items():
                    with self.subTest(manifest=name, dependency=dependency):
                        self.assertEqual(spec, "workspace:*" if dependency in package_names else "catalog:")
                        if spec == "catalog:":
                            self.assertRegex(workspace["catalog"][dependency], r"^\d+\.\d+\.\d+(?:-[\w.-]+)?$")
        lock = yaml.safe_load((ROOT / "pnpm-lock.yaml").read_text())
        self.assertEqual(set(lock["importers"]), members | {"."})
        self.assertEqual([name for name in names if Path(name).name in {"package-lock.json", "pnpm-lock.yaml"}], ["pnpm-lock.yaml"])

    def test_python_members_share_the_root_lock_and_version_constraints(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        uv = project["tool"]["uv"]
        names = tracked_names()
        projects = {name for name in names if Path(name).name == "pyproject.toml"}
        self.assertEqual(projects - {"pyproject.toml"}, {member + "/pyproject.toml" for member in uv["workspace"]["members"]})
        self.assertEqual(ci_changes.PYTHON_WORKSPACE_APPS, {member for member in uv["workspace"]["members"] if member in ci_changes.APPS})
        self.assertEqual([name for name in names if Path(name).name == "uv.lock"], ["uv.lock"])
        self.assertEqual([name for name in names if Path(name).name == ".python-version"], [".python-version"])
        self.assertRegex((ROOT / ".python-version").read_text().strip(), r"^3\.14\.\d+$")
        pins = {pin.split("==", 1)[0].lower().replace("_", "-") for pin in uv["constraint-dependencies"]}
        sources = {name.lower().replace("_", "-") for name in uv["sources"]}
        for member in uv["workspace"]["members"]:
            data = tomllib.loads((ROOT / member / "pyproject.toml").read_text())
            self.assertTrue(data["project"]["requires-python"].startswith(">=3.14"), member)
            dependencies = [*data["project"]["dependencies"]]
            for extra in data["project"].get("optional-dependencies", {}).values():
                dependencies.extend(extra)
            for group in data.get("dependency-groups", {}).values():
                dependencies.extend(dependency for dependency in group if isinstance(dependency, str))
            for dependency in dependencies:
                with self.subTest(member=member, dependency=dependency):
                    self.assertRegex(dependency, r"^[\w-]+(?:\[[\w,-]+\])?$")
                    name = dependency.split("[", 1)[0].lower().replace("_", "-")
                    self.assertTrue(name in sources or name in pins)
        versions = defaultdict(set)
        for package in tomllib.loads((ROOT / "uv.lock").read_text())["package"]:
            versions[package["name"]].add(package["version"])
        self.assertFalse({name: values for name, values in versions.items() if len(values) != 1})

    def test_the_node_installer_uses_one_frozen_lock_and_selection_specific_cache(self):
        path = ROOT / ".github/actions/setup-workspace/action.yml"
        action = workflow_data(path)
        steps = action["runs"]["steps"]
        setup_node = next(step for step in steps if step.get("uses", "").startswith("actions/setup-node@"))
        self.assertEqual(setup_node["with"]["node-version"], "26")
        setup_pnpm = next(step for step in steps if step.get("uses", "").startswith("pnpm/action-setup@"))
        self.assertEqual(setup_pnpm["with"]["package_json_file"], "${{ inputs.root }}/package.json")
        cache = next(step for step in steps if step.get("uses", "").startswith("actions/cache@"))
        for value in ("pnpm-lock.yaml", "inputs.root", "inputs.filters"):
            self.assertIn(value, cache["with"]["key"])
        install = next(step for step in steps if step.get("name") == "Install the locked workspace selection")
        self.assertEqual(install["working-directory"], "${{ inputs.root }}")
        self.assertIn("--filter @ziyixi/personal-cloud --filter @ziyixi/proto-toolchain", install["run"])
        self.assertIn('pnpm "${args[@]}" install --frozen-lockfile', install["run"])
        setup_uv = next(step for step in steps if step.get("uses", "").startswith("astral-sh/setup-uv@"))
        self.assertEqual(setup_uv["with"]["working-directory"], "${{ inputs.root }}")
        self.assertEqual(setup_uv["with"]["cache-dependency-glob"], ".python-version")
        python = next(step for step in steps if step.get("run") == "uv python install")
        self.assertEqual(python["working-directory"], "${{ inputs.root }}")
        self.assertLess(steps.index(setup_uv), steps.index(python))
        self.assertLess(steps.index(python), steps.index(install))

    def test_all_check_installers_use_the_workspace_and_root_uv_lock(self):
        for path in (ROOT / ".github/actions").glob("check-*/action.yml"):
            action = workflow_data(path)
            steps = action["runs"]["steps"]
            with self.subTest(action=path.parent.name):
                self.assertNotIn("npm ci", path.read_text())
                if any("npm " in step.get("run", "") or "npx " in step.get("run", "") or "pnpm " in step.get("run", "") for step in steps):
                    install = next(step for step in steps if step.get("uses") == "./.github/actions/setup-workspace")
                    self.assertEqual(install["with"]["root"], ".")
                for step in steps:
                    if step.get("uses", "").startswith("astral-sh/setup-uv@"):
                        self.assertEqual(step["with"]["working-directory"], ".")
                        self.assertIn("uv.lock", step["with"]["cache-dependency-glob"].splitlines())

    def test_old_release_installs_only_run_for_sources_without_a_root_lock(self):
        required = "inputs.required == 'true'"
        modern = required + " && hashFiles('.release-source/pnpm-lock.yaml') != ''"
        legacy = required + " && hashFiles('.release-source/pnpm-lock.yaml') == ''"
        for path in (ROOT / ".github/actions").glob("release-*/action.yml"):
            with self.subTest(action=path.parent.name):
                steps = workflow_data(path)["runs"]["steps"]
                workspace = next(step for step in steps if step.get("uses") == "./.github/actions/setup-workspace")
                self.assertEqual(workspace["if"], modern)
                self.assertEqual(workspace["with"]["root"], ".release-source")
                for step in steps:
                    if step.get("uses", "").startswith("actions/setup-node@"):
                        self.assertEqual(step["if"], legacy)
                    script = step.get("run", "")
                    if "npm ci" in script or "pnpm install" in script:
                        if step["if"] != legacy:
                            self.assertEqual(step["if"], required)
                            self.assertIn('if [ ! -f "$GITHUB_WORKSPACE/.release-source/pnpm-lock.yaml" ]; then', script)

    def test_root_node_inputs_reach_all_members_and_generated_python_consumers(self):
        for path in ci_changes.NODE_WORKSPACE_INPUTS:
            with self.subTest(path=path):
                result = ci_changes.classify([path])
                self.assertTrue(all(result[f"{app.replace('-', '_')}_check"] for app in ci_changes.APPS))
                self.assertTrue(all(result[f"{app.replace('-', '_')}_deploy"] for app in ci_changes.APPS))
                for key in ("packages", "contracts", "proto", "platform_publish", "website_relay_deploy", "recall_extension_publish"):
                    self.assertTrue(result[key], key)
                self.assertFalse(result["infra"])

    def test_root_python_inputs_reach_all_python_consumers(self):
        for path in ci_changes.PYTHON_WORKSPACE_INPUTS:
            with self.subTest(path=path):
                interpreter = path == ".python-version"
                expected = set(ci_changes.APPS) if interpreter else {"newsletter", "codex-gateway", "platform", "todofy"}
                result = ci_changes.classify([path])
                for app in ci_changes.APPS:
                    self.assertEqual(result[f"{app.replace('-', '_')}_check"], app in expected)
                    self.assertEqual(result[f"{app.replace('-', '_')}_deploy"], app in expected)
                self.assertTrue(result["platform_publish"])
                self.assertTrue(result["proto"])
                self.assertTrue(result["contracts"])
                self.assertEqual(result["packages"], interpreter)
                self.assertEqual(result["website_relay_deploy"], interpreter)
                self.assertEqual(result["recall_extension_publish"], interpreter)

    def test_website_code_identity_tracks_its_shared_inputs_and_ignores_other_apps(self):
        # Execute the production CLI's git query against real history, without running release side effects.
        source = (ROOT / "website/scripts/release/cli.ts").read_text()
        command = source.split('async "code-sha"() {', 1)[1].split("async gate()", 1)[0]
        arguments = re.search(r'execFileAsync\(\s*"git",\s*(\[[^\]]*\])', command).group(1)
        args = json.loads(re.sub(r",(\s*])", r"\1", arguments))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "website").mkdir()
            def git(*arguments):
                return subprocess.check_output(["git", *arguments], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
            git("init", "--quiet")
            git("config", "user.name", "Workspace test")
            git("config", "user.email", "fixture@example.invalid")
            for path in ("website/source.ts", "proto/source.proto", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".python-version"):
                target = root / path
                target.parent.mkdir(exist_ok=True)
                target.write_text(path)
                git("add", path)
                git("commit", "--quiet", "-m", "Change " + path)
                selected = subprocess.check_output(["git", *args], cwd=root / "website", text=True).strip()
                self.assertEqual(selected, git("rev-parse", "HEAD"), path)
            (root / "unrelated.txt").write_text("Other app input")
            git("add", "unrelated.txt")
            git("commit", "--quiet", "-m", "Other app")
            self.assertEqual(subprocess.check_output(["git", *args], cwd=root / "website", text=True).strip(), selected)


if __name__ == "__main__":
    unittest.main()
