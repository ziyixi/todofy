"""Refuse unknown cloud objects before applying a fresh resource creation plan."""

from __future__ import annotations

from cloud_api import list_page
from private_input import BootstrapError

PAGE_SIZE = 50
MAX_PAGES = 20
ENDPOINTS = {
    "cloudflare_d1_database": ("accounts", "d1/database"),
    "cloudflare_r2_bucket": ("accounts", "r2/buckets"),
    "cloudflare_zero_trust_access_application": ("accounts", "access/apps"),
    "cloudflare_zero_trust_access_policy": ("accounts", "access/policies"),
    "cloudflare_zero_trust_access_identity_provider": (
        "accounts",
        "access/identity_providers",
    ),
    "cloudflare_zero_trust_access_service_token": ("accounts", "access/service_tokens"),
    "cloudflare_zero_trust_tunnel_cloudflared": ("accounts", "cfd_tunnel"),
    "cloudflare_dns_record": ("zones", "dns_records"),
    "cloudflare_email_routing_rule": ("zones", "email/routing/rules"),
}


def _inventory(token, path, kind, page_fetch):
    """Bound both supported pagination forms; incomplete inventories cannot authorize create."""
    items, total, cursor, seen_cursors = [], None, None, set()
    for page in range(1, MAX_PAGES + 1):
        parameters = {"per_page": PAGE_SIZE}
        if kind == "cloudflare_r2_bucket":
            if cursor is not None:
                parameters["cursor"] = cursor
        else:
            parameters["page"] = page
        if kind == "cloudflare_zero_trust_tunnel_cloudflared":
            parameters["is_deleted"] = "false"
        document = page_fetch(token, path, parameters)
        if not isinstance(document, dict) or document.get("success") is not True:
            raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
        rows, info = document.get("result"), document.get("result_info")
        if kind == "cloudflare_r2_bucket":
            if not isinstance(rows, dict):
                raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
            if document.get("cursor") or rows.get("cursor"):
                # A cursor outside the documented result_info cannot be safely followed.
                raise BootstrapError("FRESH_RESOURCE_INVENTORY_INCOMPLETE")
            rows = rows.get("buckets")
        if (
            not isinstance(rows, list)
            or len(rows) > PAGE_SIZE
            or any(not isinstance(row, dict) for row in rows)
        ):
            raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
        if kind == "cloudflare_r2_bucket" and info is None:
            # R2 omits result_info when it has no continuation cursor.
            # Its documented maximum is the requested per_page, not a default page length.
            info = {}
        if not isinstance(info, dict):
            raise BootstrapError("FRESH_RESOURCE_INVENTORY_INCOMPLETE")
        items.extend(rows)
        if kind == "cloudflare_r2_bucket":
            cursor = info.get("cursor")
            if cursor is None or cursor == "":
                return items
            if (
                not isinstance(cursor, str)
                or len(cursor) > 4096
                or cursor in seen_cursors
                or not rows
            ):
                raise BootstrapError("FRESH_RESOURCE_INVENTORY_INCOMPLETE")
            seen_cursors.add(cursor)
            continue
        reported = info.get("total_count")
        if (
            type(reported) is not int
            or reported < 0
            or info.get("page") != page
            or type(info.get("per_page")) is not int
            or not len(rows) <= info["per_page"] <= PAGE_SIZE
            or (total is not None and total != reported)
            or len(items) > reported
        ):
            raise BootstrapError("FRESH_RESOURCE_INVENTORY_INCOMPLETE")
        total = reported
        if len(items) == total:
            return items
        if not rows:
            raise BootstrapError("FRESH_RESOURCE_INVENTORY_INCOMPLETE")
    raise BootstrapError("FRESH_RESOURCE_INVENTORY_INCOMPLETE")


def _domains(item):
    """Access exposes primary, legacy and public destination domains."""
    domains = []
    if item.get("domain"):
        domains.append(item["domain"])
    legacy, destinations = (
        item.get("self_hosted_domains") or [],
        item.get("destinations") or [],
    )
    if not isinstance(legacy, list) or not isinstance(destinations, list):
        raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
    domains.extend(legacy)
    for destination in destinations:
        if not isinstance(destination, dict):
            raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
        if destination.get("type", "public") == "public" and destination.get("uri"):
            domains.append(destination["uri"])
    if any(not isinstance(value, str) for value in domains):
        raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
    return {
        host.rstrip(".").lower() + slash + path
        for value in domains
        for host, slash, path in [value.partition("/")]
    }


def _recipients(item):
    matchers = item.get("matchers")
    if not isinstance(matchers, list) or any(
        not isinstance(value, dict) for value in matchers
    ):
        raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
    recipients = [
        value.get("value")
        for value in matchers
        if value.get("type") == "literal" and value.get("field") == "to"
    ]
    if any(not isinstance(value, str) or not value for value in recipients):
        raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
    return set(recipients)


def _collision(kind, wanted, actual):
    if kind == "cloudflare_email_routing_rule":
        return bool(_recipients(wanted) & _recipients(actual))
    if not isinstance(actual.get("name"), str):
        raise BootstrapError("FRESH_RESOURCE_INVENTORY_INVALID")
    if kind == "cloudflare_dns_record":
        # Any record type at this name can conflict with the new Tunnel CNAME.
        return wanted["name"].rstrip(".").lower() == actual["name"].rstrip(".").lower()
    if wanted["name"] == actual["name"]:
        return True
    return kind == "cloudflare_zero_trust_access_application" and bool(
        _domains(wanted) & _domains(actual)
    )


def refuse_conflicts(plan, token, account, zone, *, page_fetch=list_page):
    """Call after the existing scope/action gate and before applying a fresh saved plan."""
    inventories = {}
    for resource in plan.get("resource_changes", []):
        kind, change = resource.get("type"), resource.get("change", {})
        if kind not in ENDPOINTS or change.get("actions") != ["create"]:
            continue
        address, wanted = resource["address"], change.get("after")
        if not isinstance(wanted, dict) or (
            kind != "cloudflare_email_routing_rule"
            and (not isinstance(wanted.get("name"), str) or not wanted["name"])
        ):
            raise BootstrapError(
                "FRESH_RESOURCE_IDENTITY_UNAVAILABLE", {"address": address}
            )
        if kind == "cloudflare_email_routing_rule" and not _recipients(wanted):
            raise BootstrapError(
                "FRESH_RESOURCE_IDENTITY_UNAVAILABLE", {"address": address}
            )
        try:
            if kind not in inventories:
                scope, endpoint = ENDPOINTS[kind]
                identifier = account if scope == "accounts" else zone
                inventories[kind] = _inventory(
                    token, f"/{scope}/{identifier}/{endpoint}", kind, page_fetch
                )
            if any(_collision(kind, wanted, actual) for actual in inventories[kind]):
                raise BootstrapError("FRESH_RESOURCE_NAME_CONFLICT")
        except BootstrapError as error:
            raise BootstrapError(str(error), {"address": address}) from None
