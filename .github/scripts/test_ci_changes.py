"""Unit tests for ci_changes.py: python3 -m unittest discover -s .github/scripts"""

import io
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
    lab_check=False,
    lab_deploy=False,
    infra=False,
    flowday_check=False,
    proto=False,
    flowday_deploy=False,
    links_check=False,
    links_deploy=False,
    watch_check=False,
    watch_deploy=False,
):
    return {
        "todofy_check": todofy_check,
        "mail_hero_check": mail_hero_check,
        "dashboard_check": dashboard_check,
        "website_check": website_check,
        "lab_check": lab_check,
        "flowday_check": flowday_check,
        "links_check": links_check,
        "watch_check": watch_check,
        "contracts": contracts,
        "packages": packages,
        "infra": infra,
        "proto": proto,
        "todofy_deploy": todofy_deploy,
        "mail_hero_deploy": mail_hero_deploy,
        "dashboard_deploy": dashboard_deploy,
        "website_deploy": website_deploy,
        "website_relay_deploy": website_relay_deploy,
        "lab_deploy": lab_deploy,
        "flowday_deploy": flowday_deploy,
        "links_deploy": links_deploy,
        "watch_deploy": watch_deploy,
    }


# Every app checked (a contracts/ or .github/ change, FlowDay, the links app and the watch app included); the dashboard
# and Lab each checked and deployed; the edge-auth apps (the website compiles in no package) are todofy and mail-hero
# plus EDGE_AUTH; every app with the website Worker (the relay Worker is added where a test expects it).
ALL_CHECKED = {"dashboard_check": True, "website_check": True, "lab_check": True, "flowday_check": True, "links_check": True, "watch_check": True}
DASH = {"dashboard_check": True, "dashboard_deploy": True}
LAB = {"lab_check": True, "lab_deploy": True}
FLOWDAY = {"flowday_check": True, "flowday_deploy": True}
LINKS = {"links_check": True, "links_deploy": True}
WATCH = {"watch_check": True, "watch_deploy": True}
ALL = {**DASH, **LAB}
# Every app that compiles in packages/edge-auth besides Todofy and Mail Hero: the dashboard, Lab, FlowDay, the links app
# and the watch app, each checked and deployed.
EDGE_AUTH = {**ALL, **FLOWDAY, **LINKS, **WATCH}
EVERY = {**ALL, "website_check": True, "website_deploy": True, **FLOWDAY, **LINKS, **WATCH}


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
        self.assertEqual(push(paths), expect(T, T, T, T, T, **DASH))

    def test_lab_checks_and_deploys_only_itself_plus_contracts(self):
        """Its task-intent-v1 and ops-v1 tests run in Contracts; Todofy and the dashboard are neither checked
        nor deployed by a Lab-only change."""
        for path in ("lab/worker/src/state.ts", "lab/web/src/App.tsx", "lab/migrations/0001_init.sql", "lab/wrangler.toml", "lab/docs/ux.md"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, T, F, F, **LAB))

    def test_flowday_checks_and_deploys_only_itself(self):
        """FlowDay uses no contract (NO_CONTRACTS): its changes run only its checks and, on main, its deploy (F2)."""
        for path in (
            "flowday/worker/src/sync.ts",
            "flowday/web/lib/client/http.ts",
            "flowday/migrations/0001_init.sql",
            "flowday/wrangler.toml",
            "flowday/deploy/deploy-vars.mjs",
            "flowday/web/package-lock.json",
            "flowday/docs/design.md",
            "flowday/README.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, F, F, F, **FLOWDAY))
                self.assertEqual(push([path], ref=BRANCH), expect(F, F, F, F, F, **FLOWDAY))

    def test_every_app_but_the_check_only_ones_has_a_deploy_output(self):
        """Each app has a checks output; each but the CHECK_ONLY ones a deploy output. The watch app left CHECK_ONLY at
        W2 (watch/docs/design.md section 11), as the links app did at L2 and FlowDay at F2: it is empty."""
        self.assertEqual(ci_changes.CHECK_ONLY, set())
        for app in ci_changes.APPS:
            with self.subTest(app=app):
                self.assertIn(f"{ci_changes.PREFIX[app]}_check", ci_changes.KEYS)
                self.assertEqual(f"{ci_changes.PREFIX[app]}_deploy" in ci_changes.KEYS, app not in ci_changes.CHECK_ONLY)

    def test_links_checks_and_deploys_only_itself(self):
        """The links app uses no contract (NO_CONTRACTS): its changes run only its checks and, on main, its deploy
        (L2)."""
        for path in (
            "links/worker/src/resolve.ts",
            "links/web/src/view.ts",
            "links/migrations/0001_init.sql",
            "links/wrangler.toml",
            "links/deploy/deploy-vars.mjs",
            "links/web/package-lock.json",
            "links/docs/design.md",
            "links/README.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, F, F, F, **LINKS))
                self.assertEqual(push([path], ref=BRANCH), expect(F, F, F, F, F, **LINKS))

    def test_watch_checks_and_deploys_only_itself_plus_contracts(self):
        """The watch app proposes task-intent-v1 and answers ops-v1 (Contracts runs both tests): its changes run its
        checks and Contracts and, on main, its deploy (W2); Todofy and the dashboard are neither checked nor deployed."""
        for path in (
            "watch/worker/src/pipeline.ts",
            "watch/web/src/views/add.ts",
            "watch/wrangler.toml",
            "watch/deploy/deploy-vars.mjs",
            "watch/web/package-lock.json",
            "watch/docs/design.md",
            "watch/README.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, T, F, F, **WATCH))
                self.assertEqual(push([path], ref=BRANCH), expect(F, F, T, F, F, **WATCH))

    def test_task_intent_code_deploys_lab_and_todofy(self):
        """TASK_INTENT_LIMITS ship in Lab, the watch app and Todofy's gateway; the schema only in Lab (its types are
        generated).
        proto/'s tests read the contract, so Proto checks runs too (PROTO_READS)."""
        self.assertEqual(
            push(["contracts/task-intent-v1/task-intent-v1.ts"]),
            expect(T, T, T, T, F, **ALL_CHECKED, lab_deploy=T, watch_deploy=T, proto=T),
        )
        self.assertEqual(
            push(["contracts/task-intent-v1/task-intent-v1.schema.json"]),
            expect(T, T, T, F, F, **ALL_CHECKED, lab_deploy=T, proto=T),
        )
        self.assertEqual(
            push(["contracts/task-intent-v1/fixtures/TaskIntent/minimal.json"]), expect(T, T, T, F, F, **ALL_CHECKED, proto=T)
        )

    def test_contracts_recheck_every_app_but_deploy_none(self):
        paths = ["contracts/mail-received-v1/fixtures/plain_text.json"]
        self.assertEqual(push(paths), expect(T, T, T, F, F, **ALL_CHECKED, proto=T))
        self.assertEqual(push(["contracts/README.md"]), expect(T, T, T, F, F, **ALL_CHECKED))

    def test_ops_contract_fixtures_and_docs_recheck_every_app_but_deploy_none(self):
        paths = ["contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json", "contracts/ops-v1/README.md"]
        self.assertEqual(push(paths), expect(T, T, T, F, F, **ALL_CHECKED, proto=T))

    def test_a_contract_proto_tests_read_runs_proto_checks(self):
        """proto/'s tests round-trip every ops-v1 fixture and mail-received-v1 event byte for byte through both codecs
        (and check task-intent-v1's against its schema): a change to those contracts alone runs Proto checks too; a
        document about the contracts does not."""
        for path in (
            "contracts/ops-v1/fixtures/invalid/SetGuardInput/new-case.json",
            "contracts/ops-v1/fixtures/OpsStatus/lab-ok.json",
            "contracts/ops-v1/ops-v1.schema.json",
            "contracts/ops-v1/legacy/ops-v1.schema.json",
            "contracts/task-intent-v1/fixtures/invalid/TaskIntent/new-case.json",
            "contracts/mail-received-v1/fixtures/plain_text.json",
            "contracts/mail-received-v1/mail-received-v1.schema.json",
            "contracts/mail-received-v1/legacy/mail-received-v1.schema.json",
        ):
            with self.subTest(path=path):
                self.assertTrue(push([path])["proto"])
                self.assertTrue(push([path], ref=BRANCH)["proto"])
        self.assertFalse(push(["contracts/README.md"])["proto"])

    def test_validate_mjs_deploys_lab_and_the_generated_ops_schema_deploys_nothing(self):
        """Lab bundles validate.mjs for its task intents; ops-v1's generated schema is a document no Worker bundles (the
        dashboard reads every answer with the generated code)."""
        self.assertEqual(push(["contracts/ops-v1/ops-v1.schema.json"]), expect(T, T, T, F, F, **ALL_CHECKED, proto=T))
        self.assertEqual(
            push(["contracts/ops-v1/validate.mjs"]),
            expect(T, T, T, F, F, dashboard_check=T, **LAB, website_check=T, flowday_check=T, links_check=T, watch_check=T, proto=T),
        )

    def test_contract_code_the_workers_bundle_deploys_every_app_that_bundles_it(self):
        """OPS_LIMITS and friends ship inside all three Workers, so a change must redeploy each."""
        bundled = expect(T, T, T, T, T, **ALL, website_check=T, flowday_check=T, links_check=T, **WATCH, proto=T)
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
            "lab": [REPO / "lab" / "worker" / "src", REPO / "lab" / "web" / "src"],
            "website": [REPO / "website" / "src", REPO / "website" / "relay" / "src"],
            "flowday": [REPO / "flowday" / "worker" / "src", *(REPO / "flowday" / "web" / name for name in ("app", "components", "features", "lib"))],
            "links": [REPO / "links" / "worker" / "src", REPO / "links" / "web" / "src"],
            "watch": [REPO / "watch" / "worker" / "src", REPO / "watch" / "web" / "src"],
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
        self.assertEqual(
            push([".github/workflows/ci.yml"]), expect(T, T, T, F, F, packages=T, infra=T, proto=T, **ALL_CHECKED)
        )
        self.assertEqual(
            push([".github/scripts/ci_changes.py"]), expect(T, T, T, F, F, packages=T, infra=T, proto=T, **ALL_CHECKED)
        )

    def test_infra_runs_only_its_own_checks(self):
        """infra/ (plan-only OpenTofu) and its plan-summary tool check nothing else and deploy nothing."""
        for path in ("infra/access.tf", "infra/README.md", "infra/.terraform.lock.hcl", "tools/infra-plan-summary/summary.py"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, F, F, F, infra=T))
                self.assertEqual(push([path], ref=BRANCH), expect(F, F, F, F, F, infra=T))
        # Not a prefix match on the name alone; another tool does not run them.
        for path in ("infrastructure.md", "tools/other/x.py", "mail-hero/infra/x.tf"):
            with self.subTest(path=path):
                self.assertFalse(push([path])["infra"])
        self.assertEqual(push(["infra/storage.tf", "lab/wrangler.toml"]), expect(F, F, T, F, F, **LAB, infra=T))

    def test_proto_checks_its_users_runs_contracts_and_deploys_only_the_bundles_a_path_reaches(self):
        """proto/ re-checks every PROTO_USERS app and runs Proto checks and Contracts (the contracts' tests check the
        codecs and the generated schemas); it deploys an app only when the changed path reaches that app's bundle."""
        self.assertEqual(
            ci_changes.PROTO_USERS,
            {
                "lab": ("ts",),
                "todofy": ("python", "ts"),
                "flowday": ("ts",),
                "links": ("ts",),
                "mail-hero": ("ts",),
                "dashboard": ("ts",),
                "watch": ("ts",),
            },
        )
        # Todofy is both: todofy-core vendors the Python package, its gateway and UI bundle the TypeScript
        # (todofy.ui.v1).
        ts, python = {"lab", "mail-hero", "dashboard", "flowday", "links", "watch", "todofy"}, {"todofy"}
        every, none = ts | python, set()
        cases = {
            # task-intent-v1, bundled by Lab's and the watch app's TypeScript and todofy-core's Python.
            "proto/todofy/taskintent/v1/task_intent.proto": {"lab", "todofy", "watch"},
            # recommendation-v1 and summary-v1: todofy-core builds the reports, Todofy's gateway and UI read them in
            # todofy.ui.v1's answers.
            "proto/todofy/report/v1/report.proto": {"todofy"},
            # Todofy's owner API: its core answers it, its gateway serves it and its UI calls it.
            "proto/todofy/ui/v1/todofy_ui_service.proto": {"todofy"},
            "proto/todofy/ui/v1/mail_event.proto": {"todofy"},
            # ops-v1: the Ops entrypoints that bundle its generated code (Todofy's gateway takes its types only, its
            # core reads ops.v1 in Python).
            "proto/ops/v1/ops.proto": {"mail-hero", "lab", "todofy", "dashboard", "watch"},
            # mail.received.v1: Mail Hero builds every event, todofy-core reads every body.
            "proto/mailhero/webhook/v1/mail_received.proto": {"mail-hero", "todofy"},
            # Lab's UI API: only Lab imports it (Python does not even generate it).
            "proto/lab/ui/v1/lab_ui_service.proto": {"lab"},
            "proto/lab/ui/v1/deck.proto": {"lab"},
            # FlowDay's UI API reaches only FlowDay.
            "proto/flowday/ui/v1/flowday_ui_service.proto": {"flowday"},
            "proto/flowday/ui/v1/task.proto": {"flowday"},
            # The links app's UI API reaches only the links app.
            "proto/links/ui/v1/links_ui_service.proto": {"links"},
            # The watch app's UI API reaches only the watch app.
            "proto/watch/ui/v1/watch_ui_service.proto": {"watch"},
            # Mail Hero's owner API reaches only Mail Hero (not Todofy, which shares the mailhero/webhook package).
            "proto/mailhero/ui/v2/mail_hero_ui_service.proto": {"mail-hero"},
            "proto/mailhero/ui/v2/errors.proto": {"mail-hero"},
            # The TypeScript runtime and generator: every TypeScript user.
            "proto/ts/wire-json.ts": ts,
            "proto/ts/wire-rules.ts": ts,
            "proto/ts/http-transcoder.ts": ts,
            "proto/ts/rpc-status.ts": ts,
            "proto/ts/package.json": ts,
            "proto/buf.gen.yaml": ts,
            # The Python runtime and generator: only todofy-core vendors the wheel.
            "proto/python/src/ziyixi_proto/wire_json.py": python,
            "proto/python/build_backend.py": python,
            "proto/python/pyproject.toml": python,
            "proto/tools/gen_py.py": python,
            "proto/tools/wire_rules.py": python,
            # The wire profile's own options: both runtimes.
            "proto/common/wire/v1/wire.proto": every,
            # The runtimes' fixtures and a package imported as types only reach no bundle.
            "proto/prototest/v1/prototest.proto": none,
            "proto/prototest/v1/rules.proto": none,
            "proto/common/errors/v1/errors.proto": none,
            # What every generation depends on: every bundled user (fail safe).
            "proto/buf.yaml": every,
            "proto/buf.lock": every,
            "proto/package-lock.json": every,
            "proto/tools/ensure.mjs": every,
            "proto/newapp/ui/v1/newapp_ui_service.proto": every,
            # Checks, tests, test data, types-only output and documents: nothing.
            "proto/README.md": none,
            "proto/test/task-intent.test.ts": none,
            "proto/test/python/test_gen_py.py": none,
            "proto/testdata/wire-profile-cases.json": none,
            "proto/scripts/breaking.sh": none,
            "proto/scripts/api-lint.sh": none,
            "proto/tools/profile_breaking.py": none,
            "proto/tools/gen_wire_ts.py": none,
            "proto/tools/gen_schema.py": none,
            "proto/tools/schema.mjs": none,
            "proto/tools/api-linter/go.mod": none,
            "proto/tools/api-linter/go.sum": none,
            "proto/tsconfig.json": none,
            "proto/vitest.config.ts": none,
            "proto/ruff.toml": none,
            "proto/.gitignore": none,
        }

        def checked_and(deployed: set[str]) -> dict[str, bool]:
            return expect(
                T,
                T,
                T,
                "todofy" in deployed,
                "mail-hero" in deployed,
                proto=T,
                lab_check=T,
                lab_deploy="lab" in deployed,
                dashboard_check=T,
                dashboard_deploy="dashboard" in deployed,
                flowday_check=T,
                flowday_deploy="flowday" in deployed,
                links_check=T,
                links_deploy="links" in deployed,
                watch_check=T,
                watch_deploy="watch" in deployed,
            )

        for path, deployed in cases.items():
            with self.subTest(path=path):
                self.assertEqual(push([path]), checked_and(deployed))
        self.assertFalse(push(["protocol.md"])["proto"])
        # Paths add up: a Python runtime change with a UI API change deploys both.
        self.assertEqual(
            push(["proto/python/src/ziyixi_proto/wire_json.py", "proto/lab/ui/v1/home.proto"]),
            checked_and({"todofy", "lab"}),
        )
        self.assertEqual(ci_changes.proto_deploys("proto/ts/http-transcoder.ts"), ts)
        self.assertEqual(ci_changes.proto_deploys("proto/flowday/ui/v1/flow.proto"), {"flowday"})
        self.assertEqual(ci_changes.proto_deploys("proto/links/ui/v1/link.proto"), {"links"})
        self.assertEqual(ci_changes.proto_deploys("proto/watch/ui/v1/watch.proto"), {"watch"})
        self.assertEqual(ci_changes.proto_deploys("proto/mailhero/ui/v2/message.proto"), {"mail-hero"})

    def test_every_proto_package_and_runtime_is_mapped(self):
        """Each package directory under proto/ (a directory holding .proto files) is in PROTO_PACKAGES, and every
        language a user bundles has a runtime path, so no proto/ path falls back to "every user" by omission."""
        packages = {
            "proto/" + str(path.parent.relative_to(REPO / "proto").parent) + "/"
            for path in (REPO / "proto").rglob("*.proto")
            if "node_modules" not in path.parts and path.parent.name.startswith("v")
        }
        # A package that is part of the runtimes (common/wire: the codecs' own options) is mapped there instead.
        runtime_packages = {prefix for prefix in ci_changes.PROTO_RUNTIMES if prefix in packages}
        self.assertEqual(runtime_packages, {"proto/common/wire/"})
        self.assertEqual(packages - runtime_packages, set(ci_changes.PROTO_PACKAGES))
        languages = {language for languages in ci_changes.PROTO_USERS.values() for language in languages}
        self.assertLessEqual(languages, {language for languages in ci_changes.PROTO_RUNTIMES.values() for language in languages})

    def test_proto_deploys_only_a_user_whose_bundle_compiles_it_in(self):
        saved = ci_changes.PROTO_USERS
        try:
            ci_changes.PROTO_USERS = {"lab": ("ts",), "todofy": ()}
            for path in ("proto/todofy/taskintent/v1/task_intent.proto", "proto/ts/wire-json.ts", "proto/buf.lock"):
                with self.subTest(path=path):
                    self.assertEqual(push([path]), expect(T, F, T, F, F, proto=T, **LAB))
            self.assertEqual(push(["proto/python/build_backend.py"]), expect(T, F, T, F, F, proto=T, lab_check=T))
            ci_changes.PROTO_USERS = {"lab": (), "todofy": ()}
            self.assertEqual(push(["proto/ts/wire-json.ts"]), expect(T, F, T, F, F, proto=T, lab_check=T))
        finally:
            ci_changes.PROTO_USERS = saved

    def test_ci_tooling_under_tools_counts_as_ci(self):
        # tools/cf-guard runs in every deploy job (and the website release): re-check everything, deploy nothing.
        self.assertEqual(push(["tools/cf-guard/cf-guard.mjs"]), expect(T, T, T, F, F, packages=T, proto=T, **ALL_CHECKED))
        self.assertEqual(push(["tools-notes.md"]), expect(F, F, F, F, F))
        # The shared test and build tools (ToolsImports): their importers re-run, nothing deploys.
        for path in ("tools/workerd-cpu/workerd-cpu.mts", "tools/bundle-size/bundle-size.mjs"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(T, T, T, F, F, packages=T, proto=T, **ALL_CHECKED))

    def test_a_shared_package_checks_and_deploys_every_app_that_compiles_it_in(self):
        for path in (
            "packages/edge-auth/src/access.ts",
            "packages/edge-auth/package-lock.json",
            "packages/edge-auth/test/helpers.ts",
        ):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(T, T, T, T, T, packages=T, **EDGE_AUTH))

    def test_a_package_document_checks_every_user_but_deploys_none(self):
        """A README or SPEC is compiled into no Worker: an edit must not redeploy production."""
        for paths in (
            ["packages/edge-auth/SPEC.md"],
            ["packages/edge-auth/README.md", "packages/edge-auth/SPEC.md"],
            ["packages/edge-auth/docs/notes.md"],
        ):
            with self.subTest(paths=paths):
                self.assertEqual(push(paths), expect(T, T, T, F, F, packages=T, dashboard_check=T, lab_check=T, flowday_check=T, links_check=T, watch_check=T))
        # With the package's code, or with one app, the usual rules apply.
        paths = ["packages/edge-auth/SPEC.md", "packages/edge-auth/src/csrf.ts"]
        self.assertEqual(push(paths), expect(T, T, T, T, T, packages=T, **EDGE_AUTH))
        paths = ["packages/edge-auth/SPEC.md", "dashboard/docs/design.md"]
        self.assertEqual(push(paths), expect(T, T, T, F, F, packages=T, **DASH, lab_check=T, flowday_check=T, links_check=T, watch_check=T))
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
        self.assertEqual(
            push(paths),
            expect(T, T, T, F, F, packages=T, infra=T, proto=T, **DASH, website_check=T, lab_check=T, flowday_check=T, links_check=T, watch_check=T),
        )

    def test_a_package_change_with_one_app_still_deploys_every_user(self):
        paths = ["packages/edge-auth/src/csrf.ts", "todofy/gateway/src/csrf.ts"]
        self.assertEqual(push(paths), expect(T, T, T, T, T, packages=T, **EDGE_AUTH))

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

    def test_a_production_config_checks_and_deploys_only_its_app(self):
        """Each Worker's committed production config is that app's code: its app is checked and deployed."""
        self.assertEqual(push(["mail-hero/wrangler.toml"]), expect(F, T, T, F, T))
        for path in ("todofy/wrangler.toml", "todofy/gateway/wrangler.toml", "todofy/deploy/deploy_vars.py"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(T, F, T, T, F))
        for path in ("dashboard/wrangler.toml", "dashboard/deploy/deploy-vars.mjs"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, T, F, F, dashboard_check=T, dashboard_deploy=T))
        for path in ("lab/wrangler.toml", "lab/deploy/deploy-vars.mjs"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, T, F, F, **LAB))
        self.assertEqual(push(["mail-hero/deploy/deploy-vars.mjs"]), expect(F, T, T, F, T))

    def test_a_config_at_the_repo_root_deploys_nothing(self):
        """test_wrangler_configs.py forbids it; were it committed, it would only run the gate."""
        self.assertEqual(push(["wrangler.toml"]), expect(F, F, F, F, F))

    def test_backup_tool_counts_as_mail_hero(self):
        self.assertEqual(push(["mail-hero/deploy/backup/Dockerfile"]), expect(F, T, T, F, T))

    def test_a_rename_between_apps_touches_both(self):
        paths = ["todofy/api/mail-received-v1.schema.json", "contracts/mail-received-v1/mail-received-v1.schema.json"]
        self.assertEqual(push(paths), expect(T, T, T, T, F, **ALL_CHECKED, proto=T))

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
        # Not a prefix match on the folder name alone; a site change alone never redeploys the relay.
        self.assertEqual(push(["website/relay.md"]), expect(F, F, F, F, F, website_check=T, website_deploy=T))
        self.assertEqual(push(["website/src/app/page.tsx"])["website_relay_deploy"], False)
        self.assertEqual(
            push(["website/relay/src/index.ts"], ref=BRANCH),
            expect(F, F, F, F, F, website_check=T, website_relay_deploy=T),
        )

    def test_the_retired_apex_worker_left_no_deploy_path(self):
        """website/apex-redirect/ (the apex -> www 308 Worker) was retired on 2026-10-01: the apex is a Custom
        Domain of the site Worker now. No output or job is left for it, and a path there (its deletion) is an
        ordinary site change that releases the site."""
        self.assertNotIn("website_apex_deploy", ci_changes.KEYS)
        self.assertFalse((REPO / "website" / "apex-redirect").exists())
        for path in ("website/apex-redirect/src/index.ts", "website/apex-redirect/wrangler.toml"):
            with self.subTest(path=path):
                self.assertEqual(push([path]), expect(F, F, F, F, F, website_check=T, website_deploy=T))
        self.assertEqual(
            push(["website/apex-redirect/src/index.ts", "website/relay/src/github.ts"]),
            expect(F, F, F, F, F, website_check=T, website_deploy=T, website_relay_deploy=T),
        )
        self.assertNotIn("website-apex-deploy", workflow_jobs())
        self.assertNotIn("apex-redirect", WORKFLOW.read_text())

    def test_the_release_workflow_rechecks_every_app_but_deploys_none(self):
        self.assertEqual(
            push([".github/workflows/website-release.yml"]),
            expect(T, T, T, F, F, packages=T, infra=T, proto=T, **ALL_CHECKED),
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
        result, _, base = ci_changes.decide(
            "schedule", MAIN, SHA, "", BASE, lambda b, a: [], lambda b, a: True, lambda a: BASE
        )
        self.assertEqual(result, ci_changes.everything())
        self.assertEqual(base, "")


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

    def test_the_diff_base_is_an_output(self):
        def base(ref, **kwargs):
            return ci_changes.decide(
                "push", ref, SHA, "", kwargs.get("last_success", BASE), lambda b, a: [], lambda b, a: True,
                lambda a: kwargs.get("merge_base", "c" * 40),
            )[2]

        self.assertEqual(base(MAIN), BASE)
        self.assertEqual(base(BRANCH), "c" * 40)
        # Everything runs without a base: Proto checks then falls back to HEAD~1 (proto/scripts/breaking.sh).
        self.assertEqual(base(MAIN, last_success=""), "")
        self.assertEqual(base(BRANCH, merge_base=""), "")

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
        self.assertEqual(self.dispatch("both"), expect(T, T, T, T, T, packages=T, proto=T))
        self.assertEqual(self.dispatch(""), expect(T, T, T, T, T, packages=T, proto=T))
        self.assertEqual(
            self.dispatch("all"),
            expect(T, T, T, T, T, packages=T, proto=T, **EVERY, website_relay_deploy=T),
        )
        self.assertEqual(self.dispatch("todofy"), expect(T, F, T, T, F, packages=T, proto=T))
        self.assertEqual(self.dispatch("mail-hero"), expect(F, T, T, F, T, packages=T, proto=T))
        self.assertEqual(self.dispatch("dashboard"), expect(F, F, T, F, F, packages=T, proto=T, **DASH))
        self.assertEqual(self.dispatch("lab"), expect(F, F, T, F, F, packages=T, proto=T, **LAB))
        self.assertEqual(self.dispatch("flowday"), expect(F, F, T, F, F, packages=T, proto=T, **FLOWDAY))
        self.assertEqual(self.dispatch("links"), expect(F, F, T, F, F, packages=T, proto=T, **LINKS))
        self.assertEqual(
            self.dispatch("website"),
            expect(
                F,
                F,
                T,
                F,
                F,
                packages=T, proto=T,
                website_check=T,
                website_deploy=T,
                website_relay_deploy=T,
            ),
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
        outputs = self.run_main(EVENT_NAME="push", REF=ref, AFTER=after, DISPATCH_APP="", LAST_SUCCESS=last_success)
        # Without a token there is no run to reuse: the checks run (Reuse covers the lookup).
        self.assertEqual(outputs["checks_reused"], "false")
        return {key: outputs[key] for key in ci_changes.KEYS}

    def test_a_cancelled_pending_run_on_main_is_not_lost(self):
        # Run 1 (green) at p0; push 2 touched todofy/ and was cancelled while pending; push 3 touched
        # only Mail Hero docs. Run 3 must still check and deploy Todofy.
        p0 = self.commit("README.md")
        self.commit("todofy/worker/a.py")
        p3 = self.commit("mail-hero/docs/b.md")
        outputs = self.main_run(p3, p0)
        expected = {**dict.fromkeys(ci_changes.KEYS, "true"), "packages": "false", "infra": "false", "proto": "false"}
        expected.update(dashboard_check="false", dashboard_deploy="false")
        expected.update(website_check="false", website_deploy="false", website_relay_deploy="false")
        expected.update(lab_check="false", lab_deploy="false", flowday_check="false", flowday_deploy="false", links_check="false", links_deploy="false", watch_check="false", watch_deploy="false")
        self.assertEqual(outputs, expected)

    def test_a_failed_package_run_on_main_deploys_both_apps_next_time(self):
        green = self.commit("README.md")
        self.commit("packages/edge-auth/src/access.ts")
        after = self.commit("README.md.orig")
        outputs = self.main_run(after, green)
        unaffected = {"website_check", "website_deploy", "website_relay_deploy"}
        self.assertEqual({key for key in ci_changes.KEYS if outputs[key] == "false"}, unaffected | {"infra", "proto"})

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
        self.assertEqual(tops - {"packages", "contracts", "proto"}, set(ci_changes.APPS))


class ToolsImports(unittest.TestCase):
    """A tools/ change deploys nothing (classify), which holds only while no Worker or UI bundle carries any of it. An
    app imports a shared tool (tools/workerd-cpu, tools/bundle-size) by relative path from its tests and its build or
    deploy scripts only, never from the sources it ships; and the Changes job runs every tool's own tests."""

    IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]*/tools/[^'"]*)['"]""")
    # Directories whose files never reach a bundle.
    NOT_SHIPPED = {"test", "tests", "__tests__", "scripts", "deploy"}
    SOURCES = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")

    @staticmethod
    def tracked():
        out = subprocess.run(
            ["git", "-C", str(REPO), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            check=True,
            capture_output=True,
        ).stdout.decode()
        return [Path(name) for name in out.split("\0") if name]

    def importers(self):
        """App source file (relative) -> the tools/ files it imports."""
        found = {}
        for name in self.tracked():
            if name.parts[0] not in ci_changes.APPS or name.suffix not in self.SOURCES or "node_modules" in name.parts:
                continue
            path = REPO / name
            if not path.is_file():
                continue
            for specifier in self.IMPORT.findall(path.read_text(errors="ignore")):
                target = (path.parent / specifier).resolve()
                if target.is_relative_to(REPO / "tools"):
                    found.setdefault(name, []).append(str(target.relative_to(REPO)))
        return found

    def test_only_tests_and_scripts_import_a_tool(self):
        importers = self.importers()
        # The apps' CPU tests and bundle budgets.
        for name in (
            "lab/worker/test/runtime/cpu.test.ts",
            "flowday/worker/test/runtime/cpu.test.ts",
            "mail-hero/cloudflare/test/cpu/native-ops-cpu.test.mjs",
            "dashboard/worker/test/runtime/cpu.test.ts",
            "lab/deploy/bundle-size.mjs",
            "lab/web/scripts/js-budget.mjs",
            "flowday/worker/scripts/bundle-size.mjs",
            "flowday/web/scripts/js-budget.mjs",
            "mail-hero/deploy/bundle-size.mjs",
            "dashboard/deploy/bundle-size.mjs",
        ):
            self.assertIn(Path(name), importers)
        for name, targets in importers.items():
            with self.subTest(file=str(name)):
                self.assertTrue(self.NOT_SHIPPED & set(name.parts[:-1]), f"{name} ships, but imports {targets}")
                for target in targets:
                    self.assertTrue((REPO / target).is_file(), target)

    def test_the_import_pattern_finds_relative_tool_imports(self):
        text = (
            "import { connectCpuMeter } from '../../../../tools/workerd-cpu/workerd-cpu.mts';\n"
            "import {\n  checkWorkerBundle,\n} from '../../tools/bundle-size/bundle-size.mjs'\n"
            "const x = await import('../tools/x.mjs')\n"
            "import { y } from '@ziyixi/proto/ts/y'\n"
        )
        self.assertEqual(
            self.IMPORT.findall(text),
            ["../../../../tools/workerd-cpu/workerd-cpu.mts", "../../tools/bundle-size/bundle-size.mjs", "../tools/x.mjs"],
        )

    def test_the_changes_job_runs_every_tools_own_tests(self):
        changes = workflow_jobs()["changes"]
        for test_dir in sorted((REPO / "tools").glob("*/test")):
            kinds = sorted({path.name.split(".test.", 1)[1] for path in test_dir.glob("*.test.*")})
            for kind in kinds:
                with self.subTest(tool=test_dir.parent.name, kind=kind):
                    self.assertRegex(changes, rf"run: node --test .*tools/{test_dir.parent.name}/test/\*\.test\.{kind}\b")


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
                # ops-v1: each app's answers keep their golden bytes and the contract's rules (the wire codec and the
                # legacy schema older dashboards check), and the reference validator's verdict on the generated schema.
                "mail-hero/cloudflare/test/ops-golden.test.mjs",
                "mail-hero/cloudflare/test/native-ops.test.mjs",
                "todofy/tests/unit/test_ops_contract.py",
                "todofy/tests/unit/test_ops_core.py",
                "todofy/tests/unit/test_ops_golden.py",
                "todofy/gateway/test/ops.test.ts",
                "lab/worker/test/ops-golden.test.ts",
                # ops-v1 caller: the dashboard calls only declared methods, handles every error code and keeps the
                # bytes it read and sent before the move onto proto/.
                "dashboard/worker/test/ops-client.test.ts",
                "dashboard/worker/test/ops-golden.test.ts",
                # task-intent-v1: both validators give every fixture the same verdict; Lab's intents and
                # its reading of every result state; Todofy's gateway forwards the two methods.
                "lab/worker/test/task-intent-contract.test.ts",
                "lab/worker/test/intent.test.ts",
                "todofy/tests/unit/test_task_intent_contract.py",
                # The watch app's digest and urgent intents (the contract's watch fixtures, byte for byte) and its
                # ops-v1 answers.
                "watch/worker/test/todofy.test.ts",
                "watch/worker/test/ops-golden.test.ts",
            },
            self.named_tests(),
        )


