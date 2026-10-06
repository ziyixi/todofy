"""core/intents.py and core/sql/intents.py (task-intent-v1) on the host: the canonical form and
its hash, task text, the per-task state machine, the intent summary, and the ledger SQL on
SQLite with every migration applied (the record batch, the daily limit, the proposer's retry,
retention)."""

import ast
import json
import re
import sqlite3
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from tests import mail_contract
from todofy.core import intents
from todofy.core.backoff import DAY
from todofy.core.classify import TaskResult
from todofy.core.intents import ErrorCode, IntentState, Task, TaskState
from todofy.core.ops import InvalidInput
from todofy.core.sql import intents as sql
from todofy.core.sql import retention as retention_sql
from todofy.core.vocab import Code

FIXTURES = mail_contract.TODOFY.parent / "contracts" / "task-intent-v1" / "fixtures"
MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
NOW = 1_790_000_000
BASE = 60.0  # the production backoff base, seconds


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / "TaskIntent" / name).read_text())


def parsed(name: str = "subtasks-3.json", **changes: Any) -> intents.Intent:
    return intents.intent(fixture(name) | changes)


# ---- canonical form ------------------------------------------------------------------------


def test_the_canonical_form_is_schema_order_compact_and_pinned():
    """The hash freezes an intent for ever: a change here would turn every replay into a conflict."""
    value = parsed()
    assert value.canonical.startswith(
        '{"version":"task-intent-v1","source":"watch","intent_id":"digest-2026-09-30","mode":"subtasks",'
        '"parent":{"title":"网页监视 2026-09-30 · 3 个监视","description":"'
    )
    assert json.loads(value.canonical) == fixture("subtasks-3.json")
    assert value.sha256 == "d5bf27df8b4ae830b7059eb981ed730807431d4eb409e823e8634d223e3b5feb"
    reordered = {key: fixture("subtasks-3.json")[key] for key in reversed(list(fixture("subtasks-3.json")))}
    reordered["items"] = [dict(reversed(list(item.items()))) for item in reordered["items"]]
    assert intents.intent(reordered).sha256 == value.sha256
    assert parsed(mode="separate").sha256 != value.sha256


# The canonical form and hash of every intent fixture. Recorded intents keep their hashes in D1 for 400 days: a
# replay must hash the same, so a pin changes only with its fixture's content (the four generic fixtures were
# re-sourced to the watch app on 2026-10-05), never with the code.
PINNED = {
    "max-items.json": "37d5b5ab722c3ad2a70fc9caa8a8a39c6369b0268e6612571cac516a2eda2f67",
    "minimal.json": "701ed055316779c3554983d71f1425385ba0cdfb48bb781fd75e8cd77388d313",
    "separate-2.json": "4a08134bf5ba5c360ee0c823f798c8dbbe432985c8ecb6b4785ceba489ee942d",
    "subtasks-3.json": "d5bf27df8b4ae830b7059eb981ed730807431d4eb409e823e8634d223e3b5feb",
    # The watch app's digest and urgent intents (SOURCE_WATCH, 2026-10-01): the bytes watch/worker builds for its
    # synthetic state (its intent golden test compares them with these fixtures).
    "watch-digest.json": "8c770cf825eb116a9867ba4fb96f11a8cc10b88eb94c1c2b28555230c19d6b9a",
    "watch-urgent.json": "bcea5917d607cb5b31de2cee3b8f11284582b48417ef8795ff74bbb7f2b82442",
}


def test_every_intent_fixture_keeps_its_pinned_canonical_bytes_and_hash():
    assert sorted(PINNED) == sorted(path.name for path in (FIXTURES / "TaskIntent").glob("*.json"))
    for name, digest in PINNED.items():
        value = parsed(name)
        # The canonical form is the fixture's own compact JSON (fixtures are in schema order).
        assert value.canonical == json.dumps(fixture(name), ensure_ascii=False, separators=(",", ":")), name
        assert value.sha256 == digest, name


