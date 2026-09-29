"""Unit tests for ci_changes.py: python3 -m unittest discover -s .github/scripts"""

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ci_changes  # noqa: E402

SHA = "a" * 40
BASE = "b" * 40
MAIN = "refs/heads/main"
BRANCH = "refs/heads/feature"
WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "ci.yml"
T, F = True, False


def expect(todofy_check, mail_hero_check, contracts, todofy_deploy, mail_hero_deploy):
    return dict(zip(ci_changes.KEYS, (todofy_check, mail_hero_check, contracts, todofy_deploy, mail_hero_deploy)))


def push(paths, ref=MAIN, last_success=BASE, ancestor=True, merge_base=BASE):
    return ci_changes.decide(
        "push", ref, SHA, "", last_success, lambda b, a: list(paths), lambda b, a: ancestor, lambda a: merge_base
    )[0]


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
    def test_no_successful_main_run_runs_everything(self):
        self.assertEqual(push([], last_success=""), ci_changes.everything())
        self.assertEqual(push([], last_success="0" * 40), ci_changes.everything())

    def test_a_base_that_is_not_an_ancestor_runs_everything(self):
        self.assertEqual(push(["README.md"], ancestor=False), ci_changes.everything())

    def test_a_branch_without_a_merge_base_runs_everything(self):
        self.assertEqual(push(["README.md"], ref=BRANCH, merge_base=""), ci_changes.everything())

    def test_other_events_run_everything(self):
        result, _ = ci_changes.decide(
            "schedule", MAIN, SHA, "", BASE, lambda b, a: [], lambda b, a: True, lambda a: BASE
        )
        self.assertEqual(result, ci_changes.everything())


class Base(unittest.TestCase):
    def bases(self, ref, **kwargs):
        seen = []
        ci_changes.decide(
            "push",
            ref,
            SHA,
            "",
            kwargs.get("last_success", BASE),
            lambda b, a: seen.append((b, a)) or [],
            lambda b, a: True,
            lambda a: kwargs.get("merge_base", "c" * 40),
        )
        return seen

    def test_main_diffs_from_the_last_successful_run(self):
        self.assertEqual(self.bases(MAIN), [(BASE, SHA)])

    def test_other_branches_diff_from_the_merge_base_with_main(self):
        self.assertEqual(self.bases(BRANCH), [("c" * 40, SHA)])
        self.assertEqual(self.bases(BRANCH, last_success=""), [("c" * 40, SHA)])


class Dispatch(unittest.TestCase):
    def dispatch(self, app):
        return ci_changes.decide(
            "workflow_dispatch", MAIN, SHA, app, "", lambda b, a: [], lambda b, a: True, lambda a: ""
        )[0]

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
        return subprocess.run(
            ["git", "-C", self.root, *args], check=True, capture_output=True, text=True
        ).stdout.strip()

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

    def main_run(self, after, last_success, ref=MAIN):
        return self.run_main(EVENT_NAME="push", REF=ref, AFTER=after, DISPATCH_APP="", LAST_SUCCESS=last_success)

    def test_a_cancelled_pending_run_on_main_is_not_lost(self):
        # Run 1 (green) at p0; push 2 touched todofy/ and was cancelled while pending; push 3 touched
        # only Mail Hero docs. Run 3 must still check and deploy Todofy.
        p0 = self.commit("README.md")
        self.commit("todofy/worker/a.py")
        p3 = self.commit("mail-hero/docs/b.md")
        outputs = self.main_run(p3, p0)
        self.assertEqual(outputs, dict.fromkeys(ci_changes.KEYS, "true"))

    def test_a_failed_run_on_main_is_repeated(self):
        # Push A changed todofy/ and its run failed (a Mail Hero flake); push B fixes only mail-hero/.
        green = self.commit("README.md")
        self.commit("todofy/worker/a.py")
        b = self.commit("mail-hero/cloudflare/c.ts")
        self.assertEqual(self.main_run(b, green)["todofy_deploy"], "true")
        # Once B's run succeeded, the next Mail Hero-only push leaves Todofy alone.
        c = self.commit("mail-hero/cloudflare/d.ts")
        outputs = self.main_run(c, b)
        self.assertEqual((outputs["todofy_check"], outputs["todofy_deploy"]), ("false", "false"))
        self.assertEqual(outputs["mail_hero_deploy"], "true")

    def test_a_branch_gate_covers_every_commit_on_the_branch(self):
        main = self.commit("README.md")
        self.git("update-ref", "refs/remotes/origin/main", main)
        self.git("checkout", "-qb", "feature")
        self.commit("todofy/worker/broken.py")
        head = self.commit("mail-hero/web/e.tsx")
        outputs = self.main_run(head, "", ref=BRANCH)
        self.assertEqual(outputs["todofy_check"], "true")
        self.assertEqual(outputs["mail_hero_check"], "true")

    def test_a_branch_after_main_moved_on_uses_the_merge_base(self):
        fork = self.commit("README.md")
        self.git("checkout", "-qb", "feature")
        head = self.commit("mail-hero/web/e.tsx")
        self.git("checkout", "-q", "-")
        moved = self.commit("todofy/worker/on-main.py")
        self.git("update-ref", "refs/remotes/origin/main", moved)
        self.assertEqual(self.git("merge-base", "origin/main", head), fork)
        # Todofy changed on main after the fork, not on the branch: only Mail Hero is checked.
        outputs = self.main_run(head, "", ref=BRANCH)
        self.assertEqual((outputs["todofy_check"], outputs["mail_hero_check"]), ("false", "true"))

    def test_a_branch_without_origin_main_runs_everything(self):
        head = self.commit("mail-hero/web/e.tsx")
        self.assertEqual(set(self.main_run(head, "", ref=BRANCH).values()), {"true"})

    def test_unknown_or_unrelated_base_runs_everything(self):
        first = self.commit("todofy/a.py")
        self.git("checkout", "-q", "--orphan", "other")
        unrelated = self.commit("mail-hero/b.ts")
        self.assertEqual(set(self.main_run(unrelated, first).values()), {"true"})
        self.assertEqual(set(self.main_run(unrelated, "c" * 40).values()), {"true"})
        self.assertEqual(set(self.main_run(unrelated, "").values()), {"true"})


