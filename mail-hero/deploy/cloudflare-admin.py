#!/usr/bin/env python3
"""Use Mail Hero's separate credential without changing Wrangler's global login.

The token is read only into this process/environment. Never pass it on a command
line, include it in a configuration file, or print response headers.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import urllib.error
import urllib.request

ACCOUNT = "f57937bd1d93bf59e737b6d8445fb7a3"
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TOKEN = Path.home() / ".config/mail-hero/cloudflare-bootstrap-20260926.token"


def valid_token(value):
    return 20 <= len(value) <= 512 and all(c.isascii() and (c.isalnum() or c in "_-") for c in value)


def save_token(path):
    if not sys.stdin.isatty():
        raise ValueError("Run save-token in your local interactive terminal.")
    if path.exists() or path.is_symlink():
        raise ValueError("Token file already exists; nothing was changed.")
    value = getpass.getpass("Paste the new Mail Hero API token (input is hidden): ").strip()
    if not valid_token(value):
        raise ValueError("Invalid token format; nothing was saved.")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(value + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    print("Saved owner-only Mail Hero credential. Existing Wrangler login was not changed.")


def credential(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Token must be an owner-only regular file (chmod 600).")
    value = path.read_text().strip()
    if not valid_token(value):
        raise ValueError("Token file has an invalid format; no contents were printed.")
    return value


def api(token, path, method="GET", body=None):
    payload = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("https://api.cloudflare.com/client/v4" + path,
        data=payload, method=method,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json",
                 "User-Agent": "MailHero-Deployment/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            data = json.load(error)
            codes = [item.get("code") for item in data.get("errors", [])]
        except Exception:
            codes = []
        raise ValueError(f"Cloudflare API HTTP {error.code}, error codes {codes}") from None
    if not result.get("success"):
        raise ValueError("Cloudflare API unsuccessful; codes " + str([x.get("code") for x in result.get("errors", [])]))
    return result.get("result")


def inspect(token):
    prefix = "/accounts/" + ACCOUNT
    tasks = [
        ("token", prefix + "/tokens/verify", lambda v: {"status": v.get("status"), "expires_on": v.get("expires_on")}),
        ("workers", prefix + "/workers/scripts", lambda v: [{"name": x.get("id")} for x in v]),
        ("databases", prefix + "/d1/database", lambda v: [{"name": x.get("name"), "uuid": x.get("uuid")} for x in v]),
        ("buckets", prefix + "/r2/buckets", lambda v: [{"name": x.get("name")} for x in v.get("buckets", [])]),
        ("access_organization", prefix + "/access/organizations", lambda v: {"auth_domain": v.get("auth_domain"), "name": v.get("name")}),
        ("access_apps", prefix + "/access/apps", lambda v: [{k: x.get(k) for k in ("id", "name", "domain", "aud")} for x in v]),
        ("zones", "/zones?name=ziyixi.science", lambda v: [{k: x.get(k) for k in ("id", "name", "status")} for x in v]),
    ]
    for label, path, summarize in tasks:
        try:
            print(json.dumps({label: summarize(api(token, path))}))
        except ValueError as error:
            print(json.dumps({label: {"error": str(error)}}))


# Wrangler's global options that take a value, possibly as the next argument (--config=x is one argument).
VALUE_OPTIONS = {"-c", "--config", "-e", "--env", "--cwd", "--env-file"}


def wrangler_command(argv):
    """The wrangler command argv names, after any global options: `--config x deploy` and `-e y versions
    upload` name "deploy" and "versions upload" as much as `deploy` does."""
    position = 0
    while position < len(argv) and argv[position].startswith("-"):
        position += 1 if argv[position] == "--" else (2 if argv[position] in VALUE_OPTIONS else 1)
    words = argv[position:position + 2]
    return " ".join(words) if words[:1] == ["versions"] else " ".join(words[:1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN)
    parser.add_argument("command", choices=["save-token", "inspect", "wrangler"])
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == "save-token":
        try:
            save_token(args.token_file)
        except (OSError, ValueError, EOFError) as error:
            parser.exit(1, f"Credential was not saved: {error}\n")
        return
    try:
        token = credential(args.token_file)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Credential unavailable: {error}\n")
    if args.command == "inspect":
        inspect(token)
        return
    # An explicit environment token wins without replacing default.toml OAuth.
    environment = os.environ.copy()
    environment.update(CLOUDFLARE_API_TOKEN=token, CLOUDFLARE_ACCOUNT_ID=ACCOUNT,
        WRANGLER_SEND_METRICS="false", CI="true")
    argv = args.arguments
    if argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        parser.error("wrangler requires command arguments")
    # ../wrangler.toml is production and holds no personal values or switches: a deploy without the
    # --var flags of deploy/deploy-vars.mjs would delete them. Deploys run in CI, or through that wrapper.
    if wrangler_command(argv) in ("deploy", "versions upload"):
        parser.error("deploy only through CI or: node ../deploy/deploy-vars.mjs exec -- npx --no-install "
                     "wrangler deploy --config ../wrangler.toml (from cloudflare/)")
    result = subprocess.run([str(ROOT / "cloudflare/node_modules/.bin/wrangler"), *argv],
        cwd=ROOT / "cloudflare", env=environment)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
