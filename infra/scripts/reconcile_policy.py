"""The small subset of infrastructure drift that can be repaired unattended."""

from __future__ import annotations

import json
import re
from pathlib import Path

WORKFLOW = "Personal cloud reconcile"
DNS = 'cloudflare_dns_record.platform["runtime"]'
TUNNEL_CONFIG = "cloudflare_zero_trust_tunnel_cloudflared_config.platform"
# The tunnel's path rules on the runtime host, in their order before the daemon's catch-all (infra/platform.tf): the
# path, its loopback service, the Access application whose audience the connector requires, and that application's
# destination for the path (an exact `domain`, or one of an owner application's `destinations`).
PATH_RULES = (
    ("/api/codex/v1/.*", "http://127.0.0.1:18766", "cloudflare_zero_trust_access_application.codex_gateway",
     "/api/codex/v1/*"),
    ("/api/newsletter/v1/.*", "http://127.0.0.1:18767",
     'cloudflare_zero_trust_access_application.owner["newsletter-console"]', "/api/newsletter/v1/*"),
)


def manual_reasons(plan: dict, team: str = "") -> list[dict[str, str]]:
    """Return addresses and fixed reasons only; provider values never leave here."""
    reasons = []
    resources = plan.get("planned_values", {}).get("root_module", {}).get("resources", [])
    known = {item.get("address"): item.get("values", {}) for item in resources}
    tunnel = known.get("cloudflare_zero_trust_tunnel_cloudflared.platform", {}).get("id")
    app = known.get('cloudflare_zero_trust_access_application.platform_machine["runtime"]', {})
    path_apps = {address: known.get(address, {}) for _, _, address, _ in PATH_RULES}
    for item in plan.get("resource_changes", []):
        change = item.get("change", {})
        if change.get("actions") in ([], ["no-op"]):
            continue
        address = item.get("address", "")
        reason = _manual_reason(item, change, tunnel, app, team, path_apps)
        if reason:
            reasons.append({"address": address, "reason": reason})
    return reasons


def _manual_reason(item: dict, change: dict, tunnel: str, app: dict, team: str, path_apps: dict | None = None) -> str | None:
    if item.get("mode") != "managed" or change.get("actions") != ["update"]:
        return "IDENTITY_OR_RESOURCE_CHANGE"
    if change.get("importing") or _unknown_required(change.get("after_unknown", {})):
        return "UNKNOWN_OR_ADOPTION"
    before, after = change.get("before"), change.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return "UNKNOWN_PROVIDER_SHAPE"
    address = item.get("address")
    if address == DNS:
        allowed = {"content", "proxied", "ttl", "modified_on"}
        if not all(before.get(key) == after.get(key) and after.get(key)
                   for key in ("id", "zone_id", "name", "type")):
            return "DNS_IDENTITY_CHANGE"
        if (after.get("type") != "CNAME" or after.get("proxied") is not True
                or not _tunnel_target(after.get("content"))
                or after.get("content") != str(tunnel) + ".cfargotunnel.com"):
            return "DNS_TARGET_UNSAFE"
    elif address == TUNNEL_CONFIG:
        allowed = {"config", "version", "created_at"}
        if not all(before.get(key) == after.get(key) and after.get(key)
                   for key in ("id", "account_id", "tunnel_id")):
            return "CONNECTOR_IDENTITY_CHANGE"
        if not _loopback_ingress(after.get("config"), app, team, path_apps):
            return "CONNECTOR_TARGET_UNSAFE"
    else:
        return "SENSITIVE_OR_UNSUPPORTED_RESOURCE"
    changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
    return None if changed <= allowed else "UNSUPPORTED_ATTRIBUTE_CHANGE"


