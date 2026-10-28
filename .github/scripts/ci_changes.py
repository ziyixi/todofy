#!/usr/bin/env python3
"""Decide which apps a CI run checks and deploys. Standard library only (the runner's python3).

Outputs (GITHUB_OUTPUT, "true"/"false"):
  todofy_check, mail_hero_check, dashboard_check, website_check, links_check, watch_check, newsletter_check,
  fleet_check, platform_check, mailsort_check, recall_check, tasks_check
                    run that app's full checks
  contracts         run the contract tests: both sides of mail.received.v1 and ops-v1, and the dashboard's
                    ops-v1 caller tests (also on a proto/ change: they read every contract with the generated
                    codecs)
  packages          run every shared package's own checks (packages/*)
  infra             run "Infra checks" (OpenTofu fmt/validate of infra/, its guards and the plan-summary
                    tests): infra/, tools/infra-plan-summary/ or .github/ changed. Never deploys anything;
                    not set by a dispatch (no app needs it).
  proto             run "Proto checks" (buf lint, buf breaking and the wire profile rules against "base",
                    deterministic generation, the one-version rule, both codecs' tests): proto/, .github/ or
                    tools/ changed, or a dispatch.
  base              not a flag: the commit the diff started from (empty when everything runs), which
                    "Proto checks" compares the IDL with.
  todofy_deploy, mail_hero_deploy, dashboard_deploy, website_deploy, links_deploy, watch_deploy,
  newsletter_deploy, fleet_deploy, platform_publish, platform_deploy, mailsort_deploy, recall_deploy,
  tasks_deploy
                    the app, a shared package it compiles in, or a contract file it bundles changed
                    (deploy jobs also require refs/heads/main)
  website_relay_deploy
                    website/relay/ (the Notion relay Worker, its own wrangler.toml) changed: deploy
                    the relay. A change only there checks the website but does not release the site;
                    a website change elsewhere releases the site but does not redeploy the relay.
  recall_extension_publish
                    recall/extension/ or recall/shared/ (the Chrome extension and the code it bundles) changed:
                    publish the build "Recall checks" made as the GitHub Release recall-extension-v<version>
                    (main only; a version whose tag exists is skipped). Any file there but documentation counts
                    (shared/NOTICE is copied into the build): an extra release is harmless, a missed one is not.
                    A dispatch for recall (or all) and a run of everything publish too. The extension is never
                    deployed.
  The links app (links/, the short links on s.ziyixi.science) is checked and deployed since L2 (links/docs/design.md
  section 11). It answers ops-v1 (its Ops entrypoint, which reports its daily backup; Contracts runs that test; Home
  binds it, HOME_BOUND) and compiles in packages/edge-auth and the TypeScript proto runtime with proto/links/ui/ and
  proto/ops/, so a change to those checks and deploys it too. The watch app (watch/, the web watches on watch.ziyixi.science) is
  checked and deployed since W2 (watch/docs/design.md section 11). It creates its tasks through Tasks' TaskInbox (its
  notification sink) and answers ops-v1 (its Ops entrypoint; Contracts runs that test) and compiles in
  packages/edge-auth and the TypeScript proto runtime with proto/watch/ui/, proto/tasks/inbox/ and proto/ops/, so a
  change to those checks and deploys it too. CHECK_ONLY keeps a new app's deploy output false until its resources are ready. Fleet's
  Access resources are registered; its deployment and Home's binding can now be published after the gate. Mailsort
  (mailsort/, the Gmail sorting on sort.ziyixi.science, mailsort/docs/design.md) is checked and deployed since its
  Access application was created (2026-10-07): it answers ops-v1 (Contracts runs its tests) and compiles in
  packages/edge-auth and the TypeScript proto runtime with proto/mailsort/ui/ and proto/ops/. Home binds its Ops
  entrypoint, so while an app Home binds is CHECK_ONLY, Home's deploy output stays false too (HOME_BOUND). recall
  (recall/, the browsing record on recall.ziyixi.science, recall/docs/design.md) is checked and deployed since "Infra
  apply" created its Access applications and its bucket (2026-10-10, design section 11): it answers ops-v1 (Contracts
  runs its tests; Home binds its Ops entrypoint, HOME_BOUND) and compiles in packages/edge-auth and the TypeScript
  proto runtime with proto/recall/ui/, proto/recall/ingest/, proto/recall/archive/ and proto/ops/.

proto/ (the protobuf IDL, proto/README.md) checks every app in PROTO_USERS (an app that depends on @ziyixi/proto or
ziyixi-proto) and deploys only the apps whose bundle the changed path reaches (proto_deploys): PROTO_USERS[app] names
the languages whose generated code and runtime the app's production bundles compile in ("ts": Mail Hero's, the
links app's, the watch app's and the dashboard's Workers and UIs, and Todofy's gateway and UI
(todofy.ui.v1's transcoder and client); "python": todofy-core, through the wheel pywrangler vendors), PROTO_RUNTIMES
maps a language's runtime and generator to that language's users, and PROTO_PACKAGES maps each proto package to the apps
that import its generated code (mailhero/ui reaches Mail Hero only, links/ui the links app only, watch/ui the watch app only, dashboard/ui the dashboard only, todofy/ui Todofy only; prototest, the
runtimes' fixtures, reaches no app). Tests, test data, the check scripts, the api-linter tool module, check configs and
Markdown (PROTO_NOT_BUNDLED), and the files of a package proto/retired.json lists (its deletion), deploy nothing; any
other proto/ path (buf.yaml, buf.lock, the toolchain lockfile,
ensure.mjs, a package not listed yet) deploys every user (fail safe). test_proto.py derives PROTO_USERS and the
packages' importers from the sources. It also runs Contracts. A change to a contract proto/'s tests read (PROTO_READS:
ops-v1's and mail-received-v1's fixtures and schemas, among others) runs Proto checks as well.

push: the files changed between a cumulative base and github.sha, never only this push's own diff,
so a change whose run was cancelled or failed is checked (and deployed) again by the next run.
  main           base = the commit of the last successful push run of this workflow on main
                 (last_successful_main). Any run that failed or was cancelled, including a cancelled
                 deploy (also while pending in the concurrency group), is not "success", so its changes
                 stay in the next run's diff.
  other branches base = git merge-base origin/main HEAD, so the head commit's gate covers every
                 change on the branch, not only the latest push.
  No usable base (no successful main run yet, API failure, base not an ancestor, no origin/main)
  runs everything. An app's own directory checks it and deploys it unless the changed paths are in the
  explicitly reviewed APP_TEST_DIRECTORIES (checks still run); contracts/ and .github/ re-check
  every app but deploy none, except the contract files the TypeScript Workers bundle (BUNDLED_BY,
  e.g. OPS_LIMITS in contracts/ops-v1/ops-v1.ts), which also deploy every app listed for them. A
  shared package packages/<name>/ is compiled into the apps listed in PACKAGE_USERS, so any change
  inside it runs the package checks and checks AND deploys each of those apps. Its README and SPEC are
  documentation (below). A package missing from PACKAGE_USERS counts as used by every app (fail safe;
  the tests run by the Changes job also fail until PACKAGE_USERS matches the file: dependencies).
Documentation (is_documentation: Markdown anywhere, and any file in a docs/ folder, the repository's or an app's,
  or the website's doc/) is read by people, not by a build or a check: a change to it alone selects no check, no
  deploy and no VPS release; Changes (whose tests check the documents' links and references) and the gate still run.
  The exceptions are the Markdown a build ships (RUNTIME_MARKDOWN: the app's input like its code), reviewed test
  directories (fixtures), and the documents an app's checks read (TESTED_DOCUMENTS, the website's prettier among
  them: that app is checked, nothing is deployed). test_ci_changes.py scans Worker Text imports, ?raw imports, file
  reads, wheel package-data, image COPY sources, public/ folders and prettier checks, and fails when any of them
  reaches a path classified as documentation without selecting its reader.
Newsletter remains an independent VPS image. newsletter_deploy publishes its tested image to GHCR; it does
not upgrade the server. It still uses its locked external ziyixi-protos dependency, not the root proto runtime.
platform/ checks and publishes its own independently tested daemon image; platform_deploy upgrades the VPS.
Newsletter production changes also check and publish Platform from the same source SHA before the VPS release.
A push to main reuses a green branch run of the same commit (find_reusable): when a completed push run of
this workflow on another branch has the same head SHA, concluded success, and its Changes, CI gate and
every check job this push needs (CHECK_JOBS) succeeded, the check outputs are all false (those jobs are
skipped), checks_reused=true names that run, and the deploy outputs are unchanged. The deploy jobs accept
a skipped check job only together with checks_reused; the gate passes and prints the run. The same SHA is
the same tree and the same ci.yml, and no check job uses a secret, so the branch run's verdict holds
(test_wrangler_configs.py: no job before the deploys reads a secret, has an environment or deploys for real).
A publication of something that run built (the Newsletter and Platform images, the recall extension) also needs
its same-SHA artifact there, not expired. Anything else (no such run, a check it did not run, a missing artifact,
an API error, workflow_dispatch) runs the checks.
tools/ (CI, test and build tooling: the deploy hostname guard, and the bundle budgets and CPU meter that the
apps' build scripts and tests import, which no bundle carries: test_app_isolation.py) counts as
.github/: every app is re-checked, none deployed. The exception is tools/infra-plan-summary/, which belongs to
infra/: it runs only Infra checks, as infra/ does (and .github/ does too); the other tools/ do not run them.
The root workspace files (package.json, pnpm-workspace.yaml, pnpm-lock.yaml; pyproject.toml, uv.lock; .python-version)
check every member of their workspace. A pnpm catalog version bump deploys the members whose package.json lists that
name, a root uv constraint the members that declare it, and a lock what the manifest changes beside it reach
(workspace_reach, reading both ends of the diff); anything else in them deploys the whole workspace (fail safe). Only
the proto toolchain's dependencies (not its devDependencies) reach the Python proto package, and so the VPS images.
workflow_dispatch: the "app" input checks and deploys that app ("both" = Todofy and Mail Hero, as
before; "all" = every app; or one app; "website" = the site and its relay), and the contracts and
shared packages are checked too. The website uses no contract and no package, so a website-only
change does not run Contracts.
"""