def test_numbers_and_totals():
    subtasks, separate = parsed(), parsed("separate-2.json")
    assert (subtasks.tasks_total, list(subtasks.task_numbers)) == (4, [0, 1, 2, 3])
    assert (separate.tasks_total, list(separate.task_numbers)) == (2, [1, 2])


@pytest.mark.parametrize(
    "text",
    [
        None,
        "",
        "[1]",
        '{"version": NaN}',
        "x" * (intents.INTENT_MAX_BYTES + 1),
        json.dumps({"a": "题" * 22_000}, ensure_ascii=False),  # under the character count, over the bytes
    ],
)
def test_loads_refuses_what_is_not_bounded_json(text):
    with pytest.raises(InvalidInput):
        intents.intent(intents.loads(text))


def test_a_lone_surrogate_is_refused():
    text = json.dumps(fixture("minimal.json"), separators=(",", ":"))
    text = text.replace('"items":[{"title":"', '"items":[{"title":"\\ud800')
    assert "\\ud800Minimal" in text
    with pytest.raises(InvalidInput):
        intents.intent(intents.loads(text))


# ---- task text -----------------------------------------------------------------------------


def test_task_text_in_subtasks_mode():
    value = parsed()
    assert intents.task_text(value, 0) == (
        "网页监视 2026-09-30 · 3 个监视",
        "只有名称、类型和次数（合成示例）\nhttps://watch.ziyixi.science/\n\nTodofy intent: watch/digest-2026-09-30#0",
    )
    assert intents.task_text(value, 1) == (
        "A Synthetic Watch of Fixture Prices for Contract Tests",
        "合成示例：数值 2 次变化，变化的内容请在网页监视中查看。\n\n"
        "https://watch.ziyixi.science/watches/w2609-00001\n\nTodofy intent: watch/digest-2026-09-30#1",
    )
    # No description: the URL and the footer; titles are sent as given.
    assert intents.task_text(value, 3) == (
        'Placeholder Watch With "Quotes" & Ampersands <tags>',
        "https://watch.ziyixi.science/watches/w2609-00003\n\nTodofy intent: watch/digest-2026-09-30#3",
    )


def test_task_text_in_separate_mode_names_the_parent():
    value = parsed(mode="separate")
    content, description = intents.task_text(value, 2)
    assert content == "合成示例：面向小规模个人站点的价格监视"
    assert description.endswith("\n\n— 网页监视 2026-09-30 · 3 个监视\n\nTodofy intent: watch/digest-2026-09-30#2")
    with pytest.raises(ValueError):
        intents.task_text(value, 0)


def test_task_text_of_a_watch_digest_links_to_the_app_only():
    """SOURCE_WATCH: the owner's names, trigger types and counts, each linking to its watch in the app; the footer
    names the source, so a lookup never confuses one source's task with another's."""
    value = parsed("watch-digest.json")
    assert (value.source, value.tasks_total) == ("watch", 5)
    assert intents.urls_allowed(value, watch_host="watch.ziyixi.science")
    assert intents.task_text(value, 2) == (
        "合成示例：水壶价格 · 数值 2 次变化",
        "https://watch.ziyixi.science/watches/kettle\n\nTodofy intent: watch/digest-2026-10-01#2",
    )
    urgent = parsed("watch-urgent.json")
    assert intents.task_text(urgent, 1)[1] == (
        "https://watch.ziyixi.science/watches/tickets\n\n— 网页监视 · 紧急变化\n\n"
        "Todofy intent: watch/urgent-mg7q3k2a0b1c2d3e#1"
    )


def test_each_source_links_only_to_its_own_hosts():
    """A watch intent may link only to the watch app; a source without hosts (or a retired one) links nowhere."""
    watch = fixture("watch-digest.json")
    assert intents.urls_allowed(intents.intent(watch), watch_host="watch.ziyixi.science")
    assert not intents.urls_allowed(
        intents.intent(watch | {"items": [{"title": "t", "url": "https://other.example.com/abs/1"}]}),
        watch_host="watch.ziyixi.science",
    )
    assert set(intents.url_hosts("watch.ziyixi.science")) == set(intents.SOURCES) == {"watch"}
    assert not intents.urls_allowed(
        intents.intent(watch | {"items": [{"title": "t", "url": "https://shop.example.com/kettle"}]}),
        watch_host="watch.ziyixi.science",
    )  # a watched page's host is never on the list


