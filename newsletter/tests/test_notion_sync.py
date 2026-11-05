"""Durable outbox regressions with a local FakeWorkspace; no provider calls.

All material, images, publication rows and delivery receipts are synthetic.
Tests exercise recovery, not live Notion behavior or editorial quality.
"""

import asyncio
import collections
import copy
import dataclasses
import hashlib
import importlib.resources as resources
import json
import pathlib
import sqlite3
import urllib.parse as parse

import fastapi
import httpx
import pytest

import newsletter.adapters as adapters
import newsletter.collection.instructions as instructions
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.lifecycle as lifecycle
import newsletter.notion_cli as notion_cli
import newsletter.notion_content as newsletter_notion_content
import newsletter.notion_journal as notion_journal
import newsletter.notion_sync as notion_sync
import newsletter.preflight as preflight
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.worker as worker
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.pipeline as pipeline
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.state as state
import tests.support.notion_content as notion_content
import tests.support.story_pipeline as story_pipeline

DAY = "2026-09-07"
KEY = "material:offline-fixture"
EUR_LEX_URL = (
    "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689"
)
DESTINATION = {
    "materials": "offline-materials",
    "editions": "offline-editions",
    "include_personal": False,
}

rich = notion_content.rich
paragraph = notion_content.paragraph
FakeWorkspace = notion_content.FakeWorkspace


def linked_paragraph(url):
    block = paragraph("Offline citation fixture — a real public EUR-Lex URL")
    block["paragraph"]["rich_text"][0]["text"]["link"] = {"url": url}
    return block


def projected(key=KEY, *, count=2, prefix="Offline version", chart=False):
    blocks = [
        paragraph(f"{prefix} — paragraph {index}") for index in range(count)
    ]
    if chart:
        blocks.insert(
            1,
            {
                "object": "block",
                "type": "_newsletter_chart",
                "_newsletter_chart": {
                    "caption": rich(
                        "Synthetic frozen figure, not live research"
                    )
                },
            },
        )
    digest = contracts.content_hash(
        {
            "blocks": blocks,
            "chart": hashlib.sha256(notion_content.PNG).hexdigest()
            if chart
            else "",
        }
    )
    properties = {
        "title": {"title": rich("Offline fixture")},
        "sync_key": {"rich_text": rich(key)},
        "content_hash": {"rich_text": rich(digest)},
        "fixture": {"checkbox": True},
        "sync_state": {"select": {"name": "同步中"}},
    }
    return newsletter_notion_content.Projection(
        key, properties, blocks, digest, notion_content.PNG if chart else None
    )


class Rig(notion_content.SyncRig):
    def __init__(self, path):
        super().__init__(path, DESTINATION)

    def due(self):
        self.journal.execute("UPDATE notion_entities SET retry_at=0")

    def page(self, key=KEY):
        return self.api.pages[self.journal.entity(key)["page_id"]]

    def versions(self, key=KEY):
        return self.journal.versions(key)

    async def drain(self, limit=100):
        for _ in range(limit):
            if not await self.sync.step():
                return
        pytest.fail(
            "Offline Notion outbox did not become idle within the bounded steps"
        )


@pytest.fixture
def rig(tmp_path, monkeypatch):
    async def no_network(*args, **kwargs):
        pytest.fail(
            "An offline Notion sync test attempted a real network request"
        )

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", no_network
    )
    value = Rig(tmp_path / "newsletter.sqlite3")
    yield value
    value.store.close()


async def test_enqueue_orders_properties_body_and_synced_state(
    rig,
):
    projection = newsletter_notion_content.material_projection(
        notion_content.candidate(),
        key=KEY,
        first_seen=DAY,
        run_id="offline-run",
        fixture=True,
    )
    before = copy.deepcopy(projection)
    rig.journal.enqueue("material", projection)
    await rig.drain()
    assert projection == before
    assert rig.journal.entity(KEY)["create_state"] == "ready"
    assert rig.versions()[0]["state"] == "done"
    assert rig.versions()[0]["offset"] == len(projection.blocks)
    assert rig.page()["properties"]["sync_state"] == {
        "select": {"name": "已同步"}
    }
    assert [name for name, _ in rig.api.calls] == [
        "lookup",
        "create",
        "children",
        "append",
        "patch",
    ]
    assert [notion_sync.block_signature(b) for b in rig.page()["blocks"]] == [
        notion_sync.block_signature(b) for b in projection.blocks
    ]


async def test_duplicate_enqueue_and_restart_never_repeat_writes(
    rig,
):
    projection = newsletter_notion_content.material_projection(
        notion_content.candidate(),
        key=KEY,
        first_seen=DAY,
        run_id="offline-run",
        fixture=True,
    )
    rig.journal.enqueue("material", projection)
    await rig.drain()
    before = copy.deepcopy(rig.api.calls)
    for _ in range(3):
        rig.journal.enqueue("material", projection)
        assert rig.sync.intake.scan() == 0
        await rig.drain()
    rig.restart()
    rig.journal.enqueue("material", projection)
    await rig.drain()
    assert rig.api.calls == before
    assert len(rig.versions()) == 1


@pytest.mark.parametrize("landed", [False, True])
async def test_unknown_create_recovers_by_lookup_not_recreation(rig, landed):
    rig.journal.enqueue("material", projected())
    rig.api.fail("create", landed=landed)
    assert await rig.sync.step()
    assert rig.journal.entity(KEY)["create_state"] == "unknown"
    assert rig.api.count("create") == 1
    rig.restart()
    rig.journal.clock = lambda: 7.0
    for _ in range(2):
        rig.due()
        await rig.drain()
    assert rig.api.count("create") == 1
    if landed:
        assert rig.versions()[0]["state"] == "done"
        assert rig.api.count("append") == 1
        assert rig.journal.entity(KEY)["progress_at"] == 7.0
    else:
        assert not rig.api.pages and not rig.api.count("append")
        assert rig.journal.entity(KEY)["create_state"] == "unknown"
        assert rig.journal.entity(KEY)["error"] == "NOTION_CREATE_UNCONFIRMED"
        assert rig.api.count("lookup") == 3
        # Reading without confirming the create is never progress.
        assert rig.journal.entity(KEY)["progress_at"] == 0