class DeployConditions(unittest.TestCase):
    """Every job that needs "CI gate" must spell out its status checks.

    "CI gate" needs every app's check job; some are skipped whenever only another app changed. A job
    condition without a status function gets an implicit success() that also looks at skipped
    ancestors, so a single-app deploy would be skipped (actions/runner#491, #2205).
    """

    # (job, need) pairs where "skipped" is as good as "success": the dashboard deploys after the app
    # deploys (its service bindings need their Ops entrypoints), and Lab and the watch app after Todofy's (their
    # TODOFY bindings name Todofy's Ops), which do not run when nothing of that app changed.
    SKIPPED_OK = {
        ("dashboard-deploy", "todofy-deploy"),
        ("dashboard-deploy", "mail-hero-deploy"),
        ("dashboard-deploy", "lab-deploy"),
        ("dashboard-deploy", "watch-deploy"),
        ("lab-deploy", "todofy-deploy"),
        ("watch-deploy", "todofy-deploy"),
    }

    # Check jobs a deploy may also find skipped, but only when this push to main reuses a green branch run of
    # the same commit (ci_changes.py find_reusable); "changes" and "gate" must always succeed.
    CHECK_JOBS = {
        "todofy-static",
        "todofy-runtime",
        "todofy-checks",
        "mail-hero-checks",
        "dashboard-checks",
        "website-checks",
        "lab-checks",
        "flowday-checks",
        "links-checks",
        "watch-checks",
    }

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
            {
                "todofy-deploy",
                "mail-hero-deploy",
                "dashboard-deploy",
                "website-deploy",
                "website-relay-deploy",
                "lab-deploy",
                "flowday-deploy",
                "links-deploy",
                "watch-deploy",
            },
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
                    elif need in self.CHECK_JOBS:
                        self.assertIn(
                            f"(needs.{need}.result == 'success' || (needs.changes.outputs.checks_reused == 'true' "
                            f"&& needs.{need}.result == 'skipped'))",
                            condition,
                        )
                        self.assertEqual(condition.count(f"needs.{need}.result == 'skipped'"), 1)
                    else:
                        self.assertIn(f"needs.{need}.result == 'success'", condition)
                        self.assertNotIn(f"needs.{need}.result == 'skipped'", condition)
                self.assertIn("github.ref == 'refs/heads/main'", condition)

    def test_the_dashboard_deploys_after_the_apps_and_lab_and_watch_after_todofy(self):
        self.assertLessEqual({"todofy-deploy"}, set(self.needs(self.jobs()["lab-deploy"])))
        self.assertLessEqual({"todofy-deploy"}, set(self.needs(self.jobs()["watch-deploy"])))
        block = self.jobs()["dashboard-deploy"]
        self.assertLessEqual({"todofy-deploy", "mail-hero-deploy", "lab-deploy", "watch-deploy"}, set(self.needs(block)))
        self.assertIn("group: dashboard-production", block)
        # The only token: the one Todofy deploy uses; no other secret reaches wrangler's environment.
        # (the hostname guard's step and the deploy step).
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}", block)
        self.assertEqual(block.count("CLOUDFLARE_API_TOKEN:"), 2)
        self.assertEqual(block.count("CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}"), 2)
        # deploy-vars.mjs compares (never writes) the deploy token, to warn when it is the analytics token.
        secrets = block.split("- name: Write the Worker secrets file\n", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}", secrets)

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
                "lab-deploy": "lab-production",
                "flowday-deploy": "flowday-production",
                "links-deploy": "links-production",
                "watch-deploy": "watch-production",
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
            ("lab-deploy", "lab-checks", "lab_deploy"),
            ("flowday-deploy", "flowday-checks", "flowday_deploy"),
            ("links-deploy", "links-checks", "links_deploy"),
            ("watch-deploy", "watch-checks", "watch_deploy"),
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
                # ...into an env var that the loop over results reads.
                variable = re.search(rf"^ +(\w+): \$\{{\{{ needs\.{need}\.result \}}\}}$", gate, re.MULTILINE)
                self.assertIsNotNone(variable, need)
                self.assertRegex(gate, rf'"[^"=]+=\${variable.group(1)}"')

    def test_changes_exports_every_output_and_each_is_used(self):
        blocks = self.jobs()
        for key in ci_changes.KEYS:
            with self.subTest(output=key):
                self.assertIn(f"{key}: ${{{{ steps.decide.outputs.{key} }}}}", blocks["changes"])
                users = [name for name, block in blocks.items() if f"needs.changes.outputs.{key} == 'true'" in block]
                self.assertTrue(users, key)

    def test_changes_exports_the_reuse_outputs_and_the_gate_prints_them(self):
        blocks = self.jobs()
        for key in ci_changes.REUSE_KEYS:
            with self.subTest(output=key):
                self.assertIn(f"{key}: ${{{{ steps.decide.outputs.{key} }}}}", blocks["changes"])
                self.assertIn(f"${{{{ needs.changes.outputs.{key} }}}}", blocks["gate"])
        decide = blocks["changes"].split("- name: Decide which apps to check and deploy\n", 1)[1]
        self.assertIn("GH_TOKEN: ${{ github.token }}", decide)
        # Reading this workflow's runs and jobs needs actions: read, nothing more.
        self.assertIn("      actions: read\n", blocks["changes"])
        self.assertNotIn("write", blocks["changes"].split("    steps:", 1)[0])

    def test_check_jobs_map_names_to_the_outputs_that_run_them(self):
        """CHECK_JOBS (what a reused run must have passed) names each job that a check output runs."""
        blocks = self.jobs()
        named = {}
        for job, block in blocks.items():
            name = re.search(r"^    name: (.+)$", block, re.MULTILINE).group(1)
            flag = re.search(r"needs\.changes\.outputs\.(\w+) == 'true'", self.condition(block))
            if flag and flag.group(1) in ci_changes.CHECK_JOBS and "gate" not in self.needs(block):
                named.setdefault(flag.group(1), set()).add(re.sub(r" \(\$\{\{ matrix\.shard \}\}/\d+\)$", " (*)", name))
        self.assertEqual(named, {key: set(names) for key, names in ci_changes.CHECK_JOBS.items()})
        self.assertEqual(set(ci_changes.CHECK_JOBS), {key for key in ci_changes.KEYS if not key.endswith("_deploy")})
        for always in ci_changes.ALWAYS_JOBS:
            self.assertIn(f"    name: {always}\n", WORKFLOW.read_text())

    def test_shared_packages_run_only_when_flagged(self):
        self.assertEqual(self.condition(self.jobs()["shared-packages"]), "needs.changes.outputs.packages == 'true'")


