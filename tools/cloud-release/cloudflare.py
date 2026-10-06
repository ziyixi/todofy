"""Compare declared public Worker configuration with its actual provider identity."""

import hashlib
import json
import re

from api import ReleaseError

DO_KEYS = {
    "FleetState": "fleet-state",
    "HomeState": "home-state",
    "MailCoordinator": "mail-coordinator",
    "TodofyCore": "todofy-core-do",
    "WatchState": "watch-state",
    "MailsortState": "mailsort-state",
}


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def deployment_version(result):
    deployments = result.get("deployments") if isinstance(result, dict) else None
    if not isinstance(deployments, list) or not deployments:
        raise ReleaseError("WORKER_DEPLOYMENT_MISSING")
    versions = deployments[0].get("versions")
    if (
        not isinstance(versions, list)
        or len(versions) != 1
        or versions[0].get("percentage") != 100
    ):
        raise ReleaseError("WORKER_TRAFFIC_SPLIT")
    version = versions[0].get("version_id")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9a-f-]{36}", version):
        raise ReleaseError("WORKER_VERSION_INVALID")
    return version


def target(binding):
    kind = binding.get("type")
    if kind == "d1":
        return binding.get("id", binding.get("database_id"))
    if kind == "r2_bucket":
        return binding.get("bucket_name")
    if kind == "durable_object_namespace":
        return binding.get("namespace_id")
    if kind == "service":
        return service_target(binding)
    return None


def service_target(binding):
    # Default environments are equivalent; props are compared only when the API exposes them.
    return [
        binding.get("service"),
        binding.get("entrypoint"),
        binding.get("environment") or "production",
        binding.get("props") if binding.get("props") is not None else {},
    ]


def expected_targets(config, resources):
    result = {}
    for binding in config.get("d1_databases", []):
        result[binding["binding"]] = ("d1", binding["database_id"])
    for binding in config.get("r2_buckets", []):
        result[binding["binding"]] = ("r2_bucket", binding["bucket_name"])
    for binding in config.get("services", []):
        result[binding["binding"]] = ("service", service_target(binding))
    for binding in config.get("durable_objects", {}).get("bindings", []):
        identifier = resources.get("durable_objects", {}).get(
            DO_KEYS.get(binding["class_name"])
        )
        if identifier is not None:
            result[binding["name"]] = ("durable_object_namespace", identifier)
    return result


def binding_differences(config, desired, resources, bindings, sha):
    if not isinstance(bindings, list) or len(bindings) > 100:
        raise ReleaseError("WORKER_BINDINGS_INVALID")
    live = {
        item["name"]: item
        for item in bindings
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    if len(live) != len(bindings):
        raise ReleaseError("WORKER_BINDINGS_INVALID")
    changes = []
    expected = {item["name"]: item for item in desired["bindings"]}
    for name, binding in expected.items():
        actual = live.get(name)
        if actual is None:
            if not binding.get("optional"):
                changes.append(
                    {
                        "field": name,
                        "reason": "SECRET_MISSING"
                        if binding["type"] == "secret_text"
                        else "BINDING_MISSING",
                    }
                )
        elif actual.get("type") != binding["type"]:
            changes.append({"field": name, "reason": "BINDING_TYPE_CHANGED"})
    for name in sorted(set(live) - set(expected)):
        changes.append({"field": name, "reason": "BINDING_UNDECLARED"})
    for name, value in config.get("vars", {}).items():
        actual = live.get(name, {})
        actual_value = (
            actual.get("text") if isinstance(value, str) else actual.get("json")
        )
        if not isinstance(value, str) and isinstance(actual_value, str):
            try:
                actual_value = json.loads(actual_value)
            except ValueError:
                actual_value = None
        if actual_value != value:
            changes.append({"field": name, "reason": "PUBLIC_VAR_CHANGED"})
    if "BUILD_SHA" in expected and live.get("BUILD_SHA", {}).get("text") != sha:
        changes.append({"field": "BUILD_SHA", "reason": "BUILD_IDENTITY_CHANGED"})
    for name, (kind, wanted) in expected_targets(config, resources).items():
        actual = live.get(name, {})
        actual_target = target(actual)
        if kind == "service" and "props" not in actual:
            # Both version and settings APIs can omit deployed service props.
            # Absence supplies no evidence about their value.
            actual_target = service_target(actual)[:3]
            wanted = wanted[:3]
        if actual.get("type") != kind or actual_target != wanted:
            changes.append(
                {
                    "field": name,
                    "reason": "STATEFUL_BINDING_CHANGED"
                    if kind in {"d1", "r2_bucket", "durable_object_namespace"}
                    else "BINDING_TARGET_CHANGED",
                }
            )
    return changes


def observe(api, config, desired, resources, sha, baseline=None, operational=None):
    base = "/accounts/" + config["account_id"] + "/workers/scripts/" + config["name"]
    version = deployment_version(api.call(base + "/deployments"))
    details = api.call(base + "/versions/" + version)
    bindings = (
        details.get("resources", {}).get("bindings")
        if isinstance(details, dict)
        else None
    )
    changes = binding_differences(config, desired, resources, bindings, sha)
    live = {item["name"]: item for item in bindings}
    for name, value in (operational or {}).items():
        if live.get(name, {}).get("text") != value:
            changes.append({"field": name, "reason": "OPERATIONAL_SWITCH_CHANGED"})
    schedules = api.call(base + "/schedules")
    rows = schedules.get("schedules") if isinstance(schedules, dict) else schedules
    if not isinstance(rows, list) or any(
        not isinstance(item.get("cron"), str) for item in rows
    ):
        raise ReleaseError("WORKER_SCHEDULES_INVALID")
    if sorted(item["cron"] for item in rows) != desired["crons"]:
        changes.append({"field": "crons", "reason": "SCHEDULE_CHANGED"})
    flags = api.call(base + "/subdomain")
    if not isinstance(flags, dict):
        raise ReleaseError("WORKER_SUBDOMAIN_INVALID")
    for key, field in (
        ("enabled", "workers_dev"),
        ("previews_enabled", "preview_urls"),
    ):
        if flags.get(key) != desired[field]:
            changes.append({"field": field, "reason": "EXPOSURE_CHANGED"})
    namespaces = {
        DO_KEYS[binding["class_name"]]: live[binding["name"]].get("namespace_id")
        for binding in config.get("durable_objects", {}).get("bindings", [])
        if binding["class_name"] in DO_KEYS and binding["name"] in live
    }
    if baseline:
        if namespaces != baseline.get("namespaces", {}):
            changes.append(
                {"field": "namespaces", "reason": "STATEFUL_BINDING_CHANGED"}
            )
        if version != baseline.get("version_id"):
            changes.append({"field": "version", "reason": "WORKER_VERSION_CHANGED"})
    if any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value)
        for value in namespaces.values()
    ):
        raise ReleaseError("WORKER_NAMESPACE_INVALID")
    return {
        "script": config["name"],
        "version_id": version,
        "changes": changes,
        "namespaces": namespaces,
    }