def test_watch_host_follows_the_callers_deployment_without_rewriting_frozen_intent():
    watch = fixture("watch-digest.json")
    historical = intents.intent(watch)
    assert not intents.urls_allowed(historical, watch_host="watch.example.test")
    moved = watch | {
        "items": [
            dict(item, url=item["url"].replace("watch.ziyixi.science", "watch.example.test")) for item in watch["items"]
        ]
    }
    current = intents.intent(moved)
    assert intents.urls_allowed(current, watch_host="watch.example.test")
    assert not intents.urls_allowed(current, watch_host="watch.ziyixi.science")
    assert historical.canonical == intents.intent(watch).canonical


def test_a_parent_without_description_is_only_its_footer():
    value = parsed("minimal.json")
    assert intents.task_text(value, 0)[1] == intents.footer("watch", value.intent_id, 0)


def test_footers_match_exactly_and_only_as_the_last_line():
    footer = intents.footer("watch", "digest-2026-09-30", 1)
    assert intents.has_footer(f"text\n\n{footer}", footer)
    assert intents.has_footer(f"text\r\n{footer} \n", footer)
    assert not intents.has_footer(f"{footer} (edited)", footer)
    assert not intents.has_footer(f"{footer}\n\nmore", footer)  # quoted in a description, not its footer
    assert not intents.has_footer("", footer)
    assert not intents.has_footer(f"{footer}2", footer)  # #12 is another task
    assert not intents.has_footer(footer.replace("09-30", "09-29"), footer)
    assert not intents.has_footer(intents.footer("watch", "digest-2026-09-30-x", 1), footer)


# ---- the state machine ---------------------------------------------------------------------


def task(n: int = 1, state: str = TaskState.PENDING, **fields: Any) -> Task:
    """A task_intent_tasks row as D1 returns it (error codes by wire name), read the way the runtime reads it."""
    base = {
        "n": n,
        "request_id": f"00000000-0000-4000-8000-{n:012d}",
        "state": state,
        "attempts": 0,
        "next_attempt_at": NOW,
        "todoist_id": None,
        "error_code": "",
        "started_at": NOW - 60,
    }
    return Task.from_row(base | fields)


def create(t: Task, result: TaskResult, code: str | None = None, retry_after: float = 0.0, task_id: str = ""):
    return intents.after_create(
        t, result, code, retry_after, task_id, NOW, backoff_base=BASE, lookup_at=NOW + 120, blocked_until=NOW + 21600
    )


def test_created():
    after, stop = create(task(state=TaskState.SENDING), TaskResult.CREATED, task_id="6X1")
    assert (after.state, after.todoist_id, after.attempts, after.next_attempt_at, stop) == (
        "created",
        "6X1",
        1,
        0,
        False,
    )


def test_unknown_goes_to_the_lookup_and_is_never_resent_from_here():
    after, stop = create(task(attempts=3), TaskResult.UNKNOWN, Code.TODO_RESULT_UNKNOWN)
    assert (after.state, after.attempts, after.next_attempt_at, stop) == ("unknown", 0, NOW + 120, False)


def test_auth_block_holds_the_task_and_ends_the_step():
    after, stop = create(task(attempts=2), TaskResult.BLOCKED, Code.TODOIST_AUTH_BLOCKED)
    assert (after.state, after.attempts, after.next_attempt_at, stop) == ("pending", 2, NOW + 21600, True)


def test_a_4xx_refusal_fails_the_task_at_once():
    after, stop = create(task(), TaskResult.RETRY_LATER, Code.TODOIST_REJECTED)
    assert (after.state, after.error_code, after.next_attempt_at, stop) == (
        "failed",
        ErrorCode.TODOIST_REJECTED,
        0,
        False,
    )


