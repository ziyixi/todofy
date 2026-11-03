"""Select, compare and record a Worker release without exposing private configuration."""

import argparse
import json
import os
import sys
import tomllib
from pathlib import Path

from api import Api, ReleaseError
from cloudflare import digest, observe, routes_differences, verify, verify_resources
from deployments import identity, last_good, receipt, record_success, release_units

ROOT = Path(__file__).resolve().parents[2]
# The assets-only website has no Worker script: website-release.yml publishes it with its own recipe and receipt.
WORKERS = {unit: paths for unit, paths in release_units(ROOT).items() if unit != "website"}
# A receipt reads at most this many 100-job pages of one CI run.
MAX_JOB_PAGES = 5
MANUAL = {
    "SECRET_MISSING",
    "BINDING_TYPE_CHANGED",
    "BINDING_UNDECLARED",
    "OPERATIONAL_SWITCH_CHANGED",
    "STATEFUL_BINDING_CHANGED",
    "DOMAIN_REMOVAL_REQUIRED",
    "DOMAIN_OWNERSHIP_CONFLICT",
    "ROUTE_REMOVAL_REQUIRED",
    "ROUTE_OWNERSHIP_CONFLICT",
}
RETIRED_WEBSITE_BINDINGS = {
    "NOTION_TOKEN",
    "NOTION_DATA_SOURCE_ID",
    "NOTION_WEBHOOK_SECRET",
    "NOTION_API_VERSION",
    "AUTO_PUBLISH",
    "QUIET_MINUTES",
    "MAX_AUTO_RELEASES_PER_DAY",
    "RECONCILE_UTC_HOUR",
    "IGNORED_EDITOR_IDS",
}
# Exact non-secret bindings the owner retired; normal releases remove them, repairs still stop.
# Remove each entry in a later change after a verified release has removed those bindings.
# Todofy no longer writes Tasks through its TASKS service binding (2026-10-21).
# Its direct Gemini URL and model-chain variables move to Model Router.
# Mailsort replaces Workers AI with its native Claude API client (2026-10-24).
# Model Router owns the migrated caller connections: Mailsort's direct executor URL retires.
# Secrets never go here: deploy keeps unnamed secrets, so retire those separately before release.
RETIRED_BINDINGS: dict[str, set[str]] = {
    "todofy": {"TASKS", "GEMINI_API_BASE", "GEMINI_EMAIL_MODELS", "GEMINI_MODELS"},
    "mailsort": {"AI", "CODEX_ENDPOINT_URL"},
}


def read_toml(path):
    return tomllib.loads(path.read_text())


def release_inputs(source, app):
    profile = read_toml(source / "config/cloud.toml")
    resources = read_toml(source / "config/resources.toml")
    target_profile = read_toml(ROOT / "config/cloud.toml")
    target_resources = read_toml(ROOT / "config/resources.toml")
    if any(
        profile.get(key) != target_profile.get(key)
        for key in ("repository", "zone", "access_issuer")
    ) or any(
        resources.get(key) != target_resources.get(key)
        for key in ("account_id", "zone_id")
    ):
        raise ReleaseError("RELEASE_ENVIRONMENT_CHANGED")
    configs = [read_toml(source / path) for path in WORKERS[app]]
    desired = json.loads(
        (source / "dashboard/worker/src/drift-desired.json").read_text()
    )["workers"]
    secrets = json.loads(
        (source / "tools/cloud-config/worker-secrets.json").read_text()
    )
    for config in configs:
        if config["account_id"] != resources["account_id"]:
            raise ReleaseError("RELEASE_ENVIRONMENT_CHANGED")
        wanted = desired[config["name"]]
        bindings = {binding["name"]: binding for binding in wanted["bindings"]}
        spec = secrets[config["name"]]
        for name in spec["required"] + spec["optional"]:
            bindings[name] = {
                "name": name,
                "type": "secret_text",
                "optional": name in spec["optional"],
            }
        # Only this retired secret may remain until owner deletion after the keyless rollout.
        if config["name"] in {"home", "links", "watch", "mailsort", "recall", "tasks", "todofy", "model-router"}:
            bindings.setdefault("CSRF_SIGNING_KEY", {"name": "CSRF_SIGNING_KEY", "type": "secret_text", "optional": True})
        # Retained old model connections are tolerated only as live bindings through cutover.
        for name in {
            "todofy-core": ("GEMINI_API_KEY",),
            "mailsort": ("ANTHROPIC_API_KEY", "CODEX_ENDPOINT_TOKEN", "CODEX_ACCESS_CLIENT_ID", "CODEX_ACCESS_CLIENT_SECRET"),
        }.get(config["name"], ()):
            bindings.setdefault(name, {"name": name, "type": "secret_text", "optional": True})
        wanted["bindings"] = list(bindings.values())
    return profile, resources, configs, desired


