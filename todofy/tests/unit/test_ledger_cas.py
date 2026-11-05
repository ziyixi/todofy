"""runtime/ledger.py on host SQLite: compare-and-set transition guards, defense checks,
ingest dedupe/conflict, due queue, crash recovery, and owner action claims."""

import asyncio
from typing import Any

import pytest

from tests.unit.host_support import NOW, HostProbe, host_probe
from todofy.core.backoff import SUMMARY_CRASH_LIMIT
from todofy.core.vocab import Code, EventState

SOURCE = "mail-hero-personal"
EVENT = "0b9f3f4e-8c55-4a53-9d0c-5d1f5ce2a001"
ACTION_ID = "5a1d7c3e-2f4b-4e8a-9c61-7d2e0b3f4a55"


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch):
    with host_probe(monkeypatch) as p:
        yield p


def seed(probe: HostProbe, *, state: str, version: int) -> None:
    probe.insert(
        "mail_events",
        source_id=SOURCE,
        event_id=EVENT,
        payload_hash="0" * 64,
        payload="{}",
        state=state,
        version=version,
        created_at=NOW - 600,
        updated_at=NOW - 60,
    )


def transition(probe: HostProbe, *, version: int, to: str, actor: str, action: bool = False) -> bool:
    args: dict[str, Any] = {
        "source_id": SOURCE,
        "event_id": EVENT,
        "from_state": "todo_unknown",
        "version": version,
        "to": to,
        "actor": actor,
        "now": NOW,
    }
    if action:
        args["action"] = {
            "owner": "owner@example.com",
            "action_request_id": ACTION_ID,
            "kind": "task_not_created",
            "request_hash": "1" * 64,
        }
    return probe.call("/ledger/transition", **args)["moved"]


def written(probe: HostProbe) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return (
        probe.sql("SELECT from_state, to_state, actor FROM event_transitions WHERE event_id = ?", EVENT),
        probe.sql("SELECT action_request_id, http_status FROM owner_actions"),
    )


def test_a_stale_worker_transition_records_nothing(probe: HostProbe) -> None:
    seed(probe, state="todo_unknown", version=6)
    assert transition(probe, version=5, to="todo_unknown", actor="worker") is False
    assert written(probe) == ([], [])
    assert probe.sql("SELECT version FROM mail_events")[0]["version"] == 6


def test_a_stale_owner_action_records_neither_the_transition_nor_the_action(probe: HostProbe) -> None:
    seed(probe, state="todo_unknown", version=6)
    assert transition(probe, version=5, to="todo_unknown", actor="owner", action=True) is False
    assert written(probe) == ([], [])


def test_a_winning_owner_action_records_both(probe: HostProbe) -> None:
    seed(probe, state="todo_unknown", version=6)
    assert transition(probe, version=6, to="todo_unknown", actor="owner", action=True) is True
    assert written(probe) == (
        [{"from_state": "todo_unknown", "to_state": "todo_unknown", "actor": "owner"}],
        [{"action_request_id": ACTION_ID, "http_status": 200}],
    )


def test_transition_rejects_both_completed_and_action_or_unknown_mutable_columns(probe: HostProbe) -> None:
    from todofy.runtime import ledger

    seed(probe, state="pending", version=1)
    row = asyncio.run(ledger.get(probe.db, SOURCE, EVENT))
    assert row is not None

    with pytest.raises(TypeError, match="not both"):
        asyncio.run(
            ledger.transition(
                probe.db,
                row,
                EventState.COMPLETE,
                actor=ledger.WORKER,
                now=NOW,
                completed=ledger.CompletedSummary(subject="s", summary="sum", model="m"),
                action=ledger.OwnerAction(
                    owner="owner@example.com",
                    action_request_id=ACTION_ID,
                    kind="dismiss",
                    request_hash="1" * 64,
                ),
            )
        )

    with pytest.raises(TypeError, match="not a mutable column"):
        asyncio.run(
            ledger.transition(
                probe.db,
                row,
                EventState.SUMMARIZING,
                actor=ledger.WORKER,
                now=NOW,
                not_a_column=123,
            )
        )