@pytest.mark.parametrize("landed", [False, True])
async def test_unknown_append_reads_the_pending_prefix_without_repeating_append(
    rig, landed
):
    projection = projected()
    rig.journal.enqueue("material", projection)
    assert await rig.sync.step()  # Properties-only page creation.
    rig.api.fail("append", landed=landed)
    assert await rig.sync.step()
    failed = rig.versions()[0]
    assert failed["state"] == "unknown" and failed["offset"] == 0
    assert json.loads(failed["pending_chunk"]) == [
        notion_sync.block_signature(b) for b in projection.blocks
    ]
    rig.restart()
    for _ in range(2):
        rig.due()
        await rig.drain()
    assert rig.api.count("append") == 1
    if landed:
        assert rig.versions()[0]["state"] == "done"
        assert rig.versions()[0]["pending_chunk"] == ""
        assert len(rig.page()["blocks"]) == len(projection.blocks)
    else:
        assert rig.versions()[0]["state"] == "unknown"
        assert rig.journal.entity(KEY)["error"] == "NOTION_APPEND_UNCONFIRMED"
        assert not rig.page()["blocks"]


@pytest.mark.parametrize("escaped", ["%3A", "%3a"])
def test_eur_lex_colon_normalization_keeps_signature_and_blocks(
    escaped,
):
    expected = linked_paragraph(EUR_LEX_URL)
    actual = linked_paragraph(EUR_LEX_URL.replace("CELEX:", "CELEX" + escaped))
    before = copy.deepcopy((expected, actual))
    hashes = [contracts.content_hash(block) for block in before]
    assert notion_sync.block_signature(expected) == notion_sync.block_signature(
        actual
    )
    assert (expected, actual) == before
    assert [
        contracts.content_hash(block) for block in (expected, actual)
    ] == hashes


@pytest.mark.parametrize(
    ("expected", "actual"),
    [
        (EUR_LEX_URL, EUR_LEX_URL.replace("32024R1689", "32024R1688")),
        (EUR_LEX_URL, EUR_LEX_URL + "#article-1"),
        (EUR_LEX_URL + "#article:1", EUR_LEX_URL + "#article%3A1"),
        (EUR_LEX_URL + "&view=1", EUR_LEX_URL.replace("?", "?view=1&")),
        (EUR_LEX_URL + "&view=1&view=2", EUR_LEX_URL + "&view=2&view=1"),
        (EUR_LEX_URL + "&view=1&view=1", EUR_LEX_URL + "&view=1"),
        (EUR_LEX_URL + "&q=a+b", EUR_LEX_URL + "&q=a%20b"),
        (EUR_LEX_URL + "&q=a%2Fb", EUR_LEX_URL + "&q=a/b"),
        (EUR_LEX_URL + "&q=a%26b", EUR_LEX_URL + "&q=a&b"),
        (EUR_LEX_URL + "&q=a%3Db", EUR_LEX_URL + "&q=a=b"),
        (EUR_LEX_URL + "&q=a%253Ab", EUR_LEX_URL + "&q=a%3Ab"),
        (EUR_LEX_URL + "&q:r=x", EUR_LEX_URL + "&q%3Ar=x"),
        (
            EUR_LEX_URL.replace("/TXT/", "/TXT:/"),
            EUR_LEX_URL.replace("/TXT/", "/TXT%3A/"),
        ),
        (EUR_LEX_URL, EUR_LEX_URL.replace("/TXT/?", "/TXT?")),
        (EUR_LEX_URL, EUR_LEX_URL.replace("https:", "http:")),
        (EUR_LEX_URL, EUR_LEX_URL.replace("eur-lex.europa.eu", "example.org")),
    ],
    ids=[
        "query-value",
        "new-fragment",
        "fragment-escape",
        "query-order",
        "duplicate-order",
        "duplicate-removed",
        "plus-space",
        "encoded-slash",
        "encoded-ampersand",
        "encoded-equals",
        "double-escape",
        "query-key-escape",
        "path-escape",
        "non-root-slash",
        "scheme",
        "host",
    ],
)
def test_link_signature_does_not_hide_other_source_url_changes(
    expected, actual
):
    assert notion_sync.block_signature(
        linked_paragraph(expected)
    ) != notion_sync.block_signature(linked_paragraph(actual))


def encode_eur_lex_response(monkeypatch, api):
    original = api._returned_block

    def returned(block, page_id, index):
        result = original(block, page_id, index)
        for fragment in result[result["type"]].get("rich_text", []):
            link = fragment["text"].get("link")
            if link:
                link["url"] = EUR_LEX_URL.replace("CELEX:", "CELEX%3A")
        return result

    monkeypatch.setattr(api, "_returned_block", returned)


async def test_equivalent_append_link_keeps_snapshot_without_reappend(
    rig, monkeypatch
):
    blocks = [linked_paragraph(EUR_LEX_URL)]
    projection = dataclasses.replace(
        projected(), blocks=blocks, digest=contracts.content_hash(blocks)
    )
    before = copy.deepcopy(projection)
    encode_eur_lex_response(monkeypatch, rig.api)
    rig.journal.enqueue("material", projection)
    await rig.drain()
    assert rig.versions()[0]["state"] == "done"
    assert rig.versions()[0]["digest"] == before.digest
    assert json.loads(rig.versions()[0]["blocks"]) == before.blocks
    assert projection == before
    assert rig.api.count("append") == 1
    assert rig.page()["blocks"][0]["paragraph"]["rich_text"][0]["text"]["link"][
        "url"
    ] == (EUR_LEX_URL.replace("CELEX:", "CELEX%3A"))
    rig.restart()
    await rig.drain()
    assert rig.api.count("append") == 1