import json
import os
import re
import subprocess
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "service-catalog"))
from catalog import load_catalog  # noqa: E402

APPS = tuple(load_catalog(Path(__file__).resolve().parents[2]).apps)
# The output key prefix of each app ("<prefix>_check", "<prefix>_deploy").
PREFIX = {app: app.replace("-", "_") for app in APPS}
# A new app is checked but its deploy output stays false until its Cloudflare resources are ready. Keep its output
# present so the workflow and same-SHA reuse have one stable interface.
CHECK_ONLY: set[str] = set()
# Apps whose Ops entrypoint Home binds (dashboard/wrangler.toml): while one of them is CHECK_ONLY its Worker does not
# exist yet, so Home's deploy (whose binding would name a missing service) waits too.
HOME_BOUND = {"fleet", "mailsort", "recall", "tasks", "personal-mcp", "model-router", "links"}
KEYS = (
    "todofy_check",
    "mail_hero_check",
    "dashboard_check",
    "website_check",
    "links_check",
    "watch_check",
    "newsletter_check",
    "codex_gateway_check",
    "fleet_check",
    "platform_check",
    "mailsort_check",
    "recall_check",
    "tasks_check",
    "personal_mcp_check",
    "model_router_check",
    "contracts",
    "packages",
    "infra",
    "proto",
    "todofy_deploy",
    "mail_hero_deploy",
    "dashboard_deploy",
    "website_deploy",
    "website_relay_deploy",
    "links_deploy",
    "watch_deploy",
    "newsletter_deploy",
    "codex_gateway_deploy",
    "fleet_deploy",
    "platform_publish",
    "platform_deploy",
    "mailsort_deploy",
    "recall_deploy",
    "recall_extension_publish",
    "tasks_deploy",
    "personal_mcp_deploy",
    "model_router_deploy",
)
DISPATCH = {
    "both": ("todofy", "mail-hero"),
    "all": APPS,
    "todofy": ("todofy",),
    "mail-hero": ("mail-hero",),
    "dashboard": ("dashboard",),
    "website": ("website",),
    "links": ("links",),
    "watch": ("watch",),
    "newsletter": ("newsletter",),
    "codex-gateway": ("codex-gateway",),
    "fleet": ("fleet",),
    "platform": ("platform",),
    "mailsort": ("mailsort",),
    "recall": ("recall",),
    "tasks": ("tasks",),
    "personal-mcp": ("personal-mcp",),
    "model-router": ("model-router",),
}
# The website's Notion relay Worker deploys on its own (website_relay_deploy).
RELAY = "website/relay/"
# recall's Chrome extension and the shared code its bundle compiles in: a change publishes its build as a GitHub
# Release (recall_extension_publish).
EXTENSION = ("recall/extension/", "recall/shared/")
# Apps that neither provide nor consume a contract: their own changes do not run Contracts.
NO_CONTRACTS = {"newsletter"}
# The OpenTofu configuration (infra/README.md) and its plan-summary tool: checked here without a token; only
# .github/workflows/infra.yml plans it against Cloudflare, and only the manually dispatched infra-apply.yml applies it.
INFRA = ("infra/", "tools/infra-plan-summary/")
# These are source inputs to checked generators, not deployable Worker bundles. Generated app source changes are
# classified through their own app directory; editing the central inputs alone cannot publish production.
CLOUD_CONFIG = {"config/cloud.toml", "config/resources.toml", "config/account-resources.toml"}
# Both package managers share one root lock. These inputs check every member of their workspace. They deploy only
# the members a version bump reaches (workspace_reach) when that is all that changed; anything else can change every
# member's resolved dependencies, including the Node toolchain that generates the Python proto package before its
# image build, and deploys them all.
NODE_WORKSPACE_INPUTS = {"package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"}
PYTHON_WORKSPACE_INPUTS = {"pyproject.toml", "uv.lock", ".python-version"}
PYTHON_WORKSPACE_APPS = {"newsletter", "codex-gateway", "platform", "todofy"}
# The manifest groups that list a Node member's dependencies.
NODE_DEPENDENCY_GROUPS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
# A file's text before and after the diff; raises ValueError when either is unreadable (git_show).
Reader = Callable[[str], tuple[str, str]]
# Reviewed test directories outside production entrypoints and image inputs. Do not replace this with
# a filename glob: fixtures and files named "test" inside production source can be shipped. Newsletter's
# Docker COPY/.dockerignore and Platform's minimal context exclude their tests; Todofy's Python base_dir
# is worker/. The TS Workers bundle src/ imports, not sibling test/, and Tasks' web build bundles index.html
# and src/, not its Playwright specs in test/. Production/config changes in the same diff still deploy
# normally. test_app_isolation.py guards imports across this boundary.
APP_TEST_DIRECTORIES = (
    "newsletter/tests/",
    "codex-gateway/tests/",
    "platform/tests/",
    "todofy/tests/",
    "todofy/gateway/test/",
    "mail-hero/cloudflare/test/",
    "dashboard/worker/test/",
    "links/worker/test/",
    "watch/worker/test/",
    "fleet/worker/test/",
    "mailsort/worker/test/",
    "mailsort/tools/test/",
    "recall/worker/test/",
    "tasks/worker/test/",
    "tasks/web/test/",
    "tasks/tools/test/",
    "personal-mcp/worker/test/",
    "personal-mcp/deploy/test/",
    "personal-mcp/tools/test/",
    "model-router/worker/test/",
    "model-router/tools/test/",
)
# Documentation (is_documentation) is Markdown anywhere and every file in these folders: docs/ at the root, and
# <app>/docs/ or <app>/doc/ (the website's design notes and their images).
DOC_FOLDERS = ("docs", "doc")
# Markdown that a build ships, an input of its app like its code (checked and deployed). Keep this list in step with
# the guard in test_ci_changes.py, which scans what the builds read.
RUNTIME_MARKDOWN = (
    # The mailsort Worker imports its prompts as Text modules (*.txt today; a Markdown prompt would ship the same way).
    "mailsort/prompts/",
    # The newsletter wheel's package-data (instructions/, policy/), installed into its image.
    "newsletter/src/",
)
# Documents an app's checks read (?raw imports, file reads, a formatter), or its image check validates: a change checks
# that app and deploys nothing. newsletter/content-config/ is published by its own workflow (content-config.yml) and
# validated against the candidate image in "Newsletter image checks"; "Website checks" runs `prettier --check .`, which
# formats the website's Markdown too.
TESTED_DOCUMENTS: dict[str, tuple[str, ...]] = {
    "website/": ("website",),
    "contracts/ops-v1/README.md": ("dashboard",),
    "dashboard/docs/design.md": ("dashboard",),
    "dashboard/docs/design-v2.md": ("dashboard",),
    "dashboard/docs/limits.md": ("dashboard",),
    "mailsort/docs/backup.md": ("mailsort",),
    "newsletter/content-config/": ("newsletter",),
}
# packages/<name>/ -> the apps whose Workers compile its workspace dependency in.
PACKAGE_USERS = {"model-router-client": ("mailsort", "newsletter", "todofy"), "edge-auth": ("todofy", "mail-hero", "dashboard", "links", "watch", "fleet", "mailsort", "recall", "tasks", "personal-mcp", "model-router"), "planning-ui": ("tasks",), "task-dates": ("tasks",)}
# The protobuf IDL (proto/README.md): app -> the languages ("ts", "python") whose generated code and runtime
# its production bundles compile in; () for a user whose bundles take nothing from it (types only, tests
# only). test_proto.py derives this map from the apps' manifests and sources.
PROTO = "proto/"
PROTO_USERS: dict[str, tuple[str, ...]] = {
    "todofy": ("python", "ts"),
    "links": ("ts",),
    "mail-hero": ("ts",),
    "dashboard": ("ts",),
    "watch": ("ts",),
    "fleet": ("ts",),
    "platform": ("python",),
    "codex-gateway": ("python",),
    "website": ("ts",),
    "mailsort": ("ts",),
    "recall": ("ts",),
    "tasks": ("ts",),
    "personal-mcp": ("ts",),
    "model-router": ("ts",),
    "newsletter": ("python",),
}
# The hand-written runtimes and generators: a change reaches every user of each language listed. The wire
# profile's own options (common/wire/v1: value rules, map order, binding arguments) are part of both runtimes:
# the TypeScript codec bundles their generated descriptors, gen_py.py writes their rules into the Python tables
# (through wire_rules.py).
PROTO_RUNTIMES: dict[str, tuple[str, ...]] = {
    "proto/ts/": ("ts",),
    "proto/buf.gen.yaml": ("ts",),
    "proto/common/wire/": ("ts", "python"),
    "proto/python/": ("python",),
    "proto/tools/gen_py.py": ("python",),
    "proto/tools/wire_rules.py": ("python",),
}
# A proto package (its directory) -> the apps whose production code imports its generated code (TypeScript
# value imports, Python imports; test_proto.py checks this against the sources). A package missing here
# reaches every user (fail safe; test_proto.py fails until it is listed).
PROTO_PACKAGES: dict[str, tuple[str, ...]] = {
    "proto/modelrouter/inference/": ("model-router", "mailsort", "todofy", "newsletter", "codex-gateway"),
    # recommendation-v1 and summary-v1 (todofy/api/*.schema.json are generated from it): todofy-core builds them.
    "proto/todofy/report/": ("todofy",),
    # Todofy's owner API (todofy.ui.v1): todofy-core writes every answer with it, the gateway serves it through the
    # shared transcoder and Todofy's UI calls it through the shared client.
    "proto/todofy/ui/": ("todofy",),
    # Todofy's private Mail entry (todofy.mail.v1): todofy-core answers it, the gateway serves it, and Tasks and the
    # Personal MCP call it.
    "proto/todofy/mail/": ("todofy", "tasks", "personal-mcp"),
    "proto/tasks/ui/": ("tasks", "personal-mcp"),
    # Tasks' create-only TaskInbox (tasks.inbox.v1): Tasks serves it, Home creates the digest's daily task and the watch
    # app its notifications with it.
    "proto/tasks/inbox/": ("tasks", "dashboard", "watch"),
    "proto/links/ui/": ("links",),
    "proto/watch/ui/": ("watch", "personal-mcp"),
    # mailsort's owner API (mailsort.ui.v2, after v1): its Worker serves it, its UI calls it.
    "proto/mailsort/ui/": ("mailsort",),
    "proto/fleet/ui/": ("fleet",),
    "proto/fleet/telemetry/": ("fleet", "platform"),
    "proto/platform/runtime/": ("fleet", "platform"),
    # dashboard.ui.v1, the dashboard's owner API: its Worker serves it, its UI calls it.
    "proto/dashboard/ui/": ("dashboard", "personal-mcp"),
    "proto/dashboard/mcp/": ("dashboard", "personal-mcp"),
    # Mail Hero's owner API (mailhero.ui.v2): its Worker serves it, its UI calls it.
    "proto/mailhero/ui/": ("mail-hero",),
    # CommonReason: Platform bundles Python error aliases.
    "proto/common/errors/": ("platform",),
    # ops-v1 (contracts/ops-v1): every app's Ops entrypoint and the dashboard that calls them.
    "proto/ops/": ("mail-hero", "todofy", "dashboard", "links", "watch", "website", "mailsort", "recall", "tasks", "personal-mcp", "model-router"),
    # website.sync.v1: the relay serves its WebsiteSync entrypoint, Home calls it and shows the evidence (dashboard.ui.v1,
    # which the Personal MCP reads).
    "proto/website/sync/": ("website", "dashboard", "personal-mcp"),
    # mail.received.v1 (contracts/mail-received-v1's schema is generated from it): Mail Hero builds every event,
    # todofy-core reads every webhook body.
    "proto/mailhero/webhook/": ("mail-hero", "todofy"),
    # The runtimes' test fixtures (never imported by an app; not in the Python wheel).
    "proto/prototest/": (),
    # recall (recall/docs/design.md): its owner API (recall.ui.v1), the extension's upload (recall.ingest.v1) and the
    # archive change feed (recall.archive.v1, contracts/recall-archive-v1): its Worker serves all three.
    "proto/recall/ui/": ("recall", "personal-mcp"),
    "proto/recall/ingest/": ("recall", "personal-mcp"),
    "proto/recall/archive/": ("recall",),
}
# The contracts whose fixtures and schemas proto/'s own tests read (proto/test/ops.test.ts and test_ops.py round-trip
# every ops-v1 fixture byte for byte through both codecs, mail-received.test.ts and test_mail_received.py every
# mail-received-v1 event, recall-archive.test.ts every recall-archive-v1 fixture; Proto checks also compares the contracts' JSON Schemas with the ones the IDL generates): a
# change there runs Proto checks too, so a fixture neither codec writes byte for byte, or one a strict read wrongly
# accepts, fails its push.
PROTO_READS = (
    "contracts/ops-v1/",
    "contracts/mail-received-v1/",
    "contracts/fleet-report-v1/",
    "contracts/platform-runtime-v1/",
    "contracts/recall-archive-v1/",
)
# proto/ paths that never reach a bundle: a change there checks the users but deploys none.
PROTO_NOT_BUNDLED = (
    "proto/test/",
    "proto/testdata/",
    "proto/scripts/",
    "proto/tools/profile_breaking.py",
    "proto/reviewed-rules.json",
    # The retirement list and its check (proto/README.md "Retiring an element").
    "proto/retired.json",
    "proto/tools/retired.py",
    # The wire JSON types (types only, never in a bundle) and the contracts' JSON Schema generator.
    "proto/tools/gen_wire_ts.py",
    "proto/tools/gen_schema.py",
    "proto/tools/schema.mjs",
    "proto/tools/api-linter/",
    "proto/tsconfig.json",
    "proto/vitest.config.ts",
    "proto/ruff.toml",
    "proto/.gitignore",
)

