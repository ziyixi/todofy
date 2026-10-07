"""Select, compare and record a Worker release without exposing private configuration."""

import argparse
import json
import os
import sys
from pathlib import Path

import tomllib
from api import Api, ReleaseError
from cloudflare import digest, observe, routes_differences, verify, verify_resources
from deployments import identity, last_good, record_success

ROOT = Path(__file__).resolve().parents[2]
WORKERS = {
    "todofy": ["todofy/wrangler.toml", "todofy/gateway/wrangler.toml"],
    "mail-hero": ["mail-hero/wrangler.toml"],
    "dashboard": ["dashboard/wrangler.toml"],
    "flowday": ["flowday/wrangler.toml"],
    "links": ["links/wrangler.toml"],
    "watch": ["watch/wrangler.toml"],
    "fleet": ["fleet/wrangler.toml"],
    "mailsort": ["mailsort/wrangler.toml"],
    "website-relay": ["website/relay/wrangler.toml"],
}
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
# Bindings to Workers the owner retired; a normal release of that app removes them.
# Drop an entry once the target Worker is deleted (see infra/README "Retiring an app"). Empty: none is being retired.
RETIRED_SERVICE_BINDINGS: dict[str, set[str]] = {}


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


def prepare(app, source_sha, repair, github, expected_main_sha=""):
    repository = os.environ["GITHUB_REPOSITORY"]
    if expected_main_sha:
        identity(repository, app, expected_main_sha)
        current = github.call("/repos/" + repository + "/git/ref/heads/main")
        if current.get("object", {}).get("sha") != expected_main_sha:
            raise ReleaseError("RECONCILE_MAIN_CHANGED")
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
                and change["field"] in RETIRED_SERVICE_BINDINGS.get(app, ())
            ):
                # Explicit owner-approved app retirement; repair still cannot remove it.
                change["reason"] = "RETIRED_SERVICE_BINDING"
    if any(item["reason"] in MANUAL for item in changes):
        print(json.dumps({"state": "manual_required", "changes": changes}))
        raise ReleaseError("REPAIR_MANUAL_REQUIRED")
    print(
        json.dumps({"state": "repairable" if changes else "clean", "changes": changes})
    )
    return not check_only and (not repair or bool(changes))


def record(source, app, sha, cloud, github):
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
    args = parser.parse_args()
    try:
        if os.environ.get("GITHUB_REF") != "refs/heads/main":
            raise ReleaseError("MAIN_REQUIRED")
        github = Api("github", os.environ.get("GH_TOKEN", ""))
        if args.operation == "prepare":
            sha = prepare(
                args.app, args.source_sha, args.repair, github, args.expected_main_sha
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
                print(
                    json.dumps(
                        record(
                            args.source_root.resolve(),
                            args.app,
                            args.source_sha,
                            cloud,
                            github,
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