@pytest.mark.parametrize(
    "original_url", [EUR_LEX_URL, EUR_LEX_URL.replace("CELEX:", "CELEX%3a")]
)
async def test_legacy_link_append_recovers_read_only_after_restart(
    rig, monkeypatch, original_url
):
    blocks = [linked_paragraph(original_url)]
    projection = dataclasses.replace(
        projected(), blocks=blocks, digest=contracts.content_hash(blocks)
    )
    encode_eur_lex_response(monkeypatch, rig.api)
    rig.journal.enqueue("material", projection)
    assert await rig.sync.step()
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    assert rig.versions()[0]["state"] == "unknown"
    # A pre-fix checkpoint contains the original link spelling, not a newly
    # computed canonical signature. Reconcile it without rewriting source data.
    legacy_pending = [notion_sync.block_signature(blocks[0])]
    legacy_pending[0]["text"][0]["format"]["link"] = original_url
    rig.journal.execute(
        "UPDATE notion_versions SET pending_chunk=?",
        (json.dumps(legacy_pending),),
    )
    body = copy.deepcopy(rig.page()["blocks"])
    frozen = (rig.versions()[0]["blocks"], rig.versions()[0]["digest"])
    rig.restart()
    rig.due()
    before = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[before:]] == ["children"]
    assert rig.versions()[0]["state"] == "done"
    assert rig.versions()[0]["pending_chunk"] == ""
    await rig.drain()
    assert rig.api.count("append") == 1 and rig.api.count("create") == 1
    assert rig.page()["blocks"] == body
    assert (rig.versions()[0]["blocks"], rig.versions()[0]["digest"]) == frozen


async def test_persisted_unknown_link_conflict_recovers_in_one_read_only_step(
    rig, monkeypatch
):
    blocks = [linked_paragraph(EUR_LEX_URL)]
    projection = dataclasses.replace(
        projected(), blocks=blocks, digest=contracts.content_hash(blocks)
    )
    encode_eur_lex_response(monkeypatch, rig.api)
    rig.journal.enqueue("material", projection)
    assert await rig.sync.step()
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    rig.journal.execute(
        "UPDATE notion_entities SET create_state='conflict',"
        "error='NOTION_PROJECTION_CONFLICT'"
    )
    frozen = (rig.versions()[0]["blocks"], rig.versions()[0]["digest"])
    body = copy.deepcopy(rig.page()["blocks"])
    rig.restart()
    rig.due()
    before = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[before:]] == ["children"]
    assert rig.journal.entity(KEY)["create_state"] == "ready"
    assert rig.journal.entity(KEY)["error"] == ""
    assert (
        rig.versions()[0]["state"] == "done"
        and rig.versions()[0]["offset"] == 1
    )
    assert (rig.versions()[0]["blocks"], rig.versions()[0]["digest"]) == frozen
    await rig.drain()
    assert rig.api.count("create") == rig.api.count("append") == 1
    assert rig.page()["blocks"] == body


@pytest.mark.parametrize("checkpoint_count", [40, 80])
async def test_partial_conflict_appends_only_original_pending_tail(
    rig, monkeypatch, checkpoint_count
):
    blocks = [linked_paragraph(EUR_LEX_URL) for _ in range(103)]
    for index, block in enumerate(blocks):
        block["paragraph"]["rich_text"][0]["text"]["content"] += (
            f" — item {index}"
        )
    projection = dataclasses.replace(
        projected(), blocks=blocks, digest=contracts.content_hash(blocks)
    )
    encode_eur_lex_response(monkeypatch, rig.api)
    rig.journal.enqueue("material", projection)
    assert await rig.sync.step()
    rig.api.fail("append", landed=True)
    original_chunk = notion_sync._chunk
    # A legacy checkpoint may have used a smaller chunk than today's limit.
    with monkeypatch.context() as historical:
        historical.setattr(
            notion_sync,
            "_chunk",
            lambda items, offset: original_chunk(items, offset)[
                :checkpoint_count
            ],
        )
        assert await rig.sync.step()
    assert (
        rig.versions()[0]["state"] == "unknown"
        and rig.versions()[0]["offset"] == 0
    )
    assert (
        len(json.loads(rig.versions()[0]["pending_chunk"])) == checkpoint_count
    )
    rig.journal.execute("UPDATE notion_entities SET create_state='conflict'")
    prefix = copy.deepcopy(rig.page()["blocks"])
    rig.restart()
    rig.due()
    before = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[before:]] == ["children"]
    assert rig.versions()[0]["offset"] == checkpoint_count
    assert (
        rig.versions()[0]["state"] == "pending" and rig.api.count("append") == 1
    )
    assert rig.page()["blocks"] == prefix
    await rig.drain()
    assert [
        len(value[1]) for name, value in rig.api.calls if name == "append"
    ] == [
        checkpoint_count,
        103 - checkpoint_count,
    ]
    assert (
        rig.versions()[0]["state"] == "done"
        and rig.versions()[0]["offset"] == 103
    )
    assert [
        notion_sync.block_signature(block) for block in rig.page()["blocks"]
    ] == [notion_sync.block_signature(block) for block in blocks]