class InfraJob(unittest.TestCase):
    """Infra checks is plan-free and secret-free: it validates infra/ and never touches Cloudflare or state
    (infra/README.md). A plan job with a read token is a later, separate step."""

    def test_checks_only_with_no_credentials_plan_or_artifact(self):
        block = workflow_jobs()["infra-checks"]
        self.assertIn("    if: needs.changes.outputs.infra == 'true'\n", block)
        for forbidden in ("secrets.", "environment:", "tofu plan", "tofu apply", "tofu import", "tofu show",
                          "upload-artifact", "CLOUDFLARE_API_TOKEN", "AWS_"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, block)
        for required in (
            "tofu fmt -check -recursive",
            "tofu init -backend=false -input=false -lockfile=readonly",
            "tofu validate",
            "tofu_wrapper: false",
            "python3 -m unittest discover -s ../tools/infra-plan-summary",
            "python3 -m unittest discover -s tests",
            'data[[:space:]]+"?(external|http)"?',
            "provisioner[[:space:]]+",
            "grep -rlIE",
            "git ls-files -- .",
            "python3 ../.github/scripts/infra_guard.py .",
        ):
            with self.subTest(required=required):
                self.assertIn(required, block)

    def test_the_installed_tofu_meets_the_required_version(self):
        installed = re.search(r"tofu_version: (\d+)\.(\d+)\.(\d+)\n", workflow_jobs()["infra-checks"])
        self.assertIsNotNone(installed, "pin an exact OpenTofu version")
        required = re.search(r'required_version = ">= (\d+)\.(\d+)\.0, < (\d+)\.(\d+)\.0"', (REPO / "infra" / "versions.tf").read_text())
        self.assertIsNotNone(required)
        version = tuple(int(part) for part in installed.groups())
        self.assertGreaterEqual(version[:2], (int(required.group(1)), int(required.group(2))))
        self.assertLess(version[:2], (int(required.group(3)), int(required.group(4))))


