"""Unit tests for ci_changes.py: python3 -m unittest discover -s .github/scripts"""

import json
import os
import re
import shutil
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


def expect(
    todofy_check,
    mail_hero_check,
    contracts,
    todofy_deploy,
    mail_hero_deploy,
    packages=False,
    dashboard_check=False,
    dashboard_deploy=False,
    website_check=False,
    website_deploy=False,
    website_relay_deploy=False,
):
    return {
        "todofy_check": todofy_check,
        "mail_hero_check": mail_hero_check,
        "dashboard_check": dashboard_check,
        "website_check": website_check,
        "contracts": contracts,
        "packages": packages,
        "todofy_deploy": todofy_deploy,
        "mail_hero_deploy": mail_hero_deploy,
        "dashboard_deploy": dashboard_deploy,
        "website_deploy": website_deploy,
        "website_relay_deploy": website_relay_deploy,
    }


# Every app checked (a contracts/ or .github/ change); the three edge-auth apps checked and deployed
# (the website compiles in no package); every app with the website's two Workers.
ALL_CHECKED = {"dashboard_check": True, "website_check": True}
ALL = {"dashboard_check": True, "dashboard_deploy": True}
EVERY = {**ALL, "website_check": True, "website_deploy": True}


def push(paths, ref=MAIN, last_success=BASE, ancestor=True, merge_base=BASE):
    return ci_changes.decide(
        "push", ref, SHA, "", last_success, lambda b, a: list(paths), lambda b, a: ancestor, lambda a: merge_base
    )[0]


