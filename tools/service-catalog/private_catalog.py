"""Optional private metadata attachment; failures expose a fixed code, never supplied values."""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalog import REPO, load_catalog, require  # noqa: E402
from cloud_profile import load_profile, worker_secret_specs

ERROR = "PRIVATE_CATALOG_INVALID"
MAX_BYTES = 32768


def fields(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= set(value)
            and set(value) <= set(required) | set(optional), ERROR)


def string(value, pattern, maximum=256):
    require(isinstance(value, str) and len(value) <= maximum and re.fullmatch(pattern, value) is not None, ERROR)


def strings(value, maximum):
    require(isinstance(value, list) and len(value) <= maximum
            and all(isinstance(item, str) and len(item) <= 256 for item in value)
            and len(value) == len(set(value)), ERROR)


def owner_host(host, zone):
    string(host, r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9-]+")
    require(host == zone or host.endswith("." + zone), ERROR)


def owner_url(value, zone):
    require(isinstance(value, str), ERROR)
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.hostname and parsed.netloc == parsed.hostname
            and not parsed.query and not parsed.fragment and not any(c in value for c in "?#"), ERROR)
    owner_host(parsed.hostname, zone)
    return parsed


def load_private_catalog(raw, catalog, wanted, root):
    """The public baseline is immutable. Private entries can own only supplemental identities."""
    if raw is None or raw == "":
        return None
    try:
        require(isinstance(raw, str) and len(raw.encode()) <= MAX_BYTES, ERROR)
        value = json.loads(raw)
        fields(value, ("registry", "desired"))
        registration, desired = value["registry"], value["desired"]
        fields(registration, ("entries", "workers", "resources"))
        fields(desired, ("version", "zones", "workers"))
        zone = load_profile(root)["zone"]
        require(type(desired["version"]) is int and desired["version"] == 1
                and desired["zones"] == [zone] and isinstance(desired["workers"], dict), ERROR)
        for kind, maximum in (("entries", 8), ("workers", 8), ("resources", 24)):
            require(isinstance(registration[kind], list) and len(registration[kind]) <= maximum, ERROR)
        public_entries = {entry["id"] for entry in catalog.entries}
        entries, orders = set(), {(entry["group"], entry["order"]) for entry in catalog.entries}
        probes = 0
        for entry in registration["entries"]:
            fields(entry, ("id", "name", "description", "group", "icon", "accent", "url", "access", "status", "tile_metric", "app_only_signals", "order"))
            string(entry["id"], r"[a-z][a-z0-9-]{0,31}")
            require(entry["id"] not in public_entries | entries and type(entry["order"]) is int
                    and isinstance(entry["group"], str) and entry["group"] in {"apps", "sites", "services", "hidden"}
                    and (entry["group"], entry["order"]) not in orders and type(entry["access"]) is bool
                    and entry["app_only_signals"] == [], ERROR)
            entries.add(entry["id"])
            orders.add((entry["group"], entry["order"]))
            for name, maximum in (("name", 16), ("description", 40)):
                string(entry[name], r"[^\x00-\x1f\x7f@]+", maximum)
            url = owner_url(entry["url"], zone)
            require(re.fullmatch(r"/(?:[a-z0-9._-]+/)*", url.path) is not None, ERROR)
            status = entry["status"]
            fields(status, ("type",), ("enabled", "url", "expect", "content_type", "outside_access", "error_rate"))
            require(isinstance(status["type"], str) and status["type"] in {"public_http", "link_only"}, ERROR)
            if status["type"] == "link_only":
                require(set(status) == {"type"}, ERROR)
            else:
                require(type(status.get("enabled")) is bool and isinstance(status.get("expect"), list)
                        and 0 < len(status["expect"]) <= 8
                        and all(type(code) is int and 200 <= code <= 399 for code in status["expect"]), ERROR)
                probe = owner_url(status.get("url"), zone)
                require(re.fullmatch(r"/[a-z0-9._/-]*", probe.path) is not None, ERROR)
                for flag in ("outside_access", "error_rate"):
                    require(flag not in status or status[flag] is True, ERROR)
                if "content_type" in status:
                    string(status["content_type"], r"[a-z]+/[a-z0-9][a-z0-9.+-]{0,62}")
                if entry["access"]:
                    require(status.get("outside_access") is True and "content_type" in status
                            and all(code < 300 for code in status["expect"])
                            and probe.hostname == url.hostname and probe.path != url.path, ERROR)
                else:
                    require("outside_access" not in status, ERROR)
                probes += status["enabled"]
        # The same Free plan ceilings as Home. Extra private entries add no Ops calls or writes.
        public_probes = sum(entry["status"]["type"] == "public_http" and entry["status"].get("enabled", False)
                            or "probe" in entry["status"] for entry in catalog.entries)
        public_ops = sum(entry["status"]["type"] == "ops_v1" for entry in catalog.entries)
        require(public_ops + public_probes + probes + 1 <= 20, ERROR)
        scripts = set()
        for worker in registration["workers"]:
            fields(worker, ("script", "entry", "role"))
            string(worker["script"], r"[a-z0-9][a-z0-9_-]{0,62}")
            string(worker["role"], r"[^\x00-\x1f\x7f@]+", 24)
            require(worker["entry"] in entries and worker["script"] not in set(wanted["workers"]) | scripts, ERROR)
            scripts.add(worker["script"])
        require(set(desired["workers"]) == scripts, ERROR)
        public_desired = json.loads((root / "dashboard/worker/src/drift-desired.json").read_text())
        hosts = {host for worker in public_desired["workers"].values() for host in worker["custom_domains"]}
        routes = {route for worker in public_desired["workers"].values() for route in worker["routes"]}
        for worker in desired["workers"].values():
            fields(worker, ("config", "workers_dev", "preview_urls", "custom_domains", "routes", "crons", "bindings", "personal"))
            string(worker["config"], r"[A-Za-z0-9_./-]+")
            require(not worker["config"].startswith("/") and ".." not in worker["config"].split("/")
                    and worker["workers_dev"] is False and worker["preview_urls"] is False, ERROR)
            for kind in ("custom_domains", "routes", "crons", "personal"):
                strings(worker[kind], {"custom_domains": 8, "routes": 8, "crons": 10, "personal": 100}[kind])
            for host in worker["custom_domains"]:
                owner_host(host, zone)
                require(host not in hosts, ERROR)
                hosts.add(host)
            for route in worker["routes"]:
                string(route, r"[a-z0-9.-]+/[a-z0-9._/*-]*")
                owner_host(route.split("/", 1)[0], zone)
                require(route not in routes and route.split("/", 1)[0] not in hosts - set(worker["custom_domains"]), ERROR)
                routes.add(route)
            for cron in worker["crons"]:
                string(cron, r"[0-9*,/ -]{9,128}")
            require(isinstance(worker["bindings"], list) and len(worker["bindings"]) <= 100, ERROR)
            names = set()
            for binding in worker["bindings"]:
                fields(binding, ("name", "type", "source"), ("optional",))
                string(binding["name"], r"[A-Za-z_][A-Za-z0-9_]{0,63}")
                string(binding["type"], r"[a-z][a-z0-9_]{0,63}")
                require(binding["name"] not in names and binding["source"] in {"config", "deploy", "manual"}
                        and ("optional" not in binding or type(binding["optional"]) is bool), ERROR)
                names.add(binding["name"])
            require(set(worker["personal"]) <= names, ERROR)
        registry_text = (root / "dashboard/worker/src/registry.ts").read_text()
        public_resource_ids = set(re.findall(r"\bid: '([a-z0-9-]+)'", registry_text.split("const RESOURCES:", 1)[1].split("const FLOWS:", 1)[0]))
        resource_ids, matches = set(), set()
        ownership = {worker["script"]: worker["entry"] for worker in registration["workers"]}
        for resource in registration["resources"]:
            fields(resource, ("id", "kind", "name", "entry", "match"), ("script",))
            string(resource["id"], r"[a-z][a-z0-9-]{0,47}")
            string(resource["name"], r"[^\x00-\x1f\x7f@]+", 32)
            require(resource["id"] not in public_resource_ids | resource_ids and resource["entry"] in entries
                    and isinstance(resource["kind"], str) and resource["kind"] in {"r2", "d1", "do"}, ERROR)
            kind = resource["kind"]
            string(resource["match"], {"r2": r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", "d1": r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", "do": r"[0-9a-f]{32}"}[kind])
            require(resource["match"] not in wanted[kind] and (kind, resource["match"]) not in matches, ERROR)
            require((kind == "do" and ownership.get(resource.get("script")) == resource["entry"])
                    or (kind != "do" and "script" not in resource), ERROR)
            resource_ids.add(resource["id"])
            matches.add((kind, resource["match"]))
        return value
    except (ValueError, TypeError, KeyError, AttributeError, IndexError):
        raise ValueError(ERROR) from None