def operational_values(app, desired):
    prefix = app.upper().replace("-", "_")
    result = {}
    for item in desired["bindings"]:
        name = item["name"]
        if (
            item.get("source") == "deploy"
            and item["type"] == "plain_text"
            and name != "BUILD_SHA"
        ):
            value = os.environ.get(prefix + "_" + name)
            if value is None or value == "":
                raise ReleaseError("OPERATIONAL_INPUT_MISSING")
            result[name] = value
    return result


def _latest_jobs(github, repository, run_id):
    """Every job of the run's latest execution, page by page; an incomplete listing fails closed.

    A main run has about 55 jobs: filter=all would list a rerun's attempts twice and exceed one page,
    filter=latest lists each job's most recent attempt, and paging covers a run that outgrows one page.
    """
    jobs = []
    for page in range(1, MAX_JOB_PAGES + 1):
        listing = github.call(
            "/repos/"
            + repository
            + "/actions/runs/"
            + str(run_id)
            + "/jobs?filter=latest&per_page=100&page="
            + str(page)
        )
        if not isinstance(listing, dict) or not isinstance(listing.get("jobs"), list):
            raise ReleaseError("RECEIPT_CI_GATE_NOT_VERIFIED")
        jobs += listing["jobs"]
        total = listing.get("total_count", len(jobs))
        if type(total) is not int:
            raise ReleaseError("RECEIPT_CI_GATE_NOT_VERIFIED")
        if not listing["jobs"] or len(jobs) >= total:
            break
    if total > len(jobs):
        raise ReleaseError("RECEIPT_CI_GATE_NOT_VERIFIED")
    return jobs


def _checked_receipt_source(github, repository, sha, main_sha):
    if sha != main_sha:
        comparison = github.call(
            "/repos/" + repository + "/compare/" + sha + "..." + main_sha
        )
        if (
            not isinstance(comparison, dict)
            or comparison.get("status") != "ahead"
            or comparison.get("merge_base_commit", {}).get("sha") != sha
        ):
            raise ReleaseError("RECEIPT_SOURCE_NOT_MAIN")
    listing = github.call(
        "/repos/"
        + repository
        + "/actions/workflows/ci.yml/runs?head_sha="
        + sha
        + "&event=push&branch=main&status=completed&per_page=50"
    )
    if not isinstance(listing, dict) or not isinstance(
        listing.get("workflow_runs"), list
    ):
        raise ReleaseError("RECEIPT_CI_GATE_NOT_VERIFIED")
    runs = [
        value
        for value in listing["workflow_runs"]
        if isinstance(value, dict)
        and type(value.get("id")) is int
        and value["id"] > 0
        and value.get("head_sha") == sha
        and value.get("head_branch") == "main"
        and value.get("event") == "push"
        and value.get("status") == "completed"
    ]
    if not runs:
        raise ReleaseError("RECEIPT_CI_GATE_NOT_VERIFIED")
    run = max(runs, key=lambda value: value["id"])
    jobs = _latest_jobs(github, repository, run["id"])
    gates = [
        value
        for value in jobs
        if isinstance(value, dict)
        and type(value.get("id")) is int
        and value.get("name") == "CI gate"
        and value.get("status") == "completed"
        and value.get("head_sha", sha) == sha
    ]
    if (
        not gates
        or max(gates, key=lambda value: value["id"]).get("conclusion") != "success"
    ):
        raise ReleaseError("RECEIPT_CI_GATE_NOT_VERIFIED")


