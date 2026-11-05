"""core/carryover.py: which pending mail the morning brief carries, and its lines (synthetic summaries only)."""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from todofy.core import carryover
from todofy.core.sql import reports as report_sql

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
NOW = int(datetime(2026, 10, 4, 13, tzinfo=UTC).timestamp())
DAY = 86_400


def test_carried_lines_say_how_many_days_ago():
    assert carryover.carried_line("缴费", NOW, NOW - DAY - 5) == "[1 天前] 缴费"
    assert carryover.carried_line("缴费", NOW, NOW - 13 * DAY) == "[13 天前] 缴费"
    assert carryover.carried_line("缴费", NOW, NOW - 3600) == "[1 天前] 缴费"  # never "0 days"
    # A long stored summary (up to 64 KiB) is cut on a UTF-8 boundary.
    long = carryover.carried_line("缴" * 2000, NOW, NOW - 2 * DAY)
    assert long.startswith("[2 天前] 缴")
    assert len(long.encode()) <= carryover.CARRYOVER_LINE_BYTES + len("[2 天前] ".encode())
    long.encode().decode()


def candidates(now: int, per_day: dict[int, int]) -> list[dict[str, object]]:
    """``per_day`` maps "N 天前" to how much pending mail arrived that day."""
    rows = []
    for days, count in per_day.items():
        for index in range(count):
            rows.append({"event_id": f"d{days}-{index}", "created_at": now - days * DAY - 60 * (index + 1)})
    return rows


def test_the_carryover_is_spread_over_the_days_oldest_day_first():
    # A normal week: 40 pending mail from yesterday, 5 from 2 days ago, 2 each from 9 and 13 days ago.
    picked = carryover.pick_carried(candidates(NOW, {1: 40, 2: 5, 9: 2, 13: 2}), NOW)
    assert len(picked) == carryover.CARRYOVER_MAX_ROWS
    days = {day: sum(event.startswith(f"d{day}-") for event in picked) for day in (1, 2, 9, 13)}
    # Every older mail is carried; yesterday's fill the rest, newest first.
    assert days == {1: 21, 2: 5, 9: 2, 13: 2}
    assert picked[:4] == ["d13-0", "d9-0", "d2-0", "d1-0"]
    assert [event for event in picked if event.startswith("d1-")] == [f"d1-{index}" for index in range(21)]
    # More days than slots in a round: the oldest days go first.
    many = carryover.pick_carried(candidates(NOW, {day: 5 for day in range(1, 14)}), NOW, cap=15)
    assert sorted({int(event[1:].split("-")[0]) for event in many[:13]}) == list(range(1, 14))
    assert many[13:] == ["d13-1", "d12-1"]
    assert carryover.pick_carried([], NOW) == []


def test_carried_lines_keep_the_pick_order_until_the_byte_cap_then_newest_first():
    rows = [
        {"event_id": "old", "summary": "旧", "created_at": NOW - 9 * DAY},
        {"event_id": "new", "summary": "新", "created_at": NOW - DAY - 60},
    ]
    assert carryover.carried_lines(rows, ["old", "new", "gone"], NOW) == ["[1 天前] 新", "[9 天前] 旧"]
    big = [{"event_id": f"e{i}", "summary": "长" * 400, "created_at": NOW - (2 + i) * DAY} for i in range(30)]
    lines = carryover.carried_lines(big, [f"e{i}" for i in range(30)], NOW)
    assert sum(len(line.encode()) + 1 for line in lines) <= carryover.CARRYOVER_MAX_BYTES
    # The cap keeps the first picks in pick order (e0, e1, ...), shown newest first.
    assert 0 < len(lines) < 30
    assert lines[0].startswith("[2 天前]") and lines[-1].startswith(f"[{1 + len(lines)} 天前]")