@pytest.mark.parametrize(
    ("code", "retry_after", "wait", "error"),
    [
        (Code.TODOIST_RATE_LIMITED, 0.0, 60 * 4, ErrorCode.RATE_LIMITED),
        (Code.TODOIST_RATE_LIMITED, 900.0, 900, ErrorCode.RATE_LIMITED),
        (Code.TODOIST_UNAVAILABLE, 0.0, 60 * 4, ErrorCode.RETRY_WAIT),
    ],
)
def test_transient_failures_back_off_durably(code, retry_after, wait, error):
    after, stop = create(task(attempts=2), TaskResult.RETRY_LATER, code, retry_after)
    assert (after.state, after.attempts, after.next_attempt_at, after.error_code, stop) == (
        "pending",
        3,
        NOW + wait,
        error,
        True,
    )


def test_automatic_attempts_stop_after_48_tries_or_7_days():
    last, _ = create(task(attempts=47), TaskResult.RETRY_LATER, Code.TODOIST_UNAVAILABLE)
    assert (last.state, last.attempts, last.error_code) == ("failed", 48, ErrorCode.TODOIST_REJECTED)
    old, _ = create(task(attempts=1, started_at=NOW - 7 * DAY), TaskResult.RETRY_LATER, Code.TODOIST_RATE_LIMITED)
    assert old.state == "failed"
    young, _ = create(task(attempts=46, started_at=NOW - 7 * DAY + 1), TaskResult.RETRY_LATER, Code.TODOIST_UNAVAILABLE)
    assert young.state == "pending"


def lookup(t: Task, found: list[str] | None) -> Task:
    return intents.after_lookup(t, found, NOW, backoff_base=BASE)


def test_lookup_outcomes():
    unknown, recheck = task(state=TaskState.UNKNOWN), task(state=TaskState.RECHECK)
    assert lookup(unknown, ["6X9"]).state == lookup(recheck, ["6X9"]).state == "created"
    assert lookup(unknown, ["6X9", "6X10"]).todoist_id == "6X9"  # duplicates made elsewhere: keep one
    assert (lookup(unknown, []).state, lookup(unknown, []).error_code) == ("failed", ErrorCode.TODOIST_RESULT_UNKNOWN)
    resend = lookup(recheck, [])
    assert (resend.state, resend.next_attempt_at, resend.attempts) == ("pending", NOW, 0)
    retry = lookup(unknown, None)
    assert (retry.state, retry.attempts, retry.next_attempt_at) == ("unknown", 1, NOW + 60)
    gave_up = lookup(task(state=TaskState.RECHECK, attempts=intents.LOOKUP_MAX_ATTEMPTS - 1), None)
    assert (gave_up.state, gave_up.error_code) == ("failed", ErrorCode.TODOIST_RESULT_UNKNOWN)


def test_an_interrupted_call_becomes_unknown():
    after = intents.interrupted(task(state=TaskState.SENDING, attempts=5, error_code="retry_wait"), NOW + 120)
    assert (after.state, after.attempts, after.next_attempt_at, after.error_code) == (
        "unknown",
        0,
        NOW + 120,
        ErrorCode.UNSPECIFIED,
    )


def test_the_proposers_retry_requeues_only_unfinished_tasks():
    rows = [
        task(0, TaskState.CREATED, todoist_id="6X0"),
        task(1, TaskState.FAILED, error_code="todoist_rejected", attempts=48),
        task(2, TaskState.FAILED, error_code="todoist_result_unknown"),
        task(3, TaskState.PENDING, started_at=NOW - 30 * DAY),
    ]
    after = [intents.requeued(row, NOW) for row in rows]
    assert [(t.state, t.attempts, t.started_at) for t in after] == [
        ("created", 0, NOW - 60),
        ("pending", 0, NOW),
        ("recheck", 0, NOW),
        ("pending", 0, NOW),
    ]


def plan(mode: str, tasks: list[Task], **limits: Any) -> tuple[str, int] | None:
    return intents.next_action(
        mode,
        tasks,
        NOW,
        lookups_left=limits.get("lookups", 1),
        creates_left=limits.get("creates", 6),
        acted=limits.get("acted", set()),
    )


