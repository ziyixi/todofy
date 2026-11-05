"""Shared offline notion content builders and fakes."""

from __future__ import annotations

import asyncio
import base64
import collections
from collections.abc import Iterator
import contextlib
import copy
import hashlib
import json
import pathlib
import types as std_types
import urllib.parse as parse
import uuid

import httpx

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.notion_api as notion_api
import newsletter.notion_content as notion_content
import newsletter.notion_intake as notion_intake
import newsletter.notion_journal as notion_journal
import newsletter.notion_sync as notion_sync
import newsletter.store as newsletter_store
import newsletter.types as types
import tests.support.rendering as rendering

DAY = "2026-09-07"
MATERIAL = "11111111-1111-4111-8111-111111111111"
EDITION = "22222222-2222-4222-8222-222222222222"
PAGE = "33333333-3333-4333-8333-333333333333"
UPLOAD = "44444444-4444-4444-8444-444444444444"
TOKEN = "synthetic-test-token-not-a-real-secret"

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAA"
    "AAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)


def rich(text: str) -> list[types.Payload]:
    """Build a synthetic Notion rich-text fragment list."""
    return [{"type": "text", "text": {"content": text}}]


def paragraph(text: str = "Offline content") -> types.Payload:
    """Build a synthetic Notion paragraph block."""
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {"rich_text": rich(text)},
    }


def source(kind: str, *, complete: bool = True) -> types.Payload:
    """Build a synthetic Notion data source schema payload."""
    properties: types.Payload = {
        "My own title": {
            "id": "title",
            "name": "My own title",
            "type": "title",
            "title": {},
        }
    }
    if complete:
        for key, spec in notion_api.SCHEMAS[kind].items():
            if key == "title":
                continue
            detail: types.Payload = {}
            if spec.type in {"select", "multi_select"}:
                detail = {
                    "options": [
                        {"name": name, "id": str(index)}
                        for index, name in enumerate(spec.options)
                    ]
                }
            elif spec.type == "relation":
                detail = {
                    "data_source_id": (
                        EDITION if kind == "material" else MATERIAL
                    ),
                    "single_property": {},
                }
            properties[spec.name] = {
                "id": kind + "-" + key,
                "type": spec.type,
                "name": spec.name,
                spec.type: detail,
            }
    return {
        "object": "data_source",
        "id": MATERIAL if kind == "material" else EDITION,
        "in_trash": False,
        "properties": properties,
    }