class WebsiteRelease(unittest.TestCase):
    """Website deploy dispatches the one release workflow the Notion relay dispatches and returns at once;
    the release's jobs hold the single concurrency group and the production environment, so a push release,
    a button, the detector and a status refresh never overlap, every release is a run of that workflow (the
    relay sees it), and a main CI run never waits for a queued release."""

    RELEASE = REPO / ".github" / "workflows" / "website-release.yml"

    def release_jobs(self):
        text = self.RELEASE.read_text().split("\njobs:\n", 1)[1]
        starts = [(m.start(), m.group(1)) for m in re.finditer(r"^  ([a-z][a-z0-9-]*):\n", text, re.MULTILINE)]
        return {
            name: text[start : starts[index + 1][0] if index + 1 < len(starts) else len(text)]
            for index, (start, name) in enumerate(starts)
        }

    def test_website_deploy_dispatches_the_release_workflow_with_fixed_inputs(self):
        block = workflow_jobs()["website-deploy"]
        self.assertNotIn("uses: ./.github/workflows/website-release.yml", block)
        self.assertIn("gh workflow run website-release.yml --repo \"$GITHUB_REPOSITORY\" --ref main", block)
        for flag in (
            "-f operation=release",
            "-f confirmation=release:www.ziyixi.science",
            "-f force_build=false",
            "-f allow_empty=false",
            "-f trigger=push",
        ):
            self.assertIn(flag, block)
        # Only the dispatch permission; no environment, secret or lock of its own.
        self.assertIn("      actions: write\n", block)
        self.assertNotIn("contents:", block)
        self.assertNotIn("deployments:", block)
        self.assertNotIn("concurrency:", block)
        self.assertNotIn("environment:", block)
        self.assertNotIn("secrets.", block)
        # Nothing calls the release inline any more.
        self.assertNotIn("workflow_call:", self.RELEASE.read_text())

    def test_every_release_builds_a_commit_that_passed_the_ci_gate(self):
        jobs = self.release_jobs()
        for name, block in jobs.items():
            if name == "scheduled":
                continue
            with self.subTest(job=name):
                pin = block.index("- name: Check out the newest main commit that passed the CI gate\n")
                install = block.index("- name: Install the pinned pnpm and locked dependencies\n")
                self.assertLess(pin, install)
                self.assertIn("scripts/release/green-commit.ts", block[pin:install])
                self.assertIn('git -c advice.detachedHead=false checkout --detach "$sha"', block[pin:install])
                self.assertIn("          fetch-depth: 0\n", block)
        self.assertIn("run: pnpm release context", jobs["release"])

    def test_every_release_job_shares_one_group_and_the_production_environment(self):
        jobs = self.release_jobs()
        self.assertEqual(set(jobs), {"scheduled", "scheduled-dispatch", "release", "status"})
        for name, block in jobs.items():
            if name in ("scheduled", "scheduled-dispatch"):
                continue
            with self.subTest(job=name):
                self.assertIn("      group: website-production\n", block)
                self.assertIn("      cancel-in-progress: false\n", block)
                self.assertIn("      name: production\n", block)

    def test_the_relay_and_the_workflow_agree_on_operations_and_triggers(self):
        text = self.RELEASE.read_text()
        # A dispatched run is "Website <operation> (<trigger>)", which the relay parses; a scheduled run has
        # its own name, which the relay's parser does not match: it never releases, it dispatches
        # "Website release (reconcile)".
        self.assertIn(
            "run-name: ${{ github.event_name == 'schedule' && 'Website scheduled reconcile' || "
            "format('Website {0} ({1})', inputs.operation, inputs.trigger) }}",
            text,
        )
        self.assertIn("        options: [release, status, bootstrap, recovery]", text)
        self.assertIn("        options: [manual, button, cron, reconcile, pending, push]", text)
        relay = (REPO / "website" / "relay" / "src" / "github.ts").read_text()
        self.assertIn("(release|status|bootstrap|recovery) \\((manual|button|cron|reconcile|pending|push)\\)", relay)
        # The scheduled check reads dispatched run names exactly as the relay does.
        scheduled = (REPO / "website" / "scripts" / "release" / "scheduled-reconcile.ts").read_text()
        self.assertIn("(release|status|bootstrap|recovery) \\((manual|button|cron|reconcile|pending|push)\\)", scheduled)
        self.assertIn('export const SCHEDULED_RUN_NAME = "Website scheduled reconcile";', scheduled)
        config = (REPO / "website" / "relay" / "wrangler.toml").read_text()
        self.assertIn('RELEASE_WORKFLOW = "website-release.yml"', config)
        self.assertIn('GITHUB_REPOSITORY = "ziyixi/todofy"', config)

    def test_only_the_release_steps_see_credentials(self):
        text = self.RELEASE.read_text()
        self.assertNotIn("secrets.VERCEL", text)
        # Notion credentials only for the snapshot and the feedback; the deploy token only for Cloudflare steps.
        notion = [line for line in text.splitlines() if "secrets.WEBSITE_NOTION_TOKEN" in line]
        self.assertEqual(len(notion), 4)
        cloudflare = [line for line in text.splitlines() if "secrets.CF_API_TOKEN" in line]
        self.assertEqual(len(cloudflare), 6)
        # GITHUB_TOKEN never in a job or workflow env (install scripts, builds and tests would see it): only
        # in the env of the steps that read the CI results or read and write the release records.
        steps = [step for job in self.release_jobs().values() for step in job.split("\n      - ")[1:]]
        with_token = sorted(
            step.split("\n", 1)[0].removeprefix("name: ")
            for step in steps
            if "GITHUB_TOKEN: ${{ github.token }}" in step
        )
        self.assertEqual(
            with_token,
            sorted(
                [
                    "Check out the newest main commit that passed the CI gate",
                    "Check out the newest main commit that passed the CI gate",
                    "Check out the newest main commit that passed the CI gate",
                    "Check out the newest main commit that passed the CI gate",
                    "Decide whether today's reconcile release is due",
                    "Dispatch the reconcile release unless the relay would hold it",
                    "Assert the trusted release context and the pinned commit",
                    "Enforce the GitHub Deployment state gate",
                    "Reconcile a blocked release with what production serves",
                    "Record the release in progress",
                    "Mark the release successful",
                    "Record the failure",
                ]
            ),
        )
        self.assertEqual(text.count("GITHUB_TOKEN: ${{ github.token }}"), len(with_token))
        self.assertNotIn("GH_TOKEN", text)


class WebsiteScheduledReconcile(unittest.TestCase):
    """The daily schedule of website-release.yml stands in for the relay's reconcile dispatch: a check job with no
    environment, secret or install decides; a dispatch job checks again, holds during the relay's quiet period and
    dispatches exactly the relay's reconcile release ("Website release (reconcile)", which the relay sees as its
    own). A scheduled run never runs the release or status job itself."""

    RELEASE = REPO / ".github" / "workflows" / "website-release.yml"

    def jobs(self):
        return WebsiteRelease().release_jobs()

    def test_the_schedule_runs_hourly_after_the_relays_reconcile_hour(self):
        text = self.RELEASE.read_text()
        on = text.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
        self.assertEqual(re.findall(r"^    - cron: '([^']+)'$", on, re.MULTILINE), ["30 10-15 * * *"])
        relay = (REPO / "website" / "relay" / "wrangler.toml").read_text()
        self.assertIn('RECONCILE_UTC_HOUR = "10"\n', relay)
        self.assertNotIn("workflow_call:", text)

    def test_the_check_job_has_no_environment_secret_or_install_and_reads_only(self):
        block = self.jobs()["scheduled"]
        self.assertIn("    if: github.event_name == 'schedule' && vars.WEBSITE_SCHEDULED_RECONCILE != 'false'\n", block)
        for absent in ("environment:", "secrets.", "concurrency:", "pnpm", "npm ", "write"):
            with self.subTest(absent=absent):
                self.assertNotIn(absent, block)
        # checks: read for green-commit.ts (the CI gate's check runs), as the workflow-level block grants it.
        self.assertIn(
            "    permissions:\n      contents: read\n      actions: read\n      checks: read\n      deployments: read\n",
            block,
        )
        pin = block.index("- name: Check out the newest main commit that passed the CI gate\n")
        decide = block.index("- name: Decide whether today's reconcile release is due\n")
        self.assertLess(pin, decide)
        self.assertIn('git -c advice.detachedHead=false checkout --detach "$sha"', block[pin:decide])
        self.assertIn("node --disable-warning=ExperimentalWarning scripts/release/scheduled-reconcile.ts", block[decide:])
        self.assertIn("due: ${{ steps.decide.outputs.due }}", block)
        self.assertTrue((REPO / "website" / "scripts" / "release" / "scheduled-reconcile.ts").is_file())

    def test_the_dispatch_job_runs_only_when_due_and_only_dispatches(self):
        block = self.jobs()["scheduled-dispatch"]
        self.assertIn("    needs: scheduled\n", block)
        condition = " ".join(block.split("    if: >-\n", 1)[1].split("\n    runs-on:", 1)[0].split())
        self.assertEqual(
            condition,
            "${{ !cancelled() && github.event_name == 'schedule' "
            "&& needs.scheduled.result == 'success' && needs.scheduled.outputs.due == 'true' }}",
        )
        # Dispatch and read; no release record, no Cloudflare token, no lock of its own (the dispatched release
        # takes the lock).
        self.assertIn(
            "    permissions:\n      contents: read\n      actions: write\n      checks: read\n      deployments: read\n",
            block,
        )
        self.assertIn("      name: production\n", block)
        self.assertNotIn("concurrency:", block)
        self.assertNotIn("CF_API_TOKEN", block)
        self.assertNotIn("wrangler", block)
        self.assertNotIn("pnpm release", block)
        # The Notion secrets only in the dispatch step, after the install.
        install = block.index("- name: Install the pinned pnpm and locked dependencies\n")
        dispatch = block.index("- name: Dispatch the reconcile release unless the relay would hold it\n")
        self.assertLess(install, dispatch)
        self.assertNotIn("secrets.", block[:dispatch])
        self.assertIn("run: node --import tsx scripts/release/scheduled-dispatch.ts", block[dispatch:])
        self.assertTrue((REPO / "website" / "scripts" / "release" / "scheduled-dispatch.ts").is_file())

    def test_a_scheduled_run_never_runs_the_release_or_status_job(self):
        jobs = self.jobs()
        self.assertIn(
            "    if: github.event_name == 'workflow_dispatch' && inputs.operation != 'status'\n", jobs["release"]
        )
        self.assertIn(
            "    if: github.event_name == 'workflow_dispatch' && inputs.operation == 'status'\n", jobs["status"]
        )
        self.assertNotIn("needs:", jobs["release"])
        self.assertNotIn("schedule", jobs["release"])
        # The release reads only the dispatch inputs; the dispatch job sends the relay's (releaseInputs).
        for line in (
            "RELEASE_OPERATION: ${{ inputs.operation }}",
            "RELEASE_CONFIRMATION: ${{ inputs.confirmation }}",
            "ALLOW_EMPTY: ${{ inputs.allow_empty }}",
            "FORCE_BUILD: ${{ inputs.force_build }}",
        ):
            with self.subTest(line=line):
                self.assertIn(f"      {line}\n", jobs["release"])
        dispatch = (REPO / "website" / "scripts" / "release" / "scheduled-dispatch.ts").read_text()
        self.assertIn('releaseInputs(env, "reconcile")', dispatch)
        self.assertIn('export const RECONCILE_RUN_NAME = "Website release (reconcile)";', dispatch)


class WebsiteChecks(unittest.TestCase):
    """Website checks test and dry-run exactly the website's two Workers (the site and the Notion relay)."""

    def test_website_checks_test_and_dry_run_both_workers(self):
        block = workflow_jobs()["website-checks"]
        self.assertIn("pnpm check", block)
        self.assertIn("pnpm exec wrangler deploy --dry-run --config wrangler.toml\n", block)
        self.assertIn("pnpm exec wrangler deploy --dry-run --config relay/wrangler.toml", block)
        self.assertEqual(block.count("wrangler deploy --dry-run"), 2)
        # The import guard covers every source directory of both Workers and the tests.
        self.assertIn("src scripts relay/src tests; then exit 1; fi", block)
        vitest = (REPO / "website" / "vitest.config.ts").read_text()
        self.assertIn('include: ["tests/unit/**/*.test.ts"],', vitest)


