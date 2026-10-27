"""Read only deployed secret names before releasing Model Router's callers."""

import os
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/cloud-release"))
from api import Api, ReleaseError  # noqa: E402


def missing_connections(api, root=ROOT):
    config = tomllib.loads((root / "model-router/wrangler.toml").read_text())
    manifest = tomllib.loads((root / "model-router/app.toml").read_text())
    required = set(manifest["workers"][0]["owner_machine_secrets"])
    listed = api.call(f'/accounts/{config["account_id"]}/workers/scripts/{config["name"]}/secrets')
    if not isinstance(listed, list) or any(not isinstance(row, dict) or not isinstance(row.get("name"), str) for row in listed):
        raise ReleaseError("MODEL_ROUTER_SECRET_METADATA_INVALID")
    return sorted(required - {row["name"] for row in listed})


def main(api=None, root=ROOT):
    try:
        missing = missing_connections(api or Api("cloudflare", os.environ.get("CLOUDFLARE_API_TOKEN", "")), root)
    except (ReleaseError, OSError, KeyError, TypeError, ValueError):
        print("MODEL_ROUTER_CONNECTION_CHECK_FAILED")
        return 1
    if missing:
        print("MODEL_ROUTER_CONNECTIONS_MISSING: " + ", ".join(missing))
        return 1
    print("Model Router owner connection names are present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