@pytest.mark.parametrize("unknown", [False, True])
@pytest.mark.parametrize("edit", ["text", "link"])
async def test_human_edit_conflicts_until_undo_and_read_only_recovery(
    rig, unknown, edit
):
    blocks = [linked_paragraph(EUR_LEX_URL) for _ in range(103)]
    projection = dataclasses.replace(
        projected(), blocks=blocks, digest=contracts.content_hash(blocks)
    )
    rig.journal.enqueue("material", projection)
    assert await rig.sync.step()
    if unknown:
        rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    pristine = copy.deepcopy(rig.page()["blocks"])
    text = rig.page()["blocks"][0]["paragraph"]["rich_text"][0]["text"]
    if edit == "text":
        text["content"] = "Reader-authored note must not be overwritten"
    else:
        text["link"]["url"] += "#reader-selected-article"
    edited = copy.deepcopy(rig.page()["blocks"])
    rig.due()
    assert await rig.sync.step()
    assert rig.journal.entity(KEY)["create_state"] == "conflict"
    rig.restart()
    for _ in range(2):
        rig.due()
        before = len(rig.api.calls)
        assert await rig.sync.step()
        assert [name for name, _ in rig.api.calls[before:]] == ["children"]
        assert rig.journal.entity(KEY)["create_state"] == "conflict"
        assert rig.page()["blocks"] == edited and rig.api.count("append") == 1
    # Only the simulated user restores their edit. The synchronizer never does.
    rig.page()["blocks"] = pristine
    rig.due()
    before = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[before:]] == ["children"]
    assert rig.journal.entity(KEY)["create_state"] == "ready"
    assert (
        rig.versions()[0]["state"] == "pending"
        and rig.versions()[0]["offset"] == 80
    )
    assert rig.page()["blocks"] == pristine and rig.api.count("append") == 1
    await rig.drain()
    assert [
        len(value[1]) for name, value in rig.api.calls if name == "append"
    ] == [80, 23]
    assert rig.versions()[0]["state"] == "done"


@pytest.mark.parametrize("finished", [False, True])
async def test_unbound_or_terminal_conflict_cannot_open_write_path(
    rig, finished
):
    rig.journal.enqueue("material", projected())
    if finished:
        await rig.drain()
    rig.journal.execute("UPDATE notion_entities SET create_state='conflict'")
    versions = copy.deepcopy(rig.versions())
    before = copy.deepcopy(rig.api.calls)
    rig.restart()
    rig.due()
    await rig.sync.step()
    assert rig.journal.entity(KEY)["create_state"] == "conflict"
    assert rig.versions() == versions and rig.api.calls == before


async def test_large_material_chunked_to_eighty_completed_in_original_order(
    rig,
):
    projection = projected(count=173)
    rig.journal.enqueue("material", projection)
    await rig.drain()
    chunks = [value[1] for name, value in rig.api.calls if name == "append"]
    assert [len(chunk) for chunk in chunks] == [80, 80, 13]
    assert [b for chunk in chunks for b in chunk] == projection.blocks
    assert (
        rig.versions()[0]["offset"] == 173
        and rig.versions()[0]["state"] == "done"
    )


async def test_unknown_chunk_recovers_prefix_then_appends_tail(
    rig,
):
    projection = projected(count=173)
    rig.journal.enqueue("material", projection)
    assert await rig.sync.step() and await rig.sync.step()
    assert rig.versions()[0]["offset"] == 80
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    assert (
        rig.versions()[0]["offset"] == 80 and len(rig.page()["blocks"]) == 160
    )
    rig.restart()
    rig.due()
    await rig.drain()
    assert (
        rig.versions()[0]["state"] == "done"
        and rig.versions()[0]["offset"] == 173
    )
    assert [
        len(value[1]) for name, value in rig.api.calls if name == "append"
    ] == [80, 80, 13]
    assert [notion_sync.block_signature(b) for b in rig.page()["blocks"]] == [
        notion_sync.block_signature(b) for b in projection.blocks
    ]