def test_children_wait_for_their_parent():
    parent, child = task(0), task(1)
    assert plan("subtasks", [parent, child]) == ("create", 0)
    assert plan("subtasks", [replace(parent, state=TaskState.UNKNOWN, next_attempt_at=NOW + 60), child]) is None
    assert plan("subtasks", [replace(parent, state=TaskState.UNKNOWN), child]) == ("lookup", 0)
    assert plan("subtasks", [replace(parent, state=TaskState.FAILED), child]) is None
    assert plan("subtasks", [replace(parent, state=TaskState.CREATED, todoist_id="6X0"), child]) == ("create", 1)
    assert plan("separate", [task(1, TaskState.FAILED), task(2)]) == ("create", 2)


def test_a_step_is_bounded():
    tasks = [task(n) for n in range(1, 4)]
    assert plan("separate", tasks, acted={1}) == ("create", 2)
    assert plan("separate", tasks, creates=0) is None
    assert plan("separate", [task(1, TaskState.UNKNOWN)], lookups=0) is None
    assert plan("separate", [task(1, next_attempt_at=NOW + 1)]) is None
    assert plan("separate", [task(1, TaskState.UNKNOWN, next_attempt_at=0)]) is None  # no lookup scheduled


def summary(mode: str, *tasks: Task) -> intents.Summary:
    return intents.summarize(mode, list(tasks))


def test_the_intent_summary():
    done = task(0, TaskState.CREATED, todoist_id="6X0")
    none = ErrorCode.UNSPECIFIED
    assert summary("subtasks", done, replace(done, n=1)) == intents.Summary(IntentState.CREATED, 2, none, 0)
    waiting = summary("subtasks", done, task(1, next_attempt_at=NOW + 5, error_code="rate_limited"), task(2))
    assert waiting == intents.Summary(IntentState.PENDING, 1, ErrorCode.RATE_LIMITED, NOW)
    # A failed parent fails the intent at once, with its code; children are never sent.
    parent_failed = summary("subtasks", task(0, TaskState.FAILED, error_code="todoist_result_unknown"), task(1))
    assert parent_failed == intents.Summary(IntentState.FAILED, 0, ErrorCode.TODOIST_RESULT_UNKNOWN, 0)
    # A parent still unknown: only its lookup time counts.
    unknown_parent = summary("subtasks", task(0, TaskState.UNKNOWN, next_attempt_at=NOW + 99), task(1))
    assert unknown_parent == intents.Summary(IntentState.PENDING, 0, none, NOW + 99)
    # Separate mode keeps going around a failed task, then ends failed.
    going = summary(
        "separate", task(1, TaskState.FAILED, error_code="todoist_rejected"), task(2, next_attempt_at=NOW + 7)
    )
    assert going == intents.Summary(IntentState.PENDING, 0, none, NOW + 7)
    ended = summary("separate", task(1, TaskState.FAILED, error_code="todoist_rejected"), replace(done, n=2))
    assert ended == intents.Summary(IntentState.FAILED, 1, ErrorCode.TODOIST_REJECTED, 0)


def test_pause_precedence_and_retry_hints():
    def held(**switches: Any) -> intents.Pause | None:
        flags = {"maintenance": False, "processing_paused": False, "force_pause": False, "blocked_until": 0}
        return intents.pause(**(flags | {"backup_active": False} | switches), now=NOW)

    assert held() is None
    assert held(maintenance=True, force_pause=True) == (ErrorCode.MAINTENANCE, 3600)
    assert held(processing_paused=True, force_pause=True) == (ErrorCode.PROCESSING_PAUSED, 3600)
    assert held(force_pause=True, blocked_until=NOW + 50) == (ErrorCode.TODOIST_PAUSED, 3600)
    assert held(blocked_until=NOW + 50, backup_active=True) == (ErrorCode.TODOIST_BLOCKED, 50)
    assert held(blocked_until=NOW) is None
    assert held(backup_active=True) == (ErrorCode.BACKUP_ACTIVE, 120)