class Classify(unittest.TestCase):
    def test_one_app_checks_and_deploys_only_itself_plus_contracts(self):
        self.assertEqual(push(["todofy/worker/todofy/core/render.py"]), expect(T, F, T, T, F))
        self.assertEqual(push(["mail-hero/cloudflare/src/native/pipeline.ts"]), expect(F, T, T, F, T))

    def test_the_dashboard_checks_and_deploys_only_itself_plus_contracts(self):
        """Its ops-v1 caller tests run in Contracts; the apps it calls are neither checked nor deployed."""
        for path in ("dashboard/worker/src/state.ts", "dashboard/web/src/App.tsx", "dashboard/docs/setup.md"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, T, F, F, dashboard_check=T, dashboard_deploy=T))

    def test_both_apps(self):
        self.assertEqual(push(["todofy/README.md", "mail-hero/web/src/app/App.tsx"]), expect(T, T, T, T, T))

    def test_all_three_apps(self):
        paths = ["todofy/README.md", "mail-hero/web/src/app/App.tsx", "dashboard/README.md"]
        self.assertEqual(push(paths), expect(T, T, T, T, T, **ALL))

    def test_contracts_recheck_every_app_but_deploy_none(self):
        paths = ["contracts/mail-received-v1/fixtures/plain_text.json"]
        self.assertEqual(push(paths), expect(T, T, T, F, F, **ALL_CHECKED))

    def test_ops_contract_fixtures_and_docs_recheck_every_app_but_deploy_none(self):
        paths = ["contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json", "contracts/ops-v1/README.md"]
        self.assertEqual(push(paths), expect(T, T, T, F, F, **ALL_CHECKED))

    def test_ops_schema_and_validator_also_deploy_the_dashboard(self):
        """The dashboard validates every Ops answer at runtime with the bundled schema and validate.mjs."""
        for path in ("contracts/ops-v1/ops-v1.schema.json", "contracts/ops-v1/validate.mjs"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(T, T, T, F, F, **ALL, website_check=T))

    def test_contract_code_the_workers_bundle_deploys_every_app_that_bundles_it(self):
        """OPS_LIMITS and friends ship inside all three Workers, so a change must redeploy each."""
        bundled = expect(T, T, T, T, T, **ALL, website_check=T)
        self.assertEqual(push(["contracts/ops-v1/ops-v1.ts"]), bundled)
        self.assertEqual(push(["contracts/ops-v1/ops-v1.ts", "todofy/gateway/src/ops.ts"]), bundled)
        self.assertEqual(push(["contracts/ops-v1/ops-v1.ts"], ref=BRANCH), bundled)

    def test_bundled_by_lists_exactly_the_apps_whose_worker_imports_each_contract_file(self):
        """Every contracts/ file that an app's Worker or UI source imports (value or type) is in BUNDLED_BY
        with exactly the apps that import it. Tests (*.test.ts, test/) are not bundled and do not count."""
        roots = {
            "mail-hero": [REPO / "mail-hero" / "cloudflare" / "src", REPO / "mail-hero" / "web" / "src"],
            "todofy": [REPO / "todofy" / "gateway" / "src", REPO / "todofy" / "web" / "src"],
            "dashboard": [REPO / "dashboard" / "worker" / "src", REPO / "dashboard" / "web" / "src"],
            "website": [REPO / "website" / "src", REPO / "website" / "relay" / "src"],
        }
        self.assertEqual(set(roots), set(ci_changes.APPS))
        importers = {}
        for app, directories in roots.items():
            for directory in directories:
                for source in [*directory.rglob("*.ts"), *directory.rglob("*.tsx")]:
                    parts = source.relative_to(directory).parts
                    if "node_modules" in parts or "test" in parts or re.search(r"\.test\.tsx?$", source.name):
                        continue
                    for target in re.findall(r"""from\s+['"]([^'"]*contracts/[^'"]*)['"]""", source.read_text()):
                        path = (source.parent / target).resolve().relative_to(REPO).as_posix()
                        importers.setdefault(path, set()).add(app)
        self.assertIn("contracts/ops-v1/ops-v1.ts", importers)
        self.assertEqual({path: set(apps) for path, apps in ci_changes.BUNDLED_BY.items()}, importers)

    def test_ci_changes_recheck_everything_but_deploy_nothing(self):
        self.assertEqual(push([".github/workflows/ci.yml"]), expect(T, T, T, F, F, packages=T, **ALL_CHECKED))
        self.assertEqual(push([".github/scripts/ci_changes.py"]), expect(T, T, T, F, F, packages=T, **ALL_CHECKED))

    def test_a_shared_package_checks_and_deploys_every_app_that_compiles_it_in(self):
        for path in (
            "packages/edge-auth/src/access.ts",
            "packages/edge-auth/package-lock.json",
            "packages/edge-auth/test/helpers.ts",
        ):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(T, T, T, T, T, packages=T, **ALL))

    def test_a_package_document_checks_every_user_but_deploys_none(self):
        """A README or SPEC is compiled into no Worker: an edit must not redeploy production."""
        for paths in (
            ["packages/edge-auth/SPEC.md"],
            ["packages/edge-auth/README.md", "packages/edge-auth/SPEC.md"],
            ["packages/edge-auth/docs/notes.md"],
        ):
            with self.subTest(paths=paths):
                self.assertEqual(push(paths), expect(T, T, T, F, F, packages=T, dashboard_check=T))
        # With the package's code, or with one app, the usual rules apply.
        paths = ["packages/edge-auth/SPEC.md", "packages/edge-auth/src/csrf.ts"]
        self.assertEqual(push(paths), expect(T, T, T, T, T, packages=T, **ALL))
        paths = ["packages/edge-auth/SPEC.md", "dashboard/docs/design.md"]
        self.assertEqual(push(paths), expect(T, T, T, F, F, packages=T, **ALL))
        # An unregistered package's documents are checked by every app, deployed by none.
        self.assertEqual(push(["packages/new-kit/README.md"]), expect(T, T, T, F, F, packages=T, **ALL_CHECKED))

    def test_this_branch_redeploys_only_the_dashboard(self):
        """The dashboard branch's non-dashboard files: CI, root and contract docs, the edge-auth docs."""
        paths = [
            ".github/scripts/ci_changes.py",
            ".github/workflows/ci.yml",
            "AGENTS.md",
            "README.md",
            "contracts/README.md",
            "contracts/ops-v1/README.md",
            "packages/edge-auth/README.md",
            "packages/edge-auth/SPEC.md",
            "dashboard/worker/src/state.ts",
        ]
        self.assertEqual(push(paths), expect(T, T, T, F, F, packages=T, **ALL, website_check=T))

    def test_a_package_change_with_one_app_still_deploys_every_user(self):
        paths = ["packages/edge-auth/src/csrf.ts", "todofy/gateway/src/csrf.ts"]
        self.assertEqual(push(paths), expect(T, T, T, T, T, packages=T, **ALL))

    def test_an_unregistered_package_counts_as_used_by_every_app(self):
        self.assertEqual(push(["packages/dashboard-kit/src/index.ts"]), expect(T, T, T, T, T, packages=T, **EVERY))

    def test_a_file_directly_under_packages_is_root_documentation(self):
        self.assertEqual(push(["packages/README.md"]), expect(F, F, F, F, F))

    def test_root_documents_run_only_the_gate(self):
        self.assertEqual(push(["README.md", "AGENTS.md", ".gitignore"]), expect(F, F, F, F, F))
        self.assertEqual(push([]), expect(F, F, F, F, F))

    def test_prefixes_are_directories_not_name_prefixes(self):
        self.assertEqual(
            push(
                [
                    "todofy-notes.md",
                    "mail-hero.md",
                    "dashboard.md",
                    "website.md",
                    "contracts.md",
                    "packages.md",
                    "packages-old/x.ts",
                ]
            ),
            expect(F, F, F, F, F),
        )

    def test_backup_tool_counts_as_mail_hero(self):
        self.assertEqual(push(["mail-hero/deploy/backup/Dockerfile"]), expect(F, T, T, F, T))

    def test_a_rename_between_apps_touches_both(self):
        paths = ["todofy/api/mail-received-v1.schema.json", "contracts/mail-received-v1/mail-received-v1.schema.json"]
        self.assertEqual(push(paths), expect(T, T, T, T, F, **ALL_CHECKED))

    def test_the_website_checks_and_releases_only_itself(self):
        """No contract and no package: a site change runs neither Contracts nor another app."""
        for path in ("website/src/app/page.tsx", "website/wrangler.toml", "website/docs/release.md"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, F, F, F, website_check=T, website_deploy=T))

    def test_the_relay_deploys_without_releasing_the_site(self):
        """website/relay/ is the Notion relay Worker: its change deploys the relay only."""
        self.assertEqual(
            push(["website/relay/src/detector.ts"]), expect(F, F, F, F, F, website_check=T, website_relay_deploy=T)
        )
        both = expect(F, F, F, F, F, website_check=T, website_deploy=T, website_relay_deploy=T)
        self.assertEqual(push(["website/relay/wrangler.toml", "website/package.json"]), both)

    def test_the_release_workflow_rechecks_every_app_but_deploys_none(self):
        self.assertEqual(
            push([".github/workflows/website-release.yml"]), expect(T, T, T, F, F, packages=T, **ALL_CHECKED)
        )


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

    def test_inputs_force_one_two_or_all_apps(self):
        # "both" (also the default) keeps meaning Todofy and Mail Hero.
        self.assertEqual(self.dispatch("both"), expect(T, T, T, T, T, packages=T))
        self.assertEqual(self.dispatch(""), expect(T, T, T, T, T, packages=T))
        self.assertEqual(self.dispatch("all"), expect(T, T, T, T, T, packages=T, **EVERY, website_relay_deploy=T))
        self.assertEqual(self.dispatch("todofy"), expect(T, F, T, T, F, packages=T))
        self.assertEqual(self.dispatch("mail-hero"), expect(F, T, T, F, T, packages=T))
        self.assertEqual(self.dispatch("dashboard"), expect(F, F, T, F, F, packages=T, **ALL))
        self.assertEqual(
            self.dispatch("website"),
            expect(F, F, T, F, F, packages=T, website_check=T, website_deploy=T, website_relay_deploy=T),
        )

    def test_the_workflow_offers_exactly_the_dispatch_inputs(self):
        text = WORKFLOW.read_text()
        options = re.search(r"^        options: \[(.*)\]$", text, re.MULTILINE)
        self.assertIsNotNone(options)
        self.assertEqual({name.strip() for name in options.group(1).split(",")}, set(ci_changes.DISPATCH))
        self.assertIn("        default: both\n", text)

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
        expected = {**dict.fromkeys(ci_changes.KEYS, "true"), "packages": "false"}
        expected.update(dashboard_check="false", dashboard_deploy="false")
        expected.update(website_check="false", website_deploy="false", website_relay_deploy="false")
        self.assertEqual(outputs, expected)

    def test_a_failed_package_run_on_main_deploys_both_apps_next_time(self):
        green = self.commit("README.md")
        self.commit("packages/edge-auth/src/access.ts")
        after = self.commit("README.md.orig")
        outputs = self.main_run(after, green)
        website = {"website_check", "website_deploy", "website_relay_deploy"}
        self.assertEqual({key for key, value in outputs.items() if value == "false"}, website)

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
            self.assertLessEqual(set(users), set(ci_changes.APPS))

    def test_every_app_directory_is_known(self):
        """A top-level directory with a package.json below it is an app (or packages/); a new one must be
        added to APPS, or its changes would run nothing."""
        tops = {
            manifest.relative_to(REPO).parts[0]
            for manifest in REPO.glob("*/**/package.json")
            if "node_modules" not in manifest.parts
        }
        self.assertEqual(tops - {"packages", "contracts"}, set(ci_changes.APPS))


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
                # ops-v1 caller: the dashboard calls only declared methods and handles every error code.
                "dashboard/worker/test/ops-client.test.ts",
            },
            self.named_tests(),
        )


