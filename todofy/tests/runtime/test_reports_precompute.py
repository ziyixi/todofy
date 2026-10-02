"""reports.tick / compute / latest in real workerd: the daily precompute at
REPORT_PRECOMPUTE_UTC (one report per alarm), the hourly cap and token budget
around every computation, and ReportsLatest for the owner API."""

import json

from tests.fakes.gemini_fake import error_reply, text_reply
from tests.runtime.reports_support import NOW, Probe, clean_fixture, idl_errors, probe_fixture  # noqa: F401

DAY = 86_400
MIDNIGHT = NOW - NOW % DAY
DUE = MIDNIGHT + 13 * 3600 + 30 * 60
TASKS = [{"rank": 1, "title": "报税", "reason": "10 月 15 日截止"}]


def seed_summaries(probe: Probe, count: int, end: int = NOW) -> None:
    for index in range(count):
        probe.insert(
            "summaries",
            event_id=f"e{index}",
            created_at=end - 60 * index,
            subject="s",
            summary=f"摘要 {index}",
            model="m",
        )


def reports(probe: Probe) -> list[dict]:
    return probe.sql("SELECT kind, top_n, day, status, model, task_count, computed_at FROM daily_reports ORDER BY kind")


def test_before_the_precompute_time_nothing_runs(probe):
    assert probe.call("/reports/tick", now=DUE - 1)["next"] == DUE
    assert reports(probe) == []


def test_after_the_precompute_time_each_report_runs_once(probe):
    seed_summaries(probe, 3)
    probe.gemini.queue_generate(text_reply("日报正文", tokens=500))
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False), tokens=700))

    first = probe.call("/reports/tick", now=NOW)
    assert first["next"] == NOW + 1
    assert [row["kind"] for row in reports(probe)] == ["summary"]
    assert first["budget"][0] == ["slot", NOW]
    reserve, settle = first["budget"][1], first["budget"][2]
    assert reserve[0] == "reserve" and reserve[1] > 4096
    assert settle == ["settle", reserve[1], 500, NOW]

    assert probe.call("/reports/tick", now=NOW + 1)["next"] == NOW + 2
    assert probe.call("/reports/tick", now=NOW + 2)["next"] == DUE + DAY
    rows = reports(probe)
    assert [(row["kind"], row["top_n"], row["status"], row["task_count"]) for row in rows] == [
        ("recommendation", 10, "ok", 3),
        ("summary", 0, "ok", 3),
    ]
    assert {row["day"] for row in rows} == {"2026-09-28"}
    assert len(probe.gemini.calls()) == 2


def test_report_default_top_sets_the_precomputed_size(probe):
    probe.call("/reports/tick", now=NOW, vars={"REPORT_DEFAULT_TOP": "5"})
    probe.call("/reports/tick", now=NOW + 1, vars={"REPORT_DEFAULT_TOP": "5"})
    assert [(row["kind"], row["top_n"]) for row in reports(probe)] == [("recommendation", 5), ("summary", 0)]


def test_a_row_from_before_today_s_run_is_recomputed(probe):
    probe.call("/reports/compute", kind="summary", top_n=0, now=DUE - 60, budget_ms=10_000)
    assert probe.call("/reports/tick", now=NOW)["next"] == NOW + 1
    assert [row["computed_at"] for row in reports(probe)] == [NOW]


def test_a_failed_run_is_retried_in_ten_minutes_and_stores_nothing(probe):
    seed_summaries(probe, 1)
    probe.gemini.queue_generate(error_reply(500))
    result = probe.call("/reports/tick", now=NOW)
    assert result["next"] == NOW + 600
    assert result["budget"][-1] == ["failure", "summary", 0, "2026-09-28"]
    assert reports(probe) == []


def test_after_a_failed_summary_the_recommendation_goes_first(probe):
    seed_summaries(probe, 1)
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    result = probe.call("/reports/tick", now=NOW + 600, failures={"summary/0/2026-09-28": 1})
    assert result["next"] == NOW + 601
    assert [(row["kind"], row["status"]) for row in reports(probe)] == [("recommendation", "ok")]