def summary(db: sqlite3.Connection, event_id: str, created_at: int, text: str, **columns: object) -> None:
    row = {"event_id": event_id, "created_at": created_at, "subject": "s", "summary": text, "model": "m", **columns}
    db.execute(f"INSERT INTO summaries ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


def test_the_candidates_are_older_pending_mail_and_the_picks_are_read_by_id():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        db.executescript(migration.read_text())
    summary(db, "in-window", NOW - 3600, "今天的")
    summary(db, "edge", NOW - DAY, "正好 24 小时")  # the window is (now-24h, now]: carried
    summary(db, "converted", NOW - 2 * DAY, "已转成任务", task_id="t-done", triaged_at=NOW - DAY)
    summary(db, "imported", NOW - 2 * DAY, "导入的", imported=1)
    summary(db, "too-old", NOW - 14 * DAY, "太旧")
    for index in range(3, 40):
        summary(db, f"e{index}", NOW - DAY - 60 * index, f"摘要 {index}")
    summary(db, "long", NOW - 3 * DAY, "长" * 5000)
    bind = (NOW - 14 * DAY, NOW - DAY, carryover.MAX_CANDIDATES)
    rows = [dict(row) for row in db.execute(report_sql.CARRYOVER_CANDIDATES.sql, bind)]
    # IDs and times only, newest first, every pending one (the cap of 30 is pick_carried's).
    assert set(rows[0]) == {"event_id", "created_at"}
    assert [row["event_id"] for row in rows] == ["edge"] + [f"e{index}" for index in range(3, 40)] + ["long"]
    order = carryover.pick_carried(rows, NOW)
    assert len(order) == carryover.CARRYOVER_MAX_ROWS and order[0] == "long"  # the oldest day first
    ids = order + [""] * (carryover.CARRYOVER_MAX_ROWS - len(order))
    picked = {
        row["event_id"]: row["summary"]
        for row in db.execute(report_sql.CARRYOVER_SUMMARIES.sql, (carryover.CARRYOVER_READ_CHARS, *ids))
    }
    assert set(picked) == set(order) and len(picked["long"]) == carryover.CARRYOVER_READ_CHARS
    # Unused places are bound to '' and match nothing.
    assert list(db.execute(report_sql.CARRYOVER_SUMMARIES.sql, (10, "edge", *[""] * 29))) != []


# ---- runtime/reports.py carryover (host SQLite + stubbed Pyodide) --------------------------


import json  # noqa: E402

import jsonschema  # noqa: E402
import pytest  # noqa: E402

from tests.unit.host_support import HostProbe, host_probe, text_reply  # noqa: E402
from todofy.core import prompts  # noqa: E402

HOUR = 3_600
TODAY = datetime.fromtimestamp(NOW, UTC).strftime("%Y-%m-%d")
SCHEMA = json.loads((Path(__file__).parents[2] / "api" / "recommendation-v1.schema.json").read_text())
TASKS = [{"rank": 1, "title": "续签护照", "reason": "两周前的提醒仍未处理。"}]


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch):
    with host_probe(monkeypatch) as p:
        yield p


def probe_summary(probe: HostProbe, event_id: str, created_at: int, text: str, **columns: object) -> None:
    probe.insert("summaries", event_id=event_id, created_at=created_at, subject="s", summary=text, model="m", **columns)


@pytest.fixture
def mail(probe: HostProbe) -> None:
    """Two new summaries and five older ones: two still pending, one converted, one imported, one too old."""
    probe_summary(probe, "new-1", NOW - 5 * HOUR, "新邮件一")
    probe_summary(probe, "new-2", NOW - HOUR, "新邮件二")
    probe_summary(probe, "old-pending-2d", NOW - 2 * DAY - HOUR, "两天前仍待处理")
    probe_summary(probe, "old-pending-9d", NOW - 9 * DAY, "九天前仍待处理")
    probe_summary(
        probe, "old-converted", NOW - 3 * DAY, "已转成任务的旧邮件", task_id="t-done", triaged_at=NOW - 2 * DAY
    )
    probe_summary(probe, "old-imported", NOW - 4 * DAY, "导入的旧邮件", imported=1)
    probe_summary(probe, "too-old", NOW - 15 * DAY, "十五天前")


def recommendation(probe: HostProbe, **overrides: str) -> dict:
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    result = probe.call("/reports/compute", kind="recommendation", top_n=10, now=NOW, budget_ms=10_000, vars=overrides)
    return result["report"]


def test_older_pending_mail_is_carried_after_the_new_mail(probe: HostProbe, mail: None) -> None:
    report = recommendation(probe)
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10, carryover=True)
    carried = ["[2 天前] 两天前仍待处理", "[9 天前] 九天前仍待处理"]
    assert prompts.report_input(["新邮件一", "新邮件二", *carried]) in call.user
    for text in ("已转成任务的旧邮件", "导入的旧邮件", "十五天前"):
        assert text not in call.user
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == ("ok", 4, 2, 2)
    assert report["tasks"] == TASKS
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(report)) == []
    [stored] = probe.sql("SELECT task_count, payload_json FROM daily_reports")
    assert stored["task_count"] == 4 and json.loads(stored["payload_json"]) == report