class TodofyJobs(unittest.TestCase):
    """Todofy's checks are split into "Todofy static checks", the "Todofy runtime" shards and "Todofy checks".

    Splitting must not drop a check: every change that checks Todofy runs all three, "Todofy checks" (what
    "Todofy deploy" needs) passes only when the other two passed and the shards ran every collected runtime
    test once (pytest_completeness.py), and nothing selects, deselects or retries runtime tests.
    """

    FLAG = "needs.changes.outputs.todofy_check == 'true'"

    def setUp(self):
        self.blocks = workflow_jobs()
        self.conditions = DeployConditions()

    @staticmethod
    def code(block):
        """The block without its comment lines (comments before the next job belong to this block)."""
        return "\n".join(line for line in block.splitlines() if not line.lstrip().startswith("#"))

    def pytest_commands(self, job):
        """Every pytest command of a job, with its continuation lines."""
        commands = re.findall(r"^ +(uv run pytest (?:.*\\\n)*.*)$", self.code(self.blocks[job]), re.MULTILINE)
        self.assertTrue(commands, job)
        return commands

    def shards(self):
        match = re.search(r"^        shard: \[([\d, ]+)\]$", self.blocks["todofy-runtime"], re.MULTILINE)
        self.assertIsNotNone(match)
        return [int(value) for value in match.group(1).split(",")]

    def test_todofy_checks_requires_the_static_checks_and_every_shard(self):
        block = self.blocks["todofy-checks"]
        self.assertIn("    name: Todofy checks\n", block)
        self.assertEqual(self.conditions.needs(block), ["changes", "todofy-static", "todofy-runtime"])
        # Runs after a failed shard (to report it) but never turns a cancelled run into a pass.
        self.assertEqual(self.conditions.condition(block), f"${{{{ !cancelled() && {self.FLAG} }}}}")
        first = re.split(r"^      - ", block, flags=re.MULTILINE)[1]
        self.assertIn("STATIC: ${{ needs.todofy-static.result }}", first)
        self.assertIn("RUNTIME: ${{ needs.todofy-runtime.result }}", first)
        self.assertIn('[ "$STATIC" = success ] && [ "$RUNTIME" = success ]', first)

    def test_static_and_runtime_run_whenever_todofy_is_checked(self):
        for job in ("todofy-static", "todofy-runtime"):
            with self.subTest(job=job):
                self.assertEqual(self.conditions.needs(self.blocks[job]), [])  # needs: changes only
                self.assertIn("    needs: changes\n", self.blocks[job])
                self.assertEqual(self.conditions.condition(self.blocks[job]), self.FLAG)

    def test_the_static_job_keeps_every_check_but_the_runtime_suite(self):
        block = self.blocks["todofy-static"]
        for command in (
            "npm ci --no-audit --no-fund\n          uv sync --locked",
            "uv run ruff check worker tests tools deploy",
            "uv run ruff format --check worker tests tools deploy",
            "uv run pytest tests/unit tests/fakes tools deploy",
            "npm run lint\n          npm run typecheck\n          npm test\n          npm run test:runtime",
            "npm ci --no-audit --no-fund\n          npm run typecheck\n          npm test\n          npm run build",
            "if grep -rnE 'mail_hero|mail-hero' src; then exit 1; fi",
            'uv run python deploy/deploy_vars.py secrets core "$RUNNER_TEMP/todofy-core-secrets.json"',
            'uv run python deploy/deploy_vars.py secrets gateway "$RUNNER_TEMP/todofy-gateway-secrets.json"',
            "uv run python deploy/deploy_vars.py exec core -- uv run pywrangler deploy --dry-run --config wrangler.toml",
            '--secrets-file "$RUNNER_TEMP/todofy-core-secrets.json" --outdir "$RUNNER_TEMP/todofy-core-bundle"',
            "uv run python deploy/deploy_vars.py exec gateway -- npx --no-install wrangler deploy --dry-run",
            'node deploy/bundle-size.mjs "$RUNNER_TEMP/todofy-gateway-bundle"',
            'test -d "$RUNNER_TEMP/todofy-core-bundle/python_modules/workers"',
        ):
            with self.subTest(command=command):
                self.assertIn(command, block)
        self.assertNotIn("tests/runtime", self.code(block))

    def test_the_shards_run_every_collected_runtime_file_and_nothing_else(self):
        block = self.blocks["todofy-runtime"]
        shards = self.shards()
        self.assertEqual(shards, list(range(1, len(shards) + 1)))
        self.assertIn(f"    name: Todofy runtime (${{{{ matrix.shard }}}}/{len(shards)})\n", block)
        self.assertIn("      fail-fast: false\n", block)
        # The plan comes from pytest's own collection and GitHub's matrix position, never a hand-kept list.
        self.assertIn('uv run pytest tests/runtime --collect-only -q -p no:cacheprovider > "$RUNNER_TEMP/collected.txt"', block)
        self.assertIn('--index "${{ strategy.job-index }}" --total "${{ strategy.job-total }}"', block)
        self.assertIn('$(cat "$RUNNER_TEMP/shard-files.txt")', block)
        self.assertIn('--junitxml="$RUNNER_TEMP/junit/runtime-${{ strategy.job-index }}.xml"', block)
        self.assertIn('--junitxml="$RUNNER_TEMP/junit/runtime-${{ strategy.job-index }}-serial.xml"', block)
        self.assertIn("name: todofy-runtime-junit-${{ strategy.job-index }}", block)
        commands = self.pytest_commands("todofy-runtime") + self.pytest_commands("todofy-checks")
        self.assertEqual(len(commands), 4)  # plan, xdist run, serial run, completeness
        for option in (" -k", " -m", "--deselect", "--ignore", "--lf", "--last-failed", "--reruns", " -x", "--maxfail"):
            for command in commands:
                with self.subTest(option=option, command=command):
                    self.assertNotIn(option, command)

    def test_each_shard_runs_whole_files_in_as_many_processes_as_planned(self):
        block = self.code(self.blocks["todofy-runtime"])
        run = [command for command in self.pytest_commands("todofy-runtime") if " -n " in command]
        self.assertEqual(len(run), 1)
        processes = re.findall(r"^uv run pytest -n (\d+) --dist loadfile --no-loadscope-reorder ", run[0])
        self.assertEqual(len(processes), 1, run[0])
        # The plan balances the same number of processes per shard that pytest-xdist starts.
        self.assertEqual(re.findall(r"--workers (\d+)\b", block), processes)
        self.assertNotRegex(run[0], r"--dist[ =](?!loadfile)")
        pyproject = (REPO / "todofy" / "pyproject.toml").read_text()
        self.assertIn('addopts = "-ra --import-mode=importlib --dist loadfile --no-loadscope-reorder"', pyproject)
        self.assertIn('"pytest-xdist==', pyproject)
        # One `pywrangler sync` and the Pyodide download happen before the xdist processes start.
        self.assertLess(block.index("uv run python -m tests.runtime.warm_up"), block.index(run[0]))

    def test_the_serial_files_run_alone_after_the_xdist_run(self):
        """todofy-runtime-serial.txt: the plan writes this shard's share, one plain pytest process runs it
        after the xdist run (never with a test server of another process), and a failure of either run
        fails the step without skipping the other."""
        block = self.code(self.blocks["todofy-runtime"])
        self.assertIn(
            '--serial ../.github/scripts/todofy-runtime-serial.txt --serial-out "$RUNNER_TEMP/serial-files.txt"', block
        )
        step = block.split("- name: Runtime tests (", 1)[1].split("\n      - ", 1)[0]
        xdist, serial = [command for command in self.pytest_commands("todofy-runtime") if "--junitxml" in command]
        self.assertIn("$(cat \"$RUNNER_TEMP/shard-files.txt\") || status=$?", xdist)
        self.assertIn("$(cat \"$RUNNER_TEMP/serial-files.txt\") || status=$?", serial)
        self.assertNotRegex(serial, r" -n |--dist|--numprocesses")
        self.assertLess(step.index(xdist), step.index(serial))
        # pytest without paths would run every testpath, so an empty share skips the serial run.
        guard = 'if [ -s "$RUNNER_TEMP/serial-files.txt" ]; then'
        self.assertLess(step.index(guard), step.index(serial))
        self.assertTrue(step.rstrip().endswith('exit "$status"'), step)
        # Its own basetemp: pytest empties --basetemp when it starts, which would delete the xdist run's logs.
        self.assertIn('--basetemp="$RUNNER_TEMP/pytest-serial"', serial)
        self.assertIn("${{ runner.temp }}/pytest-serial/**/dev.log", self.blocks["todofy-runtime"])

    def test_the_pyodide_cache_is_restored_only_on_an_exact_key(self):
        block = self.code(self.blocks["todofy-runtime"])
        step = block.split("- name: Restore the Pyodide bundle\n", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("uses: actions/cache@", step)
        self.assertIn("path: todofy/.wrangler/pyodide-cache", step)
        self.assertNotIn("restore-keys", step)
        for keyed in ("todofy/package-lock.json", "todofy/tests/runtime/harness.py", "todofy/wrangler.test.toml"):
            self.assertIn(f"'{keyed}'", step)
        # Only the shards use it: nothing that deploys restores it.
        for job, other in self.blocks.items():
            if job != "todofy-runtime":
                with self.subTest(job=job):
                    self.assertNotIn("pyodide-cache", self.code(other))

    def test_todofy_deploy_needs_every_todofy_job(self):
        block = self.blocks["todofy-deploy"]
        todofy_jobs = {"todofy-static", "todofy-runtime", "todofy-checks"}
        self.assertEqual({job for job in self.blocks if job.startswith("todofy-")} - {"todofy-deploy"}, todofy_jobs)
        self.assertLessEqual(todofy_jobs, set(self.conditions.needs(block)))
        for job in todofy_jobs:
            with self.subTest(job=job):
                self.assertIn(f"needs.{job}.result == 'success'", self.conditions.condition(block))

    def test_the_completeness_check_expects_one_result_per_shard(self):
        block = self.blocks["todofy-checks"]
        self.assertEqual(re.findall(r"--shards (\d+)\b", block), [str(len(self.shards()))])
        self.assertIn("pattern: todofy-runtime-junit-*", block)
        self.assertIn('uv run pytest tests/runtime --collect-only -q -p no:cacheprovider > "$RUNNER_TEMP/collected.txt"', block)
        self.assertIn("python3 ../.github/scripts/pytest_completeness.py", block)
        self.assertIn("--expected-skips ../.github/scripts/todofy-runtime-expected-skips.txt", block)
        # A test file that vanishes at collection, and a serial file run under xdist, both fail the check.
        self.assertIn("--test-root tests/runtime", block)
        self.assertIn("--serial ../.github/scripts/todofy-runtime-serial.txt", block)

    def test_the_runtime_suite_has_no_expected_skips_today(self):
        skips = (REPO / ".github" / "scripts" / "todofy-runtime-expected-skips.txt").read_text()
        self.assertEqual([line for line in skips.splitlines() if line.strip() and not line.startswith("#")], [])

    def test_no_test_retry_plugin_is_installed(self):
        """A retried test would hide flakiness (and show up twice in the shards' results)."""
        lock = (REPO / "todofy" / "uv.lock").read_text()
        for plugin in ("pytest-rerunfailures", "flaky", "pytest-retry", "pytest-randomly"):
            with self.subTest(plugin=plugin):
                self.assertNotIn(f'name = "{plugin}"', lock)


@unittest.skipUnless(shutil.which("bash"), "needs bash (on the runner)")
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
        """Runs the step with the issuer and host the config step reads from dashboard/wrangler.toml; curl
        answers each request with the next of `answers` ("<code> <location>"), the last one repeating."""
        with tempfile.TemporaryDirectory() as root:
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
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "ACCESS_ISSUER": self.ISSUER,
                "PUBLIC_HOST": self.HOST,
            }
            result = subprocess.run(
                ["bash", "-e", "-c", self.script()], cwd=root, env=env, capture_output=True, text=True, check=False
            )
            return result.returncode, result.stdout + result.stderr

    def test_lab_deploy_runs_the_same_probe_from_its_own_config(self):
        """The Lab deploy's probe is this very script (so these tests cover it), fed from lab/wrangler.toml."""
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = lambda job: workflow_jobs()[job].split(name, 1)[1].split("\n      - ", 1)[0]  # noqa: E731
        body = lambda job: step(job).split("        run: |\n", 1)[1]  # noqa: E731
        self.assertEqual(body("lab-deploy").replace("/api/v1/today", "/api/v1/homeView"), body("dashboard-deploy"))
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step("lab-deploy"))
        config = workflow_jobs()["lab-deploy"].split("- name: Read the host and the Access issuer from the committed config\n", 1)[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])

    def test_flowday_deploy_runs_the_same_probe_from_its_own_config(self):
        """The FlowDay deploy's probe of its host (F3 staging, F4 production) is this very script too, fed from
        flowday/wrangler.toml."""
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = lambda job: workflow_jobs()[job].split(name, 1)[1].split("\n      - ", 1)[0]  # noqa: E731

        def body(job):
            """The step's `run: |` lines only (the next step's leading comments are not part of it)."""
            lines = step(job).split("        run: |\n", 1)[1].splitlines()
            return "\n".join(line for line in lines if not line.strip() or line.startswith("          ")).rstrip()

        self.assertEqual(body("flowday-deploy").replace("/api/v1/tasks", "/api/v1/homeView"), body("dashboard-deploy"))
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step("flowday-deploy"))
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step("flowday-deploy"))
        block = workflow_jobs()["flowday-deploy"]
        config = block.split("- name: Read the host and the Access issuer from the committed config\n", 1)[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])
        # After the deploy and the API check: the host serves the version just checked.
        self.assertLess(block.index("- name: Check that production runs this commit\n"), block.index(name))

    def test_links_deploy_runs_the_same_probe_on_the_owners_half(self):
        """The links deploy's probe is this very script too, fed from links/wrangler.toml, on the paths the path-scoped
        Access app covers: its exact destination /_, the launcher /_/ and the owner API."""
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = lambda job: workflow_jobs()[job].split(name, 1)[1].split("\n      - ", 1)[0]  # noqa: E731

        def body(job):
            """The step's `run: |` lines only (the next step's leading comments are not part of it)."""
            lines = step(job).split("        run: |\n", 1)[1].splitlines()
            return "\n".join(line for line in lines if not line.strip() or line.startswith("          ")).rstrip()

        links = body("links-deploy")
        self.assertIn("for path in /_ /_/ /_/api/v1/links; do", links)
        self.assertEqual(links.replace("for path in /_ /_/ /_/api/v1/links;", "for path in / /api/v1/homeView;"), body("dashboard-deploy"))
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step("links-deploy"))
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step("links-deploy"))
        block = workflow_jobs()["links-deploy"]
        config = block.split("- name: Read the host and the Access issuer from the committed config\n", 1)[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])
        self.assertLess(block.index("- name: Check that production runs this commit\n"), block.index(name))

    def test_watch_deploy_runs_the_same_probe_on_the_whole_host(self):
        """The watch deploy's probe is this very script too, fed from watch/wrangler.toml, on the inbox, the owner API
        and the add-from-phone page: the whole host is behind the Access application "watch"."""
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = lambda job: workflow_jobs()[job].split(name, 1)[1].split("\n      - ", 1)[0]  # noqa: E731

        def body(job):
            """The step's `run: |` lines only (the next step's leading comments are not part of it)."""
            lines = step(job).split("        run: |\n", 1)[1].splitlines()
            return "\n".join(line for line in lines if not line.strip() or line.startswith("          ")).rstrip()

        watch = body("watch-deploy")
        self.assertIn("for path in / /api/v1/watches /new; do", watch)
        self.assertEqual(watch.replace("for path in / /api/v1/watches /new;", "for path in / /api/v1/homeView;"), body("dashboard-deploy"))
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step("watch-deploy"))
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step("watch-deploy"))
        block = workflow_jobs()["watch-deploy"]
        config = block.split("- name: Read the host and the Access issuer from the committed config\n", 1)[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])
        self.assertLess(block.index("- name: Check that production runs this commit\n"), block.index(name))

    def test_the_issuer_and_host_come_from_the_committed_config(self):
        block = workflow_jobs()["dashboard-deploy"]
        name = "- name: Check that Access answers unauthenticated requests\n"
        step = block.split(name, 1)[1].split("\n      - ", 1)[0]
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step)
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step)
        config = block.split("- name: Read the host and the Access issuer from the committed config\n", 1)[1]
        self.assertIn('open("wrangler.toml", "rb")', config.split("\n      - ", 1)[0])

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