# Contract files whose code a TypeScript Worker imports at runtime (constants such as OPS_LIMITS land
# in its bundle), mapped to the apps
# that bundle them: a change ships only with a deploy of each. ops-v1's schema is generated from
# proto/ops/ and bundled by nobody: every app reads and writes ops-v1 with the generated code
# (PROTO_PACKAGES).
# test_ci_changes.py checks this map against the Workers' imports.
BUNDLED_BY = {
    "contracts/ops-v1/ops-v1.ts": ("mail-hero", "dashboard", "watch"),
}

# Outputs that describe a reused branch run (strings, one line each).
REUSE_KEYS = ("checks_reused", "reused_run_url", "reused_jobs", "reused_run_id")
# The diff base (a commit, or empty when everything runs): the base "Proto checks" compares the IDL with.
BASE_KEY = "base"
# The check outputs, and the jobs (by their names in ci.yml) that must have succeeded in a reused run when
# this push needs that output. "<name> (*)" stands for every job of a matrix ("Todofy runtime (1/3)", ...):
# at least one, and all of them. test_ci_changes.py checks these names against ci.yml.
CHECK_JOBS = {
    "todofy_check": ("Todofy static checks", "Todofy runtime (*)", "Todofy checks"),
    "mail_hero_check": ("Mail Hero checks",),
    "dashboard_check": ("Dashboard checks",),
    "website_check": ("Website checks",),
    "links_check": ("Links checks",),
    "watch_check": ("Watch checks",),
    "newsletter_check": ("Newsletter checks", "Newsletter image checks"),
    "codex_gateway_check": ("Codex gateway checks",),
    "fleet_check": ("Fleet checks",),
    "platform_check": ("Platform checks",),
    "mailsort_check": ("Mailsort checks",),
    "recall_check": ("Recall checks",),
    "tasks_check": ("Tasks checks",),
    "personal_mcp_check": ("Personal MCP checks",),
    "model_router_check": ("Model Router checks",),
    "contracts": ("Contracts",),
    "packages": ("Shared packages",),
    "infra": ("Infra checks",),
    "proto": ("Proto checks",),
}
# Jobs every reused run must have passed, whatever this push needs.
ALWAYS_JOBS = ("Changes", "CI gate")
# How many same-SHA branch runs are inspected (newest first).
MAX_REUSE_CANDIDATES = 5
# How many first-parent commits before this push are searched for the last successful main run.
MAX_BASE_CANDIDATES = 50