def supplemental_expected(wanted, attachment):
    if attachment is None:
        return wanted
    registration = attachment["registry"]
    return {kind: sorted([*names, *(worker["script"] for worker in registration["workers"])]) if kind == "workers"
            else sorted([*names, *(resource["match"] for resource in registration["resources"] if resource["kind"] == kind)])
            for kind, names in wanted.items()}


def configuration_changes(api, account, zone_id, attachment):
    """Read only: the private desired supplement uses Home's name/type/flag comparison semantics."""
    if attachment is None or not attachment["desired"]["workers"]:
        return 0
    from cloudflare import binding_differences, routes_differences
    changes = 0
    for script, desired in attachment["desired"]["workers"].items():
        base = "/accounts/" + account + "/workers/scripts/" + script
        settings = api.call(base + "/settings")
        require(isinstance(settings, dict), "PRIVATE_CATALOG_OBSERVATION_INVALID")
        bindings = settings.get("bindings")
        require(isinstance(bindings, list) and len(bindings) <= 100
                and all(isinstance(binding, dict) for binding in bindings), "PRIVATE_CATALOG_OBSERVATION_INVALID")
        # Source identity belongs to the private release job; this comparison observes binding names/types only.
        expected_bindings = [{**binding, "type": "secret_text" if binding["name"] in desired["personal"] else binding["type"]}
                             for binding in desired["bindings"]]
        build = next((binding.get("text") for binding in bindings if binding.get("name") == "BUILD_SHA"), None)
        names = binding_differences({}, {**desired, "bindings": expected_bindings}, {}, bindings, build)
        schedules, flags = api.call(base + "/schedules"), api.call(base + "/subdomain")
        rows = schedules.get("schedules") if isinstance(schedules, dict) else schedules
        require(isinstance(rows, list) and len(rows) <= 10 and all(isinstance(row, dict) and isinstance(row.get("cron"), str) for row in rows)
                and isinstance(flags, dict) and all(type(flags.get(key)) is bool for key in ("enabled", "previews_enabled")), "PRIVATE_CATALOG_OBSERVATION_INVALID")
        changes += len(names) + (sorted(row["cron"] for row in rows) != sorted(desired["crons"]))
        changes += (flags["enabled"] != desired["workers_dev"]) + (flags["previews_enabled"] != desired["preview_urls"])
        changes += len(routes_differences(api, account, zone_id, script, desired))
    return changes


