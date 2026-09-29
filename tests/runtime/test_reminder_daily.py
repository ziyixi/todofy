"""reminder.tick / page in real workerd against the Todoist fake: at most one task
per UTC day, claimed before the call; failed retried hourly with the frozen
request up to five times; unknown never resent that day (Go
mail_inbox_attention_test.go:355-561)."""

import pytest

from tests.fakes.server import Reply
from tests.fakes.todoist_fake import PROJECT_ID, TASKS_PATH
from tests.runtime.reports_support import (  # noqa: F401
    NOW,
    PUBLIC_HOST,
    Probe,
    clean_fixture,
    component_errors,
    probe_fixture,
)
from todofy.core.reminder_text import SENDER, AttentionRow, reminder_body, reminder_title
from todofy.core.request_id import todoist_request_id

DAY = 86_400
TOMORROW = NOW - NOW % DAY + DAY
SOURCE = "mail-hero-personal"
HASH = "0" * 64


def seed_event(probe: Probe, event_id: str, state: str, created_at: int, code: str = "") -> None:
    probe.insert(
        "mail_events",
        source_id=SOURCE,
        event_id=event_id,
        payload_hash=HASH,
        payload=None if state == "complete" else "{}",
        state=state,
        last_error_code=code,
        created_at=created_at,
        updated_at=created_at,
    )


@pytest.fixture
def attention(probe: Probe) -> list[AttentionRow]:
    """Two attention rows (oldest first) and two that are not."""
    seed_event(probe, "e-failed", "failed_summary", NOW - 100, "summary_failed")
    seed_event(probe, "e-old", "pending", NOW - 7 * 3600)
    seed_event(probe, "e-new", "pending", NOW - 60)
    seed_event(probe, "e-done", "complete", NOW - 9 * 3600)
    return [
        AttentionRow("e-old", "pending", "", NOW - 7 * 3600),
        AttentionRow("e-failed", "failed_summary", "summary_failed", NOW - 100),
    ]


def reminder(probe: Probe, day: str = "2026-09-28") -> dict:
    [row] = probe.sql("SELECT * FROM mail_reminders WHERE day = ?", day)
    return row


def tick(probe: Probe, now: int, **vars: str) -> int:
    return probe.call("/reminder/tick", now=now, vars=vars)["next"]


@pytest.mark.parametrize(
    "switch", [{"REMINDER_ENABLED": "false"}, {"FORCE_PAUSE_TODOIST": "true"}, {"PROCESSING_PAUSED": "true"}]
)
def test_disabled_or_paused_sends_nothing(probe, attention, switch):
    assert tick(probe, NOW, **switch) == NOW + 600
    assert probe.todoist.creates() == []
    assert probe.sql("SELECT day FROM mail_reminders") == []


def test_no_attention_sends_nothing(probe):
    seed_event(probe, "e-new", "pending", NOW - 60)
    assert tick(probe, NOW) == NOW + 600
    assert probe.todoist.creates() == []


def test_one_task_per_day_with_ids_only(probe, attention):
    assert tick(probe, NOW) == TOMORROW
    [create] = probe.todoist.creates()
    title = reminder_title(2)
    body = reminder_body(2, "2026-09-28", attention, PUBLIC_HOST)
    assert create.json() == {"content": title, "description": body, "project_id": PROJECT_ID}
    assert create.headers["x-request-id"] == todoist_request_id(title, body, SENDER)
    row = reminder(probe)
    assert (row["state"], row["attempts"], row["attention_count"]) == ("created", 1, 2)
    assert row["task_id"] == probe.todoist.tasks[0].id

    assert tick(probe, NOW + 600) == TOMORROW
    assert len(probe.todoist.creates()) == 1


