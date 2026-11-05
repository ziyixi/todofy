"""core/metrics.py and runtime/metrics.py: data points, counters, percentiles, days, flush walk, and API series."""

import asyncio
import json
import sqlite3
import types
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from ziyixi_proto.todofy.ui.v1 import history_pb
from ziyixi_proto.wire_json import from_wire

from tests.unit.host_support import D1, ObjectSql, stubbed_pyodide
from todofy.core import metrics, owner_ui
from todofy.core.metrics import Key, Step, StepPoint
from todofy.core.sql import metrics as sql

ROOT = Path(__file__).parents[2]
NOW = int(datetime(2026, 9, 28, 12, tzinfo=UTC).timestamp())
DAY = 86_400


def test_data_point_fits_analytics_engine_limits():
    point = StepPoint(Step.SUMMARY, "failed", "gemini_unavailable", "m" * 300, 1234, 10, 20, 3).data_point()
    assert point["indexes"] == ["summary"]
    assert point["blobs"][:3] == ["summary", "failed", "gemini_unavailable"]
    assert len(point["blobs"]) <= 20 and len(point["doubles"]) <= 20
    assert all(len(blob.encode()) <= metrics.MAX_BLOB_CHARS for blob in point["blobs"])
    assert point["doubles"] == [1234.0, 10.0, 20.0, 3.0]
    json.dumps(point)  # plain values only: it crosses to JavaScript as an Object


def test_data_point_cuts_on_a_character_boundary():
    blob = StepPoint(Step.REPORT, "ok", model="模" * 40).data_point()["blobs"][3]
    assert blob == "模" * 21 and len(blob.encode()) <= metrics.MAX_BLOB_CHARS


@pytest.mark.parametrize(
    ("point", "expected"),
    [
        (
            StepPoint(Step.SUMMARY, "ok", model="m1", tokens_in=100, tokens_out=20, attempts=2),
            {"gemini_calls": 2, "gemini_tokens:m1": 120},
        ),
        (StepPoint(Step.REPORT, "failed", attempts=1), {"gemini_calls": 1}),
        # A canary's summary call still spends the day's Gemini budget.
        (
            StepPoint(Step.CANARY, "ok", model="m1", tokens_in=10, tokens_out=5, attempts=1),
            {"gemini_calls": 1, "gemini_tokens:m1": 15},
        ),
        (StepPoint(Step.SUMMARY, "failed", attempts=0), {}),
        (StepPoint(Step.BACKUP, "ok", attempts=4), {}),
    ],
)
def test_step_counters(point, expected):
    assert point.counters() == expected


def test_tokens_key_fits_the_column():
    assert len(metrics.tokens_key("x" * 200)) == metrics.MAX_KEY_CHARS


@pytest.mark.parametrize(
    ("from_state", "to_state", "keys"),
    [
        (None, "pending", [Key.MAILS_RECEIVED]),
        ("todo_sending", "complete", [Key.MAILS_COMPLETED]),
        ("todo_created", "complete", [Key.MAILS_COMPLETED]),
        ("summarizing", "failed_summary", [Key.MAILS_FAILED]),
        ("summarizing", "pending", []),
        ("failed_summary", "ignored", []),
    ],
)
def test_transition_keys(from_state, to_state, keys):
    assert metrics.transition_keys(from_state, to_state) == keys


def test_nearest_rank_percentiles():
    assert metrics.percentile([7], 0.5) == 7 and metrics.percentile([7], 0.9) == 7
    values = list(range(1, 11))
    assert (metrics.percentile(values, 0.5), metrics.percentile(values, 0.9)) == (5, 9)
    assert metrics.percentile([1, 2, 3], 0.5) == 2


def test_day_values_mark_the_day_and_drop_zeros():
    assert metrics.day_values({}, []) == {"mails_received": 0}
    values = metrics.day_values({"mails_received": 3, "mails_failed": 0, "gemini_calls": 4}, [30, 10, 20])
    assert values == {"mails_received": 3, "gemini_calls": 4, "latency_p50_s": 20, "latency_p90_s": 30}


def test_day_arithmetic():
    assert metrics.day_of(metrics.day_start("2026-09-28")) == "2026-09-28"
    assert metrics.day_of(metrics.day_start("2026-09-28") - 1) == "2026-09-27"
    assert metrics.shift("2026-02-28", 1) == "2026-03-01"
    assert metrics.days_from("2026-09-29", "2026-10-01") == ["2026-09-29", "2026-09-30", "2026-10-01"]
    assert metrics.days_from("2026-09-29", "2026-09-28") == []


