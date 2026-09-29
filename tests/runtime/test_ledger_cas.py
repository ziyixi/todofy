"""A lost compare-and-set writes nothing: no transition row, no owner action (real D1 in workerd).

The dependent inserts must not match the row that another writer has just moved
to the version the loser expected to create (``changes() = 1`` guards).
"""

from typing import Any

from tests.runtime.reports_support import NOW, Probe, clean_fixture, probe_fixture  # noqa: F401

SOURCE = "mail-hero-personal"
EVENT = "0b9f3f4e-8c55-4a53-9d0c-5d1f5ce2a001"
ACTION_ID = "5a1d7c3e-2f4b-4e8a-9c61-7d2e0b3f4a55"


def seed(probe: Probe, *, state: str, version: int) -> None:
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


def transition(probe: Probe, *, version: int, to: str, actor: str, action: bool = False) -> bool:
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


def written(probe: Probe) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    return (
        probe.sql("SELECT from_state, to_state, actor FROM event_transitions WHERE event_id = ?", EVENT),
        probe.sql("SELECT action_request_id, http_status FROM owner_actions"),
    )


def test_a_stale_worker_transition_records_nothing(probe: Probe):
    # The owner already moved the row from version 5 to 6; the lookup still holds version 5.
    seed(probe, state="todo_unknown", version=6)
    assert transition(probe, version=5, to="todo_unknown", actor="worker") is False
    assert written(probe) == ([], [])
    assert probe.sql("SELECT version FROM mail_events")[0]["version"] == 6


def test_a_stale_owner_action_records_neither_the_transition_nor_the_action(probe: Probe):
    seed(probe, state="todo_unknown", version=6)
    assert transition(probe, version=5, to="todo_unknown", actor="owner", action=True) is False
    assert written(probe) == ([], [])


def test_a_winning_owner_action_records_both(probe: Probe):
    seed(probe, state="todo_unknown", version=6)
    assert transition(probe, version=6, to="todo_unknown", actor="owner", action=True) is True
    assert written(probe) == (
        [{"from_state": "todo_unknown", "to_state": "todo_unknown", "actor": "owner"}],
        [{"action_request_id": ACTION_ID, "http_status": 200}],
    )
