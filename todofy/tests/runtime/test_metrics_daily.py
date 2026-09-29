"""Daily metrics in real workerd: the object counts a finished UTC day from the ledger and its
own step counters, writes it to D1 daily_metrics once, and the owner API serves it.

A day is only written after it has ended, so the test moves one day back in time on disk: it
stops the Worker, shifts the ledger rows and the object's counters to yesterday, and restarts.
The Analytics Engine binding is bound in the test configs too (a local no-op dataset), so every
step also runs its data-point write.
"""

import json
import sqlite3
import time
import uuid
from pathlib import Path

import pytest

from tests import mail_contract
from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import TodoistFake
from tests.runtime.harness import Worker, mail_event, transitions, wait_until
from tests.runtime.owner_support import assert_contract, error_code

DAY = 86_400


def _utc_day(offset_days: int = 0) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + offset_days * DAY))


def _object_db(worker: Worker) -> Path:
    """The coordinator's SQLite file (workerd keeps one per object, next to metadata.sqlite)."""
    [path] = [path for path in (worker.persist_to / "v3" / "do").rglob("*.sqlite") if path.name != "metadata.sqlite"]
    return path


def _metric_rows(worker: Worker, day: str) -> dict[str, int]:
    rows = worker.d1(f"SELECT key, value FROM daily_metrics WHERE day = '{day}'")
    return {row["key"]: row["value"] for row in rows}


def _complete_one_mail(worker: Worker) -> None:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    worker.wait_event(event_id, {"complete"})


def _patch_object(worker: Worker, *statements: tuple[str, tuple[object, ...]]) -> None:
    """Edit the object's SQLite storage while the Worker is stopped, then start it again."""
    worker.stop()
    with sqlite3.connect(_object_db(worker)) as store:
        for sql, args in statements:
            store.execute(sql, args)
    worker.start()


def test_a_finished_day_is_written_once_and_served(
    worker: Worker, fresh_gemini: GeminiFake, fresh_todoist: TodoistFake
) -> None:
    # The first alarm starts counting at the newest transition and forgets its partial day.
    _complete_one_mail(worker)
    # Count the whole ledger from here on, and hold the flush while the next mail runs.
    _patch_object(
        worker,
        ("UPDATE metric_flush SET cursor = 0, flushed_day = ?, next_at = ?", (_utc_day(-2), 2**40)),
        ("DELETE FROM metric_counts", ()),
    )
    _complete_one_mail(worker)
    # A canary event (contracts/ops-v1) is not mail: it spends Gemini budget but counts as no mail.
    canary = json.loads(mail_contract.fixtures()["canary_event"].read_bytes())
    canary["event_id"], canary["message"]["id"] = str(uuid.uuid4()), str(uuid.uuid4())
    assert worker.post_event(json.dumps(canary).encode()).status_code == 204
    assert worker.wait_event(canary["event_id"], {"complete"})["canary"] is True
    # Move today to yesterday, in D1 and in the object's counters, and let the flush run.
    worker.d1(f"UPDATE event_transitions SET at = at - {DAY}")
    worker.d1(f"UPDATE mail_events SET created_at = created_at - {DAY}, updated_at = updated_at - {DAY}")
    _patch_object(
        worker,
        ("UPDATE metric_flush SET next_at = 0", ()),
        ("UPDATE metric_counts SET day = ?", (_utc_day(-1),)),
    )
    assert worker.trigger_cron().status_code == 200

    yesterday = _utc_day(-1)
    written = wait_until(lambda: _metric_rows(worker, yesterday) or None, 20, "yesterday's metrics")
    # Mail counts come from the ledger (both mails, not the canary); step counters only from the
    # second mail and the canary's summary call.
    assert written["mails_received"] == 2 and written["mails_completed"] == 2
    assert written["todoist_creates"] == 1 and written["gemini_calls"] == 2
    assert written["gemini_tokens:model-a"] > 0
    # Two mails whose end-to-end times may differ by a second on a slow runner.
    assert 0 <= written["latency_p50_s"] <= written["latency_p90_s"] < 60
    assert "mails_failed" not in written  # zero counters are not stored
    with sqlite3.connect(_object_db(worker)) as store:
        # Nothing of a written day is kept in the object; the next flush is after midnight.
        assert store.execute("SELECT count(*) FROM metric_counts WHERE day <= ?", (yesterday,)).fetchone() == (0,)

    response = worker.owner.get("/api/v1/metrics/daily", params={"days": 3})
    assert response.status_code == 200
    days = assert_contract(response, "/api/v1/metrics/daily")["days"]
    assert [day["day"] for day in days] == [_utc_day(-3), _utc_day(-2), yesterday]
    assert [day["recorded"] for day in days] == [False, False, True]
    assert days[2]["mails_completed"] == 2 and set(days[2]["gemini_tokens"]) == {"model-a"}
    assert "write_failed" not in (worker.persist_to / "dev.log").read_text()


def test_default_range_and_invalid_days(worker: Worker) -> None:
    response = worker.owner.get("/api/v1/metrics/daily")
    assert len(assert_contract(response, "/api/v1/metrics/daily")["days"]) == 30
    assert response.headers["cache-control"] == "no-store"
    for days in ("0", "91", "x", "1.5"):
        response = worker.owner.get("/api/v1/metrics/daily", params={"days": days})
        assert response.status_code == 400, days
        assert error_code(response) == "invalid_request"