def test_daily_series_is_dense_and_matches_the_contract():
    rows = [
        ("2026-09-27", "mails_received", 5),
        ("2026-09-27", "mails_completed", 4),
        ("2026-09-27", "latency_p50_s", 12),
        ("2026-09-27", "latency_p90_s", 40),
        ("2026-09-27", "gemini_tokens:m2", 7),
        ("2026-09-27", "gemini_tokens:m1", 9),
        ("2026-09-28", "mails_received", 0),
    ]
    series = metrics.daily_series(rows, "2026-09-26", 3)
    assert [day["day"] for day in series] == ["2026-09-26", "2026-09-27", "2026-09-28"]
    assert [day["recorded"] for day in series] == [False, True, True]
    assert series[0]["mails_received"] == 0 and series[0]["latency_p50_seconds"] is None
    assert series[1]["mails_completed"] == 4 and series[1]["latency_p90_seconds"] == 40
    assert list(series[1]["gemini_tokens"].items()) == [("m1", 9), ("m2", 7)]
    assert series[2]["latency_p50_seconds"] is None and series[2]["gemini_tokens"] == {}
    # Every day is a todofy.ui.v1 MetricDay (ListMetricDays), read back strictly.
    for day in series:
        wire = json.loads(owner_ui.answer(owner_ui.metric_day(day)))
        from_wire(history_pb.MetricDay, wire, strict=True)
    assert json.loads(owner_ui.answer(owner_ui.metric_day(series[1])))["gemini_tokens"] == {"m1": 9, "m2": 7}


def test_day_write_round_trips_through_json_each():
    """WRITE_DAY stores exactly the JSON object it is given and replaces a rewritten day."""
    db = sqlite3.connect(":memory:")
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        db.executescript(migration.read_text())
    day = metrics.day_values({"mails_received": 2, "gemini_tokens:m1": 5}, [3])
    db.execute(sql.WRITE_DAY.sql, ("2026-09-28", json.dumps(day)))
    db.execute(sql.WRITE_DAY.sql, ("2026-09-28", json.dumps(day | {"mails_received": 3})))
    rows = db.execute(sql.DAYS.sql, ("2026-09-01", "2026-09-30", 100)).fetchall()
    assert rows == [
        ("2026-09-28", "gemini_tokens:m1", 5),
        ("2026-09-28", "latency_p50_s", 3),
        ("2026-09-28", "latency_p90_s", 3),
        ("2026-09-28", "mails_received", 3),
    ]
    db.execute(sql.EXPIRE_DAYS.sql, ("2026-09-29", 100))
    assert db.execute("SELECT count(*) FROM daily_metrics").fetchone() == (0,)


# ---- runtime/metrics.py ----------------------------------------------------------------------------------------


