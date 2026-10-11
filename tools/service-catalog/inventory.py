"""Exact account inventory derived from public deployment inputs; no automatic adoption."""

import argparse
import json
import os
import re
import sys

from catalog import REPO, load_catalog, read_toml, require
from cloud_profile import load_resources

DO_KEYS = {
    "FleetState": "fleet-state", "HomeState": "home-state",
    "MailCoordinator": "mail-coordinator", "TodofyCore": "todofy-core-do", "WatchState": "watch-state",
    "MailsortState": "mailsort-state", "RecallState": "recall-state", "BriefState": "brief-state",
}
# Workers (script names) before their first deploy, one entry per app: the brief's until its go-live commit has
# deployed (brief/docs/design.md section 18). Such a Worker and the buckets it binds stay registered (Home's registry
# names them) but may be absent: "Infra apply" creates the bucket, the first deploy the Worker. Its Durable Object
# namespaces get their ids only from that deploy, so they are neither expected nor registered, and an existing one is
# not reported. The commit after the first deploy records those ids in config/resources.toml and removes the entry
# (expected() refuses a recorded id while the entry remains; recall's left on 2026-10-11). The entry also keeps the
# app out of "Personal cloud reconcile"'s Worker comparison, which needs a verified deployment (the matrix's exclude,
# held equal by .github/scripts/test_reconcile_workflow.py).
FIRST_DEPLOY_PENDING: set[str] = {"brief"}
OUTPUT = "dashboard/worker/src/account-inventory.json"
BUCKET_NAME = re.compile(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]")
PAGE_LIMIT = 100


def expected(root=REPO):
    catalog = load_catalog(root)
    identities = load_resources(root)
    result = {"workers": sorted(catalog.configs), "d1": [], "do": [], "r2": []}
    for script, config in catalog.configs.items():
        result["d1"].extend(b["database_id"] for b in config.get("d1_databases", []))
        result["r2"].extend(b["bucket_name"] for b in config.get("r2_buckets", []))
        for binding in config.get("durable_objects", {}).get("bindings", []):
            require(binding["class_name"] in DO_KEYS, "Durable Object inventory coverage")
            key = DO_KEYS[binding["class_name"]]
            if script in FIRST_DEPLOY_PENDING:
                require(key not in identities["durable_objects"], "first-deploy pending namespace already recorded")
                continue
            result["do"].append(identities["durable_objects"][key])
    extras = read_toml(root / "config/account-resources.toml")
    require(set(extras) == {"version", "r2"} and type(extras["version"]) is int
            and extras["version"] == 1 and isinstance(extras["r2"], list)
            and len(extras["r2"]) < PAGE_LIMIT, "account resource inventory")
    entries = {entry["id"] for entry in catalog.entries}
    registered_buckets = set(result["r2"])
    for item in extras["r2"]:
        require(isinstance(item, dict) and set(item) == {"name", "entry", "management"}
                and isinstance(item["management"], str) and item["management"] in {"bootstrap", "external"}
                # Home's existing hidden entry owns legacy backups outside this repository.
                and isinstance(item["entry"], str) and (item["entry"] in entries
                    or (item["entry"] == "self-hosted" and item["management"] == "external"))
                and isinstance(item["name"], str) and BUCKET_NAME.fullmatch(item["name"]) is not None,
                "account resource ownership")
        require(item["name"] not in registered_buckets, "duplicate account resource ownership")
        registered_buckets.add(item["name"])
        result["r2"].append(item["name"])
    return {kind: sorted(set(names)) for kind, names in result.items()}


def pending(root=REPO):
    """The registered identities that may still be absent: each FIRST_DEPLOY_PENDING Worker and the buckets it binds."""
    configs = load_catalog(root).configs
    require(FIRST_DEPLOY_PENDING <= set(configs), "first-deploy pending Worker")
    return {"workers": sorted(FIRST_DEPLOY_PENDING),
            "r2": sorted(b["bucket_name"] for script in FIRST_DEPLOY_PENDING
                         for b in configs[script].get("r2_buckets", []))}


def compare(wanted, observed, may_be_absent=None):
    allowed = may_be_absent or {}
    return [{"kind": kind, "identity": name, "change": change}
            for kind in wanted for change, values in (
                ("missing", set(wanted[kind]) - set(observed[kind]) - set(allowed.get(kind, ()))),
                ("unregistered", set(observed[kind]) - set(wanted[kind])))
            for name in sorted(values)]


def observe(api, account, pending_scripts=frozenset()):
    base = "/accounts/" + account
    paths = {"workers": ("/workers/scripts", "id"), "d1": ("/d1/database?per_page=100", "uuid"),
             "do": ("/workers/durable_objects/namespaces?per_page=100", "id"), "r2": ("/r2/buckets?per_page=100", "name")}
    result = {}
    for kind, (path, key) in paths.items():
        response = api.call(base + path, include_metadata=True)
        require(isinstance(response, dict), "account inventory response: " + kind)
        value = response.get("result")
        rows = value.get("buckets") if kind == "r2" and isinstance(value, dict) else value
        require(isinstance(rows, list) and len(rows) < PAGE_LIMIT, "bounded account inventory: " + kind)
        info = response.get("result_info")
        if kind != "workers":
            if kind == "r2":
                # R2 omits result_info when there is no continuation cursor.
                info = response.get("result_info", {})
                require(isinstance(info, dict), "account inventory pagination: " + kind)
                require(info.get("cursor") in (None, ""), "incomplete account inventory: " + kind)
            else:
                require(isinstance(info, dict), "account inventory pagination: " + kind)
                require(type(info.get("total_count")) is int and info["total_count"] == len(rows)
                        and type(info.get("page", 1)) is int and info.get("page", 1) == 1
                        and type(info.get("total_pages", 1)) is int and info.get("total_pages", 1) in (0, 1),
                        "incomplete account inventory: " + kind)
        require(all(isinstance(row, dict) and isinstance(row.get(key), str)
                    and 0 < len(row[key]) <= 256 for row in rows), "account inventory response: " + kind)
        require(len({row[key] for row in rows}) == len(rows), "duplicate account inventory: " + kind)
        # A FIRST_DEPLOY_PENDING Worker's namespace has no registered id yet.
        result[kind] = sorted(row[key] for row in rows if not (
            kind == "do" and isinstance(row.get("script"), str) and row["script"] in pending_scripts))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--generate", action="store_true")
    action.add_argument("--check", action="store_true")
    args = parser.parse_args()
    wanted = expected()
    text = json.dumps(wanted, indent=2, ensure_ascii=False) + "\n"
    output = REPO / OUTPUT
    if args.generate:
        output.write_text(text)
    elif args.check:
        require(output.read_text() == text, "generated account inventory is stale")
    else:
        sys.path.insert(0, str(REPO / "tools/cloud-release"))
        from api import Api, ReleaseError
        try:
            observed = observe(Api("cloudflare", os.environ.get("CLOUDFLARE_API_TOKEN", "")),
                               load_resources(REPO)["account_id"], FIRST_DEPLOY_PENDING)
            changes = compare(wanted, observed, pending())
            # Public logs contain counts only. Exact identities are already shown in the owner's Dashboard.
            print(json.dumps({"event": "account_inventory", "changes": len(changes),
                              "by_kind": {kind: sum(c["kind"] == kind for c in changes) for kind in wanted}}))
            return 1 if changes else 0
        except ReleaseError as error:
            print(str(error), file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
