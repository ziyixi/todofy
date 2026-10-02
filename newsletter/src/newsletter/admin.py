"""Explicit maintenance under the service lock; never starts background work."""

import argparse
import asyncio
import contextlib
import json
import os
import pathlib
import sqlite3
import sys
from typing import TypedDict

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.delivery as delivery
import newsletter.deployment_client as deployment_client
import newsletter.drain as drain
import newsletter.ownership as ownership
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.workflow.story_replay as story_replay


class MaintenanceStatus(TypedDict):
    """Read-only active-work counts for the deployment maintenance wrapper."""

    busy: bool
    counts: dict[str, int]


def configure(parser: argparse.ArgumentParser) -> None:
    """Register status, bounded story recovery and verification delivery."""
    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser(
        "status", help="Read active work counts; no job changes"
    )
    deployment_client.configure(commands.add_parser("drain"))
    retry = commands.add_parser("retry-stories")
    for name in ("parent-run-id", "request-key", "issue-date"):
        retry.add_argument("--" + name, required=True)
    send = commands.add_parser("send-verification")
    for name in ("edition-id", "request-key", "expected-render-hash"):
        send.add_argument("--" + name, required=True)
    send.add_argument("--after-verification")


def status(data_dir: pathlib.Path) -> MaintenanceStatus:
    """Read consistent active-work counts without business database changes.

    Missing/incompatible databases fail closed. SQLite mode=ro may create or
    update WAL/SHM coordination sidecars to observe committed live writes; it
    must not use immutable=1, which can miss active work in the WAL. Pending
    queues do not count as active work and remain untouched.
    """
    path = (data_dir / "newsletter.sqlite3").resolve()
    filters = {
        "editions": "state='running'",
        "packets": "projection='submitting'",
        "collection_runs": "state IN ('collecting','projecting','editing')",
        "workflow_attempts": "state='running'",
        "notion_entities": "create_state='creating'",
        "notion_versions": "state='appending'",
    }
    with contextlib.closing(
        sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    ) as database:
        database.execute("BEGIN")
        tables = {
            row[0]
            for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if not {"editions", "packets", "metadata", "sends"} <= tables:
            raise ValueError(
                "Maintenance requires an existing service database"
            )
        counts = {}
        for table, predicate in filters.items():
            if table in tables:
                # Both identifiers and predicates are fixed above, not inputs.
                counts[table] = int(
                    database.execute(
                        f"SELECT COUNT(*) FROM {table} WHERE {predicate}"
                    ).fetchone()[0]
                )
        counts["delivery"] = int(
            database.execute(
                "SELECT COUNT(*) FROM editions "
                "WHERE json_extract(body,'$.delivery_state')='submitting'"
            ).fetchone()[0]
        )
    return {"busy": any(counts.values()), "counts": counts}


def execute(
    args: argparse.Namespace, settings: newsletter_settings.Settings
) -> types.Payload:
    """Run one mutation with exclusive ownership; never recover other jobs."""
    settings.validate()
    path = settings.data_dir / "newsletter.sqlite3"
    if not path.is_file():
        raise ValueError("Maintenance requires an existing service database")
    with ownership.exclusive_store(settings.data_dir):
        if status(settings.data_dir)["busy"]:
            raise RuntimeError("Newsletter has active work; finish it first")
        store = newsletter_store.Store(
            path, settings.mode, settings.max_pending_jobs
        )
        try:
            if args.operation == "retry-stories":
                parsed = contracts.parse_message(
                    {
                        "request_key": args.request_key,
                        "issue_date": args.issue_date,
                    },
                    editorial_pb2.StartRunRequest,
                )
                contracts.validate_request(parsed)
                contracts.validate_request(
                    contracts.parse_message(
                        {"id": args.parent_run_id},
                        editorial_pb2.GetRunRequest,
                    )
                )
                with store.deployment.activity("maintenance"):
                    return story_replay.StoryReplay(store).start(
                        args.parent_run_id, contracts.to_dict(parsed)
                    )
            if args.operation != "send-verification":
                raise ValueError("Unknown maintenance operation")
            return _send(args, settings, store)
        finally:
            store.close()


def _send(
    args: argparse.Namespace,
    settings: newsletter_settings.Settings,
    store: newsletter_store.Store,
) -> types.Payload:
    store.bind_delivery_target(
        {
            "backend": settings.mail_backend,
            "from": settings.from_email,
            "to": settings.recipient_email,
        }
    )
    mail: adapters.MailAdapter
    if settings.mail_backend == "resend":
        mail = adapters.Resend(
            settings.resend_api_key,
            settings.from_email,
            settings.recipient_email,
        )
    else:
        mail = adapters.FakeMail(settings.data_dir / "outbox")
    edition = asyncio.run(
        delivery.send_edition(
            store,
            mail,
            {
                "id": args.edition_id,
                "request_key": args.request_key,
                "expected_render_hash": args.expected_render_hash,
            },
            real_delivery=settings.mail_backend == "resend",
            verification=True,
            predecessor=args.after_verification,
        )
    )
    return contracts.to_dict(
        contracts.parse_message(edition, editorial_pb2.Edition)
    )


def main(args: argparse.Namespace) -> int:
    """Print one JSON result; errors never disclose environment values."""
    if args.operation == "drain":
        return deployment_client.main(args)
    try:
        if args.operation == "status":
            result = status(
                pathlib.Path(os.getenv("NEWSLETTER_DATA_DIR", ".data"))
            )
            print(json.dumps(result))
        else:
            value = execute(args, newsletter_settings.Settings.from_env())
            print(contracts.canonical_json(value))
    except (
        OSError,
        ValueError,
        RuntimeError,
        sqlite3.Error,
        newsletter_store.StoreError,
        drain.DrainError,
    ):
        print("NEWSLETTER_MAINTENANCE_FAILED", file=sys.stderr)
        return 1
    return 0