async def test_chunk_byte_budget_is_respected_before_eighty_items(rig):
    blocks = [paragraph("界" * 1800) for _ in range(80)]
    projection = dataclasses.replace(
        projected(), blocks=blocks, digest=contracts.content_hash(blocks)
    )
    rig.journal.enqueue("material", projection)
    await rig.drain()
    chunks = [value[1] for name, value in rig.api.calls if name == "append"]
    assert len(chunks) > 1 and sum(map(len, chunks)) == 80
    assert all(
        len(
            json.dumps(
                {"children": chunk},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        )
        <= 400_000
        for chunk in chunks
    )


async def test_delivery_property_changes_do_not_append_a_second_archive_body(
    rig,
):
    original = newsletter_notion_content.edition_projection(
        notion_content.edition(),
        run_id="offline-run",
        packets=[notion_content.packet()],
        include_personal=False,
    )
    accepted = newsletter_notion_content.edition_projection(
        notion_content.edition(delivery_state="provider_accepted"),
        run_id="offline-run",
        packets=[notion_content.packet()],
        include_personal=False,
    )
    assert (
        accepted.digest == original.digest
        and accepted.blocks == original.blocks
    )
    rig.journal.enqueue("edition", original)
    await rig.drain()
    before = collections.Counter(name for name, _ in rig.api.calls)
    body = copy.deepcopy(rig.page(original.key)["blocks"])
    rig.journal.enqueue("edition", accepted)
    await rig.drain()
    after = collections.Counter(name for name, _ in rig.api.calls)
    assert after["create"] == before["create"]
    assert after["append"] == before["append"]
    assert after["upload_png"] == before["upload_png"]
    assert after["patch"] == before["patch"] + 1
    assert rig.page(original.key)["blocks"] == body
    assert rig.page(original.key)["properties"]["delivery"] == {
        "select": {"name": "已提交"}
    }


async def test_frozen_edition_body_change_is_rejected_transactionally(rig):
    first = projected("edition:offline")
    second = projected("edition:offline", prefix="Changed body")
    rig.journal.enqueue("edition", first)
    before = copy.deepcopy(rig.journal.entity(first.key))
    with pytest.raises(ValueError, match="notion_frozen_edition_changed"):
        rig.journal.enqueue("edition", second)
    assert rig.journal.entity(first.key) == before
    assert len(rig.versions(first.key)) == 1 and not rig.api.calls


@pytest.mark.parametrize("edit", ["change", "insert", "delete"])
async def test_human_body_edits_conflict_without_deleting_or_overwriting_them(
    rig, edit
):
    first = projected(count=81)
    rig.journal.enqueue("material", first)
    assert await rig.sync.step() and await rig.sync.step()
    assert rig.versions()[0]["offset"] == 80
    current = rig.page()["blocks"]
    if edit == "change":
        current[0]["paragraph"]["rich_text"] = rich(
            "Reader-authored personal note"
        )
    elif edit == "insert":
        current.insert(0, paragraph("Reader-authored personal note"))
    else:
        current.pop(0)
    edited = copy.deepcopy(current)
    assert await rig.sync.step()
    assert rig.journal.entity(KEY)["create_state"] == "conflict"
    assert rig.journal.entity(KEY)["error"] == "NOTION_PROJECTION_CONFLICT"
    assert rig.page()["blocks"] == edited and rig.api.count("append") == 1
    assert not await rig.sync.step()


@pytest.mark.parametrize("count", [3, 103])
async def test_old_conflict_reads_before_appending_unwritten_tail(rig, count):
    projection = projected(count=count - 1, chart=True)
    projection.blocks[-1 if count == 3 else 63] = linked_paragraph(EUR_LEX_URL)
    projection = dataclasses.replace(
        projection, digest=contracts.content_hash(projection.blocks)
    )
    rig.journal.enqueue("edition", projection)
    assert await rig.sync.step() and await rig.sync.step()  # Create, upload.
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    for block in rig.page()["blocks"]:
        for part in block[block["type"]].get("rich_text", []):
            if part["text"].get("link"):
                part["text"]["link"]["url"] = EUR_LEX_URL.replace(
                    "CELEX:", "CELEX%3A"
                )
    rig.journal.execute(
        "UPDATE notion_entities SET create_state='conflict',"
        "error='NOTION_PROJECTION_CONFLICT'"
    )
    # Mimic an old signature receipt and an expired upload already attached.
    old_receipt = rig.versions()[0]["pending_chunk"].replace(
        "CELEX:", "CELEX%3a"
    )
    rig.journal.execute(
        "UPDATE notion_versions SET pending_chunk=?,upload_at=upload_at-3600",
        (old_receipt,),
    )
    frozen = (rig.versions()[0]["blocks"], rig.versions()[0]["digest"])
    remote_before = copy.deepcopy(rig.page()["blocks"])
    rig.restart()
    rig.due()
    start = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[start:]] == ["children"]
    assert rig.journal.entity(KEY)["create_state"] == "ready"
    assert rig.journal.entity(KEY)["error"] == ""
    assert rig.versions()[0]["offset"] == min(count, 80)
    assert rig.page()["blocks"] == remote_before
    assert rig.api.count("append") == rig.api.count("upload_png") == 1
    await rig.drain()
    assert rig.versions()[0]["state"] == "done"
    assert len(rig.page()["blocks"]) == count
    assert [
        len(value[1]) for name, value in rig.api.calls if name == "append"
    ] == ([count] if count <= 80 else [80, count - 80])
    assert rig.api.count("upload_png") == 1
    assert (rig.versions()[0]["blocks"], rig.versions()[0]["digest"]) == frozen


async def test_body_conflict_writes_only_after_undo_and_fresh_read(
    rig,
):
    rig.journal.enqueue("material", projected(count=81))
    assert await rig.sync.step() and await rig.sync.step()
    original = copy.deepcopy(rig.page()["blocks"])
    rig.page()["blocks"][0] = paragraph("Reader's own note")
    assert await rig.sync.step()
    edited = copy.deepcopy(rig.page()["blocks"])
    for _ in range(2):
        rig.due()
        start = len(rig.api.calls)
        assert await rig.sync.step()
        assert [name for name, _ in rig.api.calls[start:]] == ["children"]
        assert rig.journal.entity(KEY)["create_state"] == "conflict"
        assert rig.page()["blocks"] == edited
    rig.page()["blocks"] = original  # Reader explicitly undoes the edit.
    rig.due()
    start = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[start:]] == ["children"]
    assert rig.journal.entity(KEY)["create_state"] == "ready"
    assert rig.api.count("append") == 1
    await rig.drain()
    assert [
        len(value[1]) for name, value in rig.api.calls if name == "append"
    ] == [80, 1]


async def test_unlanded_unknown_conflict_stays_uncertain_without_any_write(rig):
    rig.journal.enqueue("material", projected())
    assert await rig.sync.step()
    rig.api.fail("append", landed=False)
    assert await rig.sync.step()
    rig.journal.execute("UPDATE notion_entities SET create_state='conflict'")
    rig.due()
    start = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[start:]] == ["children"]
    assert rig.journal.entity(KEY)["create_state"] == "conflict"
    assert rig.journal.entity(KEY)["error"] == "NOTION_APPEND_UNCONFIRMED"
    assert rig.versions()[0]["state"] == "unknown"
    assert rig.api.count("append") == 1 and not rig.page()["blocks"]


async def test_unbound_identity_conflict_never_selects_or_creates_page(
    rig,
):
    rig.journal.enqueue("material", projected())
    rig.journal.execute("UPDATE notion_entities SET create_state='conflict'")
    assert await rig.sync.step()
    assert rig.journal.entity(KEY)["create_state"] == "conflict"
    assert not rig.api.calls