def test_precompute_gives_up_for_the_day_after_three_failures(probe):
    seed_summaries(probe, 1)
    failures = {"summary/0/2026-09-28": 3, "recommendation/10/2026-09-28": 3}
    assert probe.call("/reports/tick", now=NOW, failures=failures)["next"] == DUE + DAY
    assert probe.gemini.calls() == [] and reports(probe) == []


def test_an_unusable_recommendation_is_not_a_finished_day(probe):
    seed_summaries(probe, 1)
    probe.gemini.queue_generate(text_reply("not json at all"))
    first = probe.call("/reports/tick", now=NOW, failures={"summary/0/2026-09-28": 3})
    assert first["next"] == NOW + 600
    assert first["budget"][-1] == ["failure", "recommendation", 10, "2026-09-28"]
    assert [row["status"] for row in reports(probe)] == ["model_output_invalid"]
    # Ten minutes later it is tried again rather than kept for the rest of the day.
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    probe.call("/reports/tick", now=NOW + 600, failures={"summary/0/2026-09-28": 3})
    assert [row["status"] for row in reports(probe)] == ["ok"]


def test_a_summary_over_the_newsletter_limit_is_cut_and_stored(probe):
    seed_summaries(probe, 3)
    long_text = "\n".join(f"{index}. 一封邮件的一句话摘要，写得稍长一些。" for index in range(1, 1200))
    probe.gemini.queue_generate(text_reply(long_text))
    assert probe.call("/reports/tick", now=NOW)["next"] == NOW + 1
    [row] = probe.sql("SELECT status, payload_json FROM daily_reports")
    summary = json.loads(row["payload_json"])["summary"]
    assert row["status"] == "ok" and len(summary) <= 12_000 and summary.endswith("已截断以适应 newsletter。）")
    assert len(probe.gemini.calls()) == 1


def test_off_disables_the_precompute(probe):
    assert probe.call("/reports/tick", now=NOW, vars={"REPORT_PRECOMPUTE_UTC": "off"})["next"] == NOW + DAY
    assert reports(probe) == []


def test_over_the_hourly_cap_is_429_before_any_work(probe):
    seed_summaries(probe, 1)
    result = probe.call("/reports/compute", kind="summary", top_n=0, now=NOW, budget_ms=10_000, slots=False)
    assert result["error"] == [429, "rate_limited"]
    assert probe.gemini.calls() == [] and reports(probe) == []


def test_exhausted_token_budget_is_503_without_a_model_call(probe):
    seed_summaries(probe, 1)
    result = probe.call("/reports/compute", kind="recommendation", top_n=3, now=NOW, budget_ms=10_000, tokens=False)
    assert result["error"] == [503, "unavailable"]
    assert probe.gemini.calls() == [] and reports(probe) == []


def test_summary_window_is_the_last_24_hours(probe):
    seed_summaries(probe, 2)
    probe.insert("summaries", event_id="old", created_at=NOW - DAY, subject="s", summary="太旧", model="m")
    probe.gemini.queue_generate(text_reply("两封"))
    report = probe.call("/reports/compute", kind="summary", top_n=0, now=NOW, budget_ms=10_000)["report"]
    assert (report["task_count"], report["window_start"], report["window_end"]) == (
        2,
        "2026-09-27T15:00:00Z",
        "2026-09-28T15:00:00Z",
    )
    assert "太旧" not in probe.gemini.calls()[0].user


def test_latest_lists_the_newest_rows_in_the_newsletter_shapes(probe):
    seed_summaries(probe, 1)
    for top_n in (10, 3):
        probe.call("/reports/compute", kind="recommendation", top_n=top_n, now=NOW - DAY, budget_ms=10_000)
        probe.call("/reports/compute", kind="recommendation", top_n=top_n, now=NOW, budget_ms=10_000)
    latest = probe.call("/reports/latest")["latest"]
    assert latest["summary"] is None
    assert [(r["top_n"], r["computed_at"]) for r in latest["recommendations"]] == [
        (3, "2026-09-28T15:00:00Z"),
        (10, "2026-09-28T15:00:00Z"),
    ]
    assert idl_errors("LatestReports", latest) == []