def prepare(
    app,
    source_sha,
    repair,
    github,
    expected_main_sha="",
    *,
    record_only=False,
    deployment_id="",
):
    repository = os.environ["GITHUB_REPOSITORY"]
    if expected_main_sha:
        identity(repository, app, expected_main_sha)
        current = github.call("/repos/" + repository + "/git/ref/heads/main")
        if current.get("object", {}).get("sha") != expected_main_sha:
            raise ReleaseError("RECONCILE_MAIN_CHANGED")
    if record_only:
        if (
            repair
            or not expected_main_sha
            or os.environ.get("GITHUB_SHA") != expected_main_sha
        ):
            raise ReleaseError("RECORD_ONLY_MODE_INVALID")
        saved = receipt(github, repository, app, deployment_id)
        if source_sha and source_sha != saved["sha"]:
            raise ReleaseError("DEPLOYMENT_EVIDENCE_MISMATCH")
        _checked_receipt_source(github, repository, saved["sha"], expected_main_sha)
        return saved["sha"]
    if repair:
        record = last_good(github, repository, app)
        if source_sha and source_sha != record["sha"]:
            raise ReleaseError("REPAIR_TARGET_CHANGED")
        return record["sha"]
    identity(repository, app, source_sha)
    if source_sha != os.environ["GITHUB_SHA"]:
        raise ReleaseError("RELEASE_SOURCE_UNCHECKED")
    return source_sha


def preflight(source, app, sha, repair, cloud, github, check_only=False):
    profile, resources, configs, desired = release_inputs(source, app)
    accepted = last_good(github, profile["repository"], app) if repair else None
    baseline = accepted["payload"] if accepted else None
    if accepted and accepted["sha"] != sha:
        raise ReleaseError("REPAIR_TARGET_CHANGED")
    actual_resources = verify_resources(cloud, resources, configs)
    if baseline and actual_resources != baseline.get("persistent_resources"):
        raise ReleaseError("PERSISTENT_RESOURCE_IDENTITY_CHANGED")
    changes = []
    for config in configs:
        saved = next(
            (
                item
                for item in (baseline or {}).get("workers", [])
                if item["script"] == config["name"]
            ),
            None,
        )
        if repair and (saved is None or saved.get("config_hash") != digest(config)):
            raise ReleaseError("REPAIR_CONFIG_CHANGED")
        try:
            status = observe(
                cloud,
                config,
                desired[config["name"]],
                resources,
                sha,
                saved,
                operational_values(app, desired[config["name"]]),
            )
        except ReleaseError as error:
            if str(error) != "PROVIDER_HTTP_404" or repair:
                raise
            status = {"changes": [{"field": "script", "reason": "FIRST_DEPLOYMENT"}]}
        status["changes"] += routes_differences(
            cloud,
            resources["account_id"],
            resources["zone_id"],
            config["name"],
            desired[config["name"]],
        )
        changes += [
            {"script": config["name"], **change} for change in status["changes"]
        ]
    if not repair:
        # Normal releases apply the owner's GitHub variables; repair cannot change live switches.
        for change in changes:
            if change["reason"] == "OPERATIONAL_SWITCH_CHANGED":
                change["reason"] = "OPERATIONAL_RELEASE_UPDATE"
            if (
                app == "website-relay"
                and change["reason"] == "BINDING_UNDECLARED"
                and change["field"] in RETIRED_WEBSITE_BINDINGS
                and "DAILY_SYNC_CRON" in configs[0].get("vars", {})
            ):
                # Explicit owner-approved retirement; other undeclared bindings still stop release/repair.
                change["reason"] = "LEGACY_WEBSITE_BINDING_RETIRED"
            if (
                change["reason"] == "BINDING_UNDECLARED"
                and change["field"] in RETIRED_BINDINGS.get(app, ())
            ):
                # Explicit owner-approved retirement; repair still cannot remove it.
                change["reason"] = "RETIRED_BINDING"
    if any(item["reason"] in MANUAL for item in changes):
        print(json.dumps({"state": "manual_required", "changes": changes}))
        raise ReleaseError("REPAIR_MANUAL_REQUIRED")
    print(
        json.dumps({"state": "repairable" if changes else "clean", "changes": changes})
    )
    return not check_only and (not repair or bool(changes))


