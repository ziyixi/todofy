#!/usr/bin/env python3
"""The desired Cloudflare state of every production Worker, for the dashboard's private drift check.

    python3 .github/scripts/drift_desired.py           # rewrite dashboard/worker/src/drift-desired.json
    python3 .github/scripts/drift_desired.py --check   # exit 1 when the committed file is not current

The dashboard Worker `home` bundles the generated JSON and, once per UTC day, compares it with what the
Cloudflare API reports (dashboard/docs/design-v2.md "Configuration drift"). The JSON holds names only:
Worker names, Custom Domain hostnames, zone route patterns, cron schedules, binding names and types, the
workers.dev and preview URL flags, and the NAMES of the secrets each Worker must have. Never an id, a value
or a secret. Sources:

- each Worker's committed production config (the same map as test_wrangler_configs.py PRODUCTION);
- each app's deploy-vars wrapper (the `deploy-vars-inputs` header names its inputs; the wrapper's own
  tables name the Worker vars it adds with --var and the Worker secrets it writes with --secrets-file, one
  file per Worker for Todofy's two Workers): the wrapper is imported, never run, and its secrets function
  gets synthetic placeholder inputs, so no real value is ever read;
- MANUAL_SECRETS below: the Worker secrets set by hand (`wrangler secret put`), names only.

A wrapper --var of kind `personal` (or `optional`, a personal value that may be unset) is listed under
`personal`: it must be a `secret_text` binding on the live Worker, and the drift check reports any other type
as a finding. Every wrapper writes its personal values with --secrets-file today, so they are wanted as
`secret_text` bindings and a live plain_text one is a `bindings` change; `personal` lists stay empty.

This file reads every app's folder, which is why it lives here and not in an app (root AGENTS.md); the
dashboard only reads its own generated copy. test_drift_desired.py fails until the committed JSON equals a
fresh generation, so a changed config or wrapper must regenerate it in the same commit (which also
redeploys the dashboard with the new desired state). Needs Python 3.11+ (tomllib) and Node.js (to import
the JavaScript wrappers). Standard library only.
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUTPUT = REPO / "dashboard" / "worker" / "src" / "drift-desired.json"
VERSION = 1

# Shared public inventory, validated by the catalog and independent Wrangler tests.
sys.path.insert(0, str(REPO / "tools" / "service-catalog"))
from catalog import load_catalog  # noqa: E402

WORKERS = load_catalog(REPO).worker_configs()

# The zones whose zone routes are compared (every Custom Domain and route of every Worker is in one of them).
ZONES = ("ziyixi.science",)

# Each deploy-vars wrapper: language, file, and which Worker gets its vars and its secrets (per mode for Todofy).
WRAPPERS = {
    "mail-hero": {"language": "js", "file": "mail-hero/deploy/deploy-vars.mjs", "vars": "mail-hero", "secrets": "mail-hero"},
    "dashboard": {"language": "js", "file": "dashboard/deploy/deploy-vars.mjs", "vars": "home", "secrets": "home"},
    "lab": {"language": "js", "file": "lab/deploy/deploy-vars.mjs", "vars": "lab", "secrets": "lab"},
    "flowday": {"language": "js", "file": "flowday/deploy/deploy-vars.mjs", "vars": "flowday", "secrets": "flowday"},
    "links": {"language": "js", "file": "links/deploy/deploy-vars.mjs", "vars": "links", "secrets": "links"},
    "watch": {"language": "js", "file": "watch/deploy/deploy-vars.mjs", "vars": "watch", "secrets": "watch"},
    "todofy": {
        "language": "py",
        "file": "todofy/deploy/deploy_vars.py",
        "vars": {"core": "todofy-core", "gateway": "todofy"},
        "secrets": {"core": "todofy-core", "gateway": "todofy"},
    },
}

# Worker secrets set by hand with `wrangler secret put` (no GitHub source; see each app's setup docs). Names only.
MANUAL_SECRETS = {
    "mail-hero": ("BACKUP_RECEIPT_KEY", "BACKUP_TOKEN", "CREDENTIAL_KEY"),
    "todofy": ("CSRF_SIGNING_KEY", "MAIL_WEBHOOK_TOKEN_SHA256", "REPORT_BASIC_AUTH_SHA256"),
    "todofy-core": ("GEMINI_API_KEY", "TODOIST_API_KEY"),
    "ziyixi-notion-publish": ("GITHUB_DISPATCH_TOKEN", "NOTION_DATA_SOURCE_ID", "NOTION_TOKEN", "NOTION_WEBHOOK_SECRET"),
}

# Wrapper kinds whose value is personal (must be a Worker secret on the live Worker).
PERSONAL_KINDS = {"personal", "optional"}

# Top-level config keys that create no binding; any key outside these and BINDING_SECTIONS is refused, so a new
# kind of binding cannot be added to a config without teaching this generator its API type.
PLAIN_KEYS = {
    "name",
    "account_id",
    "main",
    "base_dir",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "routes",
    "observability",
    "migrations",
    "triggers",
}


class GeneratorError(Exception):
    pass


def _toml(path: str) -> dict:
    return tomllib.loads((REPO / path).read_text())


def _binding(name: str, type_: str, source: str, optional: bool = False) -> dict:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name):
        raise GeneratorError(f"binding name {name!r} is not a plain identifier")
    entry = {"name": name, "type": type_, "source": source}
    if optional:
        entry["optional"] = True
    return entry


def config_bindings(worker: str, config: dict) -> list[dict]:
    """The bindings a committed config declares, with their Cloudflare API types."""
    found: list[dict] = []
    for key, value in config.items():
        if key in PLAIN_KEYS:
            continue
        if key == "vars":
            for name, var in value.items():
                found.append(_binding(name, "plain_text" if isinstance(var, str) else "json", "config"))
        elif key == "assets":
            if "binding" in value:
                found.append(_binding(value["binding"], "assets", "config"))
        elif key == "d1_databases":
            found += [_binding(item["binding"], "d1", "config") for item in value]
        elif key == "r2_buckets":
            found += [_binding(item["binding"], "r2_bucket", "config") for item in value]
        elif key == "durable_objects":
            found += [_binding(item["name"], "durable_object_namespace", "config") for item in value["bindings"]]
        elif key == "services":
            found += [_binding(item["binding"], "service", "config") for item in value]
        elif key == "analytics_engine_datasets":
            found += [_binding(item["binding"], "analytics_engine", "config") for item in value]
        elif key == "ai":
            found.append(_binding(value["binding"], "ai", "config"))
        else:
            raise GeneratorError(f"{worker}: config key {key!r} is unknown to drift_desired.py (add its binding type)")
    return found


# Placeholder inputs for a wrapper's secrets function, by input name: the same kind of synthetic values the CI
# dry-runs use. Only the names of the returned secrets are kept.
def _placeholder(name: str) -> str:
    if name.endswith("_ALIASES"):
        return ""
    if "OWNER" in name or "ADDRESS" in name:
        return "owner@example.com"
    if name.endswith("_PROJECT_ID"):
        return "placeholder"
    if name.endswith("_KEY"):
        return "0" * 64
    if name.endswith("_TOKEN"):
        return "placeholder-token-0000000000000000"
    raise GeneratorError(f"no placeholder for the wrapper input {name} (teach drift_desired.py _placeholder)")


def markers(path: str) -> dict[str, list[str]]:
    """The wrapper's `deploy-vars-inputs <mode>: NAMES` lines, by mode."""
    found: dict[str, list[str]] = {}
    text = (REPO / path).read_text()
    for mode, names in re.findall(r"^(?:#|//) deploy-vars-inputs (\w+): (.+)$", text, re.M):
        found.setdefault(mode, []).extend(names.split())
    if not found:
        raise GeneratorError(f"{path} has no deploy-vars-inputs header")
    return found


