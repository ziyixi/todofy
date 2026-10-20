"""The one-time Tasks planning import workflow (.github/workflows/tasks-planning-import.yml, tasks/docs/backup.md
"One-time planning import"): python -m unittest discover -s .github/scripts

It holds a production token in a public repository and reads private planning data, so its shape is pinned here: a
manual dispatch on main in the production environment, the Tasks release's concurrency group, the one token, the
input through the environment only, read-only exports whose answers go to a private directory and never to the log,
and one write: the generated SQL applied to Tasks' D1, only when `apply` is true. The generator itself is tested in
tasks/tools/test/planning-import.test.mjs.
"""

import re
import tomllib
import unittest

from workflow_sources import ROOT, workflow_data

WORKFLOW = ROOT / ".github/workflows/tasks-planning-import.yml"


def code(text: str) -> str:
    """The workflow without comment lines and trailing comments (a `# v7` after a SHA stays out)."""
    return "\n".join(re.sub(r"\s+#.*$", "", line) for line in text.splitlines() if not line.lstrip().startswith("#"))


class TasksPlanningImportWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.code = code(cls.text)
        cls.data = workflow_data(WORKFLOW)
        cls.job = cls.data["jobs"]["import"]
        cls.script = cls.job["steps"][-1]["run"]

    def test_a_manual_dispatch_with_one_boolean_input(self):
        self.assertEqual(list(self.data["on"]), ["workflow_dispatch"])
        inputs = self.data["on"]["workflow_dispatch"]["inputs"]
        self.assertEqual(list(inputs), ["apply"])
        self.assertEqual(
            {key: value for key, value in inputs["apply"].items() if key != "description"},
            {"required": "true", "default": "false", "type": "boolean"},
        )

    def test_main_only_in_production_and_the_tasks_release_group(self):
        self.assertEqual(self.data["permissions"], {"contents": "read"})
        self.assertEqual(self.data["concurrency"], {"group": "tasks-production", "cancel-in-progress": "false"})
        # The release job's group for app tasks (worker-release.yml), so the import never overlaps a Tasks release.
        release = workflow_data(ROOT / ".github/workflows/worker-release.yml")["jobs"]["release"]
        self.assertEqual(release["concurrency"]["group"].replace("${{ inputs.app }}", "tasks"), "tasks-production")
        self.assertTrue((ROOT / ".github/actions/release-tasks/action.yml").exists())
        self.assertEqual(list(self.data["jobs"]), ["import"])
        self.assertEqual(self.job["if"], "github.ref == 'refs/heads/main'")
        self.assertEqual(self.job["environment"], "production")
        self.assertNotIn("permissions", self.job)
        self.assertLessEqual(int(self.job["timeout-minutes"]), 15)

    def test_the_token_and_the_input_reach_the_script_through_the_environment_only(self):
        self.assertEqual(set(re.findall(r"secrets\.([A-Z0-9_]+)", self.code)), {"CF_API_TOKEN"})
        self.assertEqual(
            self.job["steps"][-1]["env"],
            {"CLOUDFLARE_API_TOKEN": "${{ secrets.CF_API_TOKEN }}", "PLANNING_IMPORT_APPLY": "${{ inputs.apply }}"},
        )
        self.assertEqual(len(re.findall(r"secrets\.", self.code)), 1)
        self.assertEqual(len(re.findall(r"inputs\.", self.code)), 1)
        self.assertNotRegex(self.code, r"vars\.")
        for step in self.job["steps"]:
            self.assertNotIn("${{", step.get("run", ""))

    def test_actions_are_pinned_by_sha_without_persisted_credentials(self):
        uses = [step["uses"] for step in self.job["steps"] if "uses" in step]
        self.assertEqual([action.split("@")[0] for action in uses], ["actions/checkout", "actions/setup-node"])
        for action in uses:
            self.assertRegex(action, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
        self.assertEqual(self.job["steps"][0]["with"], {"persist-credentials": "false"})

    def test_exports_go_to_a_private_directory_and_only_counts_reach_the_log(self):
        self.assertIn(
            'dir="$RUNNER_TEMP/planning-import"\nmkdir -m 700 "$dir"\ntrap \'rm -rf "$dir"\' EXIT\n', self.script
        )
        self.assertIn('node "$tool" --exports > "$dir/exports.tsv"', self.script)
        self.assertIn('done < "$dir/exports.tsv"', self.script)
        self.assertEqual(self.script.count('node "$tool" --dir "$dir"'), 1)
        for word in (
            "cat ",
            "tee",
            "set -x",
            'echo "$',
            "printf",
            "GITHUB_OUTPUT",
            "GITHUB_STEP_SUMMARY",
            "GITHUB_ENV",
            "upload-artifact",
            "--verbose",
        ):
            with self.subTest(word=word):
                self.assertNotIn(word, self.code)

    def test_the_only_write_is_the_generated_sql_on_tasks_and_only_with_apply(self):
        calls = [line.strip() for line in self.script.splitlines() if '"$wrangler"' in line]
        self.assertEqual(
            calls,
            [
                '"$wrangler" d1 execute DB --remote --config "$app/wrangler.toml" --json --command "$sql" '
                '> "$dir/$name.json"',
                '"$wrangler" d1 time-travel info DB --config tasks/wrangler.toml',
                'if ! "$wrangler" d1 execute DB --remote --config tasks/wrangler.toml --yes --file "$dir/import.sql" '
                '> "$dir/apply.log" 2>&1; then',
            ],
        )
        dry = self.script.index('if [ "$PLANNING_IMPORT_APPLY" != true ]; then\n  count\n  exit 0\nfi\n')
        self.assertLess(dry, self.script.index("count --output"))
        self.assertLess(self.script.index("count --output"), self.script.index("time-travel info"))
        self.assertLess(self.script.index("time-travel info"), self.script.index("--file"))
        self.assertTrue(self.script.rstrip().endswith("count --expect-none"))
        self.assertIn("echo PLANNING_IMPORT_APPLY_FAILED >&2", self.script)

    def test_every_export_names_an_app_whose_production_config_binds_db(self):
        tool = (ROOT / "tasks/tools/planning-import.ts").read_text()
        apps = set(re.findall(r"\bapp: '([a-z]+)'", tool))
        self.assertEqual(apps, {"todofy", "tasks"})
        for app in apps:
            with (ROOT / app / "wrangler.toml").open("rb") as file:
                bindings = [database["binding"] for database in tomllib.load(file)["d1_databases"]]
            self.assertEqual(bindings, ["DB"], app)
        self.assertTrue((ROOT / "tasks/tools/prepare-planning-import.ts").exists())
        self.assertIn("tool=tasks/tools/prepare-planning-import.ts", self.script)


if __name__ == "__main__":
    unittest.main()
