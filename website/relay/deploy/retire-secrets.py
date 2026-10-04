"""Remove the three retired website relay inputs, preserving its GitHub dispatch token."""

import os
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/cloud-release"))
from api import Api, ReleaseError


def main():
    try:
        config = tomllib.loads(
            (Path(__file__).resolve().parents[1] / "wrangler.toml").read_text()
        )
        if (
            config["name"] != "ziyixi-notion-publish"
            or "DAILY_SYNC_CRON" not in config.get("vars", {})
        ):
            raise ReleaseError("RELAY_RETIREMENT_CONFIG_INVALID")
        api = Api("cloudflare", os.environ.get("CLOUDFLARE_API_TOKEN", ""))
        path = f'/accounts/{config["account_id"]}/workers/scripts/{config["name"]}/secrets'
        current = api.call(path)
        if not isinstance(current, list) or any(
            not isinstance(row, dict) or not isinstance(row.get("name"), str)
            for row in current
        ):
            raise ReleaseError("RELAY_SECRET_LIST_INVALID")
        names = {row["name"] for row in current}
        retired = {"NOTION_TOKEN", "NOTION_DATA_SOURCE_ID", "NOTION_WEBHOOK_SECRET"}
        for name in sorted(names & retired):
            api.call(path + "/" + name, method="DELETE")
        print('{"event":"relay_retired_inputs","status":"complete"}')
        return 0
    except (ReleaseError, OSError, KeyError, ValueError):
        print('{"event":"relay_retired_inputs","status":"failed"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
