"""GET /api/summary and /api/recommendation (reports.serve) in real workerd: Basic auth
with the hourly lockout, fresh rows served as stored, on-demand computation
through the coordinator, and the stale fallback. Every 200 must validate against
the newsletter schemas."""

import json
import time
from typing import Any

import httpx
import pytest

from tests.fakes.gemini_fake import error_reply, text_reply
from tests.runtime.owner_support import assert_contract
from tests.runtime.reports_support import NEWSLETTER, ROTATED, Probe, clean_fixture, probe_fixture  # noqa: F401
from todofy.core import gemini_wire, prompts
from todofy.core.report_schema import EMPTY_WINDOW_SUMMARY

HOUR = 3600
TASKS = [{"rank": 1, "title": "续签护照", "reason": "下周到期，需要今天预约"}]


def get(probe: Probe, path: str, auth: tuple[str, str] | None = NEWSLETTER, **vars: str) -> httpx.Response:
    headers = {"x-probe-vars": json.dumps(vars)} if vars else {}
    return probe.worker.hooks.get(path, auth=auth, headers=headers)


def seed_summaries(probe: Probe, *texts: str, age: int = HOUR) -> None:
    now = int(time.time())
    for index, text in enumerate(texts):
        probe.insert(
            "summaries",
            event_id=f"e{index}",
            created_at=now - age + index,
            subject="s",
            summary=text,
            model="m",
        )


def seed_report(probe: Probe, kind: str, top_n: int, payload: dict[str, Any], age: int) -> None:
    computed = int(time.time()) - age
    probe.insert(
        "daily_reports",
        kind=kind,
        top_n=top_n,
        day=time.strftime("%Y-%m-%d", time.gmtime(computed)),
        status=payload["status"],
        payload_json=json.dumps(payload, ensure_ascii=False),
        task_count=payload["task_count"],
        window_start=computed - 24 * HOUR,
        window_end=computed,
        computed_at=computed,
    )


def stored_summary(text: str = "旧的日报") -> dict[str, Any]:
    stamp = {"computed_at": "2026-09-26T13:30:00Z", "window_start": "2026-09-25T13:30:00Z"}
    return {
        "summary": text,
        "task_count": 2,
        "time_window_hours": 24,
        "status": "ok",
        "model": "gemini-old",
        **stamp,
        "window_end": "2026-09-26T13:30:00Z",
    }


def test_missing_or_wrong_credentials_are_401_and_counted(probe):
    for auth in (None, ("newsletter", "wrong")):
        response = get(probe, "/api/summary", auth=auth)
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic")
        assert_contract(response, "/api/summary")
    assert probe.sql("SELECT sum(count) AS n FROM auth_failures")[0]["n"] == 2
    assert probe.gemini.calls() == []


def test_twenty_failures_lock_the_hour_even_for_the_right_password(probe):
    for _ in range(20):
        assert get(probe, "/api/summary", auth=("newsletter", "guess")).status_code == 401
    response = get(probe, "/api/summary")
    assert response.status_code == 429
    assert 0 < int(response.headers["retry-after"]) <= HOUR
    assert_contract(response, "/api/summary")


def test_both_rotation_digests_are_accepted(probe):
    for auth in (NEWSLETTER, ROTATED):
        assert get(probe, "/api/summary", auth=auth).status_code == 200


def test_missing_digest_is_503_not_configured(probe):
    response = get(probe, "/api/summary", REPORT_BASIC_AUTH_SHA256="")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "not_configured"


def test_empty_window_needs_no_model_and_keeps_the_go_sentence(probe):
    response = get(probe, "/api/summary")
    body = assert_contract(response, "/api/summary")
    assert response.headers["content-type"].split(";")[0] == "application/json"
    assert (body["status"], body["task_count"], body["summary"], body["model"]) == (
        "empty_window",
        0,
        EMPTY_WINDOW_SUMMARY,
        "",
    )
    recommendation = assert_contract(get(probe, "/api/recommendation?top=10"), "/api/recommendation")
    assert (recommendation["status"], recommendation["tasks"], recommendation["top_n"]) == ("empty_window", [], 10)
    assert probe.gemini.calls() == []


def test_summary_is_computed_on_demand_then_served_from_the_stored_row(probe):
    seed_summaries(probe, "报税截止 10 月 15 日", "护照下周到期")
    probe.gemini.queue_generate(text_reply("今日重点：报税与护照。", tokens=321))
    first = assert_contract(get(probe, "/api/summary"), "/api/summary")
    assert (first["status"], first["task_count"], first["summary"]) == ("ok", 2, "今日重点：报税与护照。")
    assert first["model"] == "gemini-probe"

    [call] = probe.gemini.calls()
    assert call.system == prompts.SUMMARY_RANGE
    assert call.response_schema is None
    report_input = prompts.report_input(["报税截止 10 月 15 日", "护照下周到期"])
    assert call.user == gemini_wire.user_turn(report_input)

    assert get(probe, "/api/summary").json() == first
    assert len(probe.gemini.calls()) == 1


def test_recommendation_uses_the_response_schema_and_validates(probe):
    seed_summaries(probe, "续签护照")
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    body = assert_contract(get(probe, "/api/recommendation?top=10"), "/api/recommendation")
    assert (body["status"], body["tasks"], body["top_n"], body["task_count"]) == ("ok", TASKS, 10, 1)
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10)
    assert (call.response_mime_type, call.response_schema["maxItems"]) == ("application/json", 10)


def test_absent_top_means_three_like_go(probe):
    body = assert_contract(get(probe, "/api/recommendation"), "/api/recommendation")
    assert body["top_n"] == 3


@pytest.mark.parametrize("top", ["0", "11", "x", "1.5"])
def test_invalid_top_is_400(probe, top):
    response = get(probe, f"/api/recommendation?top={top}")
    assert response.status_code == 400
    assert_contract(response, "/api/recommendation")


def test_unusable_model_output_is_reported_without_fake_tasks(probe):
    seed_summaries(probe, "续签护照")
    probe.gemini.queue_generate(text_reply("我认为最重要的是续签护照。"))
    body = assert_contract(get(probe, "/api/recommendation?top=5"), "/api/recommendation")
    assert (body["status"], body["tasks"], body["task_count"]) == ("model_output_invalid", [], 1)


def test_old_row_is_served_as_stale_when_on_demand_fails(probe):
    seed_summaries(probe, "续签护照")
    seed_report(probe, "summary", 0, stored_summary(), age=27 * HOUR)
    probe.gemini.queue_generate(error_reply(500))
    body = assert_contract(get(probe, "/api/summary"), "/api/summary")
    assert body == stored_summary() | {"status": "stale"}
    assert len(probe.gemini.calls()) == 1


def test_row_from_the_last_26_hours_is_served_without_the_model(probe):
    seed_summaries(probe, "续签护照")
    seed_report(probe, "summary", 0, stored_summary("昨天的日报"), age=25 * HOUR)
    assert get(probe, "/api/summary").json() == stored_summary("昨天的日报")
    assert probe.gemini.calls() == []


def test_no_row_and_failed_on_demand_is_503(probe):
    seed_summaries(probe, "续签护照")
    probe.gemini.queue_generate(error_reply(503))
    response = get(probe, "/api/summary")
    assert response.status_code == 503
    assert_contract(response, "/api/summary")
