"""Local-first publication is not permission to weaken send or legacy gates."""

import copy
import json
import sqlite3
import types

import pytest

import newsletter.adapters as adapters
import newsletter.collection.pipeline as newsletter_collection_pipeline
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.store as newsletter_store
import newsletter.worker as newsletter_worker
import tests.support.publication_delivery as publication_delivery


class UnavailableNotion:
    def __init__(self, ambiguous=False):
        self.calls = []
        self.ambiguous = ambiguous

    async def project(self, packet):
        self.calls.append(packet["id"])
        raise adapters.AdapterError(
            "NOTION_UNKNOWN" if self.ambiguous else "NOTION_REJECTED",
            self.ambiguous,
        )


@pytest.fixture
def store(tmp_path):
    value = newsletter_store.Store(tmp_path / "local.sqlite3", "mock")
    yield value
    value.close()


def approval(edition, key="send"):
    return {
        "id": edition["id"],
        "request_key": key,
        "expected_render_hash": edition["rendered"]["render_hash"],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("ambiguous", [False, True])
async def test_local_publication_survives_notion_failure_without_duplicate_send(
    store, tmp_path, ambiguous
):
    edition, packet, _, _ = publication_delivery.queue(store)
    notion = UnavailableNotion(ambiguous)
    worker = newsletter_worker.Worker(
        store, editor.MockEditor(), notion, tmp_path / "jobs", 10
    )
    assert await worker.step()  # The frozen approved result renders first.
    ready = store.get(edition["id"])
    assert ready["state"] == "ready"
    assert not notion.calls
    assert (
        await worker.step()
    )  # Background copy fails after local publication is ready.
    assert store.db.execute("SELECT projection FROM packets").fetchone()[0] == (
        "unknown" if ambiguous else "failed"
    )
    assert store.reserve_send(approval(ready))[1]
    assert not store.reserve_send(approval(ready))[1]
    assert not store.reserve_send(approval(ready, "same-date-another-key"))[1]
    store.recover()
    assert not await worker.step()
    assert notion.calls == [packet["id"]]
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("projection_required", [None, True])
async def test_legacy_or_explicit_notion_policy_still_requires_confirmation(
    store, tmp_path, projection_required
):
    edition, packet, _, _ = publication_delivery.queue(
        store, projection_required=projection_required
    )
    worker = newsletter_worker.Worker(
        store, editor.MockEditor(), UnavailableNotion(), tmp_path / "jobs", 10
    )
    assert await worker.step()
    assert await worker.step()
    ready = store.get(edition["id"])
    with pytest.raises(
        newsletter_store.StoreError, match="confirmed in Notion"
    ):
        store.reserve_send(approval(ready))
    store.projection_result(packet["id"], "done")
    assert store.reserve_send(approval(ready))[1]


@pytest.mark.parametrize("change", [True, "false", 0, None])
def test_projection_policy_is_frozen_and_requires_real_boolean(store, change):
    edition, _, request, binding = publication_delivery.queue(store)
    assert (
        store.prepare(request, workflow_binding=copy.deepcopy(binding))
        == edition
    )
    binding["projection_required"] = change
    with pytest.raises(newsletter_store.StoreError):
        store.prepare(request, workflow_binding=binding)


def test_existing_database_migrates_without_weakening_legacy_bindings(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TABLE workflow_editions (edition_id TEXT PRIMARY "
            "KEY, run_id TEXT UNIQUE NOT NULL,editor_result TEXT NOT "
            "NULL,required_packets TEXT NOT NULL)"
        )
        db.execute(
            "INSERT INTO workflow_editions VALUES('legacy','run','{}','[]')"
        )
    store = newsletter_store.Store(path, "mock")
    try:
        assert (
            store.db.execute(
                "SELECT projection_required FROM workflow_editions"
            ).fetchone()[0]
            == 1
        )
        with pytest.raises(
            newsletter_store.StoreError, match="confirmed in Notion"
        ):
            store.assert_workflow_research("legacy")
    finally:
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ["missing", "changed", "unfrozen-citation", "wrong-approval"]
)
async def test_local_policy_does_not_relax_frozen_evidence_or_approval_checks(
    store, tmp_path, failure
):
    edition, packet, _, _ = publication_delivery.queue(store)
    worker = newsletter_worker.Worker(
        store, editor.MockEditor(), UnavailableNotion(), tmp_path / "jobs", 10
    )
    assert await worker.step()
    ready = store.get(edition["id"])
    requested = approval(ready)
    if failure == "missing":
        store.db.execute("DELETE FROM packets WHERE id=?", (packet["id"],))
    elif failure == "changed":
        packet["content"]["body"] = "Changed after freezing"
        store.db.execute(
            "UPDATE packets SET body=? WHERE id=?",
            (contracts.canonical_json(packet), packet["id"]),
        )
    elif failure == "unfrozen-citation":
        draft = ready["draft"]
        draft["sections"][0]["paragraphs"][0]["citations"] = ["missing/source"]
        store.finish(edition["id"], draft=draft)
    else:
        requested["expected_render_hash"] = "wrong"
    with pytest.raises(newsletter_store.StoreError):
        store.reserve_send(requested)
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_story_work_precedes_notion_but_legacy_default_does_not(
    store, tmp_path
):
    _, packet, _, _ = publication_delivery.queue(store)
    # No edition is queued here, so only content-vs-projection ordering is
    # tested.
    store.db.execute("DELETE FROM editions")
    calls = []

    async def collect():
        calls.append("content")
        return True

    pipeline = types.SimpleNamespace(
        advance=lambda: False,
        has_priority_work=lambda: True,
        collect_next=collect,
    )
    notion = UnavailableNotion()
    worker = newsletter_worker.Worker(
        store,
        editor.MockEditor(),
        notion,
        tmp_path / "jobs",
        10,
        pipeline=pipeline,
    )
    assert await worker.step()
    assert calls == ["content"] and not notion.calls
    assert (
        store.db.execute("SELECT projection FROM packets").fetchone()[0]
        == "pending"
    )
    pipeline.has_priority_work = lambda: False
    assert await worker.step()
    assert notion.calls == [packet["id"]]
    assert (
        not newsletter_collection_pipeline.CollectionPipeline.has_priority_work(
            pipeline
        )
    )


def test_local_snapshot_survives_reopen_even_when_projection_is_unknown(
    store, tmp_path
):
    edition, packet, _, _ = publication_delivery.queue(store)
    store.projection_result(packet["id"], "unknown")
    peer = newsletter_store.Store(tmp_path / "local.sqlite3", "mock")
    try:
        row = peer.db.execute(
            "SELECT snapshot FROM editions WHERE id=?", (edition["id"],)
        ).fetchone()
        assert json.loads(row[0]) == [packet]
        assert (
            peer.db.execute("SELECT projection FROM packets").fetchone()[0]
            == "unknown"
        )
    finally:
        peer.close()