class FlowDayPwaBypass(unittest.TestCase):
    """FlowDay deploy's check of its host's PWA files, run as the workflow runs it against a stubbed curl.

    Only the listed PWA files may answer an anonymous request (through the Access app flowday-bypass), each with its
    own media type; an unlisted /pwa/ file must get the Worker's 401. A 302 means the bypass is missing."""

    STEP = "- name: Check that only the PWA files bypass Access\n"
    HOST = "flowday.example.org"
    GOOD = {
        "/pwa/manifest.webmanifest": "200 application/manifest+json",
        "/pwa/icon-192x192.png": "200 image/png",
        "/pwa/apple-touch-icon.png": "200 image/png",
        "/pwa/sw": "200 application/javascript; charset=utf-8",
        "/pwa/sw.js": "401 application/json; charset=utf-8",
    }

    def script(self):
        block = workflow_jobs()["flowday-deploy"]
        body = block.split(self.STEP, 1)[1].split("        run: |\n", 1)[1]
        lines = []
        for line in body.splitlines():
            if line.strip() and not line.startswith("          "):
                break
            lines.append(line[10:])
        return "\n".join(lines) + "\n"

    def check(self, answers, host=HOST):
        """Runs the step; curl answers each URL with answers[path] ("<code> <media type>"), or, for a list, with the
        next item of that list (the last one repeating). Returns (exit code, output, the URLs requested)."""
        with tempfile.TemporaryDirectory() as root:
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            table = Path(root, "answers")
            table.mkdir()
            for index, (path, answer) in enumerate(answers.items()):
                queue = answer if isinstance(answer, list) else [answer]
                Path(table, str(index)).write_text("\n".join(queue) + "\n")
                Path(table, f"{index}.path").write_text(path)
            curl = bin_dir / "curl"
            curl.write_text(
                "#!/usr/bin/env bash\n"
                'url="${@: -1}"\n'
                f'echo "$url" >> "{root}/urls"\n'
                f'for name in "{table}"/*.path; do\n'
                '  index=${name%.path}\n'
                f'  if [ "$url" = "https://{host}$(cat "$name")" ]; then\n'
                '    line=$(head -n 1 "$index")\n'
                '    if [ "$(wc -l < "$index")" -gt 1 ]; then tail -n +2 "$index" > "$index.next"; mv "$index.next" "$index"; fi\n'
                '    printf "%s" "$line"\n'
                "    exit 0\n"
                "  fi\n"
                "done\n"
                'printf "404 text/plain"\n'
            )
            (bin_dir / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
            for tool in (curl, bin_dir / "sleep"):
                tool.chmod(0o755)
            env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "PUBLIC_HOST": host}
            result = subprocess.run(
                ["bash", "-e", "-c", self.script()], cwd=root, env=env, capture_output=True, text=True, check=False
            )
            urls = Path(root, "urls").read_text().splitlines() if Path(root, "urls").exists() else []
            return result.returncode, result.stdout + result.stderr, urls

    def test_the_listed_files_pass_and_the_unlisted_one_is_refused_by_the_worker(self):
        code, output, urls = self.check(self.GOOD)
        self.assertEqual(code, 0, output)
        self.assertEqual(urls, [f"https://{self.HOST}{path}" for path in self.GOOD])
        self.assertIn("/pwa/sw.js: 401 application/json from the Worker", output)

    def test_the_checked_files_are_the_workers_public_pwa_paths(self):
        """Every checked 200 is on the Worker's list, and the 401 one exists in the export but is not on it."""
        assets = (REPO / "flowday" / "worker" / "src" / "assets.ts").read_text()
        listed = set(re.findall(r"'(/pwa/[^']+)'", assets.split("PWA_PUBLIC_PATHS", 1)[1].split("])", 1)[0]))
        for path, answer in self.GOOD.items():
            with self.subTest(path=path):
                self.assertIn(path, self.script())
                self.assertEqual(path in listed, answer.startswith("200 "))
        self.assertTrue((REPO / "flowday" / "web" / "public" / "pwa" / "sw.js").is_file())

    def test_a_missing_bypass_fails_with_its_name(self):
        code, output, urls = self.check({**self.GOOD, "/pwa/manifest.webmanifest": "302 text/html"})
        self.assertEqual(code, 1, output)
        self.assertIn("the Access app flowday-bypass does not cover", output)
        self.assertEqual(len(urls), 1)

    def test_a_public_unlisted_file_or_a_wrong_media_type_fails(self):
        for path, answer in (
            ("/pwa/sw.js", "200 application/javascript"),
            ("/pwa/manifest.webmanifest", "200 text/html; charset=utf-8"),
            ("/pwa/icon-192x192.png", "401 application/json"),
            ("/pwa/sw", "200 "),
        ):
            with self.subTest(path=path, answer=answer):
                code, output, _ = self.check({**self.GOOD, path: answer})
                self.assertEqual(code, 1, output)
                self.assertIn(f"{path} was answered with", output)

    def test_no_connection_or_5xx_is_retried_then_fails(self):
        code, output, _ = self.check({**self.GOOD, "/pwa/manifest.webmanifest": ["000 ", "503 text/html", "200 application/manifest+json"]})
        self.assertEqual(code, 0, output)
        self.assertIn("(attempt 3)", output)
        code, output, urls = self.check({**self.GOOD, "/pwa/manifest.webmanifest": "000 "})
        self.assertEqual(code, 1, output)
        self.assertIn("/pwa/manifest.webmanifest never reached the Worker", output)
        self.assertEqual(len(urls), 10)

    def test_the_host_comes_from_the_committed_config(self):
        block = workflow_jobs()["flowday-deploy"]
        step = block.split(self.STEP, 1)[1].split("\n      - ", 1)[0]
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step)
        self.assertLess(block.index("- name: Check that Access answers unauthenticated requests\n"), block.index(self.STEP))
        code, _, _ = self.check(self.GOOD, host="")
        self.assertNotEqual(code, 0)


class LinksWorkerProbe(unittest.TestCase):
    """Links deploy's check of the host's anonymous half, run as the workflow runs it against a stubbed curl.

    Only /_ and /_/* are behind the path-scoped Access app "links"; /robots.txt and every short link reach the Worker
    anonymously. The step passes only when the Worker itself answers: its robots.txt (200, text/plain, its exact text)
    and, for a key no link uses, the 302 to this host's /_/k/<key>, both no-store and noindex."""

    STEP = "- name: Check that the Worker answers short links without Access\n"
    ISSUER = "https://example.cloudflareaccess.com"
    HOST = "s.example.org"
    ROBOTS = "User-agent: *\nDisallow: /\n"
    KEY = "/some-unknown-key"

    def good(self):
        """The Worker's answers (code, media type, redirect URL, Cache-Control, X-Robots-Tag, body) by path."""
        return {
            "/robots.txt": ["200", "text/plain; charset=utf-8", "", "private, no-store", "noindex", self.ROBOTS],
            self.KEY: ["302", "", f"https://{self.HOST}/_/k{self.KEY}", "private, no-store", "noindex", ""],
        }

    def script(self):
        block = workflow_jobs()["links-deploy"]
        body = block.split(self.STEP, 1)[1].split("        run: |\n", 1)[1]
        lines = []
        for line in body.splitlines():
            if line.strip() and not line.startswith("          "):
                break
            lines.append(line[10:])
        return "\n".join(lines) + "\n"

    def check(self, answers, host=HOST):
        """Runs the step; curl answers each URL with answers[path] (one answer, or a list whose last item repeats),
        writes the body to its -o file and prints the -w fields joined by "|". Returns (exit code, output, URLs)."""
        with tempfile.TemporaryDirectory() as root:
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            queues = {path: (answer if isinstance(answer[0], list) else [answer]) for path, answer in answers.items()}
            Path(root, "answers.json").write_text(json.dumps({f"https://{host}{path}": queue for path, queue in queues.items()}))
            curl = bin_dir / "curl"
            curl.write_text(
                f"#!{sys.executable}\n"
                "import json, sys\n"
                f"root = {root!r}\n"
                "args = sys.argv[1:]\n"
                "url = args[-1]\n"
                "open(root + '/urls', 'a').write(url + '\\n')\n"
                "table = json.load(open(root + '/answers.json'))\n"
                "queue = table.get(url, [['404', 'text/plain', '', 'private, no-store', 'noindex', 'Not found.']])\n"
                "answer = queue.pop(0) if len(queue) > 1 else queue[0]\n"
                "json.dump(table, open(root + '/answers.json', 'w'))\n"
                "open(args[args.index('-o') + 1], 'w').write(answer[5])\n"
                "sys.stdout.write('|'.join(answer[:5]))\n"
            )
            (bin_dir / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
            for tool in (curl, bin_dir / "sleep"):
                tool.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "ACCESS_ISSUER": self.ISSUER,
                "PUBLIC_HOST": host,
                "RUNNER_TEMP": root,
            }
            result = subprocess.run(
                ["bash", "-e", "-c", self.script()], cwd=root, env=env, capture_output=True, text=True, check=False
            )
            urls = Path(root, "urls").read_text().splitlines() if Path(root, "urls").exists() else []
            return result.returncode, result.stdout + result.stderr, urls

    def test_the_workers_own_answers_pass(self):
        code, output, urls = self.check(self.good())
        self.assertEqual(code, 0, output)
        self.assertEqual(urls, [f"https://{self.HOST}/robots.txt", f"https://{self.HOST}{self.KEY}"])
        self.assertIn("/robots.txt: 200 text/plain from the Worker", output)
        self.assertIn(f"{self.KEY}: 302 (no body) from the Worker", output)

    def test_the_probe_asks_curl_for_exactly_the_fields_it_reads(self):
        script = self.script()
        self.assertIn("-w '%{http_code}|%{content_type}|%{redirect_url}|%header{cache-control}|%header{x-robots-tag}'", script)
        self.assertIn("--proto '=https'", script)
        self.assertNotRegex(script, r"(?<!\S)(-L|--location)(?!\S)")

    def test_the_probed_answers_are_the_workers(self):
        """The robots text is the Worker's ROBOTS_TXT, and the probed key is a valid key that is not reserved, so the
        Worker answers it on the short-link path (an unknown key: the enumeration answer)."""
        pages = (REPO / "links" / "worker" / "src" / "pages.ts").read_text()
        self.assertIn("export const ROBOTS_TXT = 'User-agent: *\\nDisallow: /\\n'", pages)
        self.assertIn("printf 'User-agent: *\\nDisallow: /\\n'", self.script())
        key = self.KEY[1:]
        self.assertRegex(key, r"^[a-z0-9][a-z0-9-]{0,62}$")
        limits = (REPO / "links" / "worker" / "src" / "limits.ts").read_text()
        self.assertNotIn(f"'{key}'", limits.split("RESERVED_KEYS", 1)[1].split("\n", 1)[0])
        self.assertIn(f"'{self.KEY} 302'", self.script())

    def test_an_access_login_instead_of_the_worker_fails(self):
        login = ["302", "", f"{self.ISSUER}/cdn-cgi/access/login/{self.HOST}?kid=abc", "", "", ""]
        for path in ("/robots.txt", self.KEY):
            with self.subTest(path=path):
                code, output, _ = self.check({**self.good(), path: login})
                self.assertEqual(code, 1, output)
                self.assertIn("the Access app links covers more than /_/*", output)

    def test_another_robots_text_or_media_type_fails(self):
        for change in ({5: "User-agent: *\nAllow: /\n"}, {5: ""}, {1: "text/html; charset=utf-8"}, {1: ""}):
            answer = self.good()["/robots.txt"]
            for index, value in change.items():
                answer[index] = value
            with self.subTest(change=change):
                code, output, _ = self.check({**self.good(), "/robots.txt": answer})
                self.assertEqual(code, 1, output)
                self.assertIn("is not the Worker's robots.txt", output)

    def test_a_cacheable_or_indexable_answer_fails(self):
        for path in ("/robots.txt", self.KEY):
            for index, value in ((3, "public, max-age=60"), (3, ""), (4, ""), (4, "all")):
                answer = self.good()[path]
                answer[index] = value
                with self.subTest(path=path, index=index, value=value):
                    code, output, _ = self.check({**self.good(), path: answer})
                    self.assertEqual(code, 1, output)
                    self.assertIn("without Cache-Control no-store and X-Robots-Tag noindex", output)

    def test_another_status_or_redirect_fails(self):
        for path, index, value, message in (
            ("/robots.txt", 0, "404", "was answered with 404"),
            (self.KEY, 0, "404", "was answered with 404"),
            (self.KEY, 0, "301", "was answered with 301"),
            (self.KEY, 2, f"https://{self.HOST}/_/", "302 to somewhere other than"),
            (self.KEY, 2, f"https://other.example.org/_/k{self.KEY}", "302 to somewhere other than"),
            (self.KEY, 2, "https://example.com/", "302 to somewhere other than"),
        ):
            answer = self.good()[path]
            answer[index] = value
            with self.subTest(path=path, value=value):
                code, output, _ = self.check({**self.good(), path: answer})
                self.assertEqual(code, 1, output)
                self.assertIn(message, output)

    def test_no_connection_or_5xx_is_retried_then_fails(self):
        gone = ["000", "", "", "", "", ""]
        busy = ["503", "text/html", "", "", "", "busy"]
        code, output, _ = self.check({**self.good(), "/robots.txt": [gone, busy, self.good()["/robots.txt"]]})
        self.assertEqual(code, 0, output)
        self.assertIn("(attempt 3)", output)
        code, output, urls = self.check({**self.good(), self.KEY: gone})
        self.assertEqual(code, 1, output)
        self.assertIn(f"{self.KEY} never reached the Worker", output)
        self.assertEqual(len(urls), 11)

    def test_the_host_and_issuer_come_from_the_committed_config_after_the_access_probe(self):
        block = workflow_jobs()["links-deploy"]
        step = block.split(self.STEP, 1)[1].split("\n      - ", 1)[0]
        self.assertIn("PUBLIC_HOST: ${{ steps.config.outputs.host }}", step)
        self.assertIn("ACCESS_ISSUER: ${{ steps.config.outputs.access_issuer }}", step)
        self.assertLess(block.index("- name: Check that Access answers unauthenticated requests\n"), block.index(self.STEP))
        code, _, urls = self.check(self.good(), host="")
        self.assertNotEqual(code, 0)
        self.assertEqual(urls, [])


