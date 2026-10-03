#!/usr/bin/env python3
"""Decide which apps a CI run checks and deploys. Standard library only (the runner's python3).

Outputs (GITHUB_OUTPUT, "true"/"false"):
  todofy_check, mail_hero_check, dashboard_check, website_check, lab_check, flowday_check, links_check, watch_check,
  newsletter_check, fleet_check, platform_check
                    run that app's full checks
  contracts         run the contract tests: both sides of mail.received.v1, ops-v1 and
                    task-intent-v1, and the dashboard's ops-v1 caller tests (also on a proto/ change: the
                    task-intent-v1 tests check the generated types and the codecs against the schema)
  packages          run every shared package's own checks (packages/*)
  infra             run "Infra checks" (OpenTofu fmt/validate of infra/, its guards and the plan-summary
                    tests): infra/, tools/infra-plan-summary/ or .github/ changed. Never deploys anything;
                    not set by a dispatch (no app needs it).
  proto             run "Proto checks" (buf lint, buf breaking and the wire profile rules against "base",
                    deterministic generation, the one-version rule, both codecs' tests): proto/, .github/ or
                    tools/ changed, or a dispatch.
  base              not a flag: the commit the diff started from (empty when everything runs), which
                    "Proto checks" compares the IDL with.
  todofy_deploy, mail_hero_deploy, dashboard_deploy, website_deploy, lab_deploy, flowday_deploy, links_deploy,
  watch_deploy, newsletter_deploy, fleet_deploy, platform_publish, platform_deploy
                    the app, a shared package it compiles in, or a contract file it bundles changed
                    (deploy jobs also require refs/heads/main)
  website_relay_deploy
                    website/relay/ (the Notion relay Worker, its own wrangler.toml) changed: deploy
                    the relay. A change only there checks the website but does not release the site;
                    a website change elsewhere releases the site but does not redeploy the relay.
  FlowDay (flowday/) is checked and deployed like the other apps since F2 (flowday/docs/design.md section 11). It uses
  no contract (NO_CONTRACTS) and compiles in packages/edge-auth and the TypeScript proto runtime with
  proto/flowday/ui/ (its owner API, flowday.ui.v1), so a change to those checks and deploys it too. The links app
  (links/, the short links on s.ziyixi.science) is checked and deployed since L2 (links/docs/design.md section 11). It
  uses no contract and compiles in packages/edge-auth and the TypeScript proto runtime with proto/links/ui/, so a
  change to those checks and deploys it too. The watch app (watch/, the web watches on watch.ziyixi.science) is
  checked and deployed since W2 (watch/docs/design.md section 11). It proposes task-intent-v1 (its notification sink)
  and answers ops-v1 (its Ops entrypoint; Contracts runs both tests) and compiles in packages/edge-auth and the
  TypeScript proto runtime with proto/watch/ui/, proto/todofy/taskintent/ and proto/ops/, so a change to those checks
  and deploys it too. CHECK_ONLY keeps a new app's deploy output false until its resources are ready. Fleet's
  Access resources are registered; its deployment and Home's binding can now be published after the gate.

proto/ (the protobuf IDL, proto/README.md) checks every app in PROTO_USERS (an app that depends on @ziyixi/proto or
ziyixi-proto) and deploys only the apps whose bundle the changed path reaches (proto_deploys): PROTO_USERS[app] names
the languages whose generated code and runtime the app's production bundles compile in ("ts": Lab's, FlowDay's, Mail
Hero's, the links app's, the watch app's and the dashboard's Workers and UIs, and Todofy's gateway and UI
(todofy.ui.v1's transcoder and client); "python": todofy-core, through the wheel pywrangler vendors), PROTO_RUNTIMES
maps a language's runtime and generator to that language's users, and PROTO_PACKAGES maps each proto package to the apps
that import its generated code (lab/ui reaches Lab only, flowday/ui FlowDay only, mailhero/ui Mail Hero only, links/ui
the links app only, watch/ui the watch app only, dashboard/ui the dashboard only, todofy/ui Todofy only; prototest, the
runtimes' fixtures, reaches no app). Tests, test data, the check scripts, the api-linter tool module, check configs and
Markdown (PROTO_NOT_BUNDLED) deploy nothing; any other proto/ path (buf.yaml, buf.lock, the toolchain lockfile,
ensure.mjs, a package not listed yet) deploys every user (fail safe). test_proto.py derives PROTO_USERS and the
packages' importers from the sources. It also runs Contracts. A change to a contract proto/'s tests read (PROTO_READS:
ops-v1's, task-intent-v1's and mail-received-v1's fixtures and schemas) runs Proto checks as well.

push: the files changed between a cumulative base and github.sha, never only this push's own diff,
so a change whose run was cancelled or failed is checked (and deployed) again by the next run.
  main           base = the commit of the last successful push run of this workflow on main
                 (LAST_SUCCESS). Any run that failed or was cancelled, including a cancelled deploy,
                 is not "success", so its changes stay in the next run's diff.
  other branches base = git merge-base origin/main HEAD, so the head commit's gate covers every
                 change on the branch, not only the latest push.
  No usable base (no successful main run yet, API failure, base not an ancestor, no origin/main)
  runs everything. An app's own directory checks and deploys it; contracts/ and .github/ re-check
  every app but deploy none, except the contract files the TypeScript Workers bundle (BUNDLED_BY,
  e.g. OPS_LIMITS in contracts/ops-v1/ops-v1.ts, or the schema and validate.mjs Lab checks task
  intents with), which also deploy every app listed for them. A
  shared package packages/<name>/ is compiled into the apps listed in PACKAGE_USERS, so any change
  inside it runs the package checks and checks AND deploys each of those apps. Its Markdown documents
  (packages/<name>/**/*.md: README, SPEC) are compiled into nothing: they run the package checks and
  check those apps (tests cite the SPEC) but deploy none, so a documentation edit never redeploys
  production. A package missing from PACKAGE_USERS counts as used by every app (fail safe; the tests
  run by the Changes job also fail until PACKAGE_USERS matches the file: dependencies). A file
  directly under packages/ (a README) is root documentation: gate only.
Newsletter remains an independent VPS image. newsletter_deploy publishes its tested image to GHCR; it does
not upgrade the server. It still uses its locked external ziyixi-protos dependency, not the root proto runtime.
platform/ checks and publishes its own independently tested daemon image; platform_deploy upgrades the VPS.
Newsletter changes also check and publish Platform from the same source SHA before the VPS release.
A push to main reuses a green branch run of the same commit (find_reusable): when a completed push run of
this workflow on another branch has the same head SHA, concluded success, and its Changes, CI gate and
every check job this push needs (CHECK_JOBS) succeeded, the check outputs are all false (those jobs are
skipped), checks_reused=true names that run, and the deploy outputs are unchanged. The deploy jobs accept
a skipped check job only together with checks_reused; the gate passes and prints the run. The same SHA is
the same tree and the same ci.yml, and no check job uses a secret, so the branch run's verdict holds
(test_wrangler_configs.py: no job before the deploys reads a secret, has an environment or deploys for real).
Anything else (no such run, a check it did not run, an API error, workflow_dispatch) runs the checks.
tools/ (CI, test and build tooling: the deploy hostname guard, and the bundle budgets and CPU meter that the
apps' build scripts and tests import, which no bundle carries: test_ci_changes.py ToolsImports) counts as
.github/: every app is re-checked, none deployed. The exception is tools/infra-plan-summary/, which belongs to
infra/: it runs only Infra checks, as infra/ does (and .github/ does too); the other tools/ do not run them.
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
KEYS = (
    "todofy_check",
    "mail_hero_check",
    "dashboard_check",
    "website_check",
    "lab_check",
    "flowday_check",
    "links_check",
    "watch_check",
    "newsletter_check",
    "fleet_check",
    "platform_check",
    "contracts",
    "packages",
    "infra",
    "proto",
    "todofy_deploy",
    "mail_hero_deploy",
    "dashboard_deploy",
    "website_deploy",
    "website_relay_deploy",
    "lab_deploy",
    "flowday_deploy",
    "links_deploy",
    "watch_deploy",
    "newsletter_deploy",
    "fleet_deploy",
    "platform_publish",
    "platform_deploy",
)
DISPATCH = {
    "both": ("todofy", "mail-hero"),
    "all": APPS,
    "todofy": ("todofy",),
    "mail-hero": ("mail-hero",),
    "dashboard": ("dashboard",),
    "website": ("website",),
    "lab": ("lab",),
    "flowday": ("flowday",),
    "links": ("links",),
    "watch": ("watch",),
    "newsletter": ("newsletter",),
    "fleet": ("fleet",),
    "platform": ("platform",),
}
# The website's Notion relay Worker deploys on its own (website_relay_deploy).
RELAY = "website/relay/"
# Apps that neither provide nor consume a contract: their own changes do not run Contracts.
NO_CONTRACTS = {"website", "flowday", "links", "newsletter"}
# The OpenTofu configuration (infra/README.md) and its plan-summary tool: checked here without a token; only
# .github/workflows/infra.yml plans it against Cloudflare, and only the manually dispatched infra-apply.yml applies it.
INFRA = ("infra/", "tools/infra-plan-summary/")
# These are source inputs to checked generators, not deployable Worker bundles. Generated app source changes are
# classified through their own app directory; editing the central inputs alone cannot publish production.
CLOUD_CONFIG = {"config/cloud.toml", "config/resources.toml"}
# packages/<name>/ -> the apps whose Workers compile it in (a "file:../../packages/<name>" dependency).
PACKAGE_USERS = {"edge-auth": ("todofy", "mail-hero", "dashboard", "lab", "flowday", "links", "watch", "fleet")}
# The protobuf IDL (proto/README.md): app -> the languages ("ts", "python") whose generated code and runtime
# its production bundles compile in; () for a user whose bundles take nothing from it (types only, tests
# only). test_proto.py derives this map from the apps' manifests and sources.
PROTO = "proto/"
PROTO_USERS: dict[str, tuple[str, ...]] = {
    "lab": ("ts",),
    "todofy": ("python", "ts"),
    "flowday": ("ts",),
    "links": ("ts",),
    "mail-hero": ("ts",),
    "dashboard": ("ts",),
    "watch": ("ts",),
    "fleet": ("ts",),
    "platform": ("python",),
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
    "proto/todofy/taskintent/": ("lab", "todofy", "watch"),
    # recommendation-v1 and summary-v1 (todofy/api/*.schema.json are generated from it): todofy-core builds them.
    "proto/todofy/report/": ("todofy",),
    # Todofy's owner API (todofy.ui.v1): todofy-core writes every answer with it, the gateway serves it through the
    # shared transcoder and Todofy's UI calls it through the shared client.
    "proto/todofy/ui/": ("todofy",),
    "proto/lab/ui/": ("lab",),
    "proto/flowday/ui/": ("flowday",),
    "proto/links/ui/": ("links",),
    "proto/watch/ui/": ("watch",),
    "proto/fleet/ui/": ("fleet",),
    "proto/fleet/telemetry/": ("fleet", "platform"),
    "proto/platform/runtime/": ("fleet", "platform"),
    # dashboard.ui.v1, the dashboard's owner API: its Worker serves it, its UI calls it.
    "proto/dashboard/ui/": ("dashboard",),
    # Mail Hero's owner API (mailhero.ui.v2): its Worker serves it, its UI calls it.
    "proto/mailhero/ui/": ("mail-hero",),
    # CommonReason: Platform bundles Python error aliases; Lab takes its names as types only.
    "proto/common/errors/": ("platform",),
    # ops-v1 (contracts/ops-v1): every app's Ops entrypoint and the dashboard that calls them.
    "proto/ops/": ("mail-hero", "lab", "todofy", "dashboard", "watch"),
    # mail.received.v1 (contracts/mail-received-v1's schema is generated from it): Mail Hero builds every event,
    # todofy-core reads every webhook body.
    "proto/mailhero/webhook/": ("mail-hero", "todofy"),
    # The runtimes' test fixtures (never imported by an app; not in the Python wheel).
    "proto/prototest/": (),
}
# The contracts whose fixtures and schemas proto/'s own tests read (proto/test/ops.test.ts and test_ops.py round-trip
# every ops-v1 fixture byte for byte through both codecs, mail-received.test.ts and test_mail_received.py every
# mail-received-v1 event; the task-intent-v1 tests check both codecs against its schema; Proto checks also compares
# ops-v1's and mail-received-v1's JSON Schemas with the ones the IDL generates): a change there runs Proto checks too,
# so a fixture neither codec writes byte for byte, or one a strict read wrongly accepts, fails its push.
PROTO_READS = ("contracts/ops-v1/", "contracts/task-intent-v1/", "contracts/mail-received-v1/", "contracts/fleet-report-v1/", "contracts/platform-runtime-v1/")
# proto/ paths that never reach a bundle: a change there checks the users but deploys none.
PROTO_NOT_BUNDLED = (
    "proto/test/",
    "proto/testdata/",
    "proto/scripts/",
    "proto/tools/profile_breaking.py",
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
# in its bundle; Lab validates task intents with their schema and validate.mjs), mapped to the apps
# that bundle them: a change ships only with a deploy of each. ops-v1's schema is generated from
# proto/ops/ and bundled by nobody: every app reads and writes ops-v1 with the generated code
# (PROTO_PACKAGES).
# test_ci_changes.py checks this map against the Workers' imports.
BUNDLED_BY = {
    "contracts/ops-v1/ops-v1.ts": ("todofy", "mail-hero", "dashboard", "lab", "watch"),
    # Lab validates its task intents and Todofy's answers with validate.mjs (ops-v1 answers are read with the
    # generated code: proto/ops/).
    "contracts/ops-v1/validate.mjs": ("lab",),
    # task-intent-v1: Lab and the watch app propose (bounds; Lab also the schema), Todofy's gateway forwards (the input
    # bound). The types are generated from proto/ (PROTO_USERS).
    "contracts/task-intent-v1/task-intent-v1.ts": ("lab", "todofy", "watch"),
    "contracts/task-intent-v1/task-intent-v1.schema.json": ("lab",),
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
    "lab_check": ("Lab checks",),
    "flowday_check": ("FlowDay checks",),
    "links_check": ("Links checks",),
    "watch_check": ("Watch checks",),
    "newsletter_check": ("Newsletter checks", "Newsletter image checks"),
    "fleet_check": ("Fleet checks",),
    "platform_check": ("Platform checks",),
    "contracts": ("Contracts",),
    "packages": ("Shared packages",),
    "infra": ("Infra checks",),
    "proto": ("Proto checks",),
}
# Jobs every reused run must have passed, whatever this push needs.
ALWAYS_JOBS = ("Changes", "CI gate")
# How many same-SHA branch runs are inspected (newest first).
MAX_REUSE_CANDIDATES = 5


def everything() -> dict[str, bool]:
    return outputs(APPS, APPS, contracts=True, packages=True, relay=True, infra=True, proto=True)


def outputs(
    checked: Iterable[str],
    deployed: Iterable[str],
    contracts: bool,
    packages: bool,
    relay: bool = False,
    infra: bool = False,
    proto: bool = False,
) -> dict[str, bool]:
    checked, deployed = set(checked), set(deployed)
    # This release profile takes two independently tested images of the same source SHA. Any publication/VPS
    # deployment input therefore publishes both; metadata-only inputs still check without publishing.
    if deployed & {"newsletter", "platform"}:
        checked.update({"newsletter", "platform"})
        deployed.update({"newsletter", "platform"})
    result = {
        "contracts": contracts,
        "packages": packages,
        "infra": infra,
        "proto": proto,
        "website_relay_deploy": relay,
    }
    for app in APPS:
        result[f"{PREFIX[app]}_check"] = app in checked
        # Home binds Fleet's entrypoints. Until Fleet's bootstrap is complete, neither Worker can be published by
        # full fallback, dispatch, a path diff or reused branch checks. No deployment decision bypasses this gate.
        blocked = app in CHECK_ONLY or (app == "dashboard" and "fleet" in CHECK_ONLY)
        result[f"{PREFIX[app]}_deploy"] = app in deployed and not blocked
    result["platform_publish"] = result.get("platform_deploy", False)
    return {key: result[key] for key in KEYS}


def is_package_document(path: str) -> bool:
    """A Markdown file inside a package (packages/<name>/**/*.md): documentation, never compiled in."""
    return path.startswith("packages/") and path.count("/") >= 2 and path.endswith(".md")


def proto_deploys(path: str) -> set[str]:
    """The apps whose production bundle a change of one proto/ path can reach."""
    if path.startswith(PROTO_NOT_BUNDLED) or path.endswith(".md"):
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


def classify(paths: Iterable[str]) -> dict[str, bool]:
    paths = [path for path in paths if path]
    apps = {app for app in APPS if any(path.startswith(f"{app}/") for path in paths)}
    # A Newsletter release also tests and publishes the independent monitor image from this source SHA.
    if "newsletter" in apps:
        apps.add("platform")
    # Catalog metadata is verified/generated before the gate; an app.toml itself is not bundled.
    direct_deploys = {app for app in apps if any(path.startswith(f"{app}/") and path != f"{app}/app.toml"
                       and not (app in {"newsletter", "platform"} and path.endswith(".md")) for path in paths)}
    if "newsletter" in direct_deploys:
        direct_deploys.add("platform")
    # This shared promotion tool owns both tested-image publications. Its executable changes need fresh tested
    # images and the gated VPS release; its Markdown remains ordinary tooling documentation (checks only).
    if any(path.startswith(("tools/container-release/", "tools/platform-build/", "tools/vps-release/")) and not path.endswith(".md") for path in paths):
        direct_deploys.update({"newsletter", "platform"})
    # packages/<name>/<file>: at least three components; packages/README.md is documentation.
    package_paths = [path for path in paths if path.startswith("packages/") and path.count("/") >= 2]
    package_names = {path.split("/")[1] for path in package_paths}
    # Users of a package whose code (anything but its documents) changed are checked and deployed;
    # users of a package whose documents alone changed are only checked.
    compiled = {path.split("/")[1] for path in package_paths if not is_package_document(path)}
    documented: set[str] = set()
    for name in package_names:
        (apps if name in compiled else documented).update(PACKAGE_USERS.get(name, APPS))
    # tools/ is CI, test and build tooling (tools/cf-guard, tools/bundle-size, tools/workerd-cpu): like .github/, it
    # re-checks every app and deploys none.
    # tools/infra-plan-summary/ belongs to infra/ and runs only Infra checks.
    ci = any((path.startswith((".github/", "tools/")) and not path.startswith(INFRA)) or path in CLOUD_CONFIG for path in paths)
    shared = ci or any(path.startswith("contracts/") for path in paths)
    bundled = {app for path in paths for app in BUNDLED_BY.get(path, ())}
    # website/relay/ is its own Worker: it deploys itself, not the site (unless the site's own files, or a
    # package counted as used by it, changed too).
    relay = any(path.startswith(RELAY) for path in paths)
    site = any(path.startswith("website/") and not path.startswith(RELAY) for path in paths)
    site |= any("website" in PACKAGE_USERS.get(name, APPS) for name in compiled)
    proto_checked, proto_deployed = proto_users(paths)
    package_deploys = {app for name in compiled for app in PACKAGE_USERS.get(name, APPS)}
    deployed = direct_deploys | package_deploys | bundled | proto_deployed
    if not site:
        deployed -= {"website"}
    return outputs(
        checked=APPS if shared else apps | documented | proto_checked,
        deployed=deployed,
        contracts=bool((apps - NO_CONTRACTS) | documented | proto_checked) or shared,
        packages=bool(package_names) or ci,
        relay=relay,
        infra=any(path.startswith((".github/", *INFRA)) for path in paths),
        proto=ci or bool(proto_checked) or any(path.startswith(PROTO_READS) for path in paths),
    )


def dispatched(app: str) -> dict[str, bool]:
    if app not in DISPATCH:
        raise ValueError(f"unknown app input {app!r}; expected one of {sorted(DISPATCH)}")
    apps = DISPATCH[app]
    if "newsletter" in apps and "platform" not in apps:
        apps = (*apps, "platform")
    website = "website" in apps
    return outputs(checked=apps, deployed=apps, contracts=True, packages=True, relay=website, proto=True)


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
) -> tuple[dict[str, bool], str, str]:
    """(outputs, reason, diff base); the base is empty when there is no diff (everything runs)."""
    if resume:
        if event != "workflow_dispatch" or ref != MAIN or app not in {"platform", "newsletter"}:
            raise ValueError("VPS resume requires a main dispatch for platform or newsletter")
        if not re.fullmatch(r"[0-9a-f]{40}", resume_source_sha):
            raise ValueError("VPS resume requires the original release's full source SHA")
        result = outputs(checked={"platform", "newsletter"}, deployed=(), contracts=True, packages=True, proto=True)
        # Continue the authenticated daemon's immutable targets. Publishing new images here
        # could replace an existing source tag with different bytes under the same release ID.
        result["platform_deploy"] = True
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
    return classify(paths), f"{len(paths)} file(s) changed since {base[:12]} ({why})", base


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
            image_artifacts = []
            if result["newsletter_deploy"]:
                image_artifacts.append(f"newsletter-image-{sha}")
            if result["platform_publish"]:
                image_artifacts.append(f"platform-image-{sha}")
            if image_artifacts:
                # Publishing must load the exact image this branch tested. An expired or missing
                # artifact falls back to this main run's checks/build, never an untested rebuild.
                artifacts = get(f"/repos/{repository}/actions/runs/{run['id']}/artifacts?per_page=100")
                available = {a.get("name") for a in artifacts.get("artifacts", [])
                             if isinstance(a, dict) and a.get("expired") is False}
                if not set(image_artifacts) <= available:
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


def try_reuse(
    event: str, ref: str, sha: str, result: dict[str, bool], environ: dict[str, str], get: Callable[[str], dict] | None = None
) -> tuple[dict[str, bool], dict[str, str], str]:
    """Only a push to main that needs checks looks for a run to reuse; any failure runs the checks."""
    if event != "push" or ref != MAIN or not any(result[key] for key in CHECK_JOBS):
        return result, dict(NO_REUSE), ""
    repository, run_id = environ.get("GITHUB_REPOSITORY", ""), environ.get("GITHUB_RUN_ID", "")
    token = environ.get("GH_TOKEN", "")
    if get is None:
        if not (token and repository and run_id):
            return result, dict(NO_REUSE), "checks run: no token to look for a green branch run"
        get = github_get(token, environ.get("GITHUB_API_URL", "https://api.github.com"))
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


def git_is_ancestor(base: str, after: str) -> bool:
    return (
        subprocess.run(["git", "merge-base", "--is-ancestor", base, after], capture_output=True, check=False).returncode
        == 0
    )


def git_merge_base(after: str) -> str:
    result = subprocess.run(["git", "merge-base", "origin/main", after], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def main(get: Callable[[str], dict] | None = None) -> int:
    event, ref = os.environ.get("EVENT_NAME", ""), os.environ.get("REF", "")
    after = os.environ.get("AFTER", "HEAD")
    resume = os.environ.get("DISPATCH_RESUME", "false") or "false"
    if resume not in {"true", "false"}:
        raise ValueError("Invalid VPS resume selection")
    result, reason, base = decide(
        event,
        ref,
        after,
        os.environ.get("DISPATCH_APP", ""),
        os.environ.get("LAST_SUCCESS", "").strip(),
        git_diff,
        git_is_ancestor,
        git_merge_base,
        resume=resume == "true",
        resume_source_sha=os.environ.get("RESUME_SOURCE_SHA", ""),
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