async def test_chart_upload_replaces_placeholder_and_recovers_append(
    rig,
):
    projection = projected(chart=True)
    rig.journal.enqueue("edition", projection)
    assert await rig.sync.step()  # Create page.
    assert (
        await rig.sync.step()
    )  # Persist uploaded PNG ID separately from append.
    assert rig.api.count("upload_png") == 1
    upload = rig.versions()[0]["upload_id"]
    assert rig.api.uploads[upload]["png"] == notion_content.PNG
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    sent = next(value[1] for name, value in rig.api.calls if name == "append")
    assert not any(b["type"] == "_newsletter_chart" for b in sent)
    image = next(b for b in sent if b["type"] == "image")
    assert image["image"]["file_upload"]["id"] == upload
    returned = next(b for b in rig.page()["blocks"] if b["type"] == "image")
    expected = (
        "chart-" + hashlib.sha256(notion_content.PNG).hexdigest() + ".png"
    )
    assert notion_sync.block_signature(returned)["filename"] == expected
    returned["image"]["file"]["url"] = (
        "https://files.example.org/new-expiring-path/"
        + parse.quote(expected)
        + "?signature=rotated"
    )
    rig.restart()
    rig.due()
    await rig.drain()
    assert rig.versions()[0]["state"] == "done"
    assert rig.api.count("append") == rig.api.count("upload_png") == 1


async def test_wrong_image_basename_is_conflict_not_permission_to_append_again(
    rig,
):
    rig.journal.enqueue("edition", projected(chart=True))
    assert await rig.sync.step() and await rig.sync.step()
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    image = next(b for b in rig.page()["blocks"] if b["type"] == "image")
    image["image"]["file"]["url"] = (
        "https://files.example.org/different.png?signature=x"
    )
    before = copy.deepcopy(rig.page()["blocks"])
    rig.due()
    assert await rig.sync.step()
    assert rig.journal.entity(KEY)["create_state"] == "conflict"
    assert rig.page()["blocks"] == before and rig.api.count("append") == 1


async def test_expired_unattached_upload_refreshes_before_append(
    rig,
):
    rig.journal.enqueue("edition", projected(chart=True))
    assert await rig.sync.step() and await rig.sync.step()
    old_upload = rig.versions()[0]["upload_id"]
    assert (
        old_upload and not rig.page()["blocks"] and rig.api.count("append") == 0
    )
    rig.journal.execute("UPDATE notion_versions SET upload_at=upload_at-3301")
    rig.restart()
    assert rig.versions()[0]["state"] == "pending"
    assert await rig.sync.step()
    new_upload = rig.versions()[0]["upload_id"]
    assert new_upload != old_upload and rig.api.count("upload_png") == 2
    assert (
        rig.api.count("append") == 0
    )  # Upload refresh alone does not create body.
    await rig.drain()
    chunks = [value[1] for name, value in rig.api.calls if name == "append"]
    uploaded_ids = [
        b["image"]["file_upload"]["id"]
        for chunk in chunks
        for b in chunk
        if b["type"] == "image"
    ]
    assert uploaded_ids == [new_upload]
    assert rig.versions()[0]["state"] == "done" and rig.api.count("append") == 1


async def test_landed_unknown_append_recovers_without_reupload(
    rig,
):
    rig.journal.enqueue("edition", projected(chart=True))
    assert await rig.sync.step() and await rig.sync.step()
    upload = rig.versions()[0]["upload_id"]
    rig.api.fail("append", landed=True)
    assert await rig.sync.step()
    assert rig.versions()[0]["state"] == "unknown"
    body = copy.deepcopy(rig.page()["blocks"])
    rig.journal.execute("UPDATE notion_versions SET upload_at=upload_at-3301")
    rig.restart()
    rig.due()
    before = len(rig.api.calls)
    assert await rig.sync.step()
    assert [name for name, _ in rig.api.calls[before:]] == ["children"]
    assert rig.versions()[0]["state"] == "done"
    assert rig.versions()[0]["upload_id"] == upload
    await rig.drain()
    assert rig.page()["blocks"] == body
    assert rig.api.count("upload_png") == rig.api.count("append") == 1


def delivery_tables(store):
    names = (
        "packets",
        "editions",
        "sends",
        "verification_sends",
        "workflow_editions",
    )
    return {
        name: [
            tuple(row)
            for row in store.db.execute("SELECT * FROM " + name).fetchall()
        ]
        for name in names
    }


@pytest.mark.parametrize("phase", ["create", "append", "patch"])
async def test_rate_limit_retry_keeps_publication_and_send_ledgers(rig, phase):
    unrelated = rig.store.prepare(
        {
            "request_key": "offline-unrelated-edition",
            "issue_date": DAY,
            "packet_ids": [],
        }
    )
    rig.journal.execute(
        "INSERT INTO sends VALUES(?,?,?,?)",
        (DAY, unrelated["id"], "offline-send-receipt", "f" * 64),
    )
    before = delivery_tables(rig.store)
    rig.journal.enqueue("material", projected())
    if phase in {"append", "patch"}:
        assert await rig.sync.step()
    if phase == "patch":
        assert await rig.sync.step()
    rig.api.fail(phase, code="NOTION_RATE_LIMITED")
    assert await rig.sync.step()
    assert rig.journal.entity(KEY)["error"] == "NOTION_RATE_LIMITED"
    assert rig.journal.entity(KEY)["attempts"] == 1
    assert rig.journal.entity(KEY)["retry_at"] > 0
    calls = copy.deepcopy(rig.api.calls)
    assert not await rig.sync.step() and rig.api.calls == calls
    rig.due()
    await rig.drain()
    assert rig.versions()[0]["state"] == "done"
    assert rig.api.count(phase) == 2
    assert delivery_tables(rig.store) == before


@pytest.mark.parametrize("phase", ["create", "append"])
@pytest.mark.parametrize("landed", [False, True])
async def test_cancellation_preserves_unknown_without_blind_replay(
    rig, phase, landed
):
    rig.journal.enqueue("material", projected())
    if phase == "append":
        assert await rig.sync.step()
    rig.api.fail(phase, landed=landed, cancel=True)
    with pytest.raises(asyncio.CancelledError):
        await rig.sync.step()
    if phase == "create":
        assert rig.journal.entity(KEY)["create_state"] == "unknown"
    else:
        assert rig.versions()[0]["state"] == "unknown"
    rig.restart()
    await rig.drain()
    assert rig.api.count(phase) == 1
    if landed:
        assert rig.versions()[0]["state"] == "done"
    else:
        assert (
            rig.journal.entity(KEY)["error"]
            == "NOTION_" + phase.upper() + "_UNCONFIRMED"
        )


