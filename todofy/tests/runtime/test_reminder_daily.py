"""reminder.tick / page in real workerd against the Todoist fake: at most one task
per UTC day, claimed before the call; failed retried hourly with the frozen
request up to five times; unknown never resent that day (Go
mail_inbox_attention_test.go:355-561)."""

import json

import pytest

from tests import mail_contract
from tests.fakes.server import Reply
from tests.fakes.todoist_fake import PROJECT_ID, TASKS_PATH
from tests.runtime.reports_support import (  # noqa: F401
    NOW,
    PUBLIC_HOST,
    Probe,
    clean_fixture,
    idl_errors,
    probe_fixture,
)
from todofy.core import ops
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


def tick(probe: Probe, now: int, ops_report: dict | None = None, **vars: str) -> int:
    return probe.call("/reminder/tick", now=now, vars=vars, ops_report=ops_report)["next"]


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
        assert idl_errors("DailyReminder", item) == []
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


# ---- the ops digest (contracts/ops-v1) ---------------------------------------------------------

# Generated the evening before NOW's UTC day, as the dashboard reports (about 23:40 UTC).
REPORT = json.loads(
    (mail_contract.TODOFY.parent / "contracts" / "ops-v1" / "fixtures" / "OpsReport" / "daily.json").read_text()
) | {"generated_at": "2026-09-27T23:40:00Z"}
REPORT_MS = 1_790_552_400_000  # 2026-09-27T23:40:00Z


def digest(report: dict = REPORT) -> ops.OpsDigest:
    found = ops.digest(ops.report(report, NOW), NOW)
    assert found is not None
    return found


def test_an_ops_only_day_gets_its_one_task(probe):
    assert tick(probe, NOW, REPORT) == TOMORROW
    [create] = probe.todoist.creates()
    title, body = reminder_title(0, 4), reminder_body(0, "2026-09-28", [], PUBLIC_HOST, digest())
    assert create.json() == {"content": title, "description": body, "project_id": PROJECT_ID}
    assert create.headers["x-request-id"] == todoist_request_id(title, body, SENDER)
    row = reminder(probe)
    assert (row["state"], row["attention_count"], row["ops_count"]) == ("created", 0, 4)
    assert row["ops_generated_at"] == REPORT_MS

    newer = REPORT | {"generated_at": "2026-09-28T14:30:00Z", "items": REPORT["items"][:1]}
    assert tick(probe, NOW + 600, newer) == TOMORROW
    assert len(probe.todoist.creates()) == 1


def test_attention_and_ops_share_the_days_one_task(probe, attention):
    assert tick(probe, NOW, REPORT) == TOMORROW
    [create] = probe.todoist.creates()
    assert create.json()["content"] == reminder_title(2, 4) == "[Todofy System] Mail Hero：2 封邮件需要处理；运维 4 项"
    assert create.json()["description"] == reminder_body(2, "2026-09-28", attention, PUBLIC_HOST, digest())
    row = reminder(probe)
    assert (row["attention_count"], row["ops_count"]) == (2, 4)


def test_a_day_already_reminded_of_attention_gets_no_second_task_for_ops(probe, attention):
    assert tick(probe, NOW) == TOMORROW
    assert tick(probe, NOW + 600, REPORT) == TOMORROW
    [create] = probe.todoist.creates()
    assert create.json()["content"] == reminder_title(2)
    assert reminder(probe)["ops_count"] == 0


def test_a_retry_resends_the_frozen_text_whatever_the_report_says_now(probe):
    probe.todoist.queue("POST", TASKS_PATH, Reply(400, {"error": "no"}))
    assert tick(probe, NOW, REPORT) == NOW + 3600
    later = REPORT | {"generated_at": "2026-09-28T15:30:00Z", "items": REPORT["items"][:1]}
    assert tick(probe, NOW + 3600, later) == TOMORROW
    first, second = probe.todoist.creates()
    assert first.body == second.body and first.headers["x-request-id"] == second.headers["x-request-id"]


@pytest.mark.parametrize(
    "report",
    [
        REPORT | {"generated_at": "2026-09-27T02:59:59Z"},  # more than 36 hours old
        REPORT | {"items": [item for item in REPORT["items"] if item["severity"] == "info"]},
        REPORT | {"items": []},
        None,
    ],
    ids=["stale", "info_only", "empty", "none"],
)
def test_nothing_to_report_sends_nothing(probe, report):
    assert tick(probe, NOW, report) == NOW + 600
    assert probe.todoist.creates() == []
    assert probe.sql("SELECT day FROM mail_reminders") == []


@pytest.mark.parametrize(
    "switch", [{"REMINDER_ENABLED": "false"}, {"FORCE_PAUSE_TODOIST": "true"}, {"PROCESSING_PAUSED": "true"}]
)
def test_the_switches_hold_the_ops_digest_too(probe, switch):
    assert tick(probe, NOW, REPORT, **switch) == NOW + 600
    assert probe.todoist.creates() == []


def test_a_report_from_the_same_utc_day_waits_for_the_next_days_reminder(probe):
    today = REPORT | {"generated_at": "2026-09-28T14:00:00Z"}
    assert tick(probe, NOW, today) == NOW + 600
    assert probe.todoist.creates() == []
    assert probe.sql("SELECT day FROM mail_reminders") == []


def test_a_late_report_makes_exactly_one_task_across_midnight(probe):
    """F1: a report at 23:40 is the next UTC day's digest, sent once, never also that evening
    or again the day after while it is still within 36 hours."""
    late = REPORT | {"generated_at": "2026-09-28T23:40:00Z"}
    evening = TOMORROW - 20 * 60
    assert tick(probe, evening, late) == evening + 600
    assert tick(probe, evening + 600, late) == evening + 1200
    assert probe.todoist.creates() == []

    assert tick(probe, TOMORROW, late) == TOMORROW + DAY
    assert tick(probe, TOMORROW + 600, late) == TOMORROW + DAY
    [create] = probe.todoist.creates()
    assert create.json()["content"] == reminder_title(0, 4)
    row = reminder(probe, "2026-09-29")
    assert (row["ops_count"], row["ops_generated_at"]) == (4, REPORT_MS + DAY * 1000)

    # The day after, the same report is 24 h 20 min old: already listed, so nothing to send.
    assert tick(probe, TOMORROW + DAY, late) == TOMORROW + DAY + 600
    assert len(probe.todoist.creates()) == 1
    assert probe.sql("SELECT day FROM mail_reminders WHERE day = '2026-09-30'") == []


def test_a_report_listed_once_is_left_out_of_the_next_days_attention_task(probe, attention):
    assert tick(probe, NOW, REPORT) == TOMORROW
    assert reminder(probe)["ops_generated_at"] == REPORT_MS
    assert tick(probe, TOMORROW + 60, REPORT) == TOMORROW + DAY
    first, second = probe.todoist.creates()
    assert "运维" in first.json()["content"] and "运维" not in second.json()["content"]
    row = reminder(probe, "2026-09-29")
    assert (row["ops_count"], row["ops_generated_at"]) == (0, 0)


def test_a_failed_ops_only_day_is_retried_after_a_newer_same_day_report(probe):
    probe.todoist.queue("POST", TASKS_PATH, Reply(400, {"error": "no"}))
    assert tick(probe, NOW, REPORT) == NOW + 3600
    newer = REPORT | {"generated_at": "2026-09-28T15:30:00Z"}  # not due on its own today
    assert tick(probe, NOW + 3600, newer) == TOMORROW
    first, second = probe.todoist.creates()
    assert first.body == second.body
    assert reminder(probe)["state"] == "created"