JS_READER = """
import { pathToFileURL } from 'node:url'
const wrapper = await import(pathToFileURL(process.env.DRIFT_WRAPPER).href)
const env = JSON.parse(process.env.DRIFT_INPUTS)
const vars = (wrapper.INJECTED ?? []).map(({ name, kind, optional }) => ({ name, kind, optional: optional === true }))
const secrets = typeof wrapper.generateSecrets === 'function' ? Object.keys(wrapper.generateSecrets(env)) : []
process.stdout.write(JSON.stringify({ vars, secrets }))
"""


def _js_wrapper(path: str, inputs: dict[str, str]) -> dict:
    node = shutil.which("node")
    if node is None:
        raise GeneratorError("Node.js is needed to read the JavaScript deploy-vars wrappers")
    env = {"PATH": os.environ.get("PATH", ""), "DRIFT_WRAPPER": str(REPO / path), "DRIFT_INPUTS": json.dumps(inputs)}
    result = subprocess.run([node, "--input-type=module", "-e", JS_READER], capture_output=True, text=True, env=env, cwd=REPO)
    if result.returncode != 0:
        raise GeneratorError(f"could not read {path} (node exited {result.returncode})")
    return json.loads(result.stdout)


def _py_wrapper(path: str, inputs: dict[str, str]) -> tuple[dict[str, list[dict]], dict[str, list[str]]]:
    spec = importlib.util.spec_from_file_location("drift_wrapper_" + Path(path).stem, REPO / path)
    if spec is None or spec.loader is None:
        raise GeneratorError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look their module up while the class is created
    try:
        spec.loader.exec_module(module)
        modes = {
            mode: [{"name": item.name, "kind": item.kind, "optional": item.kind == "optional"} for item in items]
            for mode, items in module.INJECTED.items()
        }
        secrets = {mode: list(module.generate_secrets(mode, inputs)) for mode in module.SECRETS}
    finally:
        sys.modules.pop(spec.name, None)
    return modes, secrets


