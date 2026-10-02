"""Test crashes and idempotency using temporary SQLite and synthetic packets."""

import copy

import pytest

import newsletter.collection.collector as collector
import newsletter.collection.instructions as instructions
import newsletter.collection.pipeline as newsletter_collection_pipeline
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.store as newsletter_store


@pytest.fixture
def environment(tmp_path):
    store = newsletter_store.Store(
        tmp_path / "data" / "newsletter.sqlite3", "mock"
    )
    runs = repository.RunRepository(store)
    instruction = instructions.Instruction(
        "science",
        "Synthetic research direction.",
        contracts.content_hash("fixture"),
    )
    run = runs.start(
        {"request_key": "synthetic-run", "issue_date": "2026-09-05"},
        [instruction],
    )
    pipeline = newsletter_collection_pipeline.CollectionPipeline(
        runs, collector.MockCollector(), tmp_path / "work", 1, 20
    )
    try:
        yield store, runs, pipeline, run
    finally:
        store.close()


async def test_failed_second_packet_never_leaves_untracked_material(
    environment,
):
    store, runs, pipeline, run = environment

    class PartlyInvalidCollector(collector.MockCollector):
        async def collect(self, *args):
            result = await super().collect(*args)
            invalid = copy.deepcopy(result.packets[0])
            invalid["sources"] = []
            return collector.ResearchResult(
                [*result.packets, invalid], "Synthetic invalid second packet."
            )

    pipeline.collector = PartlyInvalidCollector()
    assert await pipeline.collect_next()
    failed = runs.get(run["id"])
    assert failed["state"] == "failed"
    persisted = {packet["id"] for packet in store.read_inbox()["packets"]}
    recorded = {
        packet_id
        for direction in failed["directions"]
        for packet_id in direction["packet_ids"]
    }
    # Either roll back the direction atomically, or retain its saved IDs. A
    # pending packet must not escape to Notion without any run/direction link.
    assert persisted <= recorded


async def test_internal_edition_key_conflict_blocks_run_not_killing_worker(
    environment,
):
    store, runs, pipeline, run = environment
    assert await pipeline.collect_next()
    collected = runs.get(run["id"])
    packet_ids = collected["directions"][0]["packet_ids"]
    for packet_id in packet_ids:
        store.projection_result(packet_id, "done")
    # This is also a valid request through POST /v1/editions: its key namespace
    # currently overlaps the pipeline's own generated editorial request key.
    store.prepare(
        {
            "request_key": "collection:" + run["id"],
            "issue_date": "2026-09-06",
            "packet_ids": packet_ids,
        }
    )
    assert pipeline.advance()
    failed = runs.get(run["id"])
    assert failed["state"] in {"blocked", "failed"}
    assert failed["error_code"]


async def test_restart_does_not_reissue_uncertain_notion_projection(
    environment,
):
    store, runs, pipeline, run = environment
    assert await pipeline.collect_next()
    packet = store.claim_projection()
    assert packet is not None
    # Simulate process death after the durable dispatch marker, before its
    # response. Recovery cannot know whether the provider created the page.
    store.recover()
    runs.recover()
    assert pipeline.advance()
    blocked = runs.get(run["id"])
    assert blocked["state"] == "blocked"
    assert blocked["error_code"] == "notion_projection_unconfirmed"
    assert blocked["edition_id"] == ""
    assert store.claim_projection() is None
    assert not pipeline.advance()


async def test_crash_between_edition_creation_and_run_link_reuses_one_edition(
    environment,
):
    store, runs, pipeline, run = environment
    assert await pipeline.collect_next()
    collected = runs.get(run["id"])
    packet_ids = collected["directions"][0]["packet_ids"]
    for packet_id in packet_ids:
        store.projection_result(packet_id, "done")
    edition = store.prepare(
        {
            "request_key": "collection:" + run["id"],
            "issue_date": run["issue_date"],
            "packet_ids": packet_ids,
        }
    )
    store.recover()
    runs.recover()
    assert pipeline.advance()
    assert runs.get(run["id"])["edition_id"] == edition["id"]
    assert store.db.execute("SELECT COUNT(*) FROM editions").fetchone()[0] == 1
    assert not pipeline.advance()
