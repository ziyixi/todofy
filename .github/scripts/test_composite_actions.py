"""Guard native workflow/composite boundaries independently of the flattened safety view."""

import copy
import re
import tempfile
import tomllib
import unittest
from pathlib import Path

import yaml
from workflow_sources import ROOT, expand_actions, jobs, release_jobs, workflow_data


class CompositeActions(unittest.TestCase):
    def assert_release_boundaries(self, release):
        self.assertEqual(set(release["jobs"]), {"release", "record"})
        job = release["jobs"]["release"]
        self.assertEqual(job["if"], "github.ref == 'refs/heads/main' && !inputs.record_only")
        self.assertEqual(
            job["concurrency"],
            {
                "group": "${{ inputs.app }}-production",
                "cancel-in-progress": "false",
            },
        )
        self.assertEqual(
            job["timeout-minutes"], "${{ inputs.app == 'website-relay' && 10 || 15 }}"
        )
        self.assertEqual(job["environment"]["name"], "production")
        sequence = job["steps"]
        preflight = next(
            i for i, step in enumerate(sequence) if step.get("id") == "preflight"
        )
        record = next(
            i
            for i, step in enumerate(sequence)
            if "control.py record " in step.get("run", "")
        )
        calls = [
            step
            for step in sequence
            if step.get("uses", "").startswith("./.github/actions/release-")
        ]
        apps = {
            path.parent.name.removeprefix("release-")
            for path in (ROOT / ".github/actions").glob("release-*/action.yml")
        }
        self.assertEqual(len(calls), len(apps))
        for app in apps:
            call = next(
                step
                for step in calls
                if step["uses"] == f"./.github/actions/release-{app}"
            )
            self.assertEqual(
                call["if"],
                f"inputs.app == '{app}' && steps.preflight.outputs.required == 'true'",
            )
            self.assertEqual(
                call["with"]["required"], "${{ steps.preflight.outputs.required }}"
            )
            self.assertLess(preflight, sequence.index(call))
            self.assertLess(sequence.index(call), record)
        self.assertNotIn(
            "secrets.",
            str({key: value for key, value in job.items() if key != "steps"}),
        )
        self.assertNotIn("continue-on-error", job)
        for step in sequence:
            self.assertNotIn("continue-on-error", step)
        self.assertNotIn("always()", sequence[record]["if"])

    def test_worker_calls_expand_one_release_job_not_all_apps(self):
        self.assert_release_boundaries(
            workflow_data(ROOT / ".github/workflows/worker-release.yml")
        )

    def test_release_guards_accept_layout_changes_and_reject_changed_locks_or_gates(
        self,
    ):
        release = workflow_data(ROOT / ".github/workflows/worker-release.yml")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "release.yml"
            for style in ("'", '"'):
                path.write_text(
                    yaml.safe_dump(
                        release, indent=4, sort_keys=True, default_style=style
                    )
                )
                self.assert_release_boundaries(workflow_data(path))
        for field, value in (
            ("if", "always()"),
            ("concurrency", {"group": "unrelated", "cancel-in-progress": "false"}),
            (
                "concurrency",
                {"group": "${{ inputs.app }}-production", "cancel-in-progress": "true"},
            ),
        ):
            changed = copy.deepcopy(release)
            changed["jobs"]["release"][field] = value
            with (
                self.subTest(field=field, value=value),
                self.assertRaises(AssertionError),
            ):
                self.assert_release_boundaries(changed)

    def test_local_actions_have_explicit_context_shell_and_directory(self):
        for path in (ROOT / ".github/actions").glob("*/action.yml"):
            with self.subTest(action=path.parent.name):
                action = workflow_data(path)
                self.assertEqual(action["runs"]["using"], "composite")
                expressions = " ".join(
                    re.findall(r"\$\{\{(.*?)\}\}", path.read_text(), re.DOTALL)
                )
                self.assertNotRegex(
                    expressions, r"\b(secrets|needs|matrix|strategy|vars)[.\[]"
                )
                referenced = set(re.findall(r"\binputs\.([a-z0-9-]+)", str(action)))
                self.assertLessEqual(referenced, set(action.get("inputs", {})))
                for step in action["runs"]["steps"]:
                    self.assertNotIn("timeout-minutes", step)
                    if "run" in step:
                        self.assertEqual(step["shell"], "bash -e {0}")
                        self.assertTrue(step["working-directory"])
                    if "uses" in step:
                        if step["uses"].startswith("./"):
                            self.assertIn(step["uses"], {
                                "./.github/actions/setup-workspace", "./.github/actions/setup-bazel",
                                "./.github/actions/worker-prepare", "./.github/actions/worker-deploy",
                            })
                            installer = workflow_data(ROOT / step["uses"] / "action.yml")
                            self.assertEqual(set(step.get("with", {})), set(installer.get("inputs", {})))
                        else:
                            self.assertRegex(step["uses"], r"^[\w./-]+@[0-9a-f]{40}$")
                    self.assertNotEqual(
                        step.get("with", {}).get("persist-credentials"), "true"
                    )

    def test_every_call_supplies_exact_declared_inputs(self):
        for filename in ("ci.yml", "worker-release.yml"):
            for job in workflow_data(ROOT / ".github/workflows" / filename)[
                "jobs"
            ].values():
                for step in job.get("steps", []):
                    action_path = step.get("uses", "")
                    if not action_path.startswith("./.github/actions/"):
                        continue
                    action = workflow_data(ROOT / action_path / "action.yml")
                    self.assertEqual(
                        set(step.get("with", {})),
                        set(action.get("inputs", {})),
                        action_path,
                    )

    def test_release_switches_inherit_the_resolved_workflow_environment(self):
        job = workflow_data(ROOT / ".github/workflows/worker-release.yml")["jobs"][
            "release"
        ]
        # Only Mailsort's job gets its production mode.
        self.assertEqual(
            job["env"]["MAILSORT_MODE"],
            "${{ inputs.app == 'mailsort' && vars.MAILSORT_MODE || '' }}",
        )
        switches = {
            "todofy": ("TODOFY_MAINTENANCE_MODE", "TODOFY_PROCESSING_PAUSED"),
            "dashboard": ("DASHBOARD_CANARY_ENABLED",),
            "mail-hero": (
                "MAIL_HERO_FORCE_SEND_PAUSED", "MAIL_HERO_MAINTENANCE_MODE",
                "MAIL_HERO_NATIVE_BACKUP_ENABLED",
            ),
            "model-router": ("MODEL_ROUTER_MAINTENANCE_MODE",),
            "mailsort": ("MAILSORT_MODE",),
        }
        recipes = release_jobs()
        for app, names in switches.items():
            call = next(
                step for step in job["steps"]
                if step.get("uses") == f"./.github/actions/release-{app}"
            )
            # vars is a workflow context; a composite, and the shared actions it calls, inherit the job's resolved
            # environment, so every step of the flattened recipe sees the switch and none may replace it.
            recipe = yaml.load("steps:\n" + recipes[app + "-deploy"].split("    steps:\n", 1)[1],
                               Loader=yaml.BaseLoader)["steps"]
            for name in names:
                with self.subTest(app=app, switch=name):
                    self.assertIn(f"vars.{name}", job["env"][name])
                    self.assertNotIn(name, call.get("env", {}))
                    for step in recipe:
                        self.assertNotIn(name, step.get("env", {}))

    def test_standard_worker_releases_pass_literal_differences_that_match_their_configs(self):
        """The release actions that call worker-deploy pass each app's differences as literals: the shared steps
        substitute them into their scripts, so no secret or runtime value may reach one. Each matches the app's files."""
        literal = {"app", "worker", "worker-directory", "tools-directory", "bundle-size", "d1", "assets",
                   "production", "access-paths"}
        shared = workflow_data(ROOT / ".github/actions/worker-deploy/action.yml")
        self.assertEqual(set(shared["inputs"]), literal | {"cf-api-token", "host", "access-issuer"})
        for step in shared["runs"]["steps"]:
            for name in ("cf-api-token", "host", "access-issuer"):
                self.assertNotIn("inputs." + name, step.get("run", "") + step.get("working-directory", ""))
        found = {}
        for path in sorted((ROOT / ".github/actions").glob("release-*/action.yml")):
            for step in workflow_data(path)["runs"]["steps"]:
                if step.get("uses") == "./.github/actions/worker-prepare":
                    self.assertEqual(step["with"]["app"], path.parent.name.removeprefix("release-"))
                if step.get("uses") != "./.github/actions/worker-deploy":
                    continue
                values = step["with"]
                app = values["app"]
                found[app] = values
                with self.subTest(app=app):
                    self.assertEqual(path.parent.name, "release-" + app)
                    for name in literal:
                        self.assertNotIn("${{", values[name])
                    for name in ("bundle-size", "d1", "assets", "production"):
                        self.assertIn(values[name], {"true", "false"})
                    config = tomllib.loads((ROOT / app / "wrangler.toml").read_text())
                    tools = ROOT / app / values["tools-directory"]
                    self.assertEqual(values["worker"], config["name"])
                    self.assertTrue((ROOT / app / values["worker-directory"]).is_dir())
                    self.assertTrue((tools / "deploy-vars.mjs").is_file())
                    self.assertEqual(values["bundle-size"] == "true", (tools / "bundle-size.mjs").is_file())
                    self.assertEqual(values["d1"] == "true", bool(config.get("d1_databases")))
                    self.assertEqual(values["assets"] == "true", "assets" in config)
                    self.assertTrue(values["cf-api-token"].startswith("${{ inputs."))
                    self.assertEqual(values["host"], "${{ steps.config.outputs.host }}")
                    self.assertEqual(values["access-issuer"], "${{ steps.config.outputs.access_issuer }}")
        # Todofy's two Workers and the website relay keep their own recipes.
        self.assertEqual(set(found), {path.parent.name.removeprefix("release-")
                                      for path in (ROOT / ".github/actions").glob("release-*/action.yml")}
                         - {"todofy", "website-relay"})
        # Home is the one without a production-version step, Personal MCP the one with its own Access check.
        self.assertEqual({app for app, values in found.items() if values["production"] != "true"}, {"dashboard"})
        self.assertEqual({app for app, values in found.items() if not values["access-paths"]}, {"personal-mcp"})

    def test_home_checks_the_private_registration_it_deploys_before_the_deploy(self):
        """A registration Home's parser refuses fails the release, not Home's API: the step runs the bundle the archive
        carries on the secrets file every wrangler command reads, after that file is written and before the first."""
        recipe = yaml.load("steps:\n" + release_jobs()["dashboard-deploy"].split("    steps:\n", 1)[1],
                           Loader=yaml.BaseLoader)["steps"]
        runs = [step.get("run", "") for step in recipe]
        written = runs.index('node ../deploy/deploy-vars.mjs secrets "$RUNNER_TEMP/home-secrets.json"')
        check = runs.index('node ../.compiled/tools/private-catalog.mjs "$RUNNER_TEMP/home-secrets.json" "$PRIVATE_CATALOG_FILE"')
        wrangler = [index for index, run in enumerate(runs) if "wrangler " in run]
        self.assertLess(written, check)
        self.assertLess(check, wrangler[0])
        for index in wrangler:
            self.assertIn('--secrets-file "$RUNNER_TEMP/home-secrets.json"', runs[index])
        for index in (written, check):
            self.assertEqual(recipe[index]["working-directory"], ".release-source/dashboard/worker")
        self.assertEqual(recipe[check]["env"], {"PRIVATE_CATALOG_FILE": "${{ runner.temp }}/private-catalog.json"})
        self.assertEqual(recipe[check]["if"], "steps.preflight.outputs.required == 'true'")
        # The archive stages its tools beside the compiled Worker (.compiled/tools/, tools/bazel/cloudflare.bzl).
        build = (ROOT / "dashboard/BUILD.bazel").read_text()
        self.assertIn('tools = [":private_catalog_cli"]', build)
        self.assertIn('outs = ["tools/private-catalog.mjs"]', build)

    def test_each_worker_release_declares_every_action_it_runs(self):
        """A change to a shared action selects every release that runs it: each release-<app> action and the local
        actions it calls are inputs of that app's tagged release target."""
        shared = (ROOT / "tools/cloud-release/BUILD.bazel").read_text().split('name = "release_inputs"', 1)[1]
        shared = shared.split("\n)\n", 1)[0]
        builds = [path.read_text() for path in ROOT.glob("*/BUILD.bazel")]
        for path in (ROOT / ".github/actions").glob("release-*/action.yml"):
            app = path.parent.name.removeprefix("release-")
            build = next(text for text in builds if f'"release:worker:{app}"' in text)
            pending, used = [path.parent.name], set()
            while pending:
                name = pending.pop()
                used.add(name)
                for step in workflow_data(ROOT / ".github/actions" / name / "action.yml")["runs"]["steps"]:
                    if step.get("uses", "").startswith("./.github/actions/"):
                        pending.append(step["uses"].removeprefix("./.github/actions/"))
            for name in used:
                with self.subTest(app=app, action=name):
                    label = f'"//.github/actions:{name}/action.yml"'
                    self.assertTrue(label in build or label in shared)

    def test_the_reader_selects_shared_steps_by_literal_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            action = root / ".github/actions/example/action.yml"
            action.parent.mkdir(parents=True)
            action.write_text(
                "runs:\n  using: composite\n  steps:\n"
                "    - name: On\n      if: inputs.flag == 'true'\n      run: echo on\n"
                "    - name: Off\n      if: inputs.flag != 'true' && inputs.paths != ''\n      run: echo off ${{ inputs.paths }}\n"
                "    - name: Always\n      if: always()\n      run: echo always\n"
            )
            call = ("    steps:\n      - name: Example\n        if: steps.gate.outputs.ok == 'true'\n"
                    "        uses: ./.github/actions/example\n        with:\n          flag: 'true'\n          paths: ''\n")
            expanded = expand_actions(call, root)
            self.assertIn("run: echo on", expanded)
            self.assertNotIn("echo off", expanded)
            self.assertIn("if: steps.gate.outputs.ok == 'true'\n        run: echo on", expanded)
            self.assertIn("if: always()\n        run: echo always", expanded)
            expanded = expand_actions(call.replace("'true'\n          paths: ''", "'false'\n          paths: /a /b"), root)
            self.assertNotIn("echo on", expanded)
            self.assertIn("run: echo off /a /b", expanded)
            with self.assertRaisesRegex(ValueError, "Unresolved action input"):
                expand_actions(call.replace("          paths: ''\n", ""), root)

    def test_image_publication_uses_the_checked_artifact_run(self):
        ci = workflow_data(ROOT / ".github/workflows/ci.yml")["jobs"]
        for job_name, service in (("newsletter-deploy", "newsletter"), ("platform-image", "platform"),
                                  ("codex-gateway-image", "codex-gateway")):
            job = ci[job_name]
            self.assertEqual(job["outputs"]["image"], "${{ steps.publish.outputs.image }}")
            publish = next(step for step in job["steps"] if step.get("id") == "publish")
            self.assertEqual(publish["uses"], "./.github/actions/publish-image")
            self.assertEqual(publish["with"]["service"], service)
            self.assertEqual(publish["with"]["artifact-run-id"], "${{ needs.changes.outputs.artifact_run_id || github.run_id }}")
            # The tested artifact of this service, published by the image tool's choice of the same name.
            block = expand_actions(jobs((ROOT / ".github/workflows/ci.yml").read_text())[job_name])
            self.assertIn(f"name: {service}-image-${{{{ github.sha }}}}", block)
            self.assertIn(f"IMAGE_SERVICE: {service}", block)
        image = (ROOT / "tools/container-release/image.py").read_text()
        self.assertIn('choices=("newsletter", "platform", "codex-gateway")', image)


    def test_worker_smokes_declare_the_built_ui_and_run_in_workerd_group(self):
        for app in ("recall", "mailsort"):
            build = (ROOT / app / "worker/BUILD.bazel").read_text()
            self.assertIn('name = "smoke_test"', build)
            self.assertIn(f'"//{app}/web:bundle"', build)
            self.assertIn('"workerd"', build)


    def test_reader_follows_real_action_commands_and_refuses_missing_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            action = root / ".github/actions/example/action.yml"
            action.parent.mkdir(parents=True)
            action.write_text(
                "runs:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.value }}\n"
            )
            call = "    steps:\n      - name: Example\n        uses: ./.github/actions/example\n        with:\n          value: hello\n"
            self.assertIn("run: echo hello", expand_actions(call, root))
            action.write_text(action.read_text().replace("echo", "printf"))
            self.assertIn("run: printf hello", expand_actions(call, root))
            with self.assertRaisesRegex(ValueError, "Unresolved action input"):
                expand_actions(call.replace("          value: hello\n", ""), root)


if __name__ == "__main__":
    unittest.main()
