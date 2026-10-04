"""The small subset of infrastructure drift that can be repaired unattended."""

from __future__ import annotations

import json
import re
from pathlib import Path

WORKFLOW = "Personal cloud reconcile"
DNS = 'cloudflare_dns_record.platform["runtime"]'
TUNNEL_CONFIG = "cloudflare_zero_trust_tunnel_cloudflared_config.platform"


def manual_reasons(plan: dict, team: str = "") -> list[dict[str, str]]:
    """Return addresses and fixed reasons only; provider values never leave here."""
    reasons = []
    resources = plan.get("planned_values", {}).get("root_module", {}).get("resources", [])
    known = {item.get("address"): item.get("values", {}) for item in resources}
    tunnel = known.get("cloudflare_zero_trust_tunnel_cloudflared.platform", {}).get("id")
    app = known.get('cloudflare_zero_trust_access_application.platform_machine["runtime"]', {})
    for item in plan.get("resource_changes", []):
        change = item.get("change", {})
        if change.get("actions") in ([], ["no-op"]):
            continue
        address = item.get("address", "")
        reason = _manual_reason(item, change, tunnel, app, team)
        if reason:
            reasons.append({"address": address, "reason": reason})
    return reasons


def _manual_reason(item: dict, change: dict, tunnel: str, app: dict, team: str) -> str | None:
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
        if not _loopback_ingress(after.get("config"), app, team):
            return "CONNECTOR_TARGET_UNSAFE"
    else:
        return "SENSITIVE_OR_UNSUPPORTED_RESOURCE"
    changed = {key for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
    return None if changed <= allowed else "UNSUPPORTED_ATTRIBUTE_CHANGE"


def _loopback_ingress(config: object, app: dict, team: str) -> bool:
    if not isinstance(config, dict):
        return False
    ingress = config.get("ingress")
    return (isinstance(ingress, list) and len(ingress) == 2
            and isinstance(ingress[0], dict) and isinstance(ingress[1], dict)
            and isinstance(ingress[0].get("hostname"), str)
            and ingress[0]["hostname"] == app.get("domain") and bool(app.get("domain"))
            and ingress[0].get("service") == "http://127.0.0.1:18765"
            and ingress[1].get("service") == "http_status:404"
            and _authenticated_origin(ingress[0].get("origin_request", {}).get("access"), app, team))


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
