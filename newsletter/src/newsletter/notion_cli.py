"""Explicit schema setup and read-only diagnostics without research or mail."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sqlite3

import newsletter.adapters as adapters
import newsletter.notion_api as notion_api


def status(path: pathlib.Path) -> dict[str, object]:
    """Read aggregate journal states without creating or mutating a database.

    Reports counts and safe error codes, never page content or credentials.
    A database without Notion tables is reported as disabled.
    """
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        if not db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND "
            "name='notion_entities'"
        ).fetchone():
            return {"enabled": False}
        return {
            "enabled": True,
            "entities": [
                dict(row)
                for row in db.execute(
                    "SELECT kind,create_state,COUNT(*) AS count FROM "
                    "notion_entities "
                    "GROUP BY kind,create_state"
                )
            ],
            "versions": [
                dict(row)
                for row in db.execute(
                    "SELECT state,COUNT(*) AS count FROM notion_versions "
                    "GROUP BY state"
                )
            ],
            "errors": [
                dict(row)
                for row in db.execute(
                    "SELECT error,COUNT(*) AS count FROM notion_entities "
                    "WHERE error!='' GROUP BY error"
                )
            ],
            "import_errors": [
                dict(row)
                for row in db.execute(
                    "SELECT error,COUNT(*) AS count FROM notion_imports "
                    "WHERE error!='' GROUP BY error"
                )
            ],
        }


def main() -> None:
    """Run an explicit schema command or read local synchronization status.

    Only ``setup --apply`` adds remote columns. Configuration and storage
    failures terminate with a safe message without exposing exception text.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    setup = subparsers.add_parser(
        "setup", help="Read both schemas; --apply adds missing columns"
    )
    setup.add_argument("--apply", action="store_true")
    subparsers.add_parser(
        "status", help="Read existing local receipts while service is running"
    )
    args = parser.parse_args()
    try:
        if args.command == "setup":
            api = notion_api.NotionWorkspace(
                os.environ.get("NOTION_TOKEN", ""),
                os.environ.get("NOTION_MATERIALS_DATA_SOURCE_ID", ""),
                os.environ.get("NOTION_EDITIONS_DATA_SOURCE_ID", ""),
            )
            result = asyncio.run(api.setup(apply=args.apply))
        else:
            directory = pathlib.Path(
                os.environ.get("NEWSLETTER_DATA_DIR", ".data")
            )
            result = status(directory / "newsletter.sqlite3")
    except adapters.AdapterError as exc:
        parser.exit(1, "Notion operation failed: " + exc.code + "\n")
    except (OSError, ValueError, sqlite3.Error):
        parser.exit(
            1,
            "Notion configuration/storage unavailable; inspect private "
            "configuration.\n",
        )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