def everything() -> dict[str, bool]:
    return outputs(APPS, APPS, contracts=True, packages=True, relay=True, infra=True, proto=True, extension=True)


def outputs(
    checked: Iterable[str],
    deployed: Iterable[str],
    contracts: bool,
    packages: bool,
    relay: bool = False,
    infra: bool = False,
    proto: bool = False,
    extension: bool = False,
) -> dict[str, bool]:
    checked, deployed = set(checked), set(deployed)
    # A paired release publishes both runtime images. The gateway releases on its own changes (and the shared
    # release tools'); the bootstrap bundle carries its image only when this run built it.
    if deployed & {"newsletter", "platform"}:
        checked.update({"newsletter", "platform"})
        deployed.update({"newsletter", "platform"})
    result = {
        "contracts": contracts,
        "packages": packages,
        "infra": infra,
        "proto": proto,
        "website_relay_deploy": relay,
        "recall_extension_publish": extension,
    }
    for app in APPS:
        result[f"{PREFIX[app]}_check"] = app in checked
        # Home binds Fleet's, mailsort's and recall's entrypoints. Until such an app's resources are ready (CHECK_ONLY),
        # neither its Worker nor Home can be published by full fallback, dispatch, a path diff or reused branch checks.
        blocked = app in CHECK_ONLY or (app == "dashboard" and bool(HOME_BOUND & CHECK_ONLY))
        result[f"{PREFIX[app]}_deploy"] = app in deployed and not blocked
    result["platform_publish"] = result.get("platform_deploy", False)
    return {key: result[key] for key in KEYS}