def attach_home_secrets(secrets, raw, root=REPO):
    """Add the separately supplied registration to an already materialized Home secrets file."""
    if raw is None or raw == "":
        return secrets
    wanted = json.loads((root / "dashboard/worker/src/account-inventory.json").read_text())
    load_private_catalog(raw, load_catalog(root), wanted, root)
    spec = worker_secret_specs(root)["home"]
    fields(secrets, spec["required"], spec["optional"])
    require(all(isinstance(value, str) and 0 < len(value) <= 65536 and "\0" not in value
                for value in secrets.values()), ERROR)
    return {**secrets, "PRIVATE_CATALOG": raw}


def main():
    parser = argparse.ArgumentParser(description="Attach private registration to Home's existing Worker secrets file.")
    parser.add_argument("--secrets-file", required=True, type=Path)
    args = parser.parse_args()
    raw = os.environ.get("PRIVATE_CATALOG")
    if raw is None or raw == "":
        return 0
    try:
        # The deployment wrapper created this owner-only temporary file. Keep its mode and credential values.
        with args.secrets_file.open("r+", encoding="utf-8") as file:
            merged = attach_home_secrets(json.load(file), raw)
            file.seek(0)
            file.write(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
            file.truncate()
    except (ValueError, OSError):
        print(ERROR, file=sys.stderr)
        return 1
    print("Private registration added to the Worker secrets file (values not printed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