class FlowDayProductionCheck(unittest.TestCase):
    """FlowDay deploy's hostname-free check, run as the workflow runs it against a stubbed npx (wrangler).

    It passes only when the live deployment serves one version at 100% whose BUILD_SHA is this commit and no D1
    migration is pending, and it never prints wrangler's JSON (it names the token's account email)."""

    JOB = "flowday-deploy"
    WORKER = "flowday"
    STEP = "- name: Check that production runs this commit\n"
    VERSION = "0b9c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"
    EMAIL = "deployer@example.org"

    def script(self):
        block = workflow_jobs()[self.JOB]
        body = block.split(self.STEP, 1)[1].split("        run: |\n", 1)[1]
        lines = []
        for line in body.splitlines():
            if line.strip() and not line.startswith("          "):
                break
            lines.append(line[10:])
        return "\n".join(lines) + "\n"

    def deployment(self, *versions):
        return {
            "id": "synthetic",
            "author_email": self.EMAIL,
            "versions": [{"version_id": v, "percentage": share} for v, share in versions] or [],
        }

    def version(self, build):
        bindings = [{"name": "DB", "type": "d1", "id": "synthetic"}, {"name": "ACCESS_OWNER", "type": "secret_text"}]
        if build is not None:
            bindings.append({"name": "BUILD_SHA", "type": "plain_text", "text": build})
        return {"id": self.VERSION, "metadata": {"author_email": self.EMAIL}, "resources": {"bindings": bindings}}

    def check(self, deployment, version, migrations="\u2705 No migrations to apply!", token="synthetic-token", fail=""):
        """Runs the step; the stub answers `deployments status`, `versions view` and `d1 migrations list`, or exits 1
        for the command named in `fail`. Returns (exit code, output, the commands npx was asked to run)."""
        if shutil.which("jq") is None and os.environ.get("GITHUB_ACTIONS") != "true":
            self.skipTest("needs jq (the runner has it)")
        with tempfile.TemporaryDirectory() as root:
            bin_dir = Path(root, "bin")
            bin_dir.mkdir()
            Path(root, "deployment.json").write_text(json.dumps(deployment))
            Path(root, "version.json").write_text(json.dumps(version))
            Path(root, "migrations.txt").write_text(migrations + "\n")
            npx = bin_dir / "npx"
            npx.write_text(
                "#!/usr/bin/env bash\n"
                f'echo "$*" >> "{root}/calls"\n'
                'args=" $* "\n'
                + (f'case "$args" in *" {fail} "*) exit 1 ;; esac\n' if fail else "")
                + 'case "$args" in\n'
                f'  *" deployments status "*) cat "{root}/deployment.json" ;;\n'
                f'  *" versions view {self.VERSION} "*) cat "{root}/version.json" ;;\n'
                f'  *" d1 migrations list DB --remote "*) cat "{root}/migrations.txt" ;;\n'
                '  *) echo "unexpected npx call" >&2; exit 3 ;;\n'
                "esac\n"
            )
            npx.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "CLOUDFLARE_API_TOKEN": token,
                "GITHUB_SHA": SHA,
            }
            result = subprocess.run(
                ["bash", "-e", "-c", self.script()], cwd=root, env=env, capture_output=True, text=True, check=False
            )
            calls = Path(root, "calls").read_text().splitlines() if Path(root, "calls").exists() else []
            output = result.stdout + result.stderr
            self.assertNotIn(self.EMAIL, output)
            return result.returncode, output, calls

    def test_this_commit_at_100_percent_with_no_pending_migration_passes(self):
        code, output, calls = self.check(self.deployment((self.VERSION, 100)), self.version(SHA))
        self.assertEqual(code, 0, output)
        self.assertIn(f"The Worker {self.WORKER} serves version {self.VERSION} at 100%, built from {SHA}", output)
        self.assertIn("No D1 migration is pending.", output)
        self.assertEqual(
            calls,
            [
                "--no-install wrangler deployments status --json --config ../wrangler.toml",
                f"--no-install wrangler versions view {self.VERSION} --json --config ../wrangler.toml",
                "--no-install wrangler d1 migrations list DB --remote --config ../wrangler.toml",
            ],
        )

    def test_another_build_or_none_fails(self):
        for build in ("c" * 40, "", None):
            with self.subTest(build=build):
                code, output, _ = self.check(self.deployment((self.VERSION, 100)), self.version(build))
                self.assertEqual(code, 1, output)
                self.assertIn(f"was not built from {SHA}", output)
                if build:
                    self.assertNotIn(build, output)

    def test_a_split_or_empty_deployment_fails(self):
        for versions in (((self.VERSION, 50), ("1" * 8 + "-0000-4000-8000-" + "1" * 12, 50)), ((self.VERSION, 90),), ()):
            with self.subTest(versions=versions):
                code, output, calls = self.check(self.deployment(*versions), self.version(SHA))
                self.assertEqual(code, 1, output)
                self.assertIn("does not serve exactly one version at 100%", output)
                self.assertEqual(len(calls), 1)

    def test_a_pending_migration_fails(self):
        pending = "Migrations to be applied:\n| Name |\n| 0004_next.sql |"
        code, output, _ = self.check(self.deployment((self.VERSION, 100)), self.version(SHA), migrations=pending)
        self.assertEqual(code, 1, output)
        self.assertIn("D1 migrations are still pending.", output)

    def test_a_failed_read_or_a_missing_token_fails(self):
        for fail, message in (
            ("deployments", "Could not read the deployment"),
            ("view", "Could not read the deployed version"),
            ("list", "Could not list the D1 migrations"),
        ):
            with self.subTest(fail=fail):
                code, output, _ = self.check(self.deployment((self.VERSION, 100)), self.version(SHA), fail=fail)
                self.assertEqual(code, 1, output)
                self.assertIn(message, output)
        code, output, calls = self.check(self.deployment((self.VERSION, 100)), self.version(SHA), token="")
        self.assertNotEqual(code, 0, output)
        self.assertEqual(calls, [])


class LabProductionCheck(FlowDayProductionCheck):
    """Lab deploy's check, the same step: Access answers every request before the Worker, so the probe alone cannot
    tell whether this commit (its lab.ui.v1 routes) is what serves; the deployed version's BUILD_SHA can."""

    JOB = "lab-deploy"
    WORKER = "lab"


class LinksProductionCheck(FlowDayProductionCheck):
    """Links deploy's check, the same step: nothing anonymous on the host shows the build, so the deployed version's
    BUILD_SHA tells whether this commit serves."""

    JOB = "links-deploy"
    WORKER = "links"


class WatchProductionCheck(FlowDayProductionCheck):
    """Watch deploy's check: the same step without the D1 part (the watch app has no D1). Nothing anonymous on the host
    shows the build (it is all behind Access), so the deployed version's BUILD_SHA tells whether this commit serves."""

    JOB = "watch-deploy"
    WORKER = "watch"

    def test_the_same_step_as_the_links_app_without_d1(self):
        links = FlowDayProductionCheck.script(LinksProductionCheck())
        d1 = links[links.index('pending=$(npx --no-install wrangler d1 migrations list') :]
        self.assertEqual(self.script(), links.replace("Worker links", "Worker watch").replace(d1, ""))
        self.assertNotIn("d1", self.script())

    def test_this_commit_at_100_percent_with_no_pending_migration_passes(self):
        code, output, calls = self.check(self.deployment((self.VERSION, 100)), self.version(SHA))
        self.assertEqual(code, 0, output)
        self.assertIn(f"The Worker {self.WORKER} serves version {self.VERSION} at 100%, built from {SHA}", output)
        self.assertNotIn("migration", output)
        self.assertEqual(
            calls,
            [
                "--no-install wrangler deployments status --json --config ../wrangler.toml",
                f"--no-install wrangler versions view {self.VERSION} --json --config ../wrangler.toml",
            ],
        )

    def test_a_pending_migration_fails(self):
        self.skipTest("the watch app has no D1 database")

    def test_a_failed_read_or_a_missing_token_fails(self):
        for fail, message in (("deployments", "Could not read the deployment"), ("view", "Could not read the deployed version")):
            with self.subTest(fail=fail):
                code, output, _ = self.check(self.deployment((self.VERSION, 100)), self.version(SHA), fail=fail)
                self.assertEqual(code, 1, output)
                self.assertIn(message, output)
        code, output, calls = self.check(self.deployment((self.VERSION, 100)), self.version(SHA), token="")
        self.assertNotEqual(code, 0, output)
        self.assertEqual(calls, [])


REPOSITORY = "ziyixi/todofy"
RUN_ID = "900"
WORKFLOW_ID = 77


def job(name, conclusion="success", status="completed"):
    return {"name": name, "status": status, "conclusion": conclusion}


def green_jobs(*names):
    return [job(name) for name in ("Changes", "CI gate", *names)]


TODOFY_JOBS = ("Todofy static checks", "Todofy runtime (1/3)", "Todofy runtime (2/3)", "Todofy runtime (3/3)", "Todofy checks")


def branch_run(run_id=800, **overrides):
    run = {
        "id": run_id,
        "workflow_id": WORKFLOW_ID,
        "head_sha": SHA,
        "event": "push",
        "head_branch": "feature",
        "status": "completed",
        "conclusion": "success",
        "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}",
        "repository": {"full_name": REPOSITORY},
        "head_repository": {"full_name": REPOSITORY},
    }
    run.update(overrides)
    return run


def fake_github(runs, jobs_by_run):
    """A read-only fake of the three GitHub REST reads find_reusable makes."""
    calls = []

    def get(path):
        calls.append(path)
        if path == f"/repos/{REPOSITORY}/actions/runs/{RUN_ID}":
            return {"id": int(RUN_ID), "workflow_id": WORKFLOW_ID}
        if path.startswith(f"/repos/{REPOSITORY}/actions/workflows/{WORKFLOW_ID}/runs?"):
            assert f"head_sha={SHA}" in path and "event=push" in path and "status=completed" in path, path
            return {"workflow_runs": runs}
        match = re.fullmatch(rf"/repos/{re.escape(REPOSITORY)}/actions/runs/(\d+)/jobs\?filter=latest&per_page=100", path)
        if match:
            jobs = jobs_by_run[int(match.group(1))]
            return {"total_count": len(jobs), "jobs": jobs}
        raise AssertionError(f"unexpected read {path}")

    get.calls = calls
    return get


ENV = {"GITHUB_REPOSITORY": REPOSITORY, "GITHUB_RUN_ID": RUN_ID, "GH_TOKEN": "unused-by-the-fake"}