def is_documentation(path: str) -> bool:
    """Read by people only: Markdown, or a file in a docs folder, that no build ships and no reviewed test directory
    holds (documents some tests read are documentation too: document_readers)."""
    if path.startswith(RUNTIME_MARKDOWN + APP_TEST_DIRECTORIES):
        return False
    folders = path.split("/")[:-1]
    return path.endswith(".md") or folders[:1] == ["docs"] or (len(folders) >= 2 and folders[1] in DOC_FOLDERS)


def document_readers(path: str) -> set[str]:
    """The apps whose tests read this document (TESTED_DOCUMENTS): they are checked, none deployed."""
    return {app for prefix, apps in TESTED_DOCUMENTS.items() if path.startswith(prefix) for app in apps}


def retired_packages(root: Path = Path(__file__).resolve().parents[2]) -> tuple[str, ...]:
    """The directories of the proto packages proto/retired.json lists, as proto/ paths. Deleting one reaches no bundle:
    every importer stopped importing it in the same change (its own directory deploys it), so the deletion alone
    deploys nothing. A missing or unreadable list retires nothing (fail safe)."""
    try:
        listed = json.loads((root / "proto" / "retired.json").read_text(encoding="utf-8")).get("packages", [])
        return tuple(PROTO + entry["path"] for entry in listed)
    except (OSError, ValueError, AttributeError, KeyError, TypeError):
        return ()


def proto_deploys(path: str) -> set[str]:
    """The apps whose production bundle a change of one proto/ path can reach."""
    if path.startswith(PROTO_NOT_BUNDLED) or path.endswith(".md"):
        return set()
    if path.startswith(retired_packages()):
        return set()
    bundling = {app for app, languages in PROTO_USERS.items() if languages}
    for prefix, languages in PROTO_RUNTIMES.items():
        if path.startswith(prefix):
            return {app for app in bundling if set(languages) & set(PROTO_USERS[app])}
    for prefix, importers in PROTO_PACKAGES.items():
        if path.startswith(prefix):
            return set(importers) & bundling
    return bundling


def proto_users(paths: list[str]) -> tuple[set[str], set[str]]:
    """(apps to check, apps to deploy) for the proto/ paths among ``paths``."""
    changed = [path for path in paths if path.startswith(PROTO)]
    if not changed:
        return set(), set()
    return set(PROTO_USERS), {app for path in changed for app in proto_deploys(path)}


def requirement_name(requirement: str) -> str:
    """A Python requirement's normalized project name (PEP 503)."""
    return re.sub(r"[-_.]+", "-", re.match(r"[A-Za-z0-9._-]*", requirement).group(0)).lower()


def pnpm_workspace(text: str) -> tuple[dict[str, str], list[str], str]:
    """pnpm-workspace.yaml as (its default catalog, its member directories, every other line). Comments and blank
    lines are left out; a member entry stays among the other lines, so adding or removing one counts as a change."""
    catalog, members, rest, key = {}, [], [], ""
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            key = line.rstrip()
        if key == "catalog:" and (entry := re.fullmatch(r"""  (["']?)([^"'\s:]+)\1:\s*(\S.*)""", line)):
            catalog[entry.group(2)] = entry.group(3)
            continue
        if key == "packages:" and (member := re.fullmatch(r"""  - (["']?)([^"'\s]+)\1\s*""", line)):
            members.append(member.group(2))
        rest.append(line)
    return catalog, members, "\n".join(rest)


def pnpm_lock_sections(text: str) -> dict[str, dict[str, str]]:
    """pnpm-lock.yaml by top-level key, each as {entry: its block}: the two-space keys of `importers`, `packages` and
    `snapshots` are entries, the text of any other section is its one entry "". Standard library only, no YAML parser."""
    sections: dict[str, dict[str, str]] = {}
    section, entry = "", ""
    for line in text.splitlines():
        if not line.strip():
            continue
        if not line[0].isspace():
            section, entry = line.split(":", 1)[0], ""
            sections[section] = {"": line + "\n"}
            continue
        if section in {"importers", "packages", "snapshots"} and line.startswith("  ") and not line[2].isspace():
            # The entry's key without its colon and value: "some/app:" and ".: {}" are "some/app" and ".".
            entry = re.match(r"""('[^']*'|"[^"]*"|[^:]*)""", line.strip()).group(1).strip("'\"")
            sections[section][entry] = ""
        sections[section][entry] += line + "\n"
    return sections


def retired_members(changed: set[str], read: Reader, old_members: list[str], members: list[str], old_rest: str,
                    new_rest: str) -> bool:
    """True when the only workspace change removes members whose directories this diff deletes (an app's retirement):
    pnpm-workspace.yaml differs by exactly their entries, and pnpm-lock.yaml only drops their importers and the
    packages nobody else uses, so every remaining member resolves exactly as before. Anything else is False."""
    removed = [member for member in old_members if member not in members]
    if not removed or not set(members) <= set(old_members) or "pnpm-lock.yaml" not in changed:
        return False
    for member in removed:
        if f"{member}/package.json" not in changed:
            return False
        try:
            read(f"{member}/package.json")
        except ValueError:
            continue  # gone after the diff (it was a member before it)
        return False

    def entry(line: str) -> str:
        match = re.fullmatch(r"""  - (["']?)([^"'\s]+)\1\s*""", line)
        return match.group(2) if match else ""

    if "\n".join(line for line in old_rest.splitlines() if entry(line) not in removed) != new_rest:
        return False
    before, after = (pnpm_lock_sections(text) for text in read("pnpm-lock.yaml"))
    if before.keys() != after.keys() or not set(removed) <= before.get("importers", {}).keys():
        return False
    for section, entries_after in after.items():
        kept = {key: block for key, block in before[section].items() if not (section == "importers" and key in removed)}
        if section == "importers" and entries_after != kept:
            return False
        if any(kept.get(key) != block for key, block in entries_after.items()):
            return False
    return True


def catalog_reach(changed: set[str], read: Reader) -> list[str] | None:
    """The member package.json files a root Node change reaches, or None for every member."""
    if "package.json" in changed:
        return None
    try:
        (old, old_members, old_rest), (new, members, new_rest) = (pnpm_workspace(text) for text in read("pnpm-workspace.yaml"))
        listed = {}
        for member in members:
            manifest = json.loads(read(f"{member}/package.json")[1])
            # The proto toolchain's devDependencies only run its own checks; its dependencies generate every app's code.
            groups = ("dependencies",) if member == "proto" else NODE_DEPENDENCY_GROUPS
            listed[f"{member}/package.json"] = {name for group in groups for name in manifest.get(group, {})}
        retired = old_rest != new_rest and retired_members(changed, read, old_members, members, old_rest, new_rest)
    except (ValueError, AttributeError, IndexError):
        return None
    bumped = {name for name in old.keys() | new.keys() if old.get(name) != new.get(name)}
    if retired:
        # A retired app's members left; the others' resolution is unchanged, so only a catalog bump reaches anyone.
        return [manifest for manifest, names in listed.items() if names & bumped]
    if old_rest != new_rest or ("pnpm-lock.yaml" in changed and not bumped and not changed & listed.keys()):
        return None
    return [manifest for manifest, names in listed.items() if names & bumped]


