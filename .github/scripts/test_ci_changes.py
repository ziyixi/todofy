"""Unit tests for ci_changes.py: python3 -m unittest discover -s .github/scripts"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ci_changes  # noqa: E402

SHA = "a" * 40
BEFORE = "b" * 40
T, F = True, False


def expect(todofy_check, mail_hero_check, contracts, todofy_deploy, mail_hero_deploy):
    return dict(zip(ci_changes.KEYS, (todofy_check, mail_hero_check, contracts, todofy_deploy, mail_hero_deploy)))


def push(paths, before=BEFORE, known=True):
    return ci_changes.decide("push", before, SHA, "", lambda b, a: list(paths), lambda commit: known)[0]


class Classify(unittest.TestCase):
    def test_one_app_checks_and_deploys_only_itself_plus_contracts(self):
        self.assertEqual(push(["todofy/worker/todofy/core/render.py"]), expect(T, F, T, T, F))
        self.assertEqual(push(["mail-hero/cloudflare/src/native/pipeline.ts"]), expect(F, T, T, F, T))

    def test_both_apps(self):
        self.assertEqual(push(["todofy/README.md", "mail-hero/web/src/app/App.tsx"]), expect(T, T, T, T, T))

    def test_contracts_recheck_both_apps_but_deploy_neither(self):
        paths = ["contracts/mail-received-v1/fixtures/plain_text.json"]
        self.assertEqual(push(paths), expect(T, T, T, F, F))

    def test_ci_changes_recheck_everything_but_deploy_nothing(self):
        self.assertEqual(push([".github/workflows/ci.yml"]), expect(T, T, T, F, F))
        self.assertEqual(push([".github/scripts/ci_changes.py"]), expect(T, T, T, F, F))

    def test_root_documents_run_only_the_gate(self):
        self.assertEqual(push(["README.md", "AGENTS.md", ".gitignore"]), expect(F, F, F, F, F))
        self.assertEqual(push([]), expect(F, F, F, F, F))

    def test_prefixes_are_directories_not_name_prefixes(self):
        self.assertEqual(push(["todofy-notes.md", "mail-hero.md", "contracts.md"]), expect(F, F, F, F, F))

    def test_backup_tool_counts_as_mail_hero(self):
        self.assertEqual(push(["mail-hero/deploy/backup/Dockerfile"]), expect(F, T, T, F, T))

    def test_a_rename_between_apps_touches_both(self):
        paths = ["todofy/api/mail-received-v1.schema.json", "contracts/mail-received-v1/mail-received-v1.schema.json"]
        self.assertEqual(push(paths), expect(T, T, T, T, F))


class Unknown(unittest.TestCase):
    def test_new_branch_runs_everything(self):
        self.assertEqual(push([], before="0" * 40), ci_changes.everything())
        self.assertEqual(push([], before=""), ci_changes.everything())

    def test_before_missing_from_history_runs_everything(self):
        self.assertEqual(push(["README.md"], known=False), ci_changes.everything())

    def test_other_events_run_everything(self):
        result, _ = ci_changes.decide("schedule", "", SHA, "", lambda b, a: [], lambda c: True)
        self.assertEqual(result, ci_changes.everything())


class Dispatch(unittest.TestCase):
    def dispatch(self, app):
        return ci_changes.decide("workflow_dispatch", "", SHA, app, lambda b, a: [], lambda c: True)[0]

    def test_inputs_force_one_or_both_apps(self):
        self.assertEqual(self.dispatch("both"), expect(T, T, T, T, T))
        self.assertEqual(self.dispatch(""), expect(T, T, T, T, T))
        self.assertEqual(self.dispatch("todofy"), expect(T, F, T, T, F))
        self.assertEqual(self.dispatch("mail-hero"), expect(F, T, T, F, T))

    def test_unknown_input_fails(self):
        with self.assertRaises(ValueError):
            self.dispatch("everything")


class RealGit(unittest.TestCase):
    """main() against a throwaway repository, the way the workflow step runs it."""

    def git(self, *args):
        return subprocess.run(["git", "-C", self.root, *args], check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, path):
        file = Path(self.root, path)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(path)
        self.git("add", "-A")
        self.git("-c", "user.name=ci", "-c", "user.email=ci@example.org", "commit", "-qm", path)
        return self.git("rev-parse", "HEAD")

    def run_main(self, **env):
        output = Path(self.root, "output.txt")
        output.unlink(missing_ok=True)
        cwd = os.getcwd()
        saved = {key: os.environ.get(key) for key in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", *env)}
        try:
            os.chdir(self.root)
            os.environ.update(env, GITHUB_OUTPUT=str(output))
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            ci_changes.main()
        finally:
            os.chdir(cwd)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        return dict(line.split("=", 1) for line in output.read_text().splitlines())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = self.temporary.name
        self.git("init", "-q")

    def tearDown(self):
        self.temporary.cleanup()

    def test_push_diff_and_unknown_before(self):
        first = self.commit("todofy/a.py")
        second = self.commit("mail-hero/b.ts")
        outputs = self.run_main(EVENT_NAME="push", BEFORE=first, AFTER=second, DISPATCH_APP="")
        self.assertEqual(outputs["mail_hero_deploy"], "true")
        self.assertEqual(outputs["todofy_deploy"], "false")
        self.assertEqual(outputs["todofy_check"], "false")
        outputs = self.run_main(EVENT_NAME="push", BEFORE="c" * 40, AFTER=second, DISPATCH_APP="")
        self.assertEqual(set(outputs.values()), {"true"})


if __name__ == "__main__":
    unittest.main()
