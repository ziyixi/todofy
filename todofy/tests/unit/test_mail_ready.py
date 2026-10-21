"""Private readiness reads use a fixed transition page before filtering, and never return personal content."""

import asyncio
import json
import types
from collections.abc import Iterator

import pytest

from tests.unit.plus_support import D1, stubbed_pyodide


@pytest.fixture
def ready(monkeypatch: pytest.MonkeyPatch) -> Iterator[types.SimpleNamespace]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import mail_ready

        db = D1()
        core = types.SimpleNamespace(env=types.SimpleNamespace(DB=db))

        def poll(**request):
            answer = asyncio.run(mail_ready.handle(core, json.dumps(request)))
            return {"error": answer["error"]} if "error" in answer else json.loads(answer["ok"])

        yield types.SimpleNamespace(db=db.db, d1=db, poll=poll, failure=stubs["JsException"])


def transition(ready, event_id, state="complete", *, summary=True, imported=0, triaged_at=None):
    ready.db.execute(
        "INSERT INTO event_transitions(event_id,at,to_state,actor) VALUES(?,1,?,'worker')", (event_id, state)
    )
    if summary:
        ready.db.execute(
            "INSERT INTO summaries(event_id,created_at,subject,summary,model,imported,triaged_at)"
            " VALUES(?,123,'Synthetic private subject','Synthetic private body','m',?,?)",
            (event_id, imported, triaged_at),
        )


def test_baseline_starts_at_current_committed_head_without_replay(ready):
    assert ready.poll(baseline=True) == {"cursor": "0"}
    transition(ready, "old-mail")
    assert ready.poll(baseline=True) == {"cursor": "1"}
    transition(ready, "new-mail")
    assert ready.poll(cursor="1") == {
        "cursor": "2",
        "mail_items": [{"event_id": "new-mail", "ready_time": "1970-01-01T00:02:03Z"}],
    }
    assert ready.poll(cursor="2") == {"cursor": "2"}


def test_cursor_advances_through_nonready_canary_imported_and_triaged_rows(ready):
    transition(ready, "arrived", state="pending", summary=False)
    transition(ready, "canary", summary=False)
    transition(ready, "imported", imported=1)
    transition(ready, "converted", triaged_at=1)
    transition(ready, "deleted")
    ready.db.execute("DELETE FROM summaries WHERE event_id='deleted'")
    assert ready.poll(cursor="0") == {"cursor": "5"}
    transition(ready, "native")
    response = ready.poll(cursor="5")
    assert response["cursor"] == "6"
    assert response["mail_items"] == [{"event_id": "native", "ready_time": "1970-01-01T00:02:03Z"}]
    assert "subject" not in json.dumps(response) and "Synthetic private" not in json.dumps(response)
    assert ready.poll(cursor="5") == response


def test_fixed_scan_bound_precedes_join_and_filter_and_retains_same_time_mail(ready):
    for index in range(51):
        transition(ready, f"unready-{index}", state="pending", summary=False)
    transition(ready, "z-ready")
    transition(ready, "a-ready")
    assert ready.poll(cursor="0") == {"cursor": "50"}
    second = ready.poll(cursor="50")
    assert second["cursor"] == "53"
    assert [item["event_id"] for item in second["mail_items"]] == ["z-ready", "a-ready"]
    assert ready.poll(cursor="53") == {"cursor": "53"}


@pytest.mark.parametrize(
    "candidate",
    [
        {},
        {"cursor": "-1"},
        {"cursor": "1.0"},
        {"cursor": "01"},
        {"cursor": "9223372036854775808"},
        {"baseline": True, "cursor": "0"},
        {"cursor": "0", "unknown": True},
    ],
)
def test_invalid_requests_are_rejected_before_querying(ready, candidate):
    assert ready.poll(**candidate) == {"error": "BAD_REQUEST"}
    assert ready.d1.statements == []


def test_d1_dependency_failure_is_unavailable(ready):
    ready.d1.failing = ready.failure
    assert ready.poll(cursor="0") == {"error": "UNAVAILABLE"}


def test_cursor_ahead_of_the_restored_database_requires_an_explicit_reset(ready):
    transition(ready, "before-restore")
    assert ready.poll(baseline=True) == {"cursor": "1"}
    ready.db.execute("DELETE FROM event_transitions")
    assert ready.poll(cursor="1") == {"error": "CURSOR_RESET_REQUIRED"}
    assert ready.poll(baseline=True) == {"cursor": "0"}
    transition(ready, "after-restore")
    assert ready.poll(cursor="0")["mail_items"][0]["event_id"] == "after-restore"


def test_unexpected_storage_shape_is_internal(ready, monkeypatch):
    class BrokenStatement:
        async def first(self):
            return {"unexpected": "synthetic"}

    monkeypatch.setattr(ready.d1, "prepare", lambda _: BrokenStatement())
    assert ready.poll(baseline=True) == {"error": "INTERNAL"}