def constraint_reach(changed: set[str], read: Reader) -> list[str] | None:
    """The member pyproject.toml files a root uv change reaches, or None for every member."""
    try:
        before, after = (tomllib.loads(text) for text in read("pyproject.toml"))
        # Popped, so that what remains of each file is everything but the constraints.
        old, new = ({requirement_name(pin): pin for pin in data.get("tool", {}).get("uv", {}).pop("constraint-dependencies", [])}
                    for data in (before, after))
        declared = {}
        for member in after["tool"]["uv"]["workspace"]["members"]:
            data = tomllib.loads(read(f"{member}/pyproject.toml")[1])
            project = data.get("project", {})
            requirements = [*project.get("dependencies", []), *(r for extra in project.get("optional-dependencies", {}).values() for r in extra),
                            *(r for group in data.get("dependency-groups", {}).values() for r in group if isinstance(r, str))]
            declared[f"{member}/pyproject.toml"] = {requirement_name(requirement) for requirement in requirements}
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    bumped = {name for name in old.keys() | new.keys() if old.get(name) != new.get(name)}
    # A pin no member declares constrains some member's transitive dependency.
    if before != after or bumped - set().union(*declared.values()):
        return None
    if "uv.lock" in changed and not bumped and not changed & declared.keys():
        return None
    return [manifest for manifest, names in declared.items() if names & bumped]


def workspace_reach(paths: list[str], read: Reader | None) -> tuple[list[str], bool, bool]:
    """(the member manifests a root workspace change reaches, whether it reaches every Node member, every Python member).

    A version bump in pnpm-workspace.yaml's default catalog reaches the members whose package.json lists that name, a
    root uv constraint the members that declare it, and a lock no more than the manifest changes beside it. Anything
    else reaches the whole workspace (fail safe): the root package.json, another key, a lock changed alone, a pin no
    member declares, an unreadable file or no reader. The interpreter (.python-version) reaches both: ensure.mjs uses it
    to generate code for every Node consumer too.
    """
    changed = set(paths)
    if ".python-version" in changed:
        return [], True, True
    node: list[str] | None = []
    python: list[str] | None = []
    if changed & NODE_WORKSPACE_INPUTS:
        node = catalog_reach(changed, read) if read else None
    if changed & PYTHON_WORKSPACE_INPUTS:
        python = constraint_reach(changed, read) if read else None
    return [*(node or []), *(python or [])], node is None, python is None


def classify(paths: Iterable[str], read: Reader | None = None) -> dict[str, bool]:
    paths = [path for path in paths if path]
    # Documentation selects nothing but the apps whose tests read it (checks only); everything below sees the rest.
    readers = {app for path in paths if is_documentation(path) for app in document_readers(path)}
    paths = [path for path in paths if not is_documentation(path)]
    node_workspace = bool(NODE_WORKSPACE_INPUTS.intersection(paths)) or ".python-version" in paths
    python_workspace = bool(PYTHON_WORKSPACE_INPUTS.intersection(paths))
    # A root workspace change checks every member; a member manifest a version bump reaches counts as changed itself.
    members, node_all, python_all = workspace_reach(paths, read)
    paths.extend(members)
    apps = readers | {app for app in APPS if any(path.startswith(f"{app}/") for path in paths)}
    apps.update((set(PROTO_USERS) if node_workspace else set()) | (PYTHON_WORKSPACE_APPS if python_workspace else set()))
    workspace_apps = (set(PROTO_USERS) if node_all else set()) | (PYTHON_WORKSPACE_APPS if python_all else set())
    # A Newsletter release also tests and publishes the independent monitor image from this source SHA.
    if "newsletter" in apps:
        apps.add("platform")
    # Catalog metadata and reviewed test directories are checked, but are not production inputs.
    direct_deploys = {app for app in apps if any(path.startswith(f"{app}/") and path != f"{app}/app.toml"
                       and not path.startswith(APP_TEST_DIRECTORIES) for path in paths)}
    direct_deploys.update(workspace_apps)
    if "newsletter" in direct_deploys:
        direct_deploys.add("platform")
    # This shared promotion tool owns both tested-image publications. Its executable changes need fresh tested
    # images and the gated VPS release (its README is documentation).
    if any(path.startswith(("tools/container-release/", "tools/platform-build/", "tools/vps-release/")) for path in paths):
        direct_deploys.update({"newsletter", "platform", "codex-gateway"})
    # packages/<name>/<file>: at least three components; packages/README.md is documentation.
    package_paths = [path for path in paths if path.startswith("packages/") and path.count("/") >= 2]
    # Users of a changed package (its documents are documentation) are checked and deployed.
    compiled = {path.split("/")[1] for path in package_paths}
    for name in compiled:
        apps.update(PACKAGE_USERS.get(name, APPS))
    # tools/ is CI, test and build tooling (tools/cf-guard, tools/bundle-size, tools/workerd-cpu): like .github/, it
    # re-checks every app and deploys none.
    # tools/infra-plan-summary/ belongs to infra/ and runs only Infra checks.
    ci = any((path.startswith((".github/", "tools/")) and not path.startswith(INFRA)) or path in CLOUD_CONFIG for path in paths)
    shared = ci or any(path.startswith("contracts/") for path in paths)
    bundled = {app for path in paths for app in BUNDLED_BY.get(path, ())}
    # website/relay/ is its own Worker: it deploys itself, not the site (unless the site's own files, or a
    # package counted as used by it, changed too).
    relay = node_all or any(path.startswith(RELAY) for path in paths)
    site = node_all or any(path.startswith("website/") and not path.startswith(RELAY) for path in paths)
    site |= any("website" in PACKAGE_USERS.get(name, APPS) for name in compiled)
    proto_checked, proto_deployed = proto_users(paths)
    # The VPS images install no Node package: a package whose only change is the package.json a catalog bump reached
    # deploys just its Worker users.
    node_reached = {path for path in members if path.endswith("/package.json")}
    node_only = compiled - {path.split("/")[1] for path in package_paths if path not in node_reached}
    package_deploys = {app for name in compiled for app in PACKAGE_USERS.get(name, APPS)
                       if not (name in node_only and app in {"newsletter", "platform", "codex-gateway"})}
    deployed = direct_deploys | package_deploys | bundled | proto_deployed
    relay |= "website" in proto_deployed
    if not site:
        deployed -= {"website"}
    return outputs(
        checked=APPS if shared else apps | proto_checked,
        deployed=deployed,
        contracts=bool((apps - NO_CONTRACTS) | proto_checked) or shared,
        packages=bool(compiled) or ci or node_workspace,
        relay=relay,
        infra=any(path.startswith((".github/", *INFRA)) for path in paths),
        proto=ci or node_workspace or python_workspace or bool(proto_checked) or any(path.startswith(PROTO_READS) for path in paths),
        extension=node_all or any(path.startswith(EXTENSION) for path in paths),
    )


