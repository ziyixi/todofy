"""Repository extraction preserves lazy scans and atomic replay receipts."""

from collections.abc import Iterator
import json
import pathlib
import sqlite3

import pytest

import newsletter.collection.repository as collection_repository
import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.workflow.story_replay_repository as replay_repository


@pytest.fixture
def store(tmp_path: pathlib.Path) -> Iterator[newsletter_store.Store]:
    database = newsletter_store.Store(tmp_path / "state.sqlite3", "mock")
    try:
        yield database
    finally:
        database.close()


def add_run(
    store: newsletter_store.Store, identifier: str, state: str, body: str
) -> None:
    with store.transaction():
        store.db.execute(
            "INSERT INTO collection_runs VALUES(?,?,?,?,?,?)",
            (identifier, identifier, "synthetic-hash", state, body, "[]"),
        )


def test_priority_scan_keeps_lazy_decoding(store):
    runs = collection_repository.RunRepository(store)
    add_run(store, "first", "queued", '{"id":"first"}')
    add_run(store, "corrupt-later", "collecting", "invalid-json")
    pending = runs.queued_collecting()
    assert next(pending) == {"id": "first"}
    with pytest.raises(json.JSONDecodeError):
        next(pending)


def test_priority_scan_uses_one_locked_row_snapshot(store):
    runs = collection_repository.RunRepository(store)
    add_run(store, "first", "queued", '{"id":"first"}')
    pending = runs.queued_collecting()
    assert next(pending) == {"id": "first"}
    add_run(store, "new", "queued", '{"id":"new"}')
    assert list(pending) == []
    assert list(runs.queued_collecting()) == [{"id": "first"}, {"id": "new"}]


def test_legacy_repair_scan_keeps_newest_first_and_lazy_decoding(store):
    runs = collection_repository.RunRepository(store)
    add_run(store, "old-corrupt", "blocked", "invalid-json")
    add_run(store, "newest", "blocked", '{"id":"newest"}')
    candidates = runs.legacy_repair_candidates()
    assert next(candidates) == {"id": "newest"}
    with pytest.raises(json.JSONDecodeError):
        next(candidates)


def test_full_queue_does_not_decode_blocked_repair_candidates(store):
    runs = collection_repository.RunRepository(store)
    store.max_pending_jobs = 1
    add_run(store, "active", "collecting", '{"id":"active"}')
    add_run(store, "blocked", "blocked", "invalid-json")
    assert list(runs.legacy_repair_candidates()) == []


def receipt() -> types.Payload:
    return {
        "parent_run_id": "parent-fixture",
        "child_run_id": "child-fixture",
        "request": {"request_key": "explicit-fixture"},
        "manifest": {"reason": "synthetic-only"},
    }


def test_replay_receipt_rolls_back_with_its_callers_transaction(store):
    ledger = replay_repository.StoryReplayRepository(store)

    def fail_after_insert():
        with store.transaction():
            ledger.save_in_transaction(receipt())
            raise RuntimeError("synthetic rollback")

    with pytest.raises(RuntimeError, match="synthetic rollback"):
        fail_after_insert()
    assert ledger.parent_record("parent-fixture") is None
    assert ledger.child_record("child-fixture") is None
    assert not ledger.is_child("child-fixture")


def test_replay_receipt_keeps_exact_bytes_and_rejects_duplicate_parent(store):
    ledger = replay_repository.StoryReplayRepository(store)
    value = receipt()
    with store.transaction():
        ledger.save_in_transaction(value)
    original = ledger.parent_record("parent-fixture")
    assert original is not None
    assert original["body"] == contracts.canonical_json(value)
    assert original["digest"] == contracts.content_hash(value)
    assert ledger.child_record("child-fixture") == original
    assert ledger.is_child("child-fixture")
    value["child_run_id"] = "other-child"
    value["request"]["request_key"] = "other-request"
    with pytest.raises(sqlite3.IntegrityError), store.transaction():
        ledger.save_in_transaction(value)
    assert ledger.parent_record("parent-fixture") == original
    assert ledger.child_record("other-child") is None