@pytest.mark.parametrize("path", ["/api/v1/metrics", "/api/v1/metrics/daily/extra"])
def test_neighbouring_paths_are_not_found(worker: Worker, path: str) -> None:
    assert worker.owner.get(path).status_code == 404


def test_a_failing_counter_write_never_fails_the_step(
    worker: Worker, fresh_gemini: GeminiFake, fresh_todoist: TodoistFake
) -> None:
    _complete_one_mail(worker)  # the object and its storage exist from here on
    # Every insert into the object's step counters fails, as with a full object storage.
    _patch_object(
        worker,
        (
            "CREATE TRIGGER metric_counts_full BEFORE INSERT ON metric_counts"
            " BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
            (),
        ),
    )
    try:
        event_id, body = mail_event()
        assert worker.post_event(body).status_code == 204
        event = worker.wait_event(event_id, {"complete"})
        # One summary and one task: the Gemini call is not rerun and the created task is not
        # left in todo_sending (then todo_unknown and a lookup) by the failed counter write.
        assert [(t[0], t[1]) for t in transitions(event)] == [
            (None, "pending"),
            ("pending", "summarizing"),
            ("summarizing", "summarized"),
            ("summarized", "todo_sending"),
            ("todo_sending", "complete"),
        ]
        assert len(fresh_gemini.calls_mentioning(event_id)) == 1
        assert len(fresh_todoist.creates_for(event_id)) == 1
        log = wait_until(
            lambda: (text := (worker.persist_to / "dev.log").read_text()).count('"count_failed"') >= 2 and text,
            10,
            "the count_failed log lines",
        )
        assert '"count_failed", "error": "' in log
    finally:
        _patch_object(worker, ("DROP TRIGGER metric_counts_full", ()))


@pytest.mark.parametrize("new_mail", [True, False], ids=["ids_reused", "ids_lower"])
def test_a_restored_database_restarts_counting_instead_of_writing_zeros(
    worker: Worker, fresh_gemini: GeminiFake, fresh_todoist: TodoistFake, new_mail: bool
) -> None:
    _complete_one_mail(worker)  # the object and its storage exist from here on
    # Hold the flush while the mails run.
    _patch_object(worker, ("UPDATE metric_flush SET next_at = ?", (2**40,)))
    _complete_one_mail(worker)
    lost_id, lost_body = mail_event()
    assert worker.post_event(lost_body).status_code == 204
    worker.wait_event(lost_id, {"complete"})
    [counted] = worker.d1(
        f"SELECT id, event_id, at FROM event_transitions WHERE event_id = '{lost_id}' ORDER BY id DESC LIMIT 1"
    )
    # The database goes back to before the last mail, as a restore of an older backup (or D1
    # Time Travel) does: its transitions are gone and event_transitions.id is not AUTOINCREMENT.
    worker.d1(f"DELETE FROM event_transitions WHERE event_id = '{lost_id}'")
    worker.d1(f"DELETE FROM mail_events WHERE event_id = '{lost_id}'")
    if new_mail:
        # A mail after the restore takes the same ids, so the cursor's id exists again, with another row.
        _complete_one_mail(worker)
        [reused] = worker.d1(f"SELECT event_id FROM event_transitions WHERE id = {counted['id']}")
        assert reused["event_id"] != lost_id
    else:
        assert worker.d1("SELECT max(id) AS id FROM event_transitions")[0]["id"] < counted["id"]
    # Move today to yesterday; the object still holds the old database's cursor (at that row's time).
    worker.d1(f"UPDATE event_transitions SET at = at - {DAY}")
    worker.d1(f"UPDATE mail_events SET created_at = created_at - {DAY}, updated_at = updated_at - {DAY}")
    _patch_object(
        worker,
        (
            "UPDATE metric_flush SET cursor = ?, cursor_event = ?, cursor_at = ?, flushed_day = ?, next_at = 0",
            (counted["id"], lost_id, counted["at"] - DAY, _utc_day(-2)),
        ),
        ("UPDATE metric_counts SET day = ?", (_utc_day(-1),)),
    )
    worker.d1(f"DELETE FROM daily_metrics WHERE day = '{_utc_day(-1)}'")
    assert worker.trigger_cron().status_code == 200

    def restarted() -> tuple[int, str] | None:
        with sqlite3.connect(_object_db(worker)) as store:
            cursor, day = store.execute("SELECT cursor, flushed_day FROM metric_flush").fetchone()
        return (cursor, day) if day == _utc_day(0) else None

    cursor, _ = wait_until(restarted, 20, "the metrics cursor restart")
    # Counting restarts at the newest transition of the restored database; yesterday stays
    # "not recorded" instead of being written with mails_received = 0.
    assert cursor == worker.d1("SELECT max(id) AS id FROM event_transitions")[0]["id"]
    assert _metric_rows(worker, _utc_day(-1)) == {}
    response = worker.owner.get("/api/v1/metrics/daily", params={"days": 1})
    assert assert_contract(response, "/api/v1/metrics/daily")["days"][0]["recorded"] is False
    assert '"cursor_reset"' in (worker.persist_to / "dev.log").read_text()
