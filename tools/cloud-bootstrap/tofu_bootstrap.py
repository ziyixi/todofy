"""Fresh creation and adoption use a private copy of the same committed OpenTofu HCL."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import infra_state
from adopt_metadata import prepare
from bootstrap_state import ensure_bucket, state_exists
from cloud_api import (
    create_state_bucket,
    ensure_workers_subdomain,
    list_page,
    request,
    verify_target,
)
from fresh_collisions import refuse_conflicts
from generate import bootstrap_infra_files
from inventory import exported_resources, import_hcl, known_imports
from private_input import BootstrapError
from state_imports import adopt as import_state


def bootstrap_gate(plan: dict, mode: str) -> None:
    """Bootstrap may read imports or create missing objects; it never edits an existing object."""
    if plan.get("_flowday_include_errors"):
        raise BootstrapError("BOOTSTRAP_FLOWDAY_INCLUDE_MISMATCH")
    if infra_state.type_violations(plan):
        raise BootstrapError("BOOTSTRAP_RESOURCE_OUTSIDE_SCOPE")
    for item in plan.get("resource_changes", []):
        change = item.get("change", {})
        actions = change.get("actions", [])
        if actions not in (["no-op"], ["create"]):
            changes = []
            for resource in plan.get("resource_changes", []):
                delta = resource.get("change", {})
                if delta.get("actions") in (["no-op"], ["create"]):
                    continue
                before, after = delta.get("before") or {}, delta.get("after") or {}
                fields = sorted(key for key in before.keys() | after.keys()
                                if key.replace("_", "").isalnum() and before.get(key) != after.get(key))
                changes.append({"address": resource["address"], "actions": delta.get("actions", []), "fields": fields})
            raise BootstrapError("BOOTSTRAP_EXISTING_RESOURCE_CHANGE", {"changes": changes})
        if mode == "adopt" and actions == ["create"]:
            raise BootstrapError("ADOPT_RESOURCE_NOT_FOUND")
        if mode == "fresh" and change.get("importing"):
            raise BootstrapError("FRESH_ADOPTION_NOT_ALLOWED")
    if not plan.get("resource_changes"):
        raise BootstrapError("BOOTSTRAP_PLAN_EMPTY")


def output(session, name: str) -> dict:
    result = subprocess.run([session.tofu.binary, "output", "-json", name],
                            cwd=session.tofu.directory, env=session.tofu.env,
                            capture_output=True, timeout=60, check=False)
    if result.returncode or len(result.stdout) > 16384:
        raise BootstrapError("BOOTSTRAP_OUTPUT_UNAVAILABLE")
    try:
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (TypeError, ValueError):
        raise BootstrapError("BOOTSTRAP_OUTPUT_INVALID") from None


def run(private: dict, profile: dict, resources: dict, mode: str, parent: Path,
        *, fetch=request, page_fetch=list_page, session_factory=infra_state.Session, check_only: bool = False) -> tuple[dict, dict]:
    try:
        if private.get("infra_values", {}).get("account_id") != resources["account_id"]:
            raise BootstrapError("INFRA_ACCOUNT_MISMATCH")
        verify_target(private["cloudflare_api_token"], resources["account_id"], resources["zone_id"], profile["zone"], fetch)
        prepare(private, resources, profile["zone"], mode, fetch)
        values = infra_state.parse_values(json.dumps(private["infra_values"]))
        token = private["cloudflare_api_token"]
        phrase = private["infra_state_passphrase"]
    except (KeyError, TypeError, infra_state.Refused):
        raise BootstrapError("INFRA_PRIVATE_INPUT_INVALID") from None
    if not isinstance(token, str) or not token or not isinstance(phrase, str) or len(phrase) < 16:
        raise BootstrapError("INFRA_PRIVATE_INPUT_INVALID")
    if values["account_id"] != resources["account_id"]:
        raise BootstrapError("INFRA_ACCOUNT_MISMATCH")
    ensure_workers_subdomain(token, values["account_id"], profile["workers_dev_subdomain"], mode == "fresh" and not check_only, fetch)
    env = {"CLOUDFLARE_API_TOKEN": token, "INFRA_STATE_PASSPHRASE": phrase, "PATH": os.environ.get("PATH", "")}
    work = infra_state.new_work_dir(parent, env, prefix="cloud-bootstrap-")
    config = work / "config"
    config.mkdir(mode=0o700)
    session_work = work / "session"
    session_work.mkdir(mode=0o700)
    for path in infra_state.INFRA.glob("*.tf"):
        if path.name != "imports.tf":
            shutil.copyfile(path, config / path.name)
    for relative, text in bootstrap_infra_files(infra_state.REPO).items():
        (config / Path(relative).name).write_text(text)
    shutil.copyfile(infra_state.INFRA / ".terraform.lock.hcl", config / ".terraform.lock.hcl")
    imports = known_imports(resources, values, private.get("adopt_ids")) if mode == "adopt" else {}
    if imports:
        (config / "imports.tf").write_text(import_hcl(imports))
    session = None
    try:
        session = session_factory(environment="production", values=values, work=session_work, env=env, directory=config)
        if check_only:
            status, _ = session.s3("HEAD", "")
            if status != 200:
                raise BootstrapError("ADOPT_STATE_BUCKET_NOT_AVAILABLE")
        else:
            ensure_bucket(session, lambda: _create_bucket(token, values["account_id"], fetch))
        existed = state_exists(session, "production")
        session.tofu.init("production")
        if mode == "adopt" and not check_only:
            import_state(session, imports, existed, env)
        code, summary, _, plan = session.plan_full("bootstrap")
        bootstrap_gate(plan, mode)
        if mode == "fresh":
            refuse_conflicts(plan, token, values["account_id"], resources["zone_id"], page_fetch=page_fetch)
        if check_only:
            return {"actions": dict(infra_state.counts(summary)), "state_exists": existed}, {}
        if code != 0:
            if existed:
                infra_state.backup_state(session, "production", env)
            session.tofu.apply(session.work / "bootstrap.tfplan", diagnostic_plan=plan)
        code, summary, _, plan = session.plan_full("verify")
        if code or infra_state.drift_exit(summary):
            raise BootstrapError("BOOTSTRAP_VERIFY_NOT_IN_SYNC")
        bootstrap_gate(plan, mode)
        status, state = session.s3("GET", infra_state.state_key("production"))
        if status != 200 or not infra_state.encrypted_state(state):
            raise BootstrapError("BOOTSTRAP_STATE_NOT_VERIFIED")
        inventory = exported_resources(resources, plan, fresh=mode == "fresh")
        credentials = output(session, "platform_bootstrap")
        connector = fetch(token, "/accounts/" + values["account_id"] + "/cfd_tunnel/" + credentials["tunnel_id"] + "/token")
        if not isinstance(connector, str) or not connector:
            raise BootstrapError("CONNECTOR_OUTPUT_INVALID")
        credentials["connector_token"] = connector
        return inventory, credentials
    except infra_state.Refused:
        raise BootstrapError("BOOTSTRAP_TOFU_FAILED", {"headlines": session.tofu.headlines() if session else []}) from None
    finally:
        if session:
            session.cleanup()
        shutil.rmtree(work)


def _create_bucket(token: str, account: str, fetch) -> int:
    create_state_bucket(token, account, fetch)
    return 0
