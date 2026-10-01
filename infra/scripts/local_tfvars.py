#!/usr/bin/env python3
"""Write the live values infra/ needs into a tfvars file OUTSIDE the repository, without printing them.

    CLOUDFLARE_API_TOKEN=... python3 infra/scripts/local_tfvars.py --account-id <id> --out ~/.config/todofy-infra/local.tfvars

Reads (GET only) the two reusable Access policies and the Mail Hero application with a read-capable token
from the environment, and writes account_id, the policies' include emails and the identity provider ids
(variables.tf) with mode 0600. It refuses an output path inside this repository and never prints a value:
only the names of the variables it wrote. Standard library only.
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
# The objects infra/ manages (imports.tf); only their identity rules are read.
OWNER_POLICY = "018f1a13-1a1b-4cf6-a470-c865c4577851"
GITHUB_OWNER_POLICY = "eea00ced-7de7-4094-a705-c9741d835b7c"
MAIL_HERO_APP = "ebd92116-4d51-4d90-923a-068b05b7e05a"


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


def values(account_id: str, fetch) -> dict:
    owner = fetch(f"/accounts/{account_id}/access/policies/{OWNER_POLICY}")
    github = fetch(f"/accounts/{account_id}/access/policies/{GITHUB_OWNER_POLICY}")
    app = fetch(f"/accounts/{account_id}/access/apps/{MAIL_HERO_APP}")
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