class DeployConditions(unittest.TestCase):
    """Every job that needs "CI gate" must spell out its status checks.

    "CI gate" needs both apps' check jobs; one of them is skipped whenever only the other app changed.
    A job condition without a status function gets an implicit success() that also looks at skipped
    ancestors, so a single-app deploy would be skipped (actions/runner#491, #2205).
    """

    def jobs(self):
        text = WORKFLOW.read_text()
        starts = [
            (match.start(), match.group(1)) for match in re.finditer(r"^  ([a-z][a-z0-9-]*):\n", text, re.MULTILINE)
        ]
        blocks = {}
        for index, (start, name) in enumerate(starts):
            end = starts[index + 1][0] if index + 1 < len(starts) else len(text)
            blocks[name] = text[start:end]
        return blocks

    def condition(self, block):
        match = re.search(r"^    if: (>-\n(?:      .*\n)+|.*\n)", block, re.MULTILINE)
        return " ".join(match.group(1).replace(">-", "").split()) if match else ""

    def needs(self, block):
        match = re.search(r"^    needs: \[(.*)\]$", block, re.MULTILINE)
        return [name.strip() for name in match.group(1).split(",")] if match else []

    def test_jobs_after_the_gate_check_every_needed_result(self):
        blocks = self.jobs()
        after_gate = {name: block for name, block in blocks.items() if "gate" in self.needs(block)}
        self.assertEqual(set(after_gate), {"todofy-deploy", "mail-hero-deploy"})
        for name, block in after_gate.items():
            condition = self.condition(block)
            with self.subTest(job=name):
                self.assertTrue(condition.startswith("${{ !cancelled()"), condition)
                for need in self.needs(block):
                    self.assertIn(f"needs.{need}.result == 'success'", condition)
                self.assertIn("github.ref == 'refs/heads/main'", condition)

    def test_each_deploy_requires_its_own_checks_and_flag(self):
        blocks = self.jobs()
        for job, checks, flag in (
            ("todofy-deploy", "todofy-checks", "todofy_deploy"),
            ("mail-hero-deploy", "mail-hero-checks", "mail_hero_deploy"),
        ):
            condition = self.condition(blocks[job])
            with self.subTest(job=job):
                self.assertIn(f"needs.{checks}.result == 'success'", condition)
                self.assertIn(f"needs.changes.outputs.{flag} == 'true'", condition)

    def test_the_gate_always_runs(self):
        self.assertEqual(self.condition(self.jobs()["gate"]), "always()")


if __name__ == "__main__":
    unittest.main()