def verify(api, config, desired, resources, sha, operational=None):
    result = observe(api, config, desired, resources, sha, operational=operational)
    if result["changes"]:
        raise ReleaseError("WORKER_CONFIGURATION_NOT_VERIFIED")
    return {
        "script": result["script"],
        "version_id": result["version_id"],
        "config_hash": digest(config),
        "namespaces": result["namespaces"],
    }


def verify_resources(api, resources, configs):
    """Missing persistent resources need recovery; never recreate them during a release."""
    account = resources["account_id"]
    databases = {
        item["database_id"]
        for config in configs
        for item in config.get("d1_databases", [])
    }
    buckets = {
        item["bucket_name"]
        for config in configs
        for item in config.get("r2_buckets", [])
    }
    identities = {"account_id": account, "databases": [], "buckets": {}}
    for identifier in sorted(databases):
        value = api.call("/accounts/" + account + "/d1/database/" + identifier)
        if not isinstance(value, dict) or value.get("uuid") != identifier:
            raise ReleaseError("D1_IDENTITY_CHANGED")
        identities["databases"].append(identifier)
    for name in sorted(buckets):
        value = api.call("/accounts/" + account + "/r2/buckets/" + name)
        if not isinstance(value, dict) or value.get("name") != name:
            raise ReleaseError("R2_IDENTITY_CHANGED")
        created = value.get("creation_date")
        if not isinstance(created, str) or len(created) > 64:
            raise ReleaseError("R2_IDENTITY_UNAVAILABLE")
        identities["buckets"][name] = created
    return identities


def routes_differences(api, account, zone_id, worker, desired):
    domains = api.call("/accounts/" + account + "/workers/domains")
    if not isinstance(domains, list):
        raise ReleaseError("WORKER_DOMAINS_INVALID")
    actual = sorted(
        item["hostname"] for item in domains if item.get("service") == worker
    )
    routes = api.call("/zones/" + zone_id + "/workers/routes")
    if not isinstance(routes, list):
        raise ReleaseError("WORKER_ROUTES_INVALID")
    patterns = sorted(
        item["pattern"] for item in routes if item.get("script") == worker
    )
    changes = []
    if actual != desired["custom_domains"]:
        reason = (
            "DOMAIN_REMOVAL_REQUIRED"
            if set(actual) - set(desired["custom_domains"])
            else "CUSTOM_DOMAIN_CHANGED"
        )
        if any(
            item.get("hostname") in desired["custom_domains"]
            and item.get("service") != worker
            for item in domains
        ):
            reason = "DOMAIN_OWNERSHIP_CONFLICT"
        changes.append({"field": "domains", "reason": reason})
    if patterns != desired["routes"]:
        reason = (
            "ROUTE_REMOVAL_REQUIRED"
            if set(patterns) - set(desired["routes"])
            else "ZONE_ROUTE_CHANGED"
        )
        if any(
            item.get("pattern") in desired["routes"] and item.get("script") != worker
            for item in routes
        ):
            reason = "ROUTE_OWNERSHIP_CONFLICT"
        changes.append({"field": "routes", "reason": reason})
    return changes
