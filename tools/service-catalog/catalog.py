#!/usr/bin/env python3
"""Public service metadata. No credentials, network calls or deployment commands.

Python 3.11+. Wrangler owns hosts/resources; app.toml owns identity and presentation.
The generated literal regions remain readable by the independent infrastructure guards.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "cloud-config"))
from cloud_profile import ProfileError, image_repositories, load_profile, worker_secret_specs  # noqa: E402

ID = re.compile(r"[a-z][a-z0-9-]{0,63}")
SKIP_DIRS = {".git", ".venv", "node_modules", "dist", "out", "uiassets", ".next", ".wrangler"}


class CatalogError(ValueError):
    """A safe diagnostic names a field or file, never its invalid value."""


def require(condition: bool, field: str) -> None:
    if not condition:
        raise CatalogError(f"Invalid service catalog field: {field}")


def fields(value: object, allowed: set[str], required: set[str], field: str) -> dict:
    require(isinstance(value, dict), field)
    require(set(value) <= allowed and required <= set(value), field)
    return value


def text(value: object, field: str) -> str:
    require(isinstance(value, str) and 0 < len(value) <= 2048, field)
    require(not any(ord(c) < 32 or ord(c) == 127 for c in value), field)
    require("@" not in value, field)
    require("${" not in value and "%{" not in value, field)
    require(re.search(r"(?<![a-z0-9])[0-9a-fA-F]{24,}(?![a-z0-9])|\b(?:\d{1,3}\.){3}\d{1,3}\b", value) is None, field)
    return value


def identifier(value: object, field: str) -> str:
    require(isinstance(value, str) and bool(ID.fullmatch(value)), field)
    return value


def route_path(value: object, field: str, *, wildcard: bool = False) -> str:
    require(isinstance(value, str) and len(value) <= 2048, field)
    require(value == "" or value.startswith("/"), field)
    require(re.fullmatch(r"[A-Za-z0-9/_.~*-]*", value) is not None, field)
    require("//" not in value and all(p not in {".", ".."} for p in value.split("/")), field)
    require("*" not in value or (wildcard and value.endswith("/*") and value.count("*") == 1), field)
    return value


def file_path(root: Path, value: object, app: str, field: str) -> Path:
    value = text(value, field)
    path = PurePosixPath(value)
    require(not path.is_absolute() and path.parts[0] == app, field)
    require(all(p and not p.startswith(".") and p not in SKIP_DIRS for p in value.split("/")) and "\\" not in value, field)
    candidate = root / path
    require(candidate.is_file() and not candidate.is_symlink(), field)
    require(candidate.resolve().is_relative_to((root / app).resolve()), field)
    require(not any(parent.is_symlink() for parent in candidate.parents if parent != root.parent), field)
    return candidate


def read_toml(path: Path) -> dict:
    if tomllib is None:
        raise CatalogError("The service catalog requires Python 3.11+")
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise CatalogError(f"Cannot read service catalog/config: {path.name}") from error


def production_configs(root: Path) -> set[str]:
    """Only names are inspected; ignored dependency/build directories are never traversed."""
    found = set()
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")
                         and not (Path(directory) / d).is_symlink())
        if "wrangler.toml" in names:
            found.add((Path(directory) / "wrangler.toml").relative_to(root).as_posix())
    return found


def primary_host(config: dict, field: str, zone: str) -> str | None:
    routes = config.get("routes", [])
    require(isinstance(routes, list) and all(isinstance(route, dict) for route in routes), field)
    hosts = [route.get("pattern") for route in routes if route.get("custom_domain") is True]
    for host in hosts:
        require(isinstance(host, str) and re.fullmatch(r"(?:[a-z0-9-]+\.)*" + re.escape(zone), host) is not None, field)
    configured = config.get("vars", {}).get("PUBLIC_HOST")
    if configured is not None:
        require(configured in hosts, field)
    return configured or (hosts[0] if hosts else None)


@dataclass
class Catalog:
    root: Path
    apps: dict[str, dict]
    configs: dict[str, dict]
    workers: list[dict]
    entries: list[dict]
    access: list[dict]

    def worker_configs(self) -> dict[str, str]:
        return {worker["script"]: worker["config"] for worker in self.workers}


def load_catalog(root: Path = REPO, *, bootstrap: bool = False) -> Catalog:
    root = Path(root).resolve()
    try:
        profile = load_profile(root)
    except ProfileError as error:
        raise CatalogError(str(error)) from error
    zone = profile["zone"]
    images = image_repositories(profile)
    manifests = sorted(root.glob("*/app.toml"))
    require(bool(manifests), "manifests")
    apps, configs, workers, entries, access = {}, {}, [], [], []
    paths, positions, entry_positions = set(), set(), set()
    for manifest in manifests:
        require(not manifest.is_symlink() and not manifest.parent.is_symlink(), "manifest path")
        app = manifest.parent.name
        identifier(app, "manifest directory")
        data = fields(read_toml(manifest), {"version", "id", "target", "image", "workers", "entries", "access"},
                      {"version", "id", "target", "entries"}, f"{app}.manifest")
        require(type(data["version"]) is int and data["version"] == 1, f"{app}.version")
        require(identifier(data["id"], f"{app}.id") == app, f"{app}.id")
        require(isinstance(data["target"], str) and data["target"] in {"cloudflare", "vps"}, f"{app}.target")
        for collection in ("workers", "access"):
            require(isinstance(data.get(collection, []), list), f"{app}.{collection}")
        if data["target"] == "vps":
            require(not data.get("workers") and not data.get("access"), f"{app}.vps resources")
            if bootstrap:
                data = {**data, "image": images.get(app)}
            else:
                require(data.get("image") == images.get(app), f"{app}.image")
        else:
            require("image" not in data and bool(data.get("workers")), f"{app}.workers")
        require(isinstance(data["entries"], list) and bool(data["entries"]), f"{app}.entries")
        apps[app] = data
        for raw in data.get("workers", []):
            worker = fields(raw, {"config", "hosts", "entry", "role", "position", "personal_secrets", "manual_secrets", "optional_secrets", "owner_machine_secrets"},
                            {"config", "hosts", "entry", "role", "position"}, f"{app}.worker")
            config_path = file_path(root, worker["config"], app, f"{app}.config")
            require(config_path.name == "wrangler.toml" and worker["config"] not in paths, f"{app}.config")
            config = read_toml(config_path)
            script = identifier(config.get("name"), f"{app}.worker name")
            require(script not in configs, f"{app}.worker name")
            position = worker["position"]
            require(type(position) is int and position > 0 and position not in positions, f"{app}.worker position")
            labels = worker["hosts"]
            require(isinstance(labels, list) and all(isinstance(label, str) and (label == "" or re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)) for label in labels)
                and len(labels) == len(set(labels)), f"{app}.host labels")
            hosts = [label + "." + zone if label else zone for label in labels]
            if bootstrap:
                # This in-memory catalog renders bootstrap HCL only; it cannot deploy a Worker.
                variables = {**config.get("vars", {})}
                if "PUBLIC_HOST" in variables:
                    require(bool(hosts), f"{app}.public host")
                    variables["PUBLIC_HOST"] = hosts[0]
                if "ACCESS_AUDIENCE" in variables:
                    variables["ACCESS_AUDIENCE"] = "0" * 64
                if "ACCESS_ISSUER" in variables:
                    variables["ACCESS_ISSUER"] = profile["access_issuer"]
                if "ACCOUNT_ID" in variables:
                    variables["ACCOUNT_ID"] = "0" * 32
                config = {**config, "account_id": "0" * 32, "vars": variables,
                          "routes": [{"pattern": host, "custom_domain": True} for host in hosts],
                          "d1_databases": [{**database, "database_id": "00000000-0000-0000-0000-000000000000"}
                                           for database in config.get("d1_databases", [])]}
            primary_host(config, f"{app}.host", zone)
            routes = config.get("routes", [])
            require(all(route.get("custom_domain") is True for route in routes)
                    and [route.get("pattern") for route in routes] == hosts, f"{app}.generated routes")
            paths.add(worker["config"])
            positions.add(position)
            configs[script] = config
            workers.append({"script": script, "config": worker["config"], "entry": identifier(worker["entry"], f"{app}.worker entry"),
                            "role": text(worker["role"], f"{app}.worker role"), "position": position, "app": app})
        for raw in data["entries"]:
            entry = fields(raw, {"id", "name", "description", "group", "icon", "accent", "worker", "url_path", "access",
                                 "status", "tile_metric", "app_only_signals", "order", "position"},
                           {"id", "name", "description", "group", "icon", "accent", "access", "status", "app_only_signals", "order", "position"},
                           f"{app}.entry")
            entry = dict(entry)
            if isinstance(entry.get("description"), str):
                entry["description"] = entry["description"].replace("{zone}", zone)
            entry_id = identifier(entry["id"], f"{app}.entry id")
            require(not any(old["id"] == entry_id for old in entries), f"{app}.entry id")
            for field in ("name", "description", "icon", "accent"):
                text(entry[field], f"{app}.{field}")
            require(isinstance(entry["group"], str) and entry["group"] in {"apps", "sites", "services", "hidden"}, f"{app}.group")
            require(type(entry["access"]) is bool, f"{app}.access")
            require(type(entry["order"]) is int and entry["order"] > 0, f"{app}.order")
            require(type(entry["position"]) is int and entry["position"] > 0 and entry["position"] not in entry_positions,
                    f"{app}.entry position")
            entry_positions.add(entry["position"])
            require(isinstance(entry["app_only_signals"], list) and all(isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]*", code)
                    for code in entry["app_only_signals"]), f"{app}.signals")
            worker = entry.get("worker")
            if worker is not None:
                identifier(worker, f"{app}.entry worker")
                require(any(w["script"] == worker and w["app"] == app for w in workers), f"{app}.entry worker")
            host = primary_host(configs[worker], f"{app}.entry host", zone) if worker is not None else None
            require("url_path" not in entry or host is not None, f"{app}.entry link")
            entry["url"] = f"https://{host}{route_path(entry['url_path'], f'{app}.url_path')}" if "url_path" in entry else None
            status = fields(entry["status"], {"type", "provider", "binding", "guard", "path", "expect", "content_type", "outside_access", "error_rate", "enabled", "max_idle_hours"},
                            {"type"}, f"{app}.status")
            status = dict(status)
            kind = status["type"]
            require(isinstance(kind, str) and kind in {"ops_v1", "public_http", "analytics", "self", "none"}, f"{app}.status type")
            shapes = {"ops_v1": ({"type", "provider", "binding", "guard"}, {"type", "binding", "guard"}),
                      "public_http": ({"type", "path", "expect", "content_type", "outside_access", "error_rate", "enabled"}, {"type", "path", "expect", "enabled"}),
                      "analytics": ({"type", "max_idle_hours"}, {"type", "max_idle_hours"}), "self": ({"type"}, {"type"}), "none": ({"type"}, {"type"})}
            fields(status, *shapes[kind], f"{app}.status fields")
            if kind == "public_http":
                require(host is not None, f"{app}.probe host")
                require(isinstance(status["expect"], list) and bool(status["expect"]) and all(type(code) is int and 200 <= code <= 299 for code in status["expect"]), f"{app}.probe codes")
                status["url"] = f"https://{host}{route_path(status.pop('path'), f'{app}.probe path')}"
                for flag in ("enabled", "outside_access", "error_rate"):
                    if flag in status:
                        require(type(status[flag]) is bool, f"{app}.probe {flag}")
                if "content_type" in status:
                    require(isinstance(status["content_type"], str) and re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", status["content_type"]) is not None, f"{app}.probe media")
            if kind == "ops_v1":
                require(isinstance(status["binding"], str) and re.fullmatch(r"[A-Z][A-Z0-9_]*", status["binding"]) is not None,
                        f"{app}.ops binding")
                require(type(status["guard"]) is bool, f"{app}.guard")
                provider = status.get("provider")
                if data["target"] == "vps":
                    require(app == "newsletter" and provider == "fleet" and status["binding"] == "NEWSLETTER"
                            and status["guard"] is False, f"{app}.VPS Ops provider")
                    service, entrypoint = "fleet", "NewsletterOps"
                else:
                    require(provider is None, f"{app}.Ops provider")
                    service, entrypoint = worker, "Ops"
                require(any(s.get("binding") == status["binding"] and s.get("service") == service and s.get("entrypoint") == entrypoint
                            for s in read_toml(root / "dashboard/wrangler.toml").get("services", [])), f"{app}.ops binding")
            if kind == "analytics":
                require(type(status["max_idle_hours"]) is int and 1 <= status["max_idle_hours"] <= 168, f"{app}.idle")
            if data["target"] == "vps":
                require(kind in {"none", "ops_v1"} and worker is None and entry["url"] is None and not entry["access"], f"{app}.vps status")
            metric = entry.get("tile_metric")
            if metric is not None:
                fields(metric, {"kind", "name"}, {"kind"}, f"{app}.metric")
                require(isinstance(metric["kind"], str) and metric["kind"] in {"counter", "latency", "last_active"}, f"{app}.metric kind")
                require((metric["kind"] == "counter") == ("name" in metric), f"{app}.metric fields")
                if "name" in metric:
                    require(isinstance(metric["name"], str) and re.fullmatch(r"[a-z][a-z0-9_]*", metric["name"]) is not None, f"{app}.metric name")
            entry["tile_metric"] = metric
            entry["status"] = status
            entries.append(entry)
        for raw in data.get("access", []):
            rule = fields(raw, {"key", "kind", "worker", "name", "paths", "session"}, {"key", "kind", "worker", "name", "paths", "session"}, f"{app}.access rule")
            rule = dict(rule)
            identifier(rule["key"], f"{app}.access key")
            require(not any(old["key"] == rule["key"] for old in access), f"{app}.access key")
            require(isinstance(rule["kind"], str) and rule["kind"] in {"owner", "flowday"}, f"{app}.access kind")
            identifier(rule["worker"], f"{app}.access worker")
            require(any(w["script"] == rule["worker"] and w["app"] == app for w in workers), f"{app}.access worker")
            text(rule["name"], f"{app}.access name")
            require(isinstance(rule["session"], str) and rule["session"] in {"6h", "24h", "168h"}, f"{app}.access session")
            require(isinstance(rule["paths"], list) and bool(rule["paths"]) and all(isinstance(p, str) for p in rule["paths"])
                    and len(set(rule["paths"])) == len(rule["paths"]), f"{app}.access paths")
            host = primary_host(configs[rule["worker"]], f"{app}.access host", zone)
            require(host is not None, f"{app}.access host")
            rule["destinations"] = [host + route_path(p, f"{app}.access path", wildcard=True) for p in rule["paths"]]
            access.append(rule)
    require(paths == production_configs(root), "production config coverage")
    entry_ids = {entry["id"] for entry in entries}
    require(all(worker["entry"] in entry_ids for worker in workers), "worker entry coverage")
    for worker in workers:
        require(any(e["id"] == worker["entry"] for e in apps[worker["app"]]["entries"]), "worker app entry coverage")
        config = configs[worker["script"]]
        if config.get("vars", {}).get("ACCESS_AUDIENCE"):
            require(any(rule["worker"] == worker["script"] and rule["key"] == worker["script"] for rule in access), "Access application coverage")
        host = primary_host(config, "worker host", zone)
        if host is not None:
            entry = next(e for e in entries if e["id"] == worker["entry"])
            require(worker["script"] == "home" or (entry["group"] in {"apps", "sites"} and entry["url"] is not None), "visible entry coverage")
    for rule in access:
        if rule["kind"] == "owner":
            require(rule["key"] == rule["worker"], "owner Access identity")
        else:
            require(rule["worker"] == "flowday" and rule["key"] in {"flowday", "flowday-bypass"} and rule["name"] == rule["key"], "FlowDay Access identity")
    try:
        worker_secret_specs(root)
    except ProfileError as error:
        raise CatalogError(str(error)) from error
    return Catalog(root, apps, configs, sorted(workers, key=lambda w: w["position"]), sorted(entries, key=lambda e: e["position"]), access)


def ts(value: object) -> str:
    if isinstance(value, str):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if isinstance(value, list):
        return "[" + ", ".join(ts(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{key}: {ts(val)}" for key, val in value.items()) + " }"
    return json.dumps(value, ensure_ascii=False)


def entries_region(catalog: Catalog) -> str:
    keys = ("id", "name", "description", "group", "icon", "accent", "url", "access", "status", "tile_metric", "app_only_signals", "order")
    rows = []
    for entry in catalog.entries:
        lines = []
        for key in keys:
            value = ts(entry[key])
            if isinstance(entry[key], dict) and len(value) > 100:
                value = "{\n" + "".join(f"      {name}: {ts(item)},\n" for name, item in entry[key].items()) + "    }"
            lines.append(f"    {key}: {value},\n")
        rows.append("  {\n" + "".join(lines) + "  },")
    return "\n".join(rows)


def workers_region(catalog: Catalog) -> str:
    return "\n".join("  { " + ", ".join(f"{key}: {ts(worker[key])}" for key in ("script", "entry", "role")) + " }," for worker in catalog.workers)


def owner_region(catalog: Catalog) -> str:
    rows = []
    width = max((len(json.dumps(rule["key"])) for rule in catalog.access if rule["kind"] == "owner"), default=0)
    for rule in catalog.access:
        if rule["kind"] != "owner":
            continue
        destinations = rule["destinations"]
        key = json.dumps(rule["key"]).ljust(width)
        rows.append(f'    {key} = {{ name = {json.dumps(rule["name"])}, domain = {json.dumps(destinations[0])}, more = {json.dumps(destinations[1:])}, session = {json.dumps(rule["session"])} }}')
    return "\n".join(rows)


def replace_region(original: str, name: str, body: str, prefix: str) -> str:
    start, end = f"{prefix} BEGIN service-catalog {name}", f"{prefix} END service-catalog {name}"
    require(original.count(start + "\n") == original.count(end + "\n") == 1, f"generated region {name}")
    before, remaining = original.split(start + "\n", 1)
    _, after = remaining.split(end + "\n", 1)
    return before + start + "\n" + body + "\n" + end + "\n" + after


def access_file(catalog: Catalog) -> str:
    """Render the same Access HCL for normal generation and private initial bootstrap."""
    access = replace_region((catalog.root / "infra/access.tf").read_text(), "owner", owner_region(catalog), "    #")
    for rule in catalog.access:
        if rule["kind"] == "flowday":
            body = f'      destinations = {json.dumps(rule["destinations"])}\n      session      = {json.dumps(rule["session"])}'
            access = replace_region(access, rule["key"], body, "      #")
    return access


def generated_files(catalog: Catalog) -> dict[str, str]:
    registry_path = "dashboard/worker/src/registry.ts"
    registry = (catalog.root / registry_path).read_text()
    registry = replace_region(registry, "entries", entries_region(catalog), "  //")
    registry = replace_region(registry, "workers", workers_region(catalog), "  //")
    return {registry_path: registry, "infra/access.tf": access_file(catalog)}


def check_generated(catalog: Catalog) -> list[str]:
    return [path for path, content in generated_files(catalog).items() if (catalog.root / path).read_text() != content]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Refuse stale generated regions without writing")
    args = parser.parse_args(argv)
    try:
        catalog = load_catalog()
        outputs = generated_files(catalog)
        stale = check_generated(catalog)
        if args.check and stale:
            raise CatalogError("Service catalog output is stale: " + ", ".join(stale))
        if not args.check:
            for path in stale:
                (REPO / path).write_text(outputs[path])
        print(f"Service catalog: {len(catalog.apps)} apps, {len(catalog.workers)} Workers; generated regions current.")
        return 0
    except CatalogError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
