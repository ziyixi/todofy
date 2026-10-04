"""Public inventory and temporary imports for the repository's existing HCL."""

from __future__ import annotations

import json
import re
from pathlib import Path

from private_input import BootstrapError

UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
TABLES = {
    "access_app_ids": "cloudflare_zero_trust_access_application.owner",
    "access_policy_ids": "cloudflare_zero_trust_access_policy",
    "flowday_app_ids": "cloudflare_zero_trust_access_application.flowday",
    "d1_databases": "cloudflare_d1_database.app",
}
POLICY_KEYS = {"github-owner": "github_owner", "fleet-receipt": "fleet_receipt"}
STANDALONE = {
    "fleet-receipt": "cloudflare_zero_trust_access_application.fleet_receipt",
    "mail-hero-backup": "cloudflare_zero_trust_access_application.mail_hero_backup",
}
PLATFORM_ADDRESSES = {
    "cloudflare_zero_trust_access_service_token.platform_deploy",
    "cloudflare_zero_trust_access_policy.platform_deploy",
    'cloudflare_zero_trust_access_application.platform_machine["runtime"]',
    "cloudflare_zero_trust_tunnel_cloudflared.platform",
    "cloudflare_zero_trust_tunnel_cloudflared_config.platform",
    'cloudflare_dns_record.platform["runtime"]',
}
MANAGED_ADDRESSES = PLATFORM_ADDRESSES | {
    "cloudflare_zero_trust_access_identity_provider.github[0]",
    "cloudflare_zero_trust_access_identity_provider.email[0]",
    'cloudflare_zero_trust_access_policy.flowday["flowday"]',
    'cloudflare_zero_trust_access_policy.flowday["flowday-bypass"]',
    "cloudflare_email_routing_rule.mail_hero[0]",
}


def resource_values(plan: dict) -> dict[str, dict]:
    def collect(module: dict):
        for item in module.get("resources", []):
            if item.get("mode") == "managed":
                yield item["address"], item.get("values", {})
        for child in module.get("child_modules", []):
            yield from collect(child)

    return dict(collect(plan.get("planned_values", {}).get("root_module", {})))


def known_imports(resources: dict, values: dict, extra: dict | None = None) -> dict[str, str]:
    account, zone = resources["account_id"], resources["zone_id"]
    imports = {}
    for table, prefix in TABLES.items():
        for name, identifier in resources.get(table, {}).items():
            suffix = "." + POLICY_KEYS.get(name, name) if table == "access_policy_ids" else "[" + json.dumps(name) + "]"
            imports[prefix + suffix] = account + "/" + identifier
    for name, address in STANDALONE.items():
        if name in resources.get("standalone_access_app_ids", {}):
            if name == "mail-hero-backup":
                address += "[0]"
            imports[address] = account + "/" + resources["standalone_access_app_ids"][name]
    for name in ("mail-hero-store", "mail-hero-backups", "todofy-backups"):
        imports['cloudflare_r2_bucket.app[' + json.dumps(name) + ']'] = account + "/" + name
    for name in ("flowday", "flowday-bypass"):
        if name in resources.get("referenced_policy_ids", {}):
            imports['cloudflare_zero_trust_access_policy.flowday[' + json.dumps(name) + ']'] = account + "/" + resources["referenced_policy_ids"][name]
    for address, identifier in {**resources.get("managed_ids", {}), **(extra or {})}.items():
        if address not in MANAGED_ADDRESSES or not isinstance(identifier, str) or (re.fullmatch(r"[0-9a-f]{32}", identifier) is None and UUID.fullmatch(identifier) is None):
            raise BootstrapError("ADOPT_ID_INVALID")
        if address.startswith("cloudflare_zero_trust_access_identity_provider."):
            prefix = "accounts/" + account
        else:
            prefix = zone if address.startswith(("cloudflare_dns_record.", "cloudflare_email_routing_rule.")) else account
        imports[address] = prefix + "/" + identifier
    return imports


def import_hcl(imports: dict[str, str]) -> str:
    return "".join("import {\n  to = " + address + "\n  id = " + json.dumps(identifier) + "\n}\n"
                   for address, identifier in sorted(imports.items()))


def exported_resources(previous: dict, plan: dict, *, fresh: bool) -> dict:
    output = plan.get("planned_values", {}).get("outputs", {})
    try:
        audiences = output["access_aud"]["value"]
        databases = output["d1_database_ids"]["value"]
        if not isinstance(audiences, dict) or not isinstance(databases, dict):
            raise ValueError
        result = {"version": 1, "account_id": previous["account_id"], "zone_id": previous["zone_id"],
                  "access_audiences": {name: audience for name, audience in audiences.items()
                                       if name not in {"flowday-bypass", "mail-hero-backup"}},
                  "d1_databases": databases,
                  "durable_objects": ({} if fresh and databases != previous["d1_databases"]
                                      else dict(previous["durable_objects"]))}
        actual = resource_values(plan)
        for table, prefix in TABLES.items():
            if table == "d1_databases":
                continue
            entries = {}
            for address, value in actual.items():
                if table == "access_policy_ids":
                    if not address.startswith(prefix + ".") or address in MANAGED_ADDRESSES:
                        continue
                    name = address[len(prefix) + 1:]
                    name = next((key for key, translated in POLICY_KEYS.items() if translated == name), name)
                else:
                    match = re.fullmatch(re.escape(prefix) + r'\["([a-z0-9-]+)"\]', address)
                    if not match:
                        continue
                    name = match[1]
                entries[name] = value["id"]
            result[table] = entries
        result["standalone_access_app_ids"] = {
            name: actual[address + ("[0]" if name == "mail-hero-backup" else "")]["id"]
            for name, address in STANDALONE.items() if address + ("[0]" if name == "mail-hero-backup" else "") in actual}
        result["managed_ids"] = {address: actual[address]["id"] for address in sorted(MANAGED_ADDRESSES)
                                 if address in actual}
        # References remain external until their rules are adopted by HCL. They cannot cross accounts.
        result["referenced_policy_ids"] = {} if fresh else dict(previous.get("referenced_policy_ids", {}))
        return result
    except (KeyError, TypeError, ValueError):
        raise BootstrapError("INVENTORY_OUTPUT_INVALID") from None


def write_resources(path: Path, value: dict) -> None:
    lines = ["# Public account/resource identities; generated by cloud-bootstrap."]
    for name in ("version", "account_id", "zone_id"):
        lines.append(name + " = " + json.dumps(value[name]))
    for table, entries in value.items():
        if not isinstance(entries, dict):
            continue
        lines.extend(["", "[" + table + "]"])
        lines.extend(json.dumps(key) + " = " + json.dumps(item) for key, item in sorted(entries.items()))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