class DeployConditions(unittest.TestCase):
    """Every job that needs "CI gate" must spell out its status checks.

    "CI gate" needs every app's check job; some are skipped whenever only another app changed. A job
    condition without a status function gets an implicit success() that also looks at skipped
    ancestors, so a single-app deploy would be skipped (actions/runner#491, #2205).
    """

    # (job, need) pairs where "skipped" is as good as "success": the dashboard deploys after both app
    # deploys (its service bindings need their Ops entrypoints), which do not run when nothing of that
    # app changed.
    SKIPPED_OK = {("dashboard-deploy", "todofy-deploy"), ("dashboard-deploy", "mail-hero-deploy")}

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
        self.assertEqual(
            set(after_gate),
            {"todofy-deploy", "mail-hero-deploy", "dashboard-deploy", "website-deploy", "website-relay-deploy"},
        )
        for name, block in after_gate.items():
            condition = self.condition(block)
            with self.subTest(job=name):
                self.assertTrue(condition.startswith("${{ !cancelled()"), condition)
                for need in self.needs(block):
                    if (name, need) in self.SKIPPED_OK:
                        self.assertIn(
                            f"(needs.{need}.result == 'success' || needs.{need}.result == 'skipped')", condition
                        )
                    else:
                        self.assertIn(f"needs.{need}.result == 'success'", condition)
                        self.assertNotIn(f"needs.{need}.result == 'skipped'", condition)
                self.assertIn("github.ref == 'refs/heads/main'", condition)

    def test_the_dashboard_deploys_after_both_apps(self):
        block = self.jobs()["dashboard-deploy"]
        self.assertLessEqual({"todofy-deploy", "mail-hero-deploy"}, set(self.needs(block)))
        self.assertIn("group: dashboard-production", block)
        # The only token: the one Todofy deploy uses; no other secret reaches wrangler's environment.
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}", block)
        self.assertEqual(block.count("CLOUDFLARE_API_TOKEN:"), 1)
        # The generator compares (never writes) the deploy token, to refuse it as the analytics token.
        generate = block.split("- name: Generate the production configuration\n", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}", generate)

    def test_every_production_job_has_its_own_concurrency_group(self):
        blocks = self.jobs()
        groups = {}
        for name, block in blocks.items():
            if "environment:" in block:
                match = re.search(r"^      group: (\S+)$", block, re.MULTILINE)
                self.assertIsNotNone(match, name)
                groups[name] = match.group(1)
        self.assertEqual(
            groups,
            {
                "todofy-deploy": "todofy-production",
                "mail-hero-deploy": "mail-hero-production",
                "dashboard-deploy": "dashboard-production",
                "website-relay-deploy": "website-relay-production",
            },
        )

    def test_each_deploy_requires_its_own_checks_and_flag(self):
        blocks = self.jobs()
        for job, checks, flag in (
            ("todofy-deploy", "todofy-checks", "todofy_deploy"),
            ("mail-hero-deploy", "mail-hero-checks", "mail_hero_deploy"),
            ("dashboard-deploy", "dashboard-checks", "dashboard_deploy"),
            ("website-deploy", "website-checks", "website_deploy"),
            ("website-relay-deploy", "website-checks", "website_relay_deploy"),
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


class WebsiteRelease(unittest.TestCase):
    """Website deploy calls the one release workflow the Notion relay dispatches; its jobs hold the single
    concurrency group and the production environment, so a push release, a button, the detector and a
    status refresh never overlap. The caller holds neither: a caller in the same group waits for itself."""

    RELEASE = REPO / ".github" / "workflows" / "website-release.yml"

    def release_jobs(self):
        text = self.RELEASE.read_text().split("\njobs:\n", 1)[1]
        starts = [(m.start(), m.group(1)) for m in re.finditer(r"^  ([a-z][a-z0-9-]*):\n", text, re.MULTILINE)]
        return {
            name: text[start : starts[index + 1][0] if index + 1 < len(starts) else len(text)]
            for index, (start, name) in enumerate(starts)
        }

    def test_website_deploy_calls_the_release_workflow_with_fixed_inputs(self):
        block = workflow_jobs()["website-deploy"]
        self.assertIn("    uses: ./.github/workflows/website-release.yml\n", block)
        for line in (
            "operation: release",
            "confirmation: release:www.ziyixi.science",
            "force_build: false",
            "allow_empty: false",
            "trigger: push",
        ):
            self.assertIn(f"      {line}\n", block)
        self.assertNotIn("concurrency:", block)
        self.assertNotIn("environment:", block)
        self.assertIn("deployments: write", block)

    def test_every_release_job_shares_one_group_and_the_production_environment(self):
        jobs = self.release_jobs()
        self.assertEqual(set(jobs), {"release", "status"})
        for name, block in jobs.items():
            with self.subTest(job=name):
                self.assertIn("      group: website-production\n", block)
                self.assertIn("      cancel-in-progress: false\n", block)
                self.assertIn("      name: production\n", block)

    def test_the_relay_and_the_workflow_agree_on_operations_and_triggers(self):
        text = self.RELEASE.read_text()
        self.assertIn("run-name: Website ${{ inputs.operation }} (${{ inputs.trigger }})", text)
        self.assertIn("        options: [release, status, bootstrap, recovery]", text)
        self.assertIn("        options: [manual, button, cron, reconcile]", text)
        relay = (REPO / "website" / "relay" / "src" / "github.ts").read_text()
        self.assertIn("(release|status|bootstrap|recovery) \\((manual|button|cron|reconcile|push)\\)", relay)
        config = (REPO / "website" / "relay" / "wrangler.toml").read_text()
        self.assertIn('RELEASE_WORKFLOW = "website-release.yml"', config)
        self.assertIn('GITHUB_REPOSITORY = "ziyixi/todofy"', config)

    def test_only_the_release_steps_see_credentials(self):
        text = self.RELEASE.read_text()
        self.assertNotIn("secrets.VERCEL", text)
        # Notion credentials only for the snapshot and the feedback; the deploy token only for Cloudflare steps.
        notion = [line for line in text.splitlines() if "secrets.WEBSITE_NOTION_TOKEN" in line]
        self.assertEqual(len(notion), 3)
        cloudflare = [line for line in text.splitlines() if "secrets.CF_API_TOKEN" in line]
        self.assertEqual(len(cloudflare), 5)


@unittest.skipUnless(shutil.which("bash") and shutil.which("jq"), "needs bash and jq (both on the runner)")
class AccessProbe(unittest.TestCase):
    """The Dashboard deploy's Access probe, run as the workflow runs it, against a stubbed curl.

    Only Access's own login page for this host passes; a 302 to anywhere else on the team domain (for
    example a zone Redirect Rule to the App Launcher, which runs before Access and the Worker) fails.
    """

    ISSUER = "https://example.cloudflareaccess.com"
    HOST = "home.example.org"

    def script(self):
        block = workflow_jobs()["dashboard-deploy"]
        step = block.split("- name: Check that Access answers unauthenticated requests\n", 1)[1]
        body = step.split("        run: |\n", 1)[1]
        lines = []
        for line in body.splitlines():
            if line.strip() and not line.startswith("          "):
                break
            lines.append(line[10:])
        return "\n".join(lines) + "\n"

    def probe(self, *answers):
        """Runs the step; curl answers each request with the next of `answers` ("<code> <location>"), the
        last one repeating."""
        with tempfile.TemporaryDirectory() as root:
            Path(root, "worker").mkdir()
            Path(root, "worker", "wrangler.production.ci.json").write_text(
                json.dumps({"vars": {"ACCESS_ISSUER": self.ISSUER, "PUBLIC_HOST": self.HOST}})
            )
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            Path(root, "answers").write_text("\n".join(answers) + "\n")
            curl = bin_dir / "curl"
            curl.write_text(
                "#!/usr/bin/env bash\n"
                f'answers="{root}/answers"\n'
                # The last answer repeats for every later request.
                'line=$(head -n 1 "$answers")\n'
                'if [ "$(wc -l < "$answers")" -gt 1 ]; then tail -n +2 "$answers" > "$answers.next"; mv "$answers.next" "$answers"; fi\n'
                'printf "%s" "$line"\n'
            )
            (bin_dir / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
            for tool in (curl, bin_dir / "sleep"):
                tool.chmod(0o755)
            env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
            result = subprocess.run(
                ["bash", "-e", "-c", self.script()], cwd=root, env=env, capture_output=True, text=True, check=False
            )
            return result.returncode, result.stdout + result.stderr

    def test_the_login_page_for_this_host_passes(self):
        login = f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}"
        code, output = self.probe(f"302 {login}?kid=abc&redirect_url=%2F", f"302 {login}?kid=abc&redirect_url=%2Fapi")
        self.assertEqual(code, 0, output)
        code, output = self.probe("000 ", f"302 {login}", f"302 {login}/")
        self.assertEqual(code, 0, output)

    def test_a_redirect_to_the_team_domain_root_fails(self):
        """A Redirect Rule to the App Launcher would leave the dashboard unreachable."""
        code, output = self.probe(f"302 {self.ISSUER}/")
        self.assertEqual(code, 1, output)
        self.assertIn("302 to somewhere other than the Access login page", output)

    def test_other_hosts_and_look_alikes_fail(self):
        for location in (
            f"{self.ISSUER}/cdn-cgi/access/login/other.example.org?kid=abc",
            f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}.evil.example?kid=abc",
            f"{self.ISSUER}.evil.example/cdn-cgi/access/login/{self.HOST}",
            f"https://{self.HOST}/login",
        ):
            with self.subTest(location=location):
                code, output = self.probe(f"302 {location}")
                self.assertEqual(code, 1, output)
                self.assertIn("/: 302 to somewhere other than the Access login page", output)

    def test_an_answer_from_the_app_fails(self):
        for answer in ("200 ", "401 "):
            with self.subTest(answer=answer):
                code, output = self.probe(answer)
                self.assertEqual(code, 1, output)
                self.assertIn("was answered with", output)

    def test_no_connection_is_retried_then_fails(self):
        code, output = self.probe("000 ")
        self.assertEqual(code, 1, output)
        self.assertIn("/ never reached Access", output)


if __name__ == "__main__":
    unittest.main()