def dispatched(app: str) -> dict[str, bool]:
    if app not in DISPATCH:
        raise ValueError(f"unknown app input {app!r}; expected one of {sorted(DISPATCH)}")
    apps = DISPATCH[app]
    if "newsletter" in apps and "platform" not in apps:
        apps = (*apps, "platform")
    website = "website" in apps
    return outputs(checked=apps, deployed=apps, contracts=True, packages=True, relay=website, proto=True, extension="recall" in apps)


MAIN = "refs/heads/main"


def decide(
    event: str,
    ref: str,
    after: str,
    app: str,
    last_success: str,
    diff: Callable[[str, str], list[str]],
    is_ancestor: Callable[[str, str], bool],
    merge_base: Callable[[str], str],
    *,
    resume: bool = False,
    resume_source_sha: str = "",
    show: Callable[[str, str], str] | None = None,
) -> tuple[dict[str, bool], str, str]:
    """(outputs, reason, diff base); the base is empty when there is no diff (everything runs)."""
    if resume:
        if event != "workflow_dispatch" or ref != MAIN or app not in {"platform", "newsletter", "codex-gateway"}:
            raise ValueError("VPS resume requires a main dispatch for platform, newsletter or codex-gateway")
        if not re.fullmatch(r"[0-9a-f]{40}", resume_source_sha):
            raise ValueError("VPS resume requires the original release's full source SHA")
        gateway = app == "codex-gateway"
        checked = {"platform", "codex-gateway"} if gateway else {"platform", "newsletter"}
        result = outputs(checked=checked, deployed=(), contracts=True, packages=True, proto=True)
        # Continue the authenticated daemon's immutable targets. Publishing new images here
        # could replace an existing source tag with different bytes under the same release ID.
        result["codex_gateway_deploy" if gateway else "platform_deploy"] = True
        return result, "explicit VPS resume: checks only, no image build or publication", ""
    if resume_source_sha:
        raise ValueError("A resume source SHA is only allowed for an explicit VPS resume")
    if event == "workflow_dispatch":
        return dispatched(app or "both"), f"dispatched for {app or 'both'}", ""
    if event != "push":
        return everything(), f"event {event!r}: running everything", ""
    if ref == MAIN:
        if not last_success or set(last_success) == {"0"}:
            return everything(), "no successful push run of this workflow on main yet: running everything", ""
        if not is_ancestor(last_success, after):
            reason = f"last successful main run {last_success[:12]} is not an ancestor: running everything"
            return everything(), reason, ""
        base, why = last_success, "the last successful main run"
    else:
        base = merge_base(after)
        if not base:
            return everything(), "no merge base with origin/main: running everything", ""
        why = "the merge base with origin/main"
    paths = diff(base, after)
    read = (lambda path: (show(base, path), show(after, path))) if show else None
    return classify(paths, read), f"{len(paths)} file(s) changed since {base[:12]} ({why})", base


def required_jobs(result: dict[str, bool]) -> list[str]:
    """The job names a reused run must have passed for this push's check outputs."""
    names = list(ALWAYS_JOBS)
    for key, jobs in CHECK_JOBS.items():
        if result[key]:
            names.extend(job for job in jobs if job not in names)
    return names


def jobs_cover(jobs: list[dict], names: Iterable[str]) -> bool:
    """Every named job (a matrix: every one of its jobs) is present and concluded success."""
    for name in names:
        if name.endswith(" (*)"):
            prefix = name[: -len("*)")]
            matches = [job for job in jobs if str(job.get("name", "")).startswith(prefix) and str(job.get("name", "")).endswith(")")]
        else:
            matches = [job for job in jobs if job.get("name") == name]
        if not matches or any(job.get("status") != "completed" or job.get("conclusion") != "success" for job in matches):
            return False
    return True