async def test_versions_append_in_order_without_recreating_page(
    rig,
):
    first = projected(count=83, prefix="First frozen material")
    second = projected(count=4, prefix="Second frozen material")
    third = projected(count=2, prefix="Third frozen material")
    for projection in (first, second, third, second):
        rig.journal.enqueue("material", projection)
    await rig.drain()
    versions = rig.versions()
    assert [v["digest"] for v in versions] == [
        p.digest for p in (first, second, third)
    ]
    assert all(v["state"] == "done" for v in versions)
    assert [notion_sync.block_signature(b) for b in rig.page()["blocks"]] == [
        notion_sync.block_signature(b)
        for p in (first, second, third)
        for b in p.blocks
    ]
    assert rig.api.count("create") == 1
    assert [
        len(value[1]) for name, value in rig.api.calls if name == "append"
    ] == [80, 3, 4, 2]


async def test_unknown_first_version_blocks_later_versions(
    rig,
):
    first, second = projected(prefix="First"), projected(prefix="Second")
    rig.journal.enqueue("material", first)
    rig.journal.enqueue("material", second)
    assert await rig.sync.step()
    rig.api.fail("append", landed=False)
    assert await rig.sync.step()
    rig.due()
    await rig.drain()
    assert [v["state"] for v in rig.versions()] == ["unknown", "pending"]
    assert rig.api.count("append") == 1 and not rig.page()["blocks"]


async def test_scan_imports_real_artifact_timestamp_once_and_restart_is_a_no_op(
    rig,
):
    repository = newsletter_workflow_repository.WorkflowRepository(rig.store)
    definition = newsletter_workflow_definition.load_definition(
        pathlib.Path(
            str(resources.files("newsletter").joinpath("workflows/daily.yaml"))
        )
    )
    repository.start("offline-candidate-run", definition, {"issue_date": DAY})
    with rig.store.transaction():
        artifact = repository._artifact(
            "offline-candidate-run",
            "candidates",
            "",
            {"candidates": [notion_content.candidate()]},
        )
    assert (
        "T"
        in rig.journal.rows(
            "SELECT created_at FROM workflow_artifacts WHERE id=?", (artifact,)
        )[0]["created_at"]
    )
    assert rig.sync.intake.scan() == 1
    imported = rig.journal.rows(
        "SELECT * FROM notion_imports WHERE kind='candidates'"
    )
    assert len(imported) == 1 and imported[0]["error"] == ""
    entities = rig.journal.rows("SELECT * FROM notion_entities")
    assert len(entities) == 1 and entities[0]["kind"] == "material"
    await rig.drain()
    calls = copy.deepcopy(rig.api.calls)
    rig.restart()
    assert rig.sync.intake.scan() == 0
    await rig.drain()
    assert rig.api.calls == calls


def test_destination_change_requires_migration_not_reassignment(
    rig,
):
    rig.journal.enqueue("material", projected())
    before = rig.journal.entity(KEY)
    with pytest.raises(ValueError, match="explicit migration required"):
        notion_journal.NotionJournal(
            rig.store, {**DESTINATION, "editions": "another-destination"}
        )
    assert rig.journal.entity(KEY) == before


async def test_confirmed_progress_is_stamped_without_changing_remote_calls(
    tmp_path,
):
    ticks = iter([1_000.0, 2_000.0, 3_000.0])
    plain = Rig(tmp_path / "plain.sqlite3")
    stamped = Rig(tmp_path / "stamped.sqlite3")
    stamped.journal.clock = lambda: next(ticks)
    for rig in (plain, stamped):
        rig.journal.enqueue("material", projected())
        assert rig.journal.entity(KEY)["progress_at"] == 0
        rig.api.fail("create", code="NOTION_RATE_LIMITED")
        assert await rig.sync.step()
    # A deferral is not progress.
    assert stamped.journal.entity(KEY)["progress_at"] == 0
    assert stamped.journal.entity(KEY)["error"] == "NOTION_RATE_LIMITED"
    for rig in (plain, stamped):
        rig.due()
        await rig.drain()
    # The last confirmed step (the property update) owns the stamp.
    assert stamped.journal.entity(KEY)["progress_at"] == 3_000.0
    assert stamped.journal.entity(KEY)["error"] == ""
    # Only local bookkeeping differs: the remote call log is identical.
    assert stamped.api.calls == plain.api.calls
    for rig in (plain, stamped):
        rig.store.close()


async def test_progress_stamp_follows_each_confirmed_step(rig):
    ticks = iter(float(second) for second in range(100, 200))
    rig.journal.clock = lambda: next(ticks)
    rig.journal.enqueue("material", projected())
    stamps = []
    while await rig.sync.step():
        stamps.append(rig.journal.entity(KEY)["progress_at"])
    # create, append and the property update each stamp once, in order.
    assert stamps == [100.0, 101.0, 102.0]
    assert [name for name, _ in rig.api.calls] == [
        "lookup",
        "create",
        "children",
        "append",
        "patch",
    ]