class ApiRig:
    """Offline Notion HTTP workspace test rig."""

    def __init__(self, complete: bool = True) -> None:
        self.sources = {
            MATERIAL: source("material", complete=complete),
            EDITION: source("edition", complete=complete),
        }
        self.requests: list[httpx.Request] = []
        self.extra = None
        self.api = notion_api.NotionWorkspace(
            TOKEN, MATERIAL, EDITION, transport=httpx.MockTransport(self.handle)
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert (
            request.url.scheme == "https"
            and request.url.host == "api.notion.com"
        )
        assert request.headers["Authorization"] == "Bearer " + TOKEN
        assert (
            request.headers["Notion-Version"]
            == notion_api.API_VERSION
            == "2026-03-11"
        )
        if request.url.path.startswith(
            "/v1/data_sources/"
        ) and not request.url.path.endswith("/query"):
            target = request.url.path.rsplit("/", 1)[1]
            if request.method == "PATCH":
                body = json.loads(request.content)
                assert set(body) == {"properties"}
                for name, value in body["properties"].items():
                    assert name not in self.sources[target]["properties"]
                    kind = next(iter(value))
                    self.sources[target]["properties"][name] = {
                        "id": "new-"
                        + str(len(self.sources[target]["properties"])),
                        "name": name,
                        "type": kind,
                        **value,
                    }
            return httpx.Response(200, json=self.sources[target])
        if self.extra:
            return self.extra(request)
        return httpx.Response(
            200, json={"object": "page", "id": PAGE, "properties": {}}
        )

    def mutations(self) -> list[httpx.Request]:
        return [
            r
            for r in self.requests
            if r.method == "PATCH"
            or (r.method == "POST" and not r.url.path.endswith("/query"))
        ]


class FakeWorkspace:
    """Retain synthetic external state across local SQLite restarts."""

    def __init__(self) -> None:
        self.pages: dict[str, types.Payload] = {}
        self.uploads: dict[str, types.Payload] = {}
        self.calls: list[tuple[str, object]] = []
        self.failures: dict[str, list[tuple[bool, str, bool]]] = (
            collections.defaultdict(list)
        )
        self.extra_lookup: list[types.Payload] = []

    def fail(
        self,
        method: str,
        *,
        landed: bool = False,
        code: str = "NOTION_UNKNOWN",
        cancel: bool = False,
    ) -> None:
        self.failures[method].append((landed, code, cancel))

    def count(self, method: str) -> int:
        return sum(name == method for name, _ in self.calls)

    def _mutation(self, method: str, value: object, effect):
        self.calls.append((method, copy.deepcopy(value)))
        if not self.failures[method]:
            return effect()
        landed, code, cancel = self.failures[method].pop(0)
        if landed:
            effect()
        if cancel:
            raise asyncio.CancelledError
        raise adapters.AdapterError(code, ambiguous=code == "NOTION_UNKNOWN")

    async def lookup(self, kind: str, key: str) -> list[types.Payload]:
        self.calls.append(("lookup", (kind, key)))
        return copy.deepcopy(
            [
                p
                for p in self.pages.values()
                if p["kind"] == kind and p["key"] == key
            ]
            + self.extra_lookup
        )

    async def create(self, kind: str, properties: types.Payload) -> str:
        key = "".join(
            p["text"]["content"] for p in properties["sync_key"]["rich_text"]
        )

        def effect() -> str:
            page_id = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    "offline-create/" + str(self.count("create")),
                )
            )
            self.pages[page_id] = {
                "object": "page",
                "id": page_id,
                "in_trash": False,
                "kind": kind,
                "key": key,
                "properties": copy.deepcopy(properties),
                "blocks": [],
            }
            return page_id

        return self._mutation("create", (kind, properties), effect)

    async def patch(
        self, kind: str, page_id: str, properties: types.Payload
    ) -> None:
        def effect() -> None:
            assert self.pages[page_id]["kind"] == kind
            self.pages[page_id]["properties"].update(copy.deepcopy(properties))

        self._mutation("patch", (kind, page_id, properties), effect)

    def _returned_block(
        self, block: types.Payload, page_id: str, index: int
    ) -> types.Payload:
        result = copy.deepcopy(block)
        result.update(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, page_id + "/" + str(index))),
            has_children=False,
            in_trash=False,
        )
        body = result[result["type"]]
        if result["type"] == "image":
            assert body["type"] == "file_upload"
            filename = self.uploads[body["file_upload"]["id"]]["filename"]
            result["image"] = {
                "type": "file",
                "file": {
                    "url": "https://files.example.org/uploads/"
                    + parse.quote(filename)
                    + "?signature=ephemeral-value",
                    "expiry_time": "2026-09-07T20:00:00Z",
                },
                "caption": body.get("caption", []),
            }
        for name in ("rich_text", "caption"):
            for fragment in result[result["type"]].get(name, []):
                fragment["annotations"] = {
                    "bold": False,
                    "italic": False,
                    "strikethrough": False,
                    "underline": False,
                    "code": False,
                    "color": "default",
                }
                fragment["text"].setdefault("link", None)
                fragment["plain_text"] = fragment["text"]["content"]
                fragment["href"] = None
        return result

    async def append(
        self, page_id: str, blocks: list[types.Payload]
    ) -> list[types.Payload]:
        def effect() -> list[types.Payload]:
            current = self.pages[page_id]["blocks"]
            returned = [
                self._returned_block(block, page_id, len(current) + index)
                for index, block in enumerate(blocks)
            ]
            current.extend(returned)
            return copy.deepcopy(returned)

        return self._mutation("append", (page_id, blocks), effect)

    async def children(self, page_id: str) -> list[types.Payload]:
        self.calls.append(("children", page_id))
        return copy.deepcopy(self.pages[page_id]["blocks"])

    async def get_page(self, page_id: str) -> types.Payload:
        self.calls.append(("get_page", page_id))
        return copy.deepcopy(self.pages[page_id])

    async def upload_png(self, png: bytes) -> str:
        def effect() -> str:
            upload_id = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    "offline-upload/" + str(self.count("upload_png")),
                )
            )
            self.uploads[upload_id] = {
                "png": png,
                "filename": "chart-" + hashlib.sha256(png).hexdigest() + ".png",
            }
            return upload_id

        return self._mutation("upload_png", png, effect)


class SyncRig:
    """Offline Notion outbox sync test rig."""

    def __init__(self, path: pathlib.Path, destination: types.Payload) -> None:
        self.path = path
        self.destination = destination
        self.api = FakeWorkspace()
        self.store = newsletter_store.Store(path, "mock")
        self.journal = notion_journal.NotionJournal(self.store, destination)
        self.sync = notion_sync.NotionSync(
            self.journal, self.api, include_personal=False
        )

    def restart(self) -> None:
        self.store.close()
        self.store = newsletter_store.Store(self.path, "mock")
        self.journal = notion_journal.NotionJournal(
            self.store, self.destination
        )
        self.sync = notion_sync.NotionSync(
            self.journal, self.api, include_personal=False
        )


