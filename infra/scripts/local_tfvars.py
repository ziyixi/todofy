#!/usr/bin/env python3
"""Write the live values infra/ needs into a tfvars file OUTSIDE the repository, without printing them.

    CLOUDFLARE_API_TOKEN=... python3 infra/scripts/local_tfvars.py --account-id <id> --out ~/.config/todofy-infra/local.tfvars

Reads (GET only) the two reusable Access policies and the Mail Hero application with a read-capable token
from the environment, and writes account_id, the policies' include emails and the identity provider ids
(variables.tf) with mode 0600. It refuses an output path inside this repository and never prints a value:
only the names of the variables it wrote. IDs come from config/resources.toml, and --account-id must
match that public configuration before any GET. Standard library only, Python 3.11+.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
API = "https://api.cloudflare.com/client/v4"
# Provider-issued IDs are public configuration. Never fetch one account's policy IDs in another.
sys.path.insert(0, str(REPO / "tools/cloud-config"))
from cloud_profile import ProfileError, load_resources  # noqa: E402


class Refused(ValueError):
    """A fixed message that never contains a value."""


def get(token: str, path: str) -> dict:
    request = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        raise Refused(f"Cloudflare API HTTP {error.code} for a GET") from None
    if not body.get("success"):
        raise Refused("Cloudflare API answered unsuccessfully")
    return body["result"]


def emails(policy: dict) -> list[str]:
    found = [rule["email"]["email"] for rule in policy.get("include", []) if "email" in rule]
    if not found or len(found) != len(policy.get("include", [])):
        raise Refused("a policy's include rules are not all email rules; update variables.tf first")
    return found


def identity_source() -> dict:
    try:
        resources = load_resources(REPO)
        return {
            "account_id": resources["account_id"],
            "owner_policy": resources["access_policy_ids"]["owner"],
            "github_owner_policy": resources["access_policy_ids"]["github-owner"],
            "mail_hero_app": resources["access_app_ids"]["mail-hero"],
        }
    except (ProfileError, KeyError):
        raise Refused("public resource identities are missing or invalid; prepare config/resources.toml first") from None


def values(account_id: str, fetch) -> dict:
    source = identity_source()
    if account_id != source["account_id"]:
        raise Refused("--account-id must match config/resources.toml before any policy GET")
    owner = fetch(f"/accounts/{account_id}/access/policies/{source['owner_policy']}")
    github = fetch(f"/accounts/{account_id}/access/policies/{source['github_owner_policy']}")
    app = fetch(f"/accounts/{account_id}/access/apps/{source['mail_hero_app']}")
    methods = [rule["login_method"]["id"] for rule in github.get("require", []) if "login_method" in rule]
    if len(methods) != 1:
        raise Refused("the GitHub owner policy does not require exactly one login method")
    return {
        "account_id": account_id,
        "access_owner_emails": emails(owner),
        "access_github_owner_emails": emails(github),
        "access_allowed_idp_ids": sorted(app.get("allowed_idps", [])),
        "access_github_idp_id": methods[0],
    }


def render(result: dict) -> str:
    return "".join(f"{name} = {json.dumps(value)}\n" for name, value in result.items())


def check_output(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if resolved == REPO or REPO in resolved.parents:
        raise Refused("refusing to write account values inside the repository; choose a path outside it")
    return resolved


def write(path: Path, text: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(text)
    os.chmod(path, 0o600)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write infra/ tfvars outside the repository without printing values.")
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if not re.fullmatch(r"[0-9a-f]{32}", args.account_id):
            raise Refused("--account-id must be 32 lowercase hex digits")
        out = check_output(args.out)
        token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        if not token:
            raise Refused("set CLOUDFLARE_API_TOKEN (a read-capable token) in the environment")
        result = values(args.account_id, lambda path: get(token, path))
        write(out, render(result))
    except Refused as error:
        print(f"local_tfvars: {error}", file=sys.stderr)
        return 2
    print("wrote " + ", ".join(result) + " (values not shown)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