def test_carryover_is_capped_at_30_and_spread_over_the_days(probe: HostProbe) -> None:
    """A normal volume: 35 pending mail from yesterday must not push out the mail pending for 5 and 12 days."""
    for index in range(35):
        probe_summary(probe, f"e{index}", NOW - DAY - 60 * (index + 1), f"昨天 {index}")
    probe_summary(probe, "d5", NOW - 5 * DAY, "五天前仍待处理")
    probe_summary(probe, "d12", NOW - 12 * DAY, "十二天前仍待处理")
    report = recommendation(probe)
    [call] = probe.gemini.calls()
    lines = [line for line in call.user.splitlines() if line.startswith("[")]
    assert len(lines) == 30 and "[5 天前] 五天前仍待处理" in lines and lines[-1] == "[12 天前] 十二天前仍待处理"
    assert lines[:28] == [f"[1 天前] 昨天 {index}" for index in range(28)]  # newest first
    assert (report["new_count"], report["carryover_count"], report["task_count"]) == (0, 30, 30)
    assert report["status"] == "ok"  # no new mail, but pending mail: not an empty window


def test_a_long_stored_summary_is_carried_cut(probe: HostProbe, mail: None) -> None:
    probe_summary(probe, "long", NOW - 3 * DAY, "长" * 20_000)
    recommendation(probe)
    [call] = probe.gemini.calls()
    [line] = [line for line in call.user.splitlines() if line.startswith("[3 天前]")]
    assert len(line.encode()) <= carryover.CARRYOVER_LINE_BYTES + len("[3 天前] ".encode())


def test_switched_off_the_report_is_exactly_the_24_hour_one(probe: HostProbe, mail: None) -> None:
    report = recommendation(probe, REPORT_CARRYOVER_DAYS="0")
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10)
    assert prompts.report_input(["新邮件一", "新邮件二"]) in call.user and "天前" not in call.user
    assert (report["task_count"], report["new_count"], report["carryover_count"]) == (2, 2, 0)


@pytest.mark.parametrize("marker", ["INDEXED BY summaries_pending", "substr(summary, 1, ?)"], ids=["pending", "lines"])
def test_a_failed_carryover_read_falls_back_to_the_24_hour_report(probe: HostProbe, mail: None, marker: str) -> None:
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "fail_sql": marker}
    report = probe.call("/reports/compute", **args)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("ok", 2, 0)


def test_after_a_failed_attempt_today_the_report_is_exactly_the_24_hour_one(probe: HostProbe, mail: None) -> None:
    """A Gemini error or unusable answer with the carryover costs the brief one attempt at most."""
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    failures = {f"recommendation/10/{TODAY}": 1}
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "failures": failures}
    report = probe.call("/reports/compute", **args)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("ok", 2, 0)


def test_a_token_budget_too_small_for_the_carryover_falls_back_to_the_24_hour_report(
    probe: HostProbe, mail: None
) -> None:
    plain = probe.call(
        "/reports/compute",
        kind="recommendation",
        top_n=10,
        now=NOW,
        budget_ms=10_000,
        tokens=False,
        vars={"REPORT_CARRYOVER_DAYS": "0"},
    )
    [[_, reserve, _]] = [call for call in plain["budget"] if call[0] == "reserve"]
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "token_limit": reserve}
    result = probe.call("/reports/compute", **args)
    reserves = [call[1] for call in result["budget"] if call[0] == "reserve"]
    assert len(reserves) == 2 and reserves[0] > reserve and reserves[1] == reserve
    [call] = probe.gemini.calls()  # one Gemini call: the refused reservation made none
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    report = result["report"]
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == ("ok", 2, 2, 0)


def test_without_new_mail_a_refused_carryover_is_an_empty_window(probe: HostProbe) -> None:
    probe_summary(probe, "old", NOW - 3 * DAY, "三天前仍待处理")
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "tokens": False}
    report = probe.call("/reports/compute", **args)["report"]
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("empty_window", 0, 0)
    assert probe.gemini.calls() == []


def test_an_empty_day_without_pending_mail_is_still_an_empty_window(probe: HostProbe) -> None:
    probe_summary(probe, "converted", NOW - 3 * DAY, "已处理", task_id="t-done", triaged_at=NOW - DAY)
    report = probe.call("/reports/compute", kind="recommendation", top_n=10, now=NOW, budget_ms=10_000)["report"]
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == (
        "empty_window",
        0,
        0,
        0,
    )
    assert probe.gemini.calls() == []
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(report)) == []


def test_the_summary_report_never_carries(probe: HostProbe, mail: None) -> None:
    probe.gemini.queue_generate(text_reply("日报"))
    report = probe.call("/reports/compute", kind="summary", top_n=0, now=NOW, budget_ms=10_000)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.SUMMARY_RANGE and "天前" not in call.user
    assert report["task_count"] == 2 and "carryover_count" not in report
