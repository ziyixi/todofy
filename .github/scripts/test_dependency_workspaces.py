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


def reader(before=None):
    """The repository's files as they are now (after the diff); ``before`` maps a path to its earlier text."""
    before = before or {}

    def read(path):
        after = (ROOT / path).read_text()
        return before.get(path, after), after

    return read


def older(name, path="pnpm-workspace.yaml", pattern=r'^(  "?{}"?: ).+$', version=r'\g<1>"0.0.1"'):
    """A root manifest whose (first) entry for ``name`` named an older version."""
    text, count = re.subn(pattern.format(re.escape(name)), version, (ROOT / path).read_text(), count=1, flags=re.M)
    assert count == 1, name
    return text


def deployed(result):
    return {app for app in ci_changes.APPS if result[f"{ci_changes.PREFIX[app]}_deploy"]}


def checked(result):
    return {app for app in ci_changes.APPS if result[f"{ci_changes.PREFIX[app]}_check"]}


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
        self.assertEqual(setup_node["with"], {"node-version-file": "${{ inputs.root }}/package.json"})
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
        for path in (ROOT / ".github/actions").glob("*/action.yml"):
            with self.subTest(action=path.parent.name):
                self.assertNotIn("npm ci", path.read_text())
        for path in (ROOT / ".github/actions").glob("check-*/action.yml"):
            action = workflow_data(path)
            steps = action["runs"]["steps"]
            with self.subTest(action=path.parent.name):
                if any("npm " in step.get("run", "") or "npx " in step.get("run", "") or "pnpm " in step.get("run", "") for step in steps):
                    install = next(step for step in steps if step.get("uses") == "./.github/actions/setup-workspace")
                    self.assertEqual(install["with"]["root"], ".")
                for step in steps:
                    if step.get("uses", "").startswith("astral-sh/setup-uv@"):
                        self.assertEqual(step["with"]["working-directory"], ".")
                        self.assertIn("uv.lock", step["with"]["cache-dependency-glob"].splitlines())

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

    def test_a_catalog_bump_deploys_only_the_members_that_list_it(self):
        workspace = yaml.safe_load((ROOT / "pnpm-workspace.yaml").read_text())
        generator = set(json.loads((ROOT / "proto/package.json").read_text())["dependencies"])
        vps = {"newsletter", "platform", "codex-gateway"}
        for name in workspace["catalog"]:
            with self.subTest(name=name):
                result = ci_changes.classify(["pnpm-workspace.yaml", "pnpm-lock.yaml"], reader({"pnpm-workspace.yaml": older(name)}))
                self.assertEqual(checked(result), set(ci_changes.PROTO_USERS))
                self.assertTrue(result["packages"] and result["proto"])
                self.assertFalse(result["infra"])
                # Only the proto generator's dependencies reach the Python proto package and so the VPS images; the
                # Router client's package.json reaches its Worker users, not Newsletter's Python half.
                self.assertEqual(deployed(result) & vps, vps if name in generator else set())
        bump = lambda name: ci_changes.classify(["pnpm-workspace.yaml", "pnpm-lock.yaml"], reader({"pnpm-workspace.yaml": older(name)}))
        self.assertEqual(deployed(bump("postal-mime")), {"mail-hero"})
        self.assertEqual(deployed(bump("vitest")), set(ci_changes.PROTO_USERS) - {"newsletter", "platform", "codex-gateway"})
        self.assertEqual(deployed(bump("react-router")), {"mail-hero", "todofy"})
        self.assertEqual(deployed(bump("chrono-node")), set(ci_changes.PACKAGE_USERS["task-dates"]))
        site = bump("next")
        self.assertEqual(deployed(site), {"website"})
        self.assertFalse(site["website_relay_deploy"])
        extension = bump("@types/chrome")
        self.assertEqual(deployed(extension), {"recall"})
        self.assertTrue(extension["recall_extension_publish"])

    def test_other_root_node_changes_and_a_lone_lock_deploy_every_member(self):
        workspace = (ROOT / "pnpm-workspace.yaml").read_text()
        for paths, before in (
            (["pnpm-workspace.yaml"], {"pnpm-workspace.yaml": workspace.replace("strictPeerDependencies: true", "strictPeerDependencies: false")}),
            (["pnpm-workspace.yaml", "pnpm-lock.yaml"], {"pnpm-workspace.yaml": workspace.replace('  - "website"\n', "")}),
            (["pnpm-lock.yaml"], {}),
            (["package.json", "pnpm-workspace.yaml"], {"pnpm-workspace.yaml": older("react")}),
        ):
            with self.subTest(paths=paths):
                result = ci_changes.classify(paths, reader(before))
                self.assertEqual(deployed(result), set(ci_changes.APPS))
                self.assertTrue(result["website_relay_deploy"] and result["recall_extension_publish"])
        # A lock beside a member manifest reaches what that manifest reaches; a comment reaches nothing.
        self.assertEqual(deployed(ci_changes.classify(["pnpm-lock.yaml", "mail-hero/web/package.json"], reader())), {"mail-hero"})
        commented = {"pnpm-workspace.yaml": workspace.replace("catalog:\n", "# Shared versions.\ncatalog:\n")}
        self.assertEqual(deployed(ci_changes.classify(["pnpm-workspace.yaml"], reader(commented))), set())

    def test_a_retired_members_removal_reaches_no_remaining_member(self):
        """An app's retirement drops its members from pnpm-workspace.yaml and their importers from the lock in the
        diff that deletes their directories: nothing else resolves differently, so no other member is reached and no
        VPS image is published. Anything more, or a member that still exists, keeps reaching every member."""
        workspace = (ROOT / "pnpm-workspace.yaml").read_text()
        lock = (ROOT / "pnpm-lock.yaml").read_text()
        retired = "  - \"gone/web\"\n"
        importer = "  gone/web:\n    devDependencies:\n      vitest:\n        specifier: 'catalog:'\n        version: 4.0.0\n\n"
        before_workspace = workspace.replace("packages:\n", "packages:\n" + retired, 1)
        before_lock = lock.replace("importers:\n\n", "importers:\n\n" + importer, 1)
        self.assertNotEqual(before_lock, lock)

        def read_retired(lock_before=before_lock, workspace_before=before_workspace, exists=False):
            def read(path):
                if path == "gone/web/package.json":
                    if exists:
                        return "{}", "{}"
                    raise ValueError(path)
                after = (ROOT / path).read_text()
                return {"pnpm-workspace.yaml": workspace_before, "pnpm-lock.yaml": lock_before}.get(path, after), after
            return read

        paths = ["pnpm-workspace.yaml", "pnpm-lock.yaml", "gone/web/package.json"]
        result = ci_changes.classify(paths, read_retired())
        self.assertEqual(deployed(result), set())
        self.assertEqual(checked(result), set(ci_changes.PROTO_USERS))
        self.assertFalse(result["platform_publish"] or result["website_relay_deploy"] or result["recall_extension_publish"])
        # A changed remaining importer, a changed package, another workspace change, a lock left alone or a directory
        # that still exists reach every member as before.
        changed_importer = before_lock.replace("  .: {}\n", "  .:\n    dependencies: {}\n", 1)
        self.assertNotEqual(changed_importer, before_lock)
        for read, changed in (
            (read_retired(lock_before=changed_importer), paths),
            (read_retired(workspace_before=before_workspace.replace("strictPeerDependencies: true", "strictPeerDependencies: false")), paths),
            (read_retired(exists=True), paths),
            (read_retired(), ["pnpm-workspace.yaml", "gone/web/package.json"]),
            (read_retired(), ["pnpm-workspace.yaml", "pnpm-lock.yaml"]),
        ):
            with self.subTest(paths=changed):
                self.assertEqual(deployed(ci_changes.classify(changed, read)), set(ci_changes.APPS))
        added = lock.replace("packages:\n\n", "packages:\n\n  new-only@1.0.0:\n    resolution: {integrity: sha512-x}\n\n", 1)
        self.assertNotEqual(added, lock)

        def read_added(path):
            if path == "gone/web/package.json":
                raise ValueError(path)
            after = added if path == "pnpm-lock.yaml" else (ROOT / path).read_text()
            return {"pnpm-workspace.yaml": before_workspace, "pnpm-lock.yaml": before_lock}.get(path, after), after

        self.assertEqual(deployed(ci_changes.classify(paths, read_added)), set(ci_changes.APPS))

    def test_a_root_constraint_deploys_only_the_python_members_that_declare_it(self):
        pin = r'^(  "{}==).+(",)$'
        bump = lambda name: ci_changes.classify(["pyproject.toml", "uv.lock"], reader({"pyproject.toml": older(name, "pyproject.toml", pin, r"\g<1>0.0.1\g<2>")}))
        for name, expected in (
            ("openai-codex", {"codex-gateway"}),
            ("jsonschema", {"codex-gateway", "todofy"}),
            # Newsletter and Platform release as a pair.
            ("kubernetes", {"newsletter", "platform"}),
        ):
            with self.subTest(name=name):
                result = bump(name)
                self.assertEqual(deployed(result), expected)
                self.assertEqual(checked(result), ci_changes.PYTHON_WORKSPACE_APPS)
        project = (ROOT / "pyproject.toml").read_text()
        transitive = project.replace('  "cryptography==', '  "transitive-only==1.0",\n  "cryptography==')
        for paths, before in (
            (["pyproject.toml", "uv.lock"], {"pyproject.toml": transitive}),
            (["pyproject.toml"], {"pyproject.toml": project.replace('required-version = "==', 'required-version = ">=')}),
            (["uv.lock"], {}),
        ):
            with self.subTest(paths=paths):
                self.assertEqual(deployed(ci_changes.classify(paths, reader(before))), ci_changes.PYTHON_WORKSPACE_APPS)
        self.assertEqual(deployed(ci_changes.classify(["uv.lock", "todofy/pyproject.toml"], reader())), {"todofy"})

    def test_the_diff_reads_root_manifests_at_both_ends(self):
        base, after = "b" * 40, "a" * 40
        texts = {base: older("postal-mime")}

        def show(revision, path):
            if path == "pnpm-workspace.yaml" and revision in texts:
                return texts[revision]
            return (ROOT / path).read_text()

        result, _, _ = ci_changes.decide("push", ci_changes.MAIN, after, "", base, lambda b, a: ["pnpm-workspace.yaml", "pnpm-lock.yaml"],
                                         lambda b, a: True, lambda a: base, show=show)
        self.assertEqual(deployed(result), {"mail-hero"})

        def missing(revision, path):
            raise ValueError(path)

        result, _, _ = ci_changes.decide("push", ci_changes.MAIN, after, "", base, lambda b, a: ["pnpm-workspace.yaml"],
                                         lambda b, a: True, lambda a: base, show=missing)
        self.assertEqual(deployed(result), set(ci_changes.APPS))

    def test_website_code_identity_tracks_its_shared_inputs_and_ignores_other_apps(self):
        # Execute the production CLI's git query against real history, without running release side effects.
        source = (ROOT / "website/scripts/release/cli.ts").read_text()
        command = source.split('async "code-sha"() {', 1)[1].split("async gate()", 1)[0]
        arguments = re.search(r'execFileAsync\(\s*"git",\s*(\[[^\]]*\])', command).group(1)
        args = json.loads(re.sub(r",(\s*])", r"\1", arguments))
        # Only other apps' proto packages are left out, never one the website's bundles import.
        excluded = tuple(arg.removeprefix(":(exclude)../") + "/" for arg in args if arg.startswith(":(exclude)"))
        self.assertTrue(excluded)
        for prefix, importers in ci_changes.PROTO_PACKAGES.items():
            if prefix.startswith(excluded):
                self.assertNotIn("website", importers, prefix)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "website").mkdir()
            def git(*arguments):
                return subprocess.check_output(["git", *arguments], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
            git("init", "--quiet")
            git("config", "user.name", "Workspace test")
            git("config", "user.email", "fixture@example.invalid")
            for path in ("website/source.ts", "proto/source.proto", "proto/ops/v1/ops.proto", "proto/shared/v1/new.proto",
                         "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".python-version"):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(path)
                git("add", path)
                git("commit", "--quiet", "-m", "Change " + path)
                selected = subprocess.check_output(["git", *args], cwd=root / "website", text=True).strip()
                self.assertEqual(selected, git("rev-parse", "HEAD"), path)
            for path in ("unrelated.txt", "proto/tasks/ui/v1/tasks.proto", "proto/modelrouter/inference/v1/inference.proto"):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("Other app input")
                git("add", path)
                git("commit", "--quiet", "-m", "Other app")
                self.assertEqual(subprocess.check_output(["git", *args], cwd=root / "website", text=True).strip(), selected, path)


if __name__ == "__main__":
    unittest.main()