def test_ingest_due_recover_interrupted_and_action_claims(probe: HostProbe) -> None:
    from todofy.runtime import ledger

    # ingest NEW, DUPLICATE, CONFLICT
    assert asyncio.run(ledger.ingest(probe.db, SOURCE, EVENT, '{"a":1}', "a" * 64, NOW)) == ledger.Stored.NEW
    assert asyncio.run(ledger.ingest(probe.db, SOURCE, EVENT, '{"a":1}', "a" * 64, NOW)) == ledger.Stored.DUPLICATE
    assert asyncio.run(ledger.ingest(probe.db, SOURCE, EVENT, '{"a":2}', "b" * 64, NOW)) == ledger.Stored.CONFLICT

    # next_due and next_wake_at
    due = asyncio.run(ledger.next_due(probe.db, NOW))
    assert due is not None and due.event_id == EVENT and not due.canary
    assert asyncio.run(ledger.next_wake_at(probe.db)) == NOW

    # transition to SUMMARIZING, then recover_interrupted (below and at crash limit)
    summarizing = asyncio.run(
        ledger.transition(probe.db, due, EventState.SUMMARIZING, actor=ledger.WORKER, now=NOW)
    )
    assert summarizing is not None
    asyncio.run(ledger.recover_interrupted(probe.db, NOW + 10))
    recovered = asyncio.run(ledger.get(probe.db, SOURCE, EVENT))
    assert recovered is not None and recovered.state == EventState.PENDING and recovered.crashes == 1

    # At crash limit, real mail moves to FAILED_SUMMARY and canary moves to IGNORED
    at_limit = asyncio.run(
        ledger.transition(
            probe.db,
            recovered,
            EventState.SUMMARIZING,
            actor=ledger.WORKER,
            now=NOW + 20,
            crashes=SUMMARY_CRASH_LIMIT - 1,
        )
    )
    assert at_limit is not None
    asyncio.run(ledger.recover_interrupted(probe.db, NOW + 30))
    failed = asyncio.run(ledger.get(probe.db, SOURCE, EVENT))
    assert (
        failed is not None
        and failed.state == EventState.FAILED_SUMMARY
        and failed.last_error_code == Code.PROCESSING_INTERRUPTED_LIMIT
    )

    # CompletedSummary writes summaries row
    completed_row = asyncio.run(
        ledger.transition(
            probe.db,
            failed,
            EventState.COMPLETE,
            actor=ledger.WORKER,
            now=NOW + 40,
            completed=ledger.CompletedSummary(subject="Subj", summary="Line 1\nLine 2", model="m1"),
        )
    )
    assert completed_row is not None and completed_row.payload is None
    assert probe.sql("SELECT brief FROM summaries WHERE event_id = ?", EVENT) == [{"brief": "Line 1"}]

    # Action claim / replay / conflict / finish / take_over / release
    owner = "owner@example.com"
    assert asyncio.run(ledger.find_action(probe.db, owner, ACTION_ID, "h1")).claim == ledger.Claim.NEW
    assert asyncio.run(ledger.claim_action(probe.db, owner, ACTION_ID, "recompute", "h1", NOW)).claim == ledger.Claim.NEW
    assert (
        asyncio.run(ledger.claim_action(probe.db, owner, ACTION_ID, "recompute", "h1", NOW)).claim
        == ledger.Claim.REPLAY
    )
    assert (
        asyncio.run(ledger.claim_action(probe.db, owner, ACTION_ID, "recompute", "h2", NOW)).claim
        == ledger.Claim.CONFLICT
    )
    assert not asyncio.run(ledger.take_over_action(probe.db, owner, ACTION_ID, "h1", NOW + 5, NOW))
    assert asyncio.run(ledger.take_over_action(probe.db, owner, ACTION_ID, "h1", NOW + 100, NOW + 50))
    asyncio.run(ledger.release_action(probe.db, owner, ACTION_ID))
    assert asyncio.run(ledger.find_action(probe.db, owner, ACTION_ID, "h1")).claim == ledger.Claim.NEW
    assert asyncio.run(ledger.claim_action(probe.db, owner, ACTION_ID, "recompute", "h1", NOW)).claim == ledger.Claim.NEW
    asyncio.run(ledger.finish_action(probe.db, owner, ACTION_ID, "summary", 200))
    finished = asyncio.run(ledger.find_action(probe.db, owner, ACTION_ID, "h1"))
    assert (finished.claim, finished.result_ref, finished.http_status) == (ledger.Claim.REPLAY, "summary", 200)