def record(source, app, sha, cloud, github, *, resume_id=None):
    profile, resources, configs, desired = release_inputs(source, app)
    evidence = []
    persistent = verify_resources(cloud, resources, configs)
    for config in configs:
        item = verify(
            cloud,
            config,
            desired[config["name"]],
            resources,
            sha,
            operational_values(app, desired[config["name"]]),
        )
        if routes_differences(
            cloud,
            resources["account_id"],
            resources["zone_id"],
            config["name"],
            desired[config["name"]],
        ):
            raise ReleaseError("WORKER_ROUTES_NOT_VERIFIED")
        evidence.append(item)
    run_url = (
        "https://github.com/"
        + profile["repository"]
        + "/actions/runs/"
        + os.environ["GITHUB_RUN_ID"]
    )
    identifier = record_success(
        github,
        profile["repository"],
        app,
        sha,
        {"workers": evidence, "persistent_resources": persistent},
        run_url,
        **({"resume_id": resume_id} if resume_id is not None else {}),
    )
    return {
        "deployment_id": identifier,
        "app": app,
        "source_sha": sha,
        "verified": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "preflight", "record"))
    parser.add_argument("--app", required=True, choices=sorted(WORKERS))
    parser.add_argument("--source-sha", default="")
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--repair", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--expected-main-sha", default="")
    parser.add_argument("--record-only", action="store_true")
    parser.add_argument("--deployment-id", default="")
    args = parser.parse_args()
    try:
        if os.environ.get("GITHUB_REF") != "refs/heads/main":
            raise ReleaseError("MAIN_REQUIRED")
        if args.record_only and (
            args.repair or args.check_only or args.operation == "preflight"
        ):
            raise ReleaseError("RECORD_ONLY_MODE_INVALID")
        if args.deployment_id and not args.record_only:
            raise ReleaseError("RECORD_ONLY_MODE_INVALID")
        github = Api("github", os.environ.get("GH_TOKEN", ""))
        if args.operation == "prepare":
            sha = prepare(
                args.app,
                args.source_sha,
                args.repair,
                github,
                args.expected_main_sha,
                record_only=args.record_only,
                deployment_id=args.deployment_id,
            )
            output = {"source_sha": sha}
        else:
            identity(os.environ["GITHUB_REPOSITORY"], args.app, args.source_sha)
            cloud = Api("cloudflare", os.environ.get("CLOUDFLARE_API_TOKEN", ""))
            if args.operation == "preflight":
                required = preflight(
                    args.source_root.resolve(),
                    args.app,
                    args.source_sha,
                    args.repair,
                    cloud,
                    github,
                    args.check_only,
                )
                output = {"required": str(required).lower()}
            else:
                if args.record_only:
                    prepare(
                        args.app,
                        args.source_sha,
                        False,
                        github,
                        args.expected_main_sha,
                        record_only=True,
                        deployment_id=args.deployment_id,
                    )
                print(
                    json.dumps(
                        record(
                            args.source_root.resolve(),
                            args.app,
                            args.source_sha,
                            cloud,
                            github,
                            **(
                                {"resume_id": int(args.deployment_id)}
                                if args.record_only
                                else {}
                            ),
                        )
                    )
                )
                return 0
        with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
            handle.writelines(
                name + "=" + value + "\n" for name, value in output.items()
            )
        if args.operation == "prepare":
            with open(os.environ["GITHUB_ENV"], "a") as handle:
                handle.write("BUILD_SOURCE_SHA=" + output["source_sha"] + "\n")
        return 0
    except (ReleaseError, KeyError, OSError, ValueError) as error:
        code = (
            str(error) if isinstance(error, ReleaseError) else "RELEASE_INPUT_INVALID"
        )
        print(json.dumps({"error_code": code}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