@pytest.mark.parametrize("status", [400, 401])
def test_failed_is_retried_hourly_with_the_frozen_request_then_stops(probe, attention, status):
    for _ in range(5):
        probe.todoist.queue("POST", TASKS_PATH, Reply(status, {"error": "no"}))
    now = NOW
    assert tick(probe, now) == now + 3600
    row = reminder(probe)
    assert (row["state"], row["attempts"], row["last_error_code"]) == ("failed", 1, "reminder_create_failed")
    assert tick(probe, now + 1800) == now + 3600
    assert len(probe.todoist.creates()) == 1

    seed_event(probe, "e-later", "todo_unknown", NOW + 60)  # the frozen text must not change
    for attempt in range(2, 6):
        now += 3600
        expected = now + 3600 if attempt < 5 else TOMORROW
        assert tick(probe, now) == expected
    creates = probe.todoist.creates()
    assert len(creates) == 5
    assert len({(create.body, create.headers["x-request-id"]) for create in creates}) == 1
    row = reminder(probe)
    assert (row["state"], row["attempts"], row["next_attempt_at"]) == ("failed", 5, 0)
    assert tick(probe, now + 3600) == TOMORROW
    assert len(probe.todoist.creates()) == 5


@pytest.mark.parametrize("reply", [Reply(500, {"error": "boom"}), Reply(200, {})], ids=["500", "no_id"])
def test_unknown_is_never_resent_that_day(probe, attention, reply):
    probe.todoist.queue("POST", TASKS_PATH, reply)
    assert tick(probe, NOW) == TOMORROW
    row = reminder(probe)
    assert (row["state"], row["last_error_code"], row["next_attempt_at"]) == (
        "unknown",
        "reminder_result_unknown",
        0,
    )
    assert tick(probe, NOW + 3 * 3600) == TOMORROW
    assert len(probe.todoist.creates()) == 1

    assert tick(probe, TOMORROW + 60) == TOMORROW + DAY
    assert reminder(probe, "2026-09-29")["state"] == "created"
    assert len(probe.todoist.creates()) == 2


def test_a_timeout_then_a_503_is_unknown_and_not_resent_that_day(probe, attention):
    probe.todoist.queue("POST", TASKS_PATH, Reply(hang=True))
    for _ in range(2):
        probe.todoist.queue("POST", TASKS_PATH, Reply(503, {"error": "busy"}))
    assert tick(probe, NOW, TODOIST_ATTEMPT_TIMEOUT_MS="1000") == TOMORROW
    row = reminder(probe)
    assert (row["state"], row["last_error_code"], row["next_attempt_at"]) == ("unknown", "reminder_result_unknown", 0)
    sent = len(probe.todoist.creates())
    assert tick(probe, NOW + 3600) == TOMORROW
    assert len(probe.todoist.creates()) == sent


def test_a_day_left_sending_is_recorded_as_interrupted(probe, attention):
    probe.insert(
        "mail_reminders",
        day="2026-09-28",
        state="sending",
        subject="t",
        body="b",
        attention_count=2,
        created_at=NOW - 60,
        updated_at=NOW - 60,
    )
    assert tick(probe, NOW) == TOMORROW
    row = reminder(probe)
    assert (row["state"], row["last_error_code"], row["attempts"]) == ("unknown", "interrupted_reminder_call", 1)
    assert probe.todoist.creates() == []


def test_page_walks_days_newest_first(probe):
    for day, state, task_id, code, next_at in (
        ("2026-09-26", "created", "t1", "", 0),
        ("2026-09-27", "failed", "", "reminder_create_failed", NOW),
        ("2026-09-28", "unknown", "", "empty_task_id", 0),
    ):
        probe.insert(
            "mail_reminders",
            day=day,
            state=state,
            task_id=task_id,
            attention_count=1,
            attempts=1,
            next_attempt_at=next_at,
            last_error_code=code,
            created_at=NOW,
            updated_at=NOW,
        )
    first = probe.call("/reminder/page", limit=2)
    assert [item["day"] for item in first["items"]] == ["2026-09-28", "2026-09-27"]
    assert first["next_day"] == "2026-09-27"
    second = probe.call("/reminder/page", limit=2, before_day=first["next_day"])
    assert [item["day"] for item in second["items"]] == ["2026-09-26"]
    assert second["next_day"] is None

    items = first["items"] + second["items"]
    for item in items:
        assert component_errors("Reminder", item) == []
    assert items[0] == {
        "day": "2026-09-28",
        "state": "unknown",
        "task_id": None,
        "attention_count": 1,
        "attempts": 1,
        "error_code": "empty_task_id",
        "next_attempt_at": None,
        "created_at": "2026-09-28T15:00:00Z",
        "updated_at": "2026-09-28T15:00:00Z",
        "imported": False,
    }
    assert (items[1]["next_attempt_at"], items[2]["task_id"]) == ("2026-09-28T15:00:00Z", "t1")
