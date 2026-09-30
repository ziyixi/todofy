"""Unit tests for ci_changes.py: python3 -m unittest discover -s .github/scripts"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ci_changes  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

SHA = "a" * 40
BASE = "b" * 40
MAIN = "refs/heads/main"
BRANCH = "refs/heads/feature"
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"
T, F = True, False


def expect(todofy_check, mail_hero_check, contracts, todofy_deploy, mail_hero_deploy, packages=False):
    return {
        "todofy_check": todofy_check,
        "mail_hero_check": mail_hero_check,
        "contracts": contracts,
        "packages": packages,
        "todofy_deploy": todofy_deploy,
        "mail_hero_deploy": mail_hero_deploy,
    }


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

    def test_ops_contract_rechecks_both_apps_but_deploys_neither(self):
        paths = ["contracts/ops-v1/ops-v1.schema.json", "contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json"]
        self.assertEqual(push(paths), expect(T, T, T, F, F))
        self.assertEqual(push(["contracts/ops-v1/ops-v1.ts", "todofy/gateway/src/ops.ts"]), expect(T, T, T, T, F))

    def test_ci_changes_recheck_everything_but_deploy_nothing(self):
        self.assertEqual(push([".github/workflows/ci.yml"]), expect(T, T, T, F, F, packages=T))
        self.assertEqual(push([".github/scripts/ci_changes.py"]), expect(T, T, T, F, F, packages=T))

    def test_a_shared_package_checks_and_deploys_every_app_that_compiles_it_in(self):
        for path in (
            "packages/edge-auth/src/access.ts",
            "packages/edge-auth/package-lock.json",
            "packages/edge-auth/SPEC.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(T, T, T, T, T, packages=T))

    def test_a_package_change_with_one_app_still_deploys_both_users(self):
        paths = ["packages/edge-auth/src/csrf.ts", "todofy/gateway/src/csrf.ts"]
        self.assertEqual(push(paths), expect(T, T, T, T, T, packages=T))

    def test_an_unregistered_package_counts_as_used_by_both_apps(self):
        self.assertEqual(push(["packages/dashboard-kit/src/index.ts"]), expect(T, T, T, T, T, packages=T))

    def test_a_file_directly_under_packages_is_root_documentation(self):
        self.assertEqual(push(["packages/README.md"]), expect(F, F, F, F, F))

    def test_root_documents_run_only_the_gate(self):
        self.assertEqual(push(["README.md", "AGENTS.md", ".gitignore"]), expect(F, F, F, F, F))
        self.assertEqual(push([]), expect(F, F, F, F, F))

    def test_prefixes_are_directories_not_name_prefixes(self):
        self.assertEqual(
            push(["todofy-notes.md", "mail-hero.md", "contracts.md", "packages.md", "packages-old/x.ts"]),
            expect(F, F, F, F, F),
        )

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
        self.assertEqual(self.dispatch("both"), expect(T, T, T, T, T, packages=T))
        self.assertEqual(self.dispatch(""), expect(T, T, T, T, T, packages=T))
        self.assertEqual(self.dispatch("todofy"), expect(T, F, T, T, F, packages=T))
        self.assertEqual(self.dispatch("mail-hero"), expect(F, T, T, F, T, packages=T))

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
        self.assertEqual(outputs, {**dict.fromkeys(ci_changes.KEYS, "true"), "packages": "false"})

    def test_a_failed_package_run_on_main_deploys_both_apps_next_time(self):
        green = self.commit("README.md")
        self.commit("packages/edge-auth/src/access.ts")
        after = self.commit("README.md.orig")
        self.assertEqual(set(self.main_run(after, green).values()), {"true"})

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


class PackageUsers(unittest.TestCase):
    """PACKAGE_USERS must match the repository: every packages/<name>/ directory is registered, and each
    lists exactly the apps with a "file:" dependency on it (a missing app would never be redeployed)."""

    def file_dependents(self):
        found = {}
        for manifest in REPO.glob("*/**/package.json"):
            relative = manifest.relative_to(REPO)
            if "node_modules" in relative.parts or relative.parts[0] == "packages":
                continue
            data = json.loads(manifest.read_text())
            for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
                for spec in data.get(section, {}).values():
                    if not spec.startswith("file:"):
                        continue
                    target = (manifest.parent / spec.removeprefix("file:")).resolve().relative_to(REPO)
                    if target.parts[0] == "packages":
                        found.setdefault(target.parts[1], set()).add(relative.parts[0])
        return found

    def test_every_package_directory_is_registered(self):
        directories = {path.name for path in (REPO / "packages").iterdir() if (path / "package.json").is_file()}
        self.assertEqual(directories, set(ci_changes.PACKAGE_USERS))

    def test_users_match_the_file_dependencies(self):
        found = self.file_dependents()
        self.assertLessEqual(set(found), set(ci_changes.PACKAGE_USERS))
        for name, users in ci_changes.PACKAGE_USERS.items():
            with self.subTest(package=name):
                self.assertEqual(found.get(name, set()), set(users))

    def test_users_are_apps_this_script_deploys(self):
        for users in ci_changes.PACKAGE_USERS.values():
            self.assertLessEqual(set(users), {"todofy", "mail-hero"})


def workflow_jobs():
    text = WORKFLOW.read_text().split("\njobs:\n", 1)[1]
    starts = [
        (match.start(), match.group(1)) for match in re.finditer(r"^  ([a-z][a-z0-9-]*):\n", text, re.MULTILINE)
    ]
    blocks = {}
    for index, (start, name) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else len(text)
        blocks[name] = text[start:end]
    return blocks


class ContractsJob(unittest.TestCase):
    """The Contracts job runs both sides of both contracts, and every test file it names exists.

    pytest and node --test fail on a missing file, but a renamed test must not silently drop out of a
    command that also lists other files; this keeps the job's list and the repository in step.
    """

    TEST_FILE = re.compile(r"(?<![\w/.-])(tests?/[\w/.-]+\.(?:mjs|py|ts))")

    def steps(self):
        block = workflow_jobs()["contracts"]
        return [step for step in re.split(r"^      - ", block, flags=re.MULTILINE)[1:] if "run: |" in step]

    def named_tests(self):
        found = set()
        for step in self.steps():
            directory = re.search(r"^        working-directory: (\S+)$", step, re.MULTILINE)
            self.assertIsNotNone(directory, step)
            for path in self.TEST_FILE.findall(step):
                found.add(f"{directory.group(1)}/{path}")
        return found

    def test_every_named_test_file_exists(self):
        names = self.named_tests()
        self.assertTrue(names)
        for name in sorted(names):
            with self.subTest(file=name):
                self.assertTrue((REPO / name).is_file(), f"{name} is named by the Contracts job but missing")

    def test_both_sides_of_both_contracts_run(self):
        self.assertLessEqual(
            {
                # mail.received.v1: producer rebuilds the golden bytes, consumer parses every fixture.
                "mail-hero/cloudflare/test/contract-fixtures.test.mjs",
                "todofy/tests/unit/test_mail_hero_compat.py",
                # ops-v1: fixtures against the schema with both validators, and each app's derived values.
                "mail-hero/cloudflare/test/ops-contract.test.mjs",
                "mail-hero/cloudflare/test/native-ops.test.mjs",
                "todofy/tests/unit/test_ops_contract.py",
                "todofy/tests/unit/test_ops_core.py",
                "todofy/gateway/test/ops.test.ts",
            },
            self.named_tests(),
        )


class DeployConditions(unittest.TestCase):
    """Every job that needs "CI gate" must spell out its status checks.

    "CI gate" needs both apps' check jobs; one of them is skipped whenever only the other app changed.
    A job condition without a status function gets an implicit success() that also looks at skipped
    ancestors, so a single-app deploy would be skipped (actions/runner#491, #2205).
    """

    def jobs(self):
        return workflow_jobs()

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

    def test_the_gate_needs_and_checks_every_job_before_it(self):
        blocks = self.jobs()
        before_gate = {name for name, block in blocks.items() if name != "gate" and "gate" not in self.needs(block)}
        gate = blocks["gate"]
        self.assertEqual(set(self.needs(gate)), before_gate)
        for need in before_gate:
            with self.subTest(job=need):
                self.assertIn(f"${{{{ needs.{need}.result }}}}", gate)

    def test_changes_exports_every_output_and_each_is_used(self):
        blocks = self.jobs()
        for key in ci_changes.KEYS:
            with self.subTest(output=key):
                self.assertIn(f"{key}: ${{{{ steps.decide.outputs.{key} }}}}", blocks["changes"])
                users = [name for name, block in blocks.items() if f"needs.changes.outputs.{key} == 'true'" in block]
                self.assertTrue(users, key)

    def test_shared_packages_run_only_when_flagged(self):
        self.assertEqual(self.condition(self.jobs()["shared-packages"]), "needs.changes.outputs.packages == 'true'")


if __name__ == "__main__":
    unittest.main()