class Reuse(unittest.TestCase):
    """A push to main reuses a green branch push run of the same commit only when that run passed every check
    this push needs; deploy decisions never change."""

    def reuse(self, result, runs, jobs_by_run, event="push", ref=MAIN):
        return ci_changes.try_reuse(event, ref, SHA, result, ENV, fake_github(runs, jobs_by_run))

    def test_a_covering_green_branch_run_skips_the_checks_and_keeps_the_deploys(self):
        needed = expect(T, F, T, T, F)  # Todofy changed: Todofy checks, Contracts, Todofy deploy
        result, extra, reason = self.reuse(needed, [branch_run()], {800: green_jobs(*TODOFY_JOBS, "Contracts", "Mail Hero checks")})
        self.assertEqual(result, expect(F, F, F, T, F))
        self.assertEqual(extra["checks_reused"], "true")
        self.assertEqual(extra["reused_run_url"], f"https://github.com/{REPOSITORY}/actions/runs/800")
        self.assertEqual(extra["reused_jobs"], "Changes, CI gate, Todofy static checks, Todofy runtime (*), Todofy checks, Contracts")
        self.assertIn("checks reused", reason)

    def test_every_deploy_decision_survives_reuse(self):
        needed = ci_changes.everything()
        jobs = green_jobs(
            *TODOFY_JOBS,
            "Mail Hero checks",
            "Dashboard checks",
            "Website checks",
            "Lab checks",
            "FlowDay checks",
            "Links checks",
            "Watch checks",
            "Contracts",
            "Shared packages",
            "Infra checks",
            "Proto checks",
        )
        result, extra, _ = self.reuse(needed, [branch_run()], {800: jobs})
        self.assertEqual(extra["checks_reused"], "true")
        for key in ci_changes.KEYS:
            with self.subTest(output=key):
                self.assertEqual(result[key], key.endswith("_deploy"))

    def test_infra_checks_are_reused_only_when_the_branch_run_passed_them(self):
        needed = expect(F, F, F, F, F, infra=T)  # infra/ changed: Infra checks only, no deploy
        result, extra, _ = self.reuse(needed, [branch_run()], {800: green_jobs("Infra checks")})
        self.assertEqual((result, extra["checks_reused"]), (expect(F, F, F, F, F), "true"))
        self.assertEqual(extra["reused_jobs"], "Changes, CI gate, Infra checks")
        for jobs in (green_jobs(), green_jobs() + [job("Infra checks", "skipped")], green_jobs() + [job("Infra checks", "failure")]):
            with self.subTest(jobs=jobs):
                result, extra, _ = self.reuse(needed, [branch_run()], {800: jobs})
                self.assertEqual((result, extra["checks_reused"]), (needed, "false"))

    def test_a_run_that_skipped_a_needed_check_is_not_reused(self):
        # The branch diff was Todofy-only, but main also needs Mail Hero checks (a change since the last green main).
        needed = expect(T, T, T, T, T)
        result, extra, reason = self.reuse(needed, [branch_run()], {800: green_jobs(*TODOFY_JOBS, "Contracts") + [job("Mail Hero checks", "skipped")]})
        self.assertEqual((result, extra["checks_reused"]), (needed, "false"))
        self.assertIn("ran every check this push needs", reason)

    def test_a_missing_failed_or_partial_matrix_is_not_reused(self):
        needed = expect(T, F, T, T, F)
        for jobs in (
            green_jobs("Todofy static checks", "Todofy checks", "Contracts"),  # no runtime shard at all
            green_jobs(*TODOFY_JOBS[:-2], "Todofy checks", "Contracts") + [job("Todofy runtime (3/3)", "failure")],
            green_jobs(*TODOFY_JOBS, "Contracts")[:1] + green_jobs(*TODOFY_JOBS, "Contracts")[2:],  # no CI gate
            [job("Changes"), job("CI gate", "failure"), *[job(name) for name in (*TODOFY_JOBS, "Contracts")]],
            green_jobs(*TODOFY_JOBS) + [job("Contracts", None, "in_progress")],
        ):
            with self.subTest(jobs=[(j["name"], j["conclusion"]) for j in jobs]):
                result, extra, _ = self.reuse(needed, [branch_run()], {800: jobs})
                self.assertEqual((result, extra["checks_reused"]), (needed, "false"))

    def test_only_green_branch_push_runs_of_this_commit_and_workflow_count(self):
        needed = expect(F, T, T, F, T)
        jobs = green_jobs("Mail Hero checks", "Contracts")
        for run in (
            branch_run(head_branch="main"),
            branch_run(head_sha="c" * 40),
            branch_run(event="workflow_dispatch"),
            branch_run(conclusion="failure"),
            branch_run(conclusion="cancelled"),
            branch_run(status="in_progress", conclusion=None),
            branch_run(workflow_id=WORKFLOW_ID + 1),
            branch_run(head_repository={"full_name": "someone/fork"}),
            branch_run(run_id=int(RUN_ID)),  # this run itself
        ):
            with self.subTest(run={k: run[k] for k in ("head_branch", "head_sha", "event", "conclusion", "workflow_id")}):
                result, extra, reason = self.reuse(needed, [run], {run["id"]: jobs})
                self.assertEqual((result, extra["checks_reused"]), (needed, "false"))
                self.assertIn("no green branch run of this commit", reason)

    def test_the_newest_covering_run_is_used(self):
        needed = expect(F, T, T, F, T)
        runs = [branch_run(801), branch_run(805), branch_run(803)]
        jobs = {801: green_jobs("Mail Hero checks", "Contracts"), 803: green_jobs("Mail Hero checks", "Contracts"), 805: green_jobs("Contracts")}
        _, extra, _ = self.reuse(needed, runs, jobs)
        self.assertTrue(extra["reused_run_url"].endswith("/runs/803"))

    def test_no_lookup_off_main_for_dispatch_or_when_no_check_is_needed(self):
        for event, ref, needed in (
            ("push", BRANCH, expect(T, F, T, T, F)),
            ("workflow_dispatch", MAIN, ci_changes.dispatched("both")),
            ("push", MAIN, expect(F, F, F, F, F)),
        ):
            with self.subTest(event=event, ref=ref):
                def get(path):
                    raise AssertionError("no read expected")

                result, extra, _ = ci_changes.try_reuse(event, ref, SHA, needed, ENV, get)
                self.assertEqual((result, extra), (needed, ci_changes.NO_REUSE))

    def test_any_lookup_failure_runs_the_checks(self):
        needed = expect(T, F, T, T, F)

        forbidden = ci_changes.urllib.error.HTTPError("/x", 403, "Forbidden", {}, io.BytesIO(b""))
        self.addCleanup(forbidden.close)

        def broken(path):
            raise forbidden

        result, extra, reason = ci_changes.try_reuse("push", MAIN, SHA, needed, ENV, broken)
        self.assertEqual((result, extra["checks_reused"]), (needed, "false"))
        self.assertIn("HTTP 403", reason)
        result, extra, reason = ci_changes.try_reuse("push", MAIN, SHA, needed, {}, None)
        self.assertEqual((result, extra["checks_reused"]), (needed, "false"))
        self.assertIn("no token", reason)


class ReuseRealGit(unittest.TestCase):
    """main() with a fake GitHub, the way the Changes step runs it on a push to main."""

    git, commit, setUp, tearDown = RealGit.git, RealGit.commit, RealGit.setUp, RealGit.tearDown

    def test_main_writes_the_reuse_outputs(self):
        green = self.commit("README.md")
        after = self.commit("mail-hero/cloudflare/x.ts")
        get = fake_github([branch_run(head_sha=after)], {800: green_jobs("Mail Hero checks", "Contracts")})
        # fake_github checks head_sha=SHA in the query; give it this commit instead.
        def get_for(path):
            return get(path.replace(after, SHA)) if "workflows" in path else get(path)

        output = Path(self.root, "output.txt")
        cwd = os.getcwd()
        saved = {key: os.environ.get(key) for key in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "EVENT_NAME", "REF", "AFTER", "DISPATCH_APP", "LAST_SUCCESS", *ENV)}
        try:
            os.chdir(self.root)
            os.environ.update(ENV, EVENT_NAME="push", REF=MAIN, AFTER=after, DISPATCH_APP="", LAST_SUCCESS=green, GITHUB_OUTPUT=str(output))
            os.environ.pop("GITHUB_STEP_SUMMARY", None)
            ci_changes.main(get_for)
        finally:
            os.chdir(cwd)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual(outputs["checks_reused"], "true")
        self.assertEqual(outputs["mail_hero_check"], "false")
        self.assertEqual(outputs["contracts"], "false")
        self.assertEqual(outputs["mail_hero_deploy"], "true")
        self.assertEqual(outputs["reused_jobs"], "Changes, CI gate, Mail Hero checks, Contracts")
        self.assertEqual(set(outputs), {*ci_changes.KEYS, *ci_changes.REUSE_KEYS, ci_changes.BASE_KEY})
        self.assertEqual(outputs["base"], green)


class HostnameGuard(unittest.TestCase):
    """Every deploy that applies a wrangler.toml with Custom Domains or zone routes runs tools/cf-guard on that
    config, with the job's own token, before the first production change (D1 migrations or wrangler deploy)."""

    GUARD = "node tools/cf-guard/cf-guard.mjs"
    STEP = "- name: Check the hostnames against production\n"
    # Intentional hostname changes, (CF_GUARD_ALLOW_REMOVE, CF_GUARD_ALLOW_CONFLICT) per job, set only in the commit
    # that makes them (FlowDay's F4 cutover set both for "flowday-deploy"; the next commit cleared them). None today.
    # A conflict allowance names its kind: "dns:<host>", "worker:<host>" or "route:<pattern>" (tools/cf-guard).
    ALLOWED: dict[str, tuple[str, str]] = {}

    @staticmethod
    def has_routes(config):
        import tomllib

        with open(REPO / config, "rb") as handle:
            data = tomllib.load(handle)
        return bool(data.get("routes") or data.get("route"))

    def test_each_deploy_guards_its_configs_before_changing_production(self):
        blocks = workflow_jobs()
        for job, configs, token, first_change in (
            ("todofy-deploy", ["todofy/wrangler.toml", "todofy/gateway/wrangler.toml"], "CF_API_TOKEN", "wrangler d1 migrations apply"),
            ("mail-hero-deploy", ["mail-hero/wrangler.toml"], "MAIL_HERO_CF_API_TOKEN", "wrangler d1 migrations apply"),
            ("dashboard-deploy", ["dashboard/wrangler.toml"], "CF_API_TOKEN", "deploy-vars.mjs exec -- npx --no-install wrangler deploy --config"),
            ("lab-deploy", ["lab/wrangler.toml"], "CF_API_TOKEN", "wrangler d1 migrations apply"),
            ("flowday-deploy", ["flowday/wrangler.toml"], "CF_API_TOKEN", "wrangler d1 migrations apply"),
            ("links-deploy", ["links/wrangler.toml"], "CF_API_TOKEN", "wrangler d1 migrations apply"),
            ("watch-deploy", ["watch/wrangler.toml"], "CF_API_TOKEN", "deploy-vars.mjs exec -- npx --no-install wrangler deploy --config"),
        ):
            block = blocks[job]
            with self.subTest(job=job):
                self.assertEqual(block.count(self.STEP), 1)
                step = block.split(self.STEP, 1)[1].split("\n      - ", 1)[0]
                self.assertIn("        working-directory: .\n", step)
                self.assertIn(f"CLOUDFLARE_API_TOKEN: ${{{{ secrets.{token} }}}}", step)
                remove, conflict = (value or "''" for value in self.ALLOWED.get(job, ("", "")))
                self.assertIn(f"CF_GUARD_ALLOW_REMOVE: {remove}\n", step)
                self.assertIn(f"CF_GUARD_ALLOW_CONFLICT: {conflict}\n", step)
                self.assertIn(self.GUARD + "".join(f" --config {config}" for config in configs) + "\n", step + "\n")
                self.assertLess(block.index(self.STEP), block.index(first_change))
                self.assertTrue(any(self.has_routes(config) for config in configs))

    def test_every_production_config_with_routes_is_guarded(self):
        text = WORKFLOW.read_text()
        release = (REPO / ".github" / "workflows" / "website-release.yml").read_text()
        for config in sorted(REPO.glob("*/**/wrangler.toml")):
            relative = config.relative_to(REPO).as_posix()
            if "node_modules" in relative or not self.has_routes(relative):
                continue
            with self.subTest(config=relative):
                if relative == "website/wrangler.toml":
                    # The site release runs the guard through `pnpm release hostnames` and inside `deploy`.
                    self.assertIn("\n            pnpm release hostnames\n", release)
                else:
                    self.assertIn(f"--config {relative}", text)

    def test_the_website_release_guards_before_the_upload_and_the_deploy(self):
        release = (REPO / ".github" / "workflows" / "website-release.yml").read_text()
        guard = release.index("- name: Check the wrangler.toml hostnames against production\n")
        self.assertLess(guard, release.index("- name: Upload the verified export as a Worker version\n"))
        step = release[guard:].split("\n      - ", 1)[0]
        self.assertIn("if: steps.decision.outputs.deploy_required == 'true'", step)
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}", step)
        deploy = release[release.index("- name: Deploy the version and the wrangler.toml hostnames\n") :].split("\n      - ", 1)[0]
        self.assertIn("CF_GUARD_ALLOW_REMOVE: ''", deploy)
        steps = (REPO / "website" / "scripts" / "release" / "steps.ts").read_text()
        self.assertLess(steps.index("await deps.hostnames.check()"), steps.index("await deps.wrangler.deployTriggers()"))
        cloudflare = (REPO / "website" / "scripts" / "release" / "cloudflare.ts").read_text()
        self.assertIn('path.resolve(cwd, "..", "tools", "cf-guard", "cf-guard.mjs")', cloudflare)

    @staticmethod
    def release_guard_script():
        """The `run: |` script of the release's guard step, dedented."""
        release = (REPO / ".github" / "workflows" / "website-release.yml").read_text()
        step = release[release.index("- name: Check the wrangler.toml hostnames against production\n") :].split("\n      - ", 1)[0]
        block = step.split("        run: |\n", 1)[1]
        return "".join(line[10:] + "\n" for line in block.split("\n") if line.strip())

    def test_the_website_release_guard_skips_only_a_commit_that_predates_it(self):
        """The release workflow comes from main, the code from the green commit, which can predate the guard
        (no `pnpm release hostnames` there). Only a commit whose history never had tools/cf-guard is skipped;
        one that deleted it, or a git failure, still runs the guard or fails."""
        script = self.release_guard_script()
        git = shutil.which("git")
        bash = shutil.which("bash")
        if not git or not bash:
            self.skipTest("needs git and bash")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / "bin"
            stub.mkdir()
            calls = root / "pnpm-calls"
            (stub / "pnpm").write_text(f'#!/bin/sh\necho "$*" >> "{calls}"\n')
            (stub / "pnpm").chmod(0o755)
            env = {
                "PATH": f"{stub}{os.pathsep}{os.environ.get('PATH', '')}",
                "HOME": directory,
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CEILING_DIRECTORIES": directory,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@example.com",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@example.com",
            }
            repo = root / "repo"
            (repo / "website").mkdir(parents=True)

            def git_run(*args):
                subprocess.run([git, *args], cwd=repo, env=env, check=True, capture_output=True)

            def commit(message):
                git_run("add", "-A")
                git_run("commit", "-q", "--allow-empty", "-m", message)

            def step():
                if calls.exists():
                    calls.unlink()
                result = subprocess.run(
                    [bash, "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                    cwd=repo / "website", env=env, capture_output=True, text=True,
                )
                ran = calls.read_text() if calls.exists() else ""
                return result.returncode, result.stdout, ran

            git_run("init", "-q")
            (repo / "website" / "index.txt").write_text("site\n")
            commit("site before the guard")
            code, out, ran = step()
            self.assertEqual((code, ran), (0, ""), out)
            self.assertIn("cf-guard: skipped", out)

            (repo / "tools" / "cf-guard").mkdir(parents=True)
            (repo / "tools" / "cf-guard" / "cf-guard.mjs").write_text("// guard\n")
            commit("add the guard")
            code, out, ran = step()
            self.assertEqual((code, ran), (0, "release hostnames\n"), out)

            shutil.rmtree(repo / "tools")
            commit("delete the guard")
            code, out, ran = step()
            self.assertEqual(ran, "release hostnames\n", out)
            self.assertNotIn("skipped", out)

            # Not a repository (git fails): the step fails, it does not skip.
            shutil.rmtree(repo / ".git")
            code, out, ran = step()
            self.assertNotEqual(code, 0)
            self.assertEqual(ran, "")

    def test_the_changes_job_tests_the_guard(self):
        self.assertIn("run: node --test tools/cf-guard/test/*.test.mjs\n", workflow_jobs()["changes"])

    def test_website_jobs_cache_the_playwright_browser_by_its_locked_version(self):
        release = (REPO / ".github" / "workflows" / "website-release.yml").read_text()
        for name, text in (("ci.yml website-checks", workflow_jobs()["website-checks"]), ("website-release.yml", release)):
            with self.subTest(workflow=name):
                self.assertIn("uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0", text)
                self.assertIn("path: ~/.cache/ms-playwright", text)
                self.assertIn("key: playwright-chromium-${{ runner.os }}-${{ steps.playwright.outputs.version }}", text)
                self.assertIn("pnpm exec playwright install-deps chromium", text)
                self.assertIn("pnpm exec playwright install --with-deps chromium", text)


if __name__ == "__main__":
    unittest.main()