@pytest.fixture
def runtime_metrics(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import metrics as rm

        yield rm


class Store:
    """The object's ``ctx.storage.sql``: records ``exec`` calls, or fails every one."""

    def __init__(self, fail: bool = False) -> None:
        self.fail, self.calls = fail, []

    def exec(self, *args: Any) -> None:
        if self.fail:
            raise RuntimeError("SQLITE_FULL")
        self.calls.append(args)


class Dataset:
    def __init__(self, fail: bool = False) -> None:
        self.fail, self.points = fail, []

    def writeDataPoint(self, point: Any) -> None:
        if self.fail:
            raise RuntimeError("analytics engine down")
        self.points.append(point)


def _logged(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]


def test_counters_and_data_point_are_written(runtime_metrics: Any) -> None:
    env, store = types.SimpleNamespace(METRICS=Dataset()), Store()
    runtime_metrics.record(env, store, StepPoint(Step.REPORT, "ok", attempts=2), 1_790_000_000)
    assert len(env.METRICS.points) == 1
    assert [call[1:] for call in store.calls] == [("2026-09-21", "gemini_calls", 2)]


def test_a_failing_counter_write_is_only_logged(runtime_metrics: Any, capsys: pytest.CaptureFixture[str]) -> None:
    env = types.SimpleNamespace(METRICS=Dataset())
    runtime_metrics.record(env, Store(fail=True), StepPoint(Step.REPORT, "ok", attempts=1), 1_790_000_000)
    assert len(env.METRICS.points) == 1  # the data point went out before the counter failed
    assert _logged(capsys) == [{"metrics": "count_failed", "error": "RuntimeError"}]


def test_both_writes_failing_is_only_logged(runtime_metrics: Any, capsys: pytest.CaptureFixture[str]) -> None:
    env = types.SimpleNamespace(METRICS=Dataset(fail=True))
    point = StepPoint(Step.SUMMARY, "ok", model="m", tokens_in=5, tokens_out=5, attempts=1)
    runtime_metrics.record(env, Store(fail=True), point, 1_790_000_000)
    assert [entry["metrics"] for entry in _logged(capsys)] == ["write_failed", "count_failed"]
    # Missing METRICS binding is a no-op.
    runtime_metrics.write_point(types.SimpleNamespace(), point)


def _init_store(rm: Any) -> ObjectSql:
    store = ObjectSql()
    for statement in rm.DO_SCHEMA:
        store.exec(statement)
    return store


def _seed_event(
    d1: D1, event_id: str, created_at: int, transitions: list[tuple[str | None, str, int]], canary: str | None = None
) -> None:
    d1.insert(
        "mail_events",
        source_id="mail-hero-personal",
        event_id=event_id,
        payload_hash="0" * 64,
        state=transitions[-1][1],
        created_at=created_at,
        updated_at=transitions[-1][2],
        canary_run_id=canary,
    )
    for from_state, to_state, at in transitions:
        d1.insert(
            "event_transitions",
            event_id=event_id,
            at=at,
            from_state=from_state,
            to_state=to_state,
            actor="worker",
        )


def test_flush_baselines_then_walks_finished_days_and_resets_on_foreign_cursor(
    runtime_metrics: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    d1 = D1()
    store = _init_store(runtime_metrics)
    env = types.SimpleNamespace(DB=d1, MAIL_SOURCE_ID="mail-hero-personal")
    assert runtime_metrics.next_flush(store) == 0
    runtime_metrics.set_next_flush(store, 123)
    assert runtime_metrics.next_flush(store) == 123

    # Day 0 (2026-09-26): initial flush baselines cursor at the newest transition and skips partial day.
    day0 = metrics.day_start("2026-09-26") + 3600
    _seed_event(d1, "e0", day0, [(None, "pending", day0)])
    next_at = asyncio.run(runtime_metrics.flush(env, store, day0 + 60))
    assert next_at == metrics.day_start("2026-09-26") + DAY + runtime_metrics.FLUSH_OFFSET

    # Day 1 (2026-09-27): real mail completes, a straggler from 2026-09-26 arrives, a canary completes,
    # and a transition on Day 2 (today, 2026-09-28) stops the walk at midnight.
    day1 = metrics.day_start("2026-09-27") + 100
    _seed_event(d1, "straggler", day0, [("pending", "complete", day0 + 120)])
    _seed_event(d1, "e1", day1, [(None, "pending", day1), ("summarizing", "complete", day1 + 25)])
    _seed_event(d1, "canary", day1, [(None, "pending", day1 + 5), ("summarizing", "complete", day1 + 10)], canary="c1")
    _seed_event(d1, "today-e", NOW, [(None, "pending", NOW)])
    runtime_metrics.record(
        env, store, StepPoint(Step.SUMMARY, "ok", model="m1", tokens_in=10, tokens_out=5, attempts=1), day1
    )

    next_at = asyncio.run(runtime_metrics.flush(env, store, NOW))
    assert next_at == metrics.day_start("2026-09-28") + DAY + runtime_metrics.FLUSH_OFFSET
    # Flushing again on the same day has no open finished days.
    assert asyncio.run(runtime_metrics.flush(env, store, NOW + 60)) == next_at

    daily = asyncio.run(runtime_metrics.daily(d1, 2, NOW))["days"]
    assert [d["day"] for d in daily] == ["2026-09-26", "2026-09-27"]
    assert daily[0]["recorded"] is False
    assert daily[1]["recorded"] is True
    assert (daily[1]["mails_received"], daily[1]["mails_completed"], daily[1]["latency_p50_seconds"]) == (1, 1, 25)
    assert daily[1]["gemini_tokens"] == {"m1": 15}

    # Foreign/restored database: cursor no longer matches the row at that ID -> cursor_reset.
    d1.sql("UPDATE event_transitions SET event_id = 'different' WHERE id = 6")
    asyncio.run(runtime_metrics.flush(env, store, NOW))
    assert _logged(capsys)[-1]["metrics"] == "cursor_reset"


def test_walk_stops_after_max_pages_and_day_page_bounds(runtime_metrics: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    d1 = D1()
    store = _init_store(runtime_metrics)
    env = types.SimpleNamespace(DB=d1, MAIL_SOURCE_ID="mail-hero-personal")
    # Baseline on an empty ledger (cursor = 0, flushed_day = 2026-09-25).
    day_base = metrics.day_start("2026-09-25") + 60
    asyncio.run(runtime_metrics.flush(env, store, day_base))

    monkeypatch.setattr(runtime_metrics, "WALK_PAGE", 1)
    monkeypatch.setattr(runtime_metrics, "WALK_PAGES", 2)
    day1 = metrics.day_start("2026-09-26") + 100
    _seed_event(
        d1,
        "e1",
        day1,
        [(None, "pending", day1), ("pending", "summarizing", day1 + 1), ("summarizing", "complete", day1 + 2)],
    )
    # 3 transitions with WALK_PAGE=1, WALK_PAGES=2 -> _walk returns False and flush schedules CONTINUE.
    assert asyncio.run(runtime_metrics.flush(env, store, NOW)) == NOW + runtime_metrics.CONTINUE
    # Next call finishes the walk and writes the 2 finished days (2026-09-26 and 2026-09-27).
    assert asyncio.run(runtime_metrics.flush(env, store, NOW)) > NOW + runtime_metrics.CONTINUE

    # day_page: normal page, and before <= oldest returns ([], None).
    days, before = asyncio.run(runtime_metrics.day_page(d1, 2, None, NOW))
    assert [d["day"] for d in days] == ["2026-09-27", "2026-09-26"]
    assert before == "2026-09-26"
    oldest = metrics.day_of(NOW - runtime_metrics.KEEP_DAYS * DAY)
    assert asyncio.run(runtime_metrics.day_page(d1, 10, oldest, NOW)) == ([], None)
    _, last_before = asyncio.run(runtime_metrics.day_page(d1, 5, metrics.shift(oldest, 2), NOW))
    assert last_before is None
