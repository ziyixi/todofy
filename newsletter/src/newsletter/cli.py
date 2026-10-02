"""Serve the private API or run a completely offline fixture demonstration."""

import argparse
import asyncio
import base64
import importlib.resources as resources
import json
import pathlib
import secrets
import sys

import uvicorn
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.admin as admin
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.rendering as rendering
import newsletter.store as newsletter_store
import newsletter.todofy as todofy
import newsletter.worker as newsletter_worker


async def demo(output: pathlib.Path) -> pathlib.Path:
    """Never read environment credentials, call providers, or send real mail."""
    output = output.resolve()
    # Exclusive directory: a demo cannot overwrite a service database or prior
    # issue.
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    store = newsletter_store.Store(output / "newsletter.sqlite3", "mock")
    try:
        fixtures = json.loads(
            resources.files("newsletter")
            .joinpath("fixtures/packets.json")
            .read_text()
        )
        packets = []
        for request in fixtures:
            message = contracts.parse_message(
                request, editorial_pb2.PutPacketRequest
            )
            contracts.validate_request(message)
            packets.append(store.put_packet(contracts.to_dict(message)))
        edition = store.prepare(
            {
                "request_key": "demo-v1",
                "issue_date": "2026-09-05",
                "packet_ids": [p["id"] for p in packets],
            }
        )
        worker = newsletter_worker.Worker(
            store,
            editor.MockEditor(),
            adapters.FakeNotion(output / "notion"),
            output / "jobs",
            30,
            todofy=todofy.FakeTodofy(),
        )
        while await worker.step():
            pass
        edition = store.get(edition["id"])
        if edition["state"] != "ready":
            raise RuntimeError("Offline demo did not produce a ready preview")
        (output / "preview.html").write_text(
            rendering.preview_html(edition["rendered"]),
            encoding="utf-8",
        )
        (output / "preview.txt").write_text(
            edition["rendered"]["text"], encoding="utf-8"
        )
        if edition["rendered"].get("chart_png"):
            (output / "chart.png").write_bytes(
                base64.b64decode(edition["rendered"]["chart_png"])
            )
        request = {
            "id": edition["id"],
            "request_key": "demo-send-v1",
            "expected_render_hash": edition["rendered"]["render_hash"],
        }
        reserved, _ = store.reserve_send(request)
        result = await adapters.FakeMail(output / "outbox").send(
            reserved, "demo-" + edition["id"]
        )
        edition = store.finish(edition["id"], **result)
        (output / "edition.json").write_text(
            contracts.canonical_json(edition), encoding="utf-8"
        )
    finally:
        store.close()
    return output / "preview.html"


def main() -> None:
    """Dispatch server, offline demo, token generation or locked maintenance."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    server = commands.add_parser("serve", help="Start one private HTTP service")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8080)
    sample = commands.add_parser(
        "demo", help="Offline fixtures, local preview and simulated .eml only"
    )
    sample.add_argument("--output", type=pathlib.Path)
    commands.add_parser(
        "token",
        help="Print one service token; use distinct editor/send values",
    )
    admin.configure(commands.add_parser("admin", help="Explicit maintenance"))
    args = parser.parse_args()
    if args.command == "serve":
        uvicorn.run(
            "newsletter.app:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            workers=1,
            access_log=False,
            limit_concurrency=32,
            timeout_keep_alive=5,
            timeout_graceful_shutdown=40,
        )
    elif args.command == "demo":
        output = args.output or pathlib.Path(".artifacts") / (
            "demo-" + secrets.token_hex(4)
        )
        print(asyncio.run(demo(output)))
        print("MOCK only: no model, Notion, or email network calls.")
    elif args.command == "admin":
        sys.exit(admin.main(args))
    else:
        print(secrets.token_urlsafe(32))


if __name__ == "__main__":
    main()