@contextlib.contextmanager
def make_intake_rig(
    path: pathlib.Path,
    destination: types.Payload,
    bootstrap: str = "2026-09-07T12:00:00+00:00",
) -> Iterator[std_types.SimpleNamespace]:
    """Create an offline SQLite Notion intake rig with workflow schema."""
    store = newsletter_store.Store(path, "live")
    journal = notion_journal.NotionJournal(store, destination)
    journal.execute(
        "INSERT INTO metadata VALUES('notion_v2_bootstrap_at',?)", (bootstrap,)
    )
    store.db.executescript("""
        CREATE TABLE workflow_runs(
            id TEXT PRIMARY KEY, definition TEXT NOT NULL);
        CREATE TABLE workflow_artifacts(
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
            item_id TEXT NOT NULL, body TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL);
        CREATE TABLE publication_units(
            run_id TEXT NOT NULL, story_id TEXT NOT NULL, mode TEXT NOT NULL,
            issue_date TEXT NOT NULL, task TEXT NOT NULL, body TEXT NOT NULL,
            digest TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(run_id, story_id, mode, digest));
        CREATE TABLE collection_runs(
            id TEXT PRIMARY KEY, request_key TEXT NOT NULL);
        CREATE TABLE candidate_history(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    """)
    value = std_types.SimpleNamespace(
        store=store,
        journal=journal,
        intake=notion_intake.NotionIntake(journal, include_personal=False),
    )
    try:
        yield value
    finally:
        store.close()


def candidate(**changes: object) -> types.Payload:
    """Build synthetic material metadata with boundary-test overrides."""
    value = {
        "id": "candidate-fixture",
        "direction": "01-ai-ml",
        "title": "Synthetic work with a defined comparison",
        "url": "https://example.org/paper",
        "doi": "10.1234/synthetic",
        "version": "v2",
        "event_key": "synthetic-event",
        "published_at": "2026-09-06",
        "summary": (
            "The synthetic earlier baseline has a limitatio"
            "n. This work tests one change."
        ),
        "why_now": "A new synthetic comparison is available.",
        "access_scope": "abstract",
        "provenance": "discovery",
        "authors": "Synthetic Author",
        "affiliations": "Synthetic Institute",
        "venue": "Synthetic journal",
        "publication_status": "已发表",
        "contribution": (
            "Tests a specific previous assumption, not a new product name."
        ),
        "source_basis": "The synthetic primary abstract identifies the work.",
        "evidence_urls": [
            "https://example.org/paper",
            "https://example.org/authors",
        ],
    }
    return {**value, **changes}


def packet(identifier: str = "sample-packet") -> types.Payload:
    """Copy sample evidence with a caller-owned packet identity."""
    value = copy.deepcopy(rendering.SAMPLE_PACKETS[0])
    value["id"] = identifier
    value["is_fixture"] = False
    value["content_hash"] = contracts.content_hash(value["content"])
    return value


def edition(**changes: object) -> types.Payload:
    """Build a synthetic edition containing identifiable private sentinels."""
    return {
        "id": "edition-fixture",
        "issue_date": DAY,
        "state": "ready",
        "delivery_state": "not_requested",
        "packet_ids": ["sample-packet"],
        "is_fixture": False,
        "draft": copy.deepcopy(rendering.SAMPLE_DRAFT),
        "rendered": {
            "html": "<p>PRIVATE RENDERED BODY SHOULD NEVER BE COPIED</p>",
            "text": "PRIVATE RENDERED BODY SHOULD NEVER BE COPIED",
            "chart_png": base64.b64encode(PNG).decode(),
            "render_hash": "a" * 64,
        },
        "personal_digest": {
            "state": "current",
            "title": "私人事件",
            "summary": "PRIVATE SUMMARY",
            "items": [
                {"rank": 1, "title": "PRIVATE TASK", "detail": "PRIVATE DETAIL"}
            ],
            "task_count": 7,
            "time_window_hours": 24,
            "fetched_at": "2026-09-07T15:00:00Z",
            "source_label": "PRIVATE SOURCE",
            "limitations": "PRIVATE BOUNDARY",
            "is_fixture": False,
        },
        "usage": {
            "usage": {
                "input_tokens": "900",
                "cached_input_tokens": "700",
                "output_tokens": "100",
                "reasoning_output_tokens": "40",
                "total_tokens": "1000",
            },
            "invocations": 3,
            "missing_invocations": 0,
            "partial": False,
        },
        "publication": {
            "mode": "partial",
            "reason": "completed",
            "stories": [
                {
                    "story_id": "story-fixture",
                    "title": "Synthetic pending topic",
                    "candidate_ids": ["candidate-fixture"],
                    "priority": 1,
                    "disposition": "deferred",
                    "reason": "Synthetic independent review was not finished.",
                }
            ],
        },
        **changes,
    }


def block_text(blocks: list[types.Payload]) -> str:
    """Flatten rich-text blocks for public-content assertions."""
    return "\n".join(
        "".join(
            item["text"]["content"]
            for item in block[block["type"]].get("rich_text", [])
        )
        for block in blocks
    )


def project_material(
    value: types.Payload | None = None,
    *,
    evidence: list[types.Payload] | None = None,
    progress: str = "候选",
    fixture: bool = False,
) -> notion_content.Projection:
    """Project synthetic public material using fixed ledger metadata."""
    return notion_content.material_projection(
        candidate() if value is None else value,
        key="material:synthetic",
        first_seen=DAY,
        run_id="run-fixture",
        evidence=evidence,
        progress=progress,
        fixture=fixture,
    )
