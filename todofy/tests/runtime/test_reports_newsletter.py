"""GET /api/summary and /api/recommendation in real workerd: Basic auth with the hourly
lockout of failures (gateway and core together), and reports.serve through the probe:
rows from since the latest precompute served as stored, on-demand computation through
the coordinator, and 503 (never an old or unusable report) when that fails. Every 200
must validate against the newsletter schemas."""

import json
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from tests.fakes.gemini_fake import GeminiFake, error_reply, text_reply
from tests.fakes.todoist_fake import TodoistFake
from tests.runtime.conftest import pipeline_vars
from tests.runtime.harness import Worker, start_gateway
from tests.runtime.owner_support import assert_contract
from tests.runtime.reports_support import (  # noqa: F401
    NEWSLETTER,
    ROTATED,
    Probe,
    clean_fixture,
    digest,
    probe_fixture,
)
from todofy.core import gemini_wire, prompts
from todofy.core.report_schema import EMPTY_WINDOW_SUMMARY

HOUR = 3600
TASKS = [{"rank": 1, "title": "续签护照", "reason": "下周到期，需要今天预约"}]


def get(probe: Probe, path: str, **vars: str) -> httpx.Response:
    headers = {"x-probe-vars": json.dumps(vars)} if vars else {}
    return probe.worker.hooks.get(path, headers=headers)


def auth_failures(worker: Worker) -> int | None:
    return worker.d1("SELECT sum(count) AS n FROM auth_failures")[0]["n"]


def start_newsletter(
    tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake, digests: str | None
) -> Iterator[Worker]:
    """A fresh gateway and core: the failure count and the gateway's lock last an hour."""
    variables = pipeline_vars(gemini, todoist)
    del variables["REPORT_BASIC_AUTH_SHA256"]
    if digests is not None:
        variables["REPORT_BASIC_AUTH_SHA256"] = digests
    yield from start_gateway(tmp_path_factory.mktemp("newsletter"), variables)


@pytest.fixture(name="newsletter")
def newsletter_fixture(
    tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake
) -> Iterator[Worker]:
    yield from start_newsletter(tmp_path_factory, gemini, todoist, f"{digest(*NEWSLETTER)},{digest(*ROTATED)}")


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


def test_missing_or_wrong_credentials_are_401_and_counted(newsletter: Worker, gemini: GeminiFake):
    for auth in (None, ("newsletter", "wrong")):
        response = newsletter.hooks.get("/api/summary", auth=auth)
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic")
        assert_contract(response, "/api/summary")
    assert auth_failures(newsletter) == 2
    assert gemini.calls() == []


def test_twenty_failures_lock_out_failures_but_never_the_right_password(newsletter: Worker):
    for _ in range(20):
        assert newsletter.hooks.get("/api/summary", auth=("newsletter", "guess")).status_code == 401
    for auth in (("newsletter", "guess"), None, ("newsletter", "guess")):
        response = newsletter.hooks.get("/api/summary", auth=auth)
        assert response.status_code == 429
        assert 0 < int(response.headers["retry-after"]) <= HOUR
        assert_contract(response, "/api/summary")
    # Locked failures write nothing more to D1.
    assert auth_failures(newsletter) == 20
    for auth in (NEWSLETTER, ROTATED):
        assert newsletter.hooks.get("/api/summary", auth=auth).status_code == 200


def test_both_rotation_digests_are_accepted(newsletter: Worker):
    for auth in (NEWSLETTER, ROTATED):
        assert newsletter.hooks.get("/api/summary", auth=auth).status_code == 200
    assert auth_failures(newsletter) is None


def test_missing_digest_is_503_not_configured(tmp_path_factory, gemini, todoist):
    for worker in start_newsletter(tmp_path_factory, gemini, todoist, None):
        response = worker.hooks.get("/api/summary", auth=NEWSLETTER)
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


def precompute_hours_ago(hours: int) -> str:
    """A REPORT_PRECOMPUTE_UTC whose latest occurrence was about ``hours`` ago."""
    return time.strftime("%H:%M", time.gmtime(time.time() - hours * HOUR))


def test_unusable_model_output_is_503_not_an_empty_list(probe):
    # An empty task list would read as "nothing important today" in the newsletter.
    seed_summaries(probe, "续签护照")
    probe.gemini.queue_generate(text_reply("我认为最重要的是续签护照。"))
    response = get(probe, "/api/recommendation?top=5")
    assert (response.status_code, response.json()["error"]["code"]) == (503, "unavailable")
    assert_contract(response, "/api/recommendation")


def test_a_stored_unusable_report_is_recomputed(probe):
    seed_summaries(probe, "续签护照")
    invalid = {"tasks": [], "model": "m", "task_count": 1, "status": "model_output_invalid", "top_n": 10}
    invalid |= {"computed_at": "2026-09-28T13:30:00Z", "window_start": "2026-09-27T13:30:00Z"}
    seed_report(probe, "recommendation", 10, invalid | {"window_end": "2026-09-28T13:30:00Z"}, age=60)
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    body = assert_contract(
        get(probe, "/api/recommendation?top=10", REPORT_PRECOMPUTE_UTC=precompute_hours_ago(2)), "/api/recommendation"
    )
    assert (body["status"], body["tasks"]) == ("ok", TASKS)


def test_old_row_is_not_served_when_on_demand_fails(probe):
    seed_summaries(probe, "续签护照")
    seed_report(probe, "summary", 0, stored_summary(), age=27 * HOUR)
    probe.gemini.queue_generate(error_reply(500))
    response = get(probe, "/api/summary")
    assert (response.status_code, response.json()["error"]["code"]) == (503, "unavailable")
    assert_contract(response, "/api/summary")
    assert len(probe.gemini.calls()) == 1


def test_row_from_since_the_latest_precompute_is_served_without_the_model(probe):
    seed_summaries(probe, "续签护照")
    seed_report(probe, "summary", 0, stored_summary("今天的日报"), age=HOUR)
    response = get(probe, "/api/summary", REPORT_PRECOMPUTE_UTC=precompute_hours_ago(2))
    assert response.json() == stored_summary("今天的日报")
    assert probe.gemini.calls() == []


def test_row_from_before_the_latest_precompute_is_recomputed(probe):
    # Yesterday's report, even under 24 hours old, must not be shown as today's.
    seed_summaries(probe, "续签护照")
    seed_report(probe, "summary", 0, stored_summary("昨天的日报"), age=3 * HOUR)
    probe.gemini.queue_generate(text_reply("今日重点：护照。"))
    body = assert_contract(get(probe, "/api/summary", REPORT_PRECOMPUTE_UTC=precompute_hours_ago(2)), "/api/summary")
    assert (body["status"], body["summary"]) == ("ok", "今日重点：护照。")


def test_no_row_and_failed_on_demand_is_503(probe):
    seed_summaries(probe, "续签护照")
    probe.gemini.queue_generate(error_reply(503))
    response = get(probe, "/api/summary")
    assert response.status_code == 503
    assert_contract(response, "/api/summary")