def test_a_failed_intent_proposed_again_during_a_pause_is_answered_paused():
    row = intents.IntentRow(
        "watch", "digest-2026-09-30", "a" * 64, "subtasks", 4, 1, "failed", ErrorCode.TODOIST_REJECTED, 0, NOW, NOW
    )
    held = (ErrorCode.TODOIST_PAUSED, 3600)
    replayed = intents.describe(row, held, NOW, proposing=True)
    assert (replayed["state"], replayed["recorded"], replayed["error_code"], replayed["retry_after_seconds"]) == (
        "paused",
        True,
        "todoist_paused",
        3600,
    )
    assert (replayed["tasks_total"], replayed["tasks_created"]) == (4, 1)
    # taskIntentStatus reports what the ledger holds; without a pause the replay is the failure.
    assert intents.describe(row, held, NOW, proposing=False)["state"] == "failed"
    assert intents.describe(row, None, NOW, proposing=True)["state"] == "failed"


def test_ledger_error_codes_are_stored_by_wire_name():
    """D1 keeps the wire name ("" for none); a name this build does not know reads as none, never a crash."""
    for code in ErrorCode:
        assert intents.code_of(intents.code_name(code)) == code
    assert intents.code_name(ErrorCode.UNSPECIFIED) == ""
    assert intents.code_name(ErrorCode.TODOIST_RESULT_UNKNOWN) == "todoist_result_unknown"
    assert task(error_code="quota_exhausted").error_code == ErrorCode.UNSPECIFIED
    # The SQL's own spelling (REQUEUE_TASKS) is the wire name.
    assert f"error_code = '{intents.code_name(ErrorCode.TODOIST_RESULT_UNKNOWN)}'" in sql.REQUEUE_TASKS.sql


def test_the_daily_limit_resets_at_utc_midnight():
    assert intents.day_start(NOW) % DAY == 0 and intents.day_start(NOW) <= NOW
    assert intents.until_tomorrow(NOW) == intents.day_start(NOW) + DAY - NOW


# ---- the ledger SQL on SQLite --------------------------------------------------------------


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:", isolation_level=None)
    connection.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        connection.executescript(migration.read_text())
    yield connection
    connection.close()


def record(db: sqlite3.Connection, value: intents.Intent, now: int = NOW) -> tuple[int, sqlite3.Row | None]:
    """The record batch as runtime/intents.py sends it (D1 runs a batch as one transaction)."""
    key = (value.source, value.intent_id)
    tasks = json.dumps([[n, f"00000000-0000-4000-8000-{n:012d}"] for n in value.task_numbers])
    db.execute("BEGIN")
    fields = (value.sha256, value.mode, value.tasks_total, value.canonical, now, now, now)
    limit = (value.source, intents.day_start(now), intents.INTENTS_PER_SOURCE_PER_DAY)
    inserted = db.execute(sql.RECORD.sql, (*key, *fields, *limit)).rowcount
    db.execute(sql.RECORD_TASKS.sql, (*key, now, now, now, tasks))
    row = db.execute(sql.INTENT.sql, key).fetchone()
    db.execute("COMMIT")
    return inserted, row


def tasks_of(db: sqlite3.Connection, value: intents.Intent) -> list[sqlite3.Row]:
    return db.execute(sql.TASKS.sql, (value.source, value.intent_id)).fetchall()


def test_recording_writes_the_intent_and_its_frozen_tasks_once(db):
    value = parsed()
    inserted, row = record(db, value)
    assert inserted == 1 and (row["state"], row["tasks_total"], row["payload_json"]) == ("pending", 4, value.canonical)
    first = [(t["n"], t["request_id"], t["state"]) for t in tasks_of(db, value)]
    assert [n for n, _, _ in first] == [0, 1, 2, 3] and {state for _, _, state in first} == {"pending"}
    again, row = record(db, value, NOW + 5)
    assert again == 0 and row["created_at"] == NOW
    assert [(t["n"], t["request_id"], t["state"]) for t in tasks_of(db, value)] == first