def test_old_journal_schema_gains_progress_column_once(tmp_path):
    path = tmp_path / "old.sqlite3"
    store = newsletter_store.Store(path, "mock")
    with store.transaction():
        # The entity table exactly as written before progress_at existed.
        store.db.execute(
            "CREATE TABLE notion_entities ("
            "key TEXT PRIMARY KEY, kind TEXT NOT NULL, "
            "page_id TEXT NOT NULL DEFAULT '', "
            "create_state TEXT NOT NULL DEFAULT 'new', "
            "properties TEXT NOT NULL, "
            "applied_hash TEXT NOT NULL DEFAULT '', "
            "error TEXT NOT NULL DEFAULT '', "
            "retry_at REAL NOT NULL DEFAULT 0, "
            "attempts INTEGER NOT NULL DEFAULT 0)"
        )
        store.db.execute(
            "INSERT INTO notion_entities(key,kind,create_state,properties,"
            "error,attempts) VALUES (?,?,?,?,?,?)",
            (KEY, "material", "ready", "{}", "NOTION_UNKNOWN", 2),
        )
    journal = notion_journal.NotionJournal(
        store, DESTINATION, clock=lambda: 42.0
    )
    entity = journal.entity(KEY)
    assert entity["progress_at"] == 0
    assert (entity["error"], entity["attempts"]) == ("NOTION_UNKNOWN", 2)
    notion_journal.NotionJournal(store, DESTINATION)
    columns = [
        row["name"]
        for row in store.db.execute("PRAGMA table_info(notion_entities)")
    ]
    assert columns.count("progress_at") == 1
    journal.clear_error(KEY)
    assert journal.entity(KEY)["progress_at"] == 42.0
    assert journal.entity(KEY)["attempts"] == 0
    store.close()


@pytest.fixture
def live_settings(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "live",
        mode="live",
        editor_backend="codex",
        workflow_backend="dag",
        notion_backend="notion",
        notion_token="synthetic-notion-token-for-offline-test",
        notion_materials_data_source_id="11111111-1111-4111-8111-111111111111",
        notion_editions_data_source_id="22222222-2222-4222-8222-222222222222",
        model_router_url="https://models.example.test",
        model_router_token="synthetic-token",
    )


async def test_consumers_stop_before_store_and_skip_legacy_projection(
    live_settings, monkeypatch
):
    events = []

    async def checked(*args, **kwargs):
        return preflight.PreflightReport((), ())

    async def idle_worker(self):
        events.append("worker-start")
        try:
            await asyncio.Event().wait()
        finally:
            self.store.db.execute("SELECT 1")
            events.append("worker-stop")

    async def idle_sync(self):
        events.append("sync-start")
        try:
            await asyncio.Event().wait()
        finally:
            self.journal.store.db.execute("SELECT 1")
            events.append("sync-stop")

    monkeypatch.setattr(preflight, "preflight", checked)
    monkeypatch.setattr(worker.Worker, "run", idle_worker)
    monkeypatch.setattr(notion_sync.NotionSync, "run", idle_sync)
    app = fastapi.FastAPI()
    async with lifecycle.service_lifespan(
        app, settings=live_settings, editor=editor.MockEditor()
    ):
        await asyncio.sleep(0)
        assert events == ["worker-start", "sync-start"]
        assert isinstance(app.state.worker.notion, adapters.DisabledNotion)
        assert app.state.worker.skip_packet_projection
        assert app.state.worker.pipeline.packet_projection is False
        before = (live_settings.data_dir / "newsletter.sqlite3").read_bytes()
        assert notion_cli.status(live_settings.data_dir / "newsletter.sqlite3")[
            "enabled"
        ]
        assert (
            live_settings.data_dir / "newsletter.sqlite3"
        ).read_bytes() == before
        assert not app.state.store.db.execute("SELECT 1 FROM sends").fetchone()
    assert events == ["worker-start", "sync-start", "sync-stop", "worker-stop"]


async def test_destination_failure_does_not_leave_content_worker_running(
    live_settings, monkeypatch
):
    async def checked(*args, **kwargs):
        return preflight.PreflightReport((), ())

    async def forbidden(*args, **kwargs):
        pytest.fail("A consumer started before initialization completed")

    monkeypatch.setattr(preflight, "preflight", checked)
    app = fastapi.FastAPI()
    async with lifecycle.service_lifespan(
        app, settings=live_settings, start_worker=False
    ):
        pass
    monkeypatch.setattr(worker.Worker, "run", forbidden)
    with pytest.raises(ValueError, match="explicit migration"):
        async with lifecycle.service_lifespan(
            app,
            settings=dataclasses.replace(
                live_settings, notion_archive_private=True
            ),
        ):
            pytest.fail("Changed audience/privacy was silently adopted")


async def test_live_startup_ignores_the_offline_fixture_directions(
    live_settings, monkeypatch, tmp_path
):
    async def checked(*args, **kwargs):
        return preflight.PreflightReport((), ())

    legacy = tmp_path / "unreadable-legacy-directions"
    real_loader = instructions.load_instructions

    def guarded(directory):
        if directory == legacy:
            pytest.fail("Live startup read the offline fixture directions")
        return real_loader(directory)

    monkeypatch.setattr(preflight, "preflight", checked)
    monkeypatch.setattr(instructions, "load_instructions", guarded)
    app = fastapi.FastAPI()
    async with lifecycle.service_lifespan(
        app,
        settings=dataclasses.replace(live_settings, instructions_dir=legacy),
        start_worker=False,
    ):
        assert isinstance(app.state.worker.pipeline, pipeline.DagPipeline)


def test_status_missing_database_never_creates_it(tmp_path):
    path = tmp_path / "absent.sqlite3"
    with pytest.raises(sqlite3.OperationalError):
        notion_cli.status(path)
    assert not path.exists()


def test_retired_whole_edition_recipe_is_rejected_before_freezing(
    live_settings, tmp_path
):
    retired = dataclasses.replace(
        live_settings, workflow_file=story_pipeline.LEGACY_RECIPE
    )
    with_store = newsletter_store.Store(tmp_path / "source.sqlite3", "live")
    try:
        with pytest.raises(newsletter_workflow_definition.DefinitionError):
            pipeline.freeze_workflow(
                retired, state.WorkflowState(with_store), "2026-09-07"
            )
    finally:
        with_store.close()
