"""core/metrics.py: data point shape, counters, percentiles, days and the API series."""

import json
import sqlite3
from pathlib import Path

import pytest
from ziyixi_proto.todofy.ui.v1 import history_pb
from ziyixi_proto.wire_json import from_wire

from todofy.core import metrics, owner_ui
from todofy.core.metrics import Key, Step, StepPoint
from todofy.core.sql import metrics as sql

ROOT = Path(__file__).parents[2]


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
        (StepPoint(Step.TASK, "created", attempts=3), {"todoist_creates": 3}),
        (StepPoint(Step.REMINDER, "retry_later", attempts=1), {"todoist_creates": 1}),
        (StepPoint(Step.LOOKUP, "todo_created"), {"todoist_lookups": 1}),
        (StepPoint(Step.REVIEW, "created", attempts=1), {"todoist_creates": 1}),
        (StepPoint(Step.GTD, "ok"), {}),
        (StepPoint(Step.INTENT, "created", attempts=2), {"todoist_creates": 2}),
        (StepPoint(Step.INTENT_LOOKUP, "created"), {"todoist_lookups": 1}),
        (StepPoint(Step.TASK, "retry_later", attempts=0), {}),
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