def find_reusable(
    get: Callable[[str], dict], repository: str, run_id: str, sha: str, result: dict[str, bool]
) -> tuple[dict | None, list[str], str]:
    """A green branch push run of this workflow for exactly this commit that ran every check this push
    needs: (run, required job names, reason). `get` reads a GitHub REST path and returns its JSON."""
    current = get(f"/repos/{repository}/actions/runs/{run_id}")
    workflow_id = current.get("workflow_id")
    if not isinstance(workflow_id, int):
        return None, [], "this run's workflow is unknown"
    query = urllib.parse.urlencode({"head_sha": sha, "event": "push", "status": "completed", "per_page": 100})
    listing = get(f"/repos/{repository}/actions/workflows/{workflow_id}/runs?{query}")
    candidates = [
        run
        for run in listing.get("workflow_runs", [])
        if isinstance(run, dict)
        and str(run.get("id")) != str(run_id)
        and run.get("workflow_id") == workflow_id
        and run.get("head_sha") == sha
        and run.get("event") == "push"
        and run.get("head_branch") not in (None, "", "main")
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and (run.get("repository") or {}).get("full_name") == repository
        and (run.get("head_repository") or {}).get("full_name") == repository
    ]
    candidates.sort(key=lambda run: int(run.get("id", 0)), reverse=True)
    names = required_jobs(result)
    for run in candidates[:MAX_REUSE_CANDIDATES]:
        jobs = get(f"/repos/{repository}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
        if int(jobs.get("total_count", 0)) > 100:
            continue
        if jobs_cover(jobs.get("jobs", []), names):
            tested_artifacts = []
            if result["newsletter_deploy"]:
                tested_artifacts.append(f"newsletter-image-{sha}")
            if result["codex_gateway_deploy"]:
                tested_artifacts.append(f"codex-gateway-image-{sha}")
            if result["platform_publish"]:
                tested_artifacts.append(f"platform-image-{sha}")
            if result["recall_extension_publish"]:
                tested_artifacts.extend([f"recall-extension-{sha}", f"recall-orion-{sha}"])
            if tested_artifacts:
                # Publishing must load the exact image (or extension build) this branch tested. An expired or
                # missing artifact falls back to this main run's checks/build, never an untested rebuild.
                artifacts = get(f"/repos/{repository}/actions/runs/{run['id']}/artifacts?per_page=100")
                available = {a.get("name") for a in artifacts.get("artifacts", [])
                             if isinstance(a, dict) and a.get("expired") is False}
                if not set(tested_artifacts) <= available:
                    continue
            return run, names, f"reusing the green branch run {run.get('html_url', run['id'])} of this commit"
    if not candidates:
        return None, names, "no green branch run of this commit"
    return None, names, "no green branch run of this commit ran every check this push needs"


def reuse(result: dict[str, bool], run: dict, names: list[str]) -> tuple[dict[str, bool], dict[str, str]]:
    """Skip every check (the reused run passed them); keep every deploy decision."""
    reused = {key: (False if key in CHECK_JOBS else value) for key, value in result.items()}
    extra = {"checks_reused": "true", "reused_run_url": str(run.get("html_url", "")), "reused_jobs": ", ".join(names), "reused_run_id": str(run["id"])}
    return reused, extra


NO_REUSE = {"checks_reused": "false", "reused_run_url": "", "reused_jobs": "", "reused_run_id": ""}


def github_get(token: str, api_url: str) -> Callable[[str], dict]:
    def get(path: str) -> dict:
        request = urllib.request.Request(
            api_url.rstrip("/") + path,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    return get


def last_successful_main(get: Callable[[str], dict], repository: str, run_id: str, commits: Iterable[str]) -> str:
    """The newest of `commits` (this push's first-parent history, newest first) whose push run of this workflow on
    main concluded success, or "" when none did. Git decides the order, never the API's run listing, which twice
    returned a months-old Go-era run first; the workflow is this run's by numeric id, as the Go-era CI shared its
    path. A commit whose lookup fails is passed over: an older base only checks more."""
    workflow_id = get(f"/repos/{repository}/actions/runs/{run_id}").get("workflow_id")
    if not isinstance(workflow_id, int):
        return ""
    for commit in commits:
        query = urllib.parse.urlencode({"head_sha": commit, "branch": "main", "event": "push", "per_page": 10})
        try:
            listing = get(f"/repos/{repository}/actions/workflows/{workflow_id}/runs?{query}")
        except Exception:  # noqa: BLE001 - this commit's run is unknown, so it is no base
            continue
        for run in listing.get("workflow_runs", []):
            if isinstance(run, dict) and run.get("head_sha") == commit and run.get("conclusion") == "success":
                return commit
    return ""


def api(environ: dict[str, str], get: Callable[[str], dict] | None) -> Callable[[str], dict] | None:
    """The GitHub reader: the given one (tests), the read-only token's, or None without a token."""
    if get is None and environ.get("GH_TOKEN"):
        get = github_get(environ["GH_TOKEN"], environ.get("GITHUB_API_URL", "https://api.github.com"))
    return get


def find_last_success(after: str, environ: dict[str, str], get: Callable[[str], dict] | None) -> str:
    """The diff base of a push to main. Any failure leaves it empty, and an empty base runs everything."""
    get, repository, run_id = api(environ, get), environ.get("GITHUB_REPOSITORY", ""), environ.get("GITHUB_RUN_ID", "")
    if not (get and repository and run_id):
        return ""
    try:
        return last_successful_main(get, repository, run_id, git_first_parents(after, MAX_BASE_CANDIDATES))
    except Exception:  # noqa: BLE001 - no base means: run everything
        return ""


def try_reuse(
    event: str, ref: str, sha: str, result: dict[str, bool], environ: dict[str, str], get: Callable[[str], dict] | None = None
) -> tuple[dict[str, bool], dict[str, str], str]:
    """Only a push to main that needs checks looks for a run to reuse; any failure runs the checks."""
    if event != "push" or ref != MAIN or not any(result[key] for key in CHECK_JOBS):
        return result, dict(NO_REUSE), ""
    get, repository, run_id = api(environ, get), environ.get("GITHUB_REPOSITORY", ""), environ.get("GITHUB_RUN_ID", "")
    if not (get and repository and run_id):
        return result, dict(NO_REUSE), "checks run: no token to look for a green branch run"
    try:
        run, names, why = find_reusable(get, repository, run_id, sha, result)
    except urllib.error.HTTPError as error:
        return result, dict(NO_REUSE), f"checks run: the run lookup failed with HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - any failure means: run the checks
        return result, dict(NO_REUSE), f"checks run: the run lookup failed ({type(error).__name__})"
    if run is None:
        return result, dict(NO_REUSE), f"checks run: {why}"
    reused, extra = reuse(result, run, names)
    return reused, extra, f"checks reused: {why} ({extra['reused_jobs']})"


def git_diff(base: str, after: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", base, after], check=True, capture_output=True, text=True
    )
    return result.stdout.splitlines()


def git_show(revision: str, path: str) -> str:
    """A file's text at a revision. A file missing there, or any other failure, raises ValueError (the classifier then
    counts the whole workspace as changed)."""
    result = subprocess.run(["git", "show", f"{revision}:{path}"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise ValueError(f"{path} is unreadable at {revision[:12]}")
    return result.stdout


def git_is_ancestor(base: str, after: str) -> bool:
    return (
        subprocess.run(["git", "merge-base", "--is-ancestor", base, after], capture_output=True, check=False).returncode
        == 0
    )


def git_first_parents(after: str, count: int) -> list[str]:
    """The commits before `after` on its first-parent line, newest first; empty when git cannot tell."""
    command = ["git", "rev-list", "--first-parent", f"--max-count={count}", f"{after}~1"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    return result.stdout.split() if result.returncode == 0 else []


def git_merge_base(after: str) -> str:
    result = subprocess.run(["git", "merge-base", "origin/main", after], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def main(get: Callable[[str], dict] | None = None) -> int:
    event, ref = os.environ.get("EVENT_NAME", ""), os.environ.get("REF", "")
    after = os.environ.get("AFTER", "HEAD")
    resume = os.environ.get("DISPATCH_RESUME", "false") or "false"
    if resume not in {"true", "false"}:
        raise ValueError("Invalid VPS resume selection")
    last_success = ""
    if event == "push" and ref == MAIN:
        last_success = find_last_success(after, dict(os.environ), get)
        print(f"Last successful main run: {last_success or 'none'}")
    result, reason, base = decide(
        event,
        ref,
        after,
        os.environ.get("DISPATCH_APP", ""),
        last_success,
        git_diff,
        git_is_ancestor,
        git_merge_base,
        resume=resume == "true",
        resume_source_sha=os.environ.get("RESUME_SOURCE_SHA", ""),
        show=git_show,
    )
    result, extra, reuse_reason = try_reuse(event, ref, after, result, dict(os.environ), get)
    if reuse_reason:
        reason = f"{reason}; {reuse_reason}"
    lines = [f"{key}={str(result[key]).lower()}" for key in KEYS]
    lines += [f"{key}={' '.join(extra[key].split())}" for key in REUSE_KEYS]
    lines.append(f"{BASE_KEY}={base if all(c in '0123456789abcdef' for c in base) else ''}")
    print(reason)
    print("\n".join(lines))
    for name, text in (("GITHUB_OUTPUT", "\n".join(lines)), ("GITHUB_STEP_SUMMARY", summary(result, reason))):
        if os.environ.get(name):
            with open(os.environ[name], "a", encoding="utf-8") as handle:
                handle.write(text + "\n")
    return 0


def summary(result: dict[str, bool], reason: str) -> str:
    rows = "\n".join(f"| `{key}` | {'yes' if result[key] else 'no'} |" for key in KEYS)
    return f"### Changed areas\n\n{reason}\n\n| Output | Runs |\n| --- | --- |\n{rows}"


if __name__ == "__main__":
    sys.exit(main())
