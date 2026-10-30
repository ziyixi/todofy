"""Check the actual caller and reusable workflow independently of effective_ci()."""

import re
import subprocess
import sys
import unittest
from pathlib import Path

from workflow_sources import jobs, release_jobs, workflow_data

ROOT = Path(__file__).absolute().parents[2]
APPS = ("todofy", "mail-hero", "dashboard", "links", "watch", "fleet", "mailsort", "recall", "tasks", "personal-mcp", "model-router", "newsletter-console", "website-relay")
REQUIRED = "steps.preflight.outputs.required == 'true'"


def steps(block):
    parts = re.split(r"^      - ", block.split("    steps:\n", 1)[1], flags=re.M)
    return ["      - " + part for part in parts[1:]]


def field(step, name):
    match = re.search(r"^        " + re.escape(name) + r": (.+)$", step, flags=re.M)
    return match.group(1) if match else None


class WorkerReleaseWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.caller_text = (ROOT / ".github/workflows/ci.yml").read_text()
        cls.release_text = (ROOT / ".github/workflows/worker-release.yml").read_text()
        cls.callers = jobs(cls.caller_text)
        cls.releases = release_jobs()
        cls.caller_data = workflow_data(ROOT / ".github/workflows/ci.yml")["jobs"]
        cls.release_data = workflow_data(ROOT / ".github/workflows/worker-release.yml")

    def test_each_app_calls_the_recipe_with_the_checked_sha_and_explicit_gate(self):
        calls = {name for name, job in self.caller_data.items()
                 if job.get("uses") == "./.github/workflows/worker-release.yml"}
        self.assertEqual(calls, {app + "-deploy" for app in APPS})
        self.assertEqual(set(self.releases), calls)
        for app in APPS:
            with self.subTest(app=app):
                caller = self.caller_data[app + "-deploy"]
                self.assertIn("needs.gate.result == 'success'", caller["if"])
                self.assertIn("needs.changes.result == 'success'", caller["if"])
                self.assertIn("github.ref == 'refs/heads/main'", caller["if"])
                self.assertIn("!cancelled()", caller["if"])
                self.assertIn("gate", caller["needs"])
                self.assertEqual(caller["with"]["app"], app)
                self.assertEqual(caller["with"]["source_sha"], "${{ github.sha }}")
                self.assertEqual(caller["secrets"], "inherit")

    def test_the_environment_url_names_every_release_that_reports_one(self):
        # A release whose composite reports a url but is missing here records no environment URL (Tasks' did not).
        recipe = self.release_data["jobs"]["release"]
        named = set(re.findall(r"steps\.([a-z_]+)\.outputs\.url", recipe["environment"]["url"]))
        reporting = {step["id"] for step in recipe["steps"]
                     if step.get("uses", "").startswith("./.github/actions/release-")
                     and "url" in workflow_data(ROOT / step["uses"] / "action.yml").get("outputs", {})}
        self.assertEqual(named, reporting)

    def test_write_permission_is_granted_by_the_real_caller_and_recipe(self):
        permissions = {"contents": "read", "actions": "read", "deployments": "write"}
        self.assertEqual(self.release_data["permissions"], permissions)
        for app in APPS:
            with self.subTest(app=app):
                self.assertEqual(self.caller_data[app + "-deploy"]["permissions"], permissions)

    def test_router_connections_gate_runs_after_publish_even_when_upload_is_not_required(self):
        recipe = self.release_data["jobs"]["release"]["steps"]
        gate = next(step for step in recipe if "check_connections.py" in step.get("run", ""))
        upload = next(step for step in recipe if step.get("uses") == "./.github/actions/release-model-router")
        record = next(step for step in recipe if "control.py record " in step.get("run", ""))
        self.assertEqual(gate["if"], "inputs.app == 'model-router'")
        self.assertEqual(gate["working-directory"], ".release-source")
        self.assertEqual(gate["env"], {"CLOUDFLARE_API_TOKEN": "${{ secrets.CF_API_TOKEN }}"})
        self.assertLess(recipe.index(upload), recipe.index(gate))
        self.assertLess(recipe.index(gate), recipe.index(record))

    def test_source_selection_is_inside_the_app_lock_and_production_environment(self):
        for app in APPS:
            with self.subTest(app=app):
                block = self.releases[app + "-deploy"]
                self.assertIn("github.ref == 'refs/heads/main'", block)
                self.assertRegex(block, r"(?m)^    environment:\n      name: production\n")
                self.assertIn("      group: " + app + "-production\n", block)
                self.assertIn("      cancel-in-progress: false\n", block)
                source = next(step for step in steps(block) if field(step, "id") == "source")
                self.assertIn("RELEASE_SOURCE: ${{ inputs.source_sha }}", source)
                self.assertIn("RELEASE_REPAIR: ${{ inputs.repair }}", source)
                self.assertIn("RELEASE_EXPECTED_MAIN: ${{ inputs.expected_main_sha }}", source)
                self.assertIn('--expected-main-sha "$RELEASE_EXPECTED_MAIN"', source)
                self.assertIn('control.py prepare --app "$RELEASE_APP" --source-sha "$RELEASE_SOURCE"', source)

    def test_builds_and_probes_use_the_selected_checkout(self):
        for app in APPS:
            with self.subTest(app=app):
                block = self.releases[app + "-deploy"]
                recipe = steps(block)
                checkout = next(step for step in recipe if "path: .release-source" in step)
                self.assertIn("ref: ${{ steps.source.outputs.source_sha }}", checkout)
                self.assertIn("persist-credentials: false", checkout)
                self.assertRegex(block, r"(?m)^        working-directory: \.release-source/[^\n]+$")
                preflight = next(step for step in recipe if field(step, "id") == "preflight")
                self.assertIn("RELEASE_SOURCE: ${{ steps.source.outputs.source_sha }}", preflight)
                self.assertIn("--source-root .release-source", preflight)
                self.assertLess(recipe.index(checkout), recipe.index(preflight))
                if app == "todofy":
                    self.assertIn('"$BUILD_SOURCE_SHA"', block)
                elif app == "website-relay":
                    self.assertIn("BUILD_SOURCE_SHA", (ROOT / "website/relay/deploy/deploy-vars.mjs").read_text())
                elif app == "dashboard":
                    self.assertIn('.release-source/tools/deploy-probes/access.sh"', block)
                else:
                    self.assertIn('.release-source/tools/deploy-probes/production.sh"', block)

    def test_static_asset_deploys_repeat_only_an_unopened_upload_session(self):
        """wrangler never retries opening the asset upload session; tools/cloud-release/assets-session-retry.sh
        repeats a deploy that failed there, and only a deploy of a Worker with static assets opens one."""
        helper = 'bash "$GITHUB_WORKSPACE/tools/cloud-release/assets-session-retry.sh" '
        wrapped = 0
        for app in APPS:
            for step in steps(self.releases[app + "-deploy"]):
                directory = field(step, "working-directory")
                for line in step.replace("\\\n", " ").splitlines():
                    deploy = re.search(r"(?<![\w-])wrangler deploy\b.*--config[ =](\S+)", line)
                    if not deploy or "--dry-run" in line:
                        continue
                    config = ROOT / directory.removeprefix(".release-source/") / deploy.group(1)
                    assets = bool(re.search(r"(?m)^\[assets\]", config.read_text()))
                    with self.subTest(app=app, config=deploy.group(1)):
                        self.assertEqual(line.strip().startswith(helper), assets)
                    wrapped += assets
        self.assertGreaterEqual(wrapped, 11)

    def test_check_only_forwards_to_preflight_and_guards_every_following_write(self):
        for app in APPS:
            with self.subTest(app=app):
                recipe = steps(self.releases[app + "-deploy"])
                preflight = next(step for step in recipe if field(step, "id") == "preflight")
                self.assertIn("RELEASE_CHECK_ONLY: ${{ inputs.check_only }}", preflight)
                self.assertIn('if [ "$RELEASE_CHECK_ONLY" = true ]; then args+=(--check-only); fi', preflight)
                for step in recipe[recipe.index(preflight) + 1:]:
                    # Cleanup only removes temporary local secrets; it has no provider write.
                    if re.search(r"(?m)^        run: rm -f ", step):
                        continue
                    # The Router connection gate performs one metadata GET even without an upload.
                    if "run: python3 model-router/tools/check_connections.py" in step:
                        self.assertEqual(app, "model-router")
                        self.assertEqual(field(step, "if"), "inputs.app == 'model-router'")
                        continue
                    self.assertRegex(field(step, "if") or "", "^" + re.escape(REQUIRED) + r"(?: && !?inputs\.repair)?$", step.splitlines()[0])

    def test_success_record_requires_successful_probes_and_uses_the_selected_sha(self):
        for app in APPS:
            with self.subTest(app=app):
                recipe = steps(self.releases[app + "-deploy"])
                records = [step for step in recipe if "control.py record " in step]
                self.assertEqual(len(records), 1)
                record = records[0]
                self.assertEqual(field(record, "if"), REQUIRED)
                self.assertIsNone(field(record, "continue-on-error"))
                self.assertIn("RELEASE_SOURCE: ${{ steps.source.outputs.source_sha }}", record)
                self.assertIn("--source-root .release-source", record)
                probes = [step for step in recipe if "curl " in step or "tools/deploy-probes/" in step]
                if app == "website-relay":
                    # This binding-only Worker has no public liveness route. record() checks provider
                    # identity/settings before persisting the successful deployment receipt.
                    self.assertFalse(probes)
                    control = (ROOT / "tools/cloud-release/control.py").read_text()
                    self.assertIn("item = verify(", control)
                    provider = (ROOT / "tools/cloud-release/cloudflare.py").read_text()
                    self.assertIn('live.get("BUILD_SHA", {}).get("text") != sha', provider)
                    self.assertIn("WORKER_CONFIGURATION_NOT_VERIFIED", provider)
                else:
                    self.assertTrue(probes)
                for probe in probes:
                    self.assertLess(recipe.index(probe), recipe.index(record))
                    self.assertIsNone(field(probe, "continue-on-error"))
                    self.assertEqual(field(probe, "if"), REQUIRED)


    def test_real_preflight_check_only_returns_false_without_any_provider_write(self):
        program = '''
import json
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, "tools/cloud-release")
import control

class ReadOnlyApi:
    def call(self, path, **kwargs):
        assert kwargs.get("method", "GET") == "GET"
        raise AssertionError("unexpected provider request")

config = {"name": "watch", "vars": {}}
desired = {"watch": {"bindings": []}}
inputs = ({"repository": "example/cloud"}, {"account_id": "a" * 32, "zone_id": "b" * 32}, [config], desired)
changes = {"changes": [{"field": "BUILD_SHA", "reason": "BUILD_IDENTITY_CHANGED"}]}
with patch.object(control, "release_inputs", return_value=inputs), \\
     patch.object(control, "verify_resources", return_value={}), \\
     patch.object(control, "observe", return_value=changes), \\
     patch.object(control, "routes_differences", return_value=[]):
    required = control.preflight(Path.cwd(), "watch", "a" * 40, False, ReadOnlyApi(), ReadOnlyApi(), check_only=True)
assert required is False
print(json.dumps({"required": required}))
'''
        result = subprocess.run([sys.executable, "-c", program], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"required": false', result.stdout)

    def test_real_prepare_exports_the_selected_repair_sha_to_later_build_steps(self):
        program = '''
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, "tools/cloud-release")
import control

with tempfile.TemporaryDirectory() as directory:
    output, environment = Path(directory) / "output", Path(directory) / "environment"
    inputs = {"GITHUB_REPOSITORY": "example/cloud", "GITHUB_REF": "refs/heads/main",
              "GITHUB_SHA": "a" * 40, "GITHUB_OUTPUT": str(output), "GITHUB_ENV": str(environment)}
    with patch.dict(os.environ, inputs), patch.object(control, "Api"), \\
         patch.object(control, "last_good", return_value={"sha": "b" * 40}), \\
         patch.object(sys, "argv", ["control.py", "prepare", "--app", "watch", "--repair"]):
        assert control.main() == 0
    assert output.read_text() == "source_sha=" + "b" * 40 + "\\n"
    assert environment.read_text() == "BUILD_SOURCE_SHA=" + "b" * 40 + "\\n"
    assert "a" * 40 not in environment.read_text()
'''
        result = subprocess.run([sys.executable, "-c", program], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