def test_the_daily_limit_counts_new_intents_per_source_and_utc_day(db):
    for n in range(intents.INTENTS_PER_SOURCE_PER_DAY):
        assert record(db, parsed(intent_id=f"digest-{n}"))[0] == 1
    inserted, row = record(db, parsed(intent_id="digest-over"))
    assert (inserted, row) == (0, None)
    assert tasks_of(db, parsed(intent_id="digest-over")) == []
    assert record(db, parsed(intent_id="digest-over"), intents.day_start(NOW) + DAY)[0] == 1


def test_a_created_intent_holds_no_text_and_all_its_tasks(db):
    value = parsed("minimal.json")
    record(db, value)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE task_intents SET state = 'created', tasks_created = 1")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE task_intent_tasks SET state = 'created'")  # without its Todoist ID
    # A finished intent is never touched by a later step (it matches only a pending row).
    for state, count in (("created", 2), ("failed", 1)):
        db.execute(sql.INTENT_STEP.sql, (state, count, "", 0, NOW, state, value.source, value.intent_id))
    row = db.execute(sql.INTENT.sql, (value.source, value.intent_id)).fetchone()
    assert (row["state"], row["tasks_created"], row["payload_json"]) == ("created", 2, None)


def test_the_proposers_retry_requeues_a_failed_intent_once(db):
    value = parsed()
    record(db, value)
    key = (value.source, value.intent_id)
    outcomes = [(0, "created", "", "6X0"), (1, "failed", "todoist_result_unknown", None)]
    for n, state, code, todoist_id in [*outcomes, (2, "failed", "todoist_rejected", None)]:
        db.execute(sql.TASK_RESULT.sql, (state, 3, 0, todoist_id, code, NOW, *key, n, "pending"))
    db.execute("UPDATE task_intents SET state = 'failed', payload_json = NULL, tasks_created = 1")

    def requeue(now: int) -> int:
        db.execute("BEGIN")
        changed = db.execute(sql.REQUEUE.sql, (now, now, value.canonical, *key)).rowcount
        db.execute(sql.REQUEUE_TASKS.sql, (now, now, now, *key))
        db.execute("COMMIT")
        return changed

    assert requeue(NOW + 10) == 1
    row = db.execute(sql.INTENT.sql, key).fetchone()
    assert (row["state"], row["payload_json"], row["next_attempt_at"]) == ("pending", value.canonical, NOW + 10)
    assert [(t["state"], t["attempts"], t["started_at"]) for t in tasks_of(db, value)] == [
        ("created", 3, NOW),
        ("recheck", 0, NOW + 10),
        ("pending", 0, NOW + 10),
        ("pending", 0, NOW + 10),
    ]
    # A second retry while it is pending changes nothing (changes() = 0 guards the tasks).
    db.execute(sql.TASK_RESULT.sql, ("failed", 0, 0, None, "todoist_rejected", NOW, *key, 3, "pending"))
    assert requeue(NOW + 20) == 0
    assert tasks_of(db, value)[3]["state"] == "failed"


def test_retention_drops_failed_text_after_30_days_and_rows_after_400(db):
    fresh, failed_old, done_old = (
        parsed(intent_id="fresh"),
        parsed(intent_id="failed-old"),
        parsed(intent_id="done-old"),
    )
    for value in (fresh, failed_old, done_old):
        record(db, value)
    db.execute(
        "UPDATE task_intents SET state = 'failed', updated_at = ? WHERE intent_id = 'failed-old'", (NOW - 31 * DAY,)
    )
    db.execute("UPDATE task_intent_tasks SET state = 'created', todoist_id = 'x' WHERE intent_id = 'done-old'")
    db.execute(
        "UPDATE task_intents SET state = 'created', tasks_created = 4, payload_json = NULL, updated_at = ?"
        " WHERE intent_id = 'done-old'",
        (NOW - 401 * DAY,),
    )
    now = NOW
    db.execute(retention_sql.EXPIRE_FAILED_INTENT_TEXT.sql, (now - 30 * DAY, 100))
    db.execute(retention_sql.EXPIRE_INTENT_TASKS.sql, (now - 400 * DAY, 100))
    db.execute(retention_sql.EXPIRE_INTENTS.sql, (now - 400 * DAY, 100))
    rows = {row["intent_id"]: row["payload_json"] for row in db.execute("SELECT * FROM task_intents")}
    assert rows == {"fresh": fresh.canonical, "failed-old": None}
    assert {row[0] for row in db.execute("SELECT DISTINCT intent_id FROM task_intent_tasks")} == {"fresh", "failed-old"}