def wrapper_bindings() -> tuple[dict[str, list[dict]], dict[str, list[str]]]:
    """Worker -> bindings added at deploy, and Worker -> the names of its personal values."""
    bindings: dict[str, list[dict]] = {}
    personal: dict[str, list[str]] = {}
    for app, wrapper in WRAPPERS.items():
        found = markers(wrapper["file"])
        secret_modes = [mode for mode in found if mode == "secrets" or mode.startswith("secrets_")]
        secret_inputs = [name for mode in secret_modes for name in found[mode]]
        inputs = {name: _placeholder(name) for name in secret_inputs}
        if wrapper["language"] == "js":
            read = _js_wrapper(wrapper["file"], inputs)
            modes = {"": read["vars"]}
            secrets = {"": read["secrets"]}
            targets = {"": wrapper["vars"]}
            secret_targets = {"": wrapper["secrets"]}
        else:
            modes, secrets = _py_wrapper(wrapper["file"], inputs)
            targets = wrapper["vars"]
            secret_targets = wrapper["secrets"]
            if set(modes) != set(targets) or set(secrets) != set(secret_targets):
                raise GeneratorError(f"{app}: wrapper modes {sorted(modes)}/{sorted(secrets)} != {sorted(targets)}")
        for mode, items in modes.items():
            worker = targets[mode]
            for item in items:
                bindings.setdefault(worker, []).append(_binding(item["name"], "plain_text", "deploy", item["optional"]))
                if item["kind"] in PERSONAL_KINDS:
                    personal.setdefault(worker, []).append(item["name"])
        for mode, names in secrets.items():
            for name in names:
                bindings.setdefault(secret_targets[mode], []).append(_binding(name, "secret_text", "deploy"))
    return bindings, personal


def build() -> dict:
    deployed, personal = wrapper_bindings()
    workers = {}
    for worker, path in sorted(WORKERS.items()):
        config = _toml(path)
        if config.get("name") != worker:
            raise GeneratorError(f"{path} names {config.get('name')!r}, not {worker!r}")
        for flag in ("workers_dev", "preview_urls"):
            if not isinstance(config.get(flag), bool):
                raise GeneratorError(f"{path}: {flag} must be set explicitly")
        routes = config.get("routes", [])
        domains = sorted(route["pattern"] for route in routes if route.get("custom_domain") is True)
        zone_routes = sorted(route["pattern"] for route in routes if route.get("custom_domain") is not True)
        for host in [*domains, *(pattern.split("/", 1)[0].lstrip("*.") for pattern in zone_routes)]:
            if not any(host == zone or host.endswith("." + zone) for zone in ZONES):
                raise GeneratorError(f"{path}: {host} is in no zone of ZONES")
        bindings = config_bindings(worker, config)
        bindings += deployed.get(worker, [])
        bindings += [_binding(name, "secret_text", "manual") for name in MANUAL_SECRETS.get(worker, ())]
        names = [binding["name"] for binding in bindings]
        duplicates = sorted({name for name in names if names.count(name) > 1})
        if duplicates:
            raise GeneratorError(f"{worker}: binding names declared twice: {duplicates}")
        workers[worker] = {
            "config": path,
            "workers_dev": config["workers_dev"],
            "preview_urls": config["preview_urls"],
            "custom_domains": domains,
            "routes": zone_routes,
            "crons": sorted(config.get("triggers", {}).get("crons", [])),
            "bindings": sorted(bindings, key=lambda binding: binding["name"]),
            "personal": sorted(personal.get(worker, [])),
        }
    unknown = (set(MANUAL_SECRETS) | set(deployed)) - set(WORKERS)
    if unknown:
        raise GeneratorError(f"secrets or vars for unknown Workers: {sorted(unknown)}")
    return {"version": VERSION, "zones": list(ZONES), "workers": workers}


def render(state: dict) -> str:
    return json.dumps(state, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    try:
        text = render(build())
    except GeneratorError as error:
        print(f"drift_desired.py: {error}", file=sys.stderr)
        return 2
    if argv == ["--check"]:
        current = OUTPUT.read_text() if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT.relative_to(REPO)} is out of date: run python3 .github/scripts/drift_desired.py", file=sys.stderr)
            return 1
        print(f"{OUTPUT.relative_to(REPO)} is current.")
        return 0
    if argv:
        print("Usage: drift_desired.py [--check]", file=sys.stderr)
        return 2
    OUTPUT.write_text(text)
    print(f"Wrote {OUTPUT.relative_to(REPO)} ({len(json.loads(text)['workers'])} Workers, names only).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
