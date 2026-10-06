#!/usr/bin/env python3
"""Initialize this cloud from an owner-only local JSON file. Values are never printed."""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(REPO / "infra/scripts"), str(REPO / "tools/cloud-config")]

import infra_state  # noqa: E402
from cloud_profile import ProfileError, load_profile, load_resources, owner_machine_secrets, worker_secret_specs  # noqa: E402
from github_config import initialize as initialize_github
from github_secrets import set_production, worker_secret_values  # noqa: E402
from inventory import write_resources  # noqa: E402
from private_input import BootstrapError, generated_secrets, read_document, read_private, update_private, vps_credentials, write_private  # noqa: E402
from tofu_bootstrap import run as cloud_bootstrap  # noqa: E402
from finalize import namespaces  # noqa: E402
from inventory_pr import create as inventory_pr
from generate import generated_files, write as render_config
from catalog import generated_files as catalog_files, load_catalog  # noqa: E402


def event(status: str, **fields) -> None:
    print(json.dumps({"event": "cloud_bootstrap", "status": status, **fields}, sort_keys=True))


def materialize(private: dict, specs: dict, *, fresh: bool) -> tuple[dict, list[str]]:
    if not isinstance(private.get("infra_values"), dict):
        raise BootstrapError("INFRA_PRIVATE_INPUT_INVALID")
    infra_state.parse_values(json.dumps(private["infra_values"]))
    scalar = generated_secrets(private, generate=fresh)
    maps, missing = worker_secret_values(private, scalar, specs, complete=fresh, owner_machine=owner_machine_secrets(REPO))
    return {**scalar, **maps}, missing


def export_inventory(path: Path, value: dict) -> None:
    write_resources(path, value)
    if path.resolve() == (REPO / "config/resources.toml").resolve():
        render_config(REPO, generated_files(REPO))
        render_config(REPO, catalog_files(load_catalog(REPO)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "check", "plan", "cloud", "secrets", "finalize"))
    parser.add_argument("--private-file", type=Path, required=True)
    parser.add_argument("--mode", choices=("fresh", "adopt"), default="fresh")
    parser.add_argument("--output", type=Path, help="prepare: new owner-only JSON; secrets: new VPS private JSON")
    parser.add_argument("--resources-output", type=Path, default=REPO / "config/resources.toml")
    parser.add_argument("--work-dir", type=Path, default=Path.home() / ".cache/todofy-infra")
    parser.add_argument("--create-pr", action="store_true", help="finalize: create an inventory-only PR and dispatch full branch CI")
    args = parser.parse_args(argv)
    try:
        private = read_private(args.private_file, REPO)
        profile, resources, specs = load_profile(REPO), load_resources(REPO), worker_secret_specs(REPO)
        if args.command == "plan":
            report, _ = cloud_bootstrap(private, profile, resources, args.mode, args.work_dir, check_only=True)
            event("plan_ready", **report)
            return 0
        if args.command == "prepare":
            if not args.output:
                raise BootstrapError("PRIVATE_OUTPUT_REQUIRED")
            if args.mode == "fresh":
                private.setdefault("infra_state_passphrase", secrets.token_urlsafe(32))
            private["github_secrets"], missing = materialize(private, specs, fresh=args.mode == "fresh")
            write_private(args.output, private, REPO)
            event("prepared", missing=missing)
            return 2 if missing else 0
        if args.command == "finalize":
            identifiers = namespaces(private, profile, resources)
            private["infra_values"]["mail_route_ready"] = True
            update_private(args.private_file, private, REPO)
            inventory, _ = cloud_bootstrap(private, profile, resources, args.mode, args.work_dir)
            inventory["durable_objects"] = identifiers
            export_inventory(args.resources_output, inventory)
            update_private(args.private_file, private, REPO)
            # Only this private tfvars secret changes: no application key is generated or rotated.
            set_production(profile["repository"], {"INFRA_TFVARS": json.dumps(private["infra_values"], separators=(",", ":"))})
            url = inventory_pr(REPO, profile["repository"]) if args.create_pr else ""
            event("finalized", inventory_updated=True, pull_request=url)
            return 0
        if args.command == "cloud":
            inventory, credentials = cloud_bootstrap(private, profile, resources, args.mode, args.work_dir)
            export_inventory(args.resources_output, inventory)
            configured = private.get("github_secrets", {})
            if not isinstance(configured, dict):
                raise BootstrapError("GITHUB_SECRETS_INVALID")
            captured = {}
            for binding, field in (("PLATFORM_ACCESS_CLIENT_ID", "client_id"), ("PLATFORM_ACCESS_CLIENT_SECRET", "client_secret")):
                value = credentials.get(field)
                if isinstance(value, str) and value:
                    captured[binding] = value
                elif args.mode == "fresh":
                    raise BootstrapError("PLATFORM_CREDENTIAL_OUTPUT_MISSING")
            private["github_secrets"] = {**configured, **captured}
            private["connector_token"] = credentials["connector_token"]
            update_private(args.private_file, private, REPO)
            event("cloud_in_sync", inventory_updated=True)
            return 0
        configured, missing = materialize(private, specs, fresh=args.mode == "fresh")
        if missing:
            event("input_missing", missing=missing)
            return 2
        if args.command == "check":
            event("input_ready", secret_names=sorted(configured))
            return 0
        if not args.output:
            raise BootstrapError("VPS_PRIVATE_OUTPUT_REQUIRED")
        connector = private.get("connector_token", private.get("vps", {}).get("connector_token", ""))
        if not isinstance(connector, str) or not connector:
            raise BootstrapError("CONNECTOR_TOKEN_MISSING_RUN_CLOUD")
        configured.update({"MAIL_HERO_CF_API_TOKEN": configured.get("CF_API_TOKEN", "")})
        private["github_secrets"] = configured
        update_private(args.private_file, private, REPO)
        vps = vps_credentials(private, configured, connector)
        if args.output.exists():
            if read_document(args.output, REPO) != vps:
                raise BootstrapError("VPS_PRIVATE_OUTPUT_MISMATCH")
        else:
            write_private(args.output, vps, REPO)
        setup = initialize_github(profile["repository"], mode=args.mode)
        set_production(profile["repository"], configured)
        event("production_secrets_set", secret_names=sorted(configured), vps_private_written=True, **setup)
        return 0
    except (BootstrapError, ProfileError, infra_state.Refused, OSError) as error:
        event("failed", error_code=str(error) if isinstance(error, BootstrapError) else "BOOTSTRAP_CONFIGURATION_OR_TOOL_FAILED",
              **(error.details if isinstance(error, BootstrapError) else {}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