def test_the_retention_tick_uses_every_expiry_within_its_documented_budget():
    """runtime/retention.tick (not importable on the host) sends one D1 batch: every EXPIRE_* query once, so
    at most thirteen writes, the number its docstring and docs/dev-notes.md state (D1 Free: 50 per call)."""
    root = mail_contract.TODOFY
    source = (root / "worker" / "todofy" / "runtime" / "retention.py").read_text()
    [tick] = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.AsyncFunctionDef)]
    body = ast.unparse(tick)
    used = re.findall(r"\bsql\.(EXPIRE_[A-Z_]+)\b", body)
    expiries = [name for name in vars(retention_sql) if name.startswith("EXPIRE_")]
    assert sorted(used) == sorted(expiries) and len(set(used)) == len(used)
    assert body.count("await db.batch(") == 1 and body.count("await ") == 1
    words = {12: "twelve", 13: "thirteen", 14: "fourteen"}
    assert f"at most {words[len(used)]} bounded writes" in (ast.get_docstring(tick) or "")
    notes = (root / "docs" / "dev-notes.md").read_text()
    assert f"≤ {len(used)} bounded writes per call" in notes
    assert len(used) <= 50


def test_an_intent_goes_only_once_its_tasks_are_gone(db):
    value = parsed("max-items.json")
    record(db, value)
    db.execute("UPDATE task_intents SET state = 'failed', updated_at = ?", (NOW - 401 * DAY,))
    db.execute(retention_sql.EXPIRE_INTENT_TASKS.sql, (NOW - 400 * DAY, 10))
    db.execute(retention_sql.EXPIRE_INTENTS.sql, (NOW - 400 * DAY, 10))
    assert db.execute("SELECT count(*) FROM task_intents").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM task_intent_tasks").fetchone()[0] == value.tasks_total - 10


def test_status_counts(db):
    for name, state, updated in (("a", "pending", NOW), ("b", "failed", NOW - DAY), ("c", "failed", NOW - 8 * DAY)):
        record(db, parsed(intent_id=name))
        db.execute("UPDATE task_intents SET state = ?, updated_at = ? WHERE intent_id = ?", (state, updated, name))
    row = db.execute(sql.COUNTS.sql, (NOW - 7 * DAY,)).fetchone()
    assert (row["pending"], row["failed"]) == (1, 1)
    db.execute("DELETE FROM task_intents")
    row = db.execute(sql.COUNTS.sql, (NOW - 7 * DAY,)).fetchone()
    assert (row["pending"], row["failed"]) == (0, 0)


@pytest.mark.parametrize(
    ("column", "value"),
    [("source", "Watch"), ("mode", "both"), ("state", "paused"), ("tasks_total", 32), ("payload_sha256", "A" * 64)],
)
def test_intent_rows_are_checked(db, column, value):
    record(db, parsed())
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(f"UPDATE task_intents SET {column} = ?", (value,))


def test_state_checks_equal_the_vocabulary(db):
    def check(table: str, column: str) -> set[str]:
        text = db.execute("SELECT sql FROM sqlite_master WHERE name = ?", (table,)).fetchone()[0]
        body = text.split(f"{column} TEXT NOT NULL CHECK ({column} IN (", 1)[1].split("))", 1)[0]
        return {part.strip().strip("'") for part in body.split(",")}

    assert check("task_intents", "state") == set(IntentState)
    assert check("task_intent_tasks", "state") == set(TaskState)
    assert check("task_intents", "mode") == set(intents.MODES)