def _loopback_ingress(config: object, app: dict, team: str, path_apps: dict | None = None) -> bool:
    """The runtime host's path rules in PATH_RULES order (each present one exact and pinned to its application's
    audience), then the daemon's catch-all, then 404. Any other rule, order or target needs review."""
    if not isinstance(config, dict):
        return False
    ingress = config.get("ingress")
    if not isinstance(ingress, list):
        return False
    rules = list(PATH_RULES)
    # A plan writes every attribute of a rule, an unset path as null.
    while len(ingress) > 2 and isinstance(ingress[0], dict) and ingress[0].get("path"):
        rule = ingress[0]
        while rules and rules[0][0] != rule.get("path"):
            rules.pop(0)
        if not rules:
            return False
        path, service, address, destination = rules.pop(0)
        path_app = (path_apps or {}).get(address)
        if (not isinstance(path_app, dict)
                or not _destination(path_app, str(app.get("domain")) + destination)
                or rule.get("hostname") != app.get("domain") or not app.get("domain")
                or rule.get("service") != service
                or not _authenticated_origin(rule.get("origin_request", {}).get("access"), path_app, team)):
            return False
        ingress = ingress[1:]
    return (len(ingress) == 2
            and isinstance(ingress[0], dict) and isinstance(ingress[1], dict)
            and isinstance(ingress[0].get("hostname"), str) and not ingress[0].get("path")
            and ingress[0]["hostname"] == app.get("domain") and bool(app.get("domain"))
            and ingress[0].get("service") == "http://127.0.0.1:18765"
            and ingress[1].get("service") == "http_status:404"
            and _authenticated_origin(ingress[0].get("origin_request", {}).get("access"), app, team))


def _destination(app: dict, uri: str) -> bool:
    """Whether the Access application gates exactly `uri`: its domain, or one of its public destinations."""
    destinations = app.get("destinations")
    return app.get("domain") == uri or (isinstance(destinations, list) and any(
        isinstance(item, dict) and item.get("type") == "public" and item.get("uri") == uri for item in destinations))


def _authenticated_origin(access: object, app: dict, team: str) -> bool:
    return (isinstance(access, dict) and access.get("required") is True
            and isinstance(access.get("team_name"), str) and access["team_name"] == team and bool(team)
            and isinstance(access.get("aud_tag"), list) and len(access["aud_tag"]) == 1
            and isinstance(access["aud_tag"][0], str)
            and re.fullmatch(r"[0-9a-f]{64}", access["aud_tag"][0]) is not None
            and access["aud_tag"] == [app.get("aud")])


def _tunnel_target(value: object) -> bool:
    return (isinstance(value, str)
            and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.cfargotunnel\.com", value) is not None)


def _unknown_required(unknown: object) -> bool:
    # Provider-generated timestamps/version may be unknown; the repair's target and authentication may not.
    if not isinstance(unknown, dict):
        return bool(unknown)
    def has_unknown(value):
        if isinstance(value, dict):
            return any(has_unknown(item) for item in value.values())
        if isinstance(value, list):
            return any(has_unknown(item) for item in value)
        return bool(value)

    return any(has_unknown(value) for key, value in unknown.items() if key not in {"modified_on", "created_at", "version"})


def context_problem(env: dict[str, str]) -> str | None:
    if (env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_WORKFLOW") != WORKFLOW
            or env.get("GITHUB_REF") != "refs/heads/main"):
        return "RECONCILE_CONTEXT_INVALID"
    event = env.get("GITHUB_EVENT_NAME")
    if event in {"schedule", "workflow_dispatch"}:
        return None
    if event != "workflow_run":
        return "RECONCILE_EVENT_INVALID"
    try:
        payload = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
        run = payload["workflow_run"]
        expected_sha = env.get("INFRA_RECONCILE_SOURCE_SHA", env.get("GITHUB_SHA"))
        valid = (run["name"] == "CI and deploy" and run["conclusion"] == "success" and run["head_branch"] == "main"
                 and run["head_sha"] == expected_sha
                 and run["head_repository"]["full_name"] == env["GITHUB_REPOSITORY"])
    except (OSError, ValueError, TypeError, KeyError):
        valid = False
    return None if valid else "RECONCILE_SOURCE_UNVERIFIED"
