"""Newsletter reports: daily precompute, on-demand computation, owner recompute and the newsletter contract."""

import uuid

import pytest

from tests.fakes.gemini_fake import GeminiFake, text_reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, error_code, mail_event, wait_until
from tests.runtime.owner_support import assert_contract
from todofy.core.prompts import SUMMARY_RANGE
from todofy.core.report_schema import EMPTY_WINDOW_SUMMARY


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    # A precompute time of midnight makes today's reports due at the first alarm.
    return launch(REPORT_PRECOMPUTE_UTC="00:00")


def _recompute(worker: Worker, kind: str, **fields: object) -> dict:
    body = {"kind": kind, "action_request_id": str(uuid.uuid4())} | fields
    response = worker.post_owner("/api/v1/reports/recompute", body)
    return assert_contract(response, "/api/v1/reports/recompute", "post")


def _complete_one(worker: Worker) -> str:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    worker.wait_event(event_id, {"complete"})
    return event_id


def test_precompute_stores_todays_empty_reports_without_calling_gemini(worker: Worker, gemini: GeminiFake) -> None:
    assert worker.trigger_cron().status_code == 200

    def stored() -> dict | None:
        latest = worker.owner.get("/api/v1/reports/latest").json()
        return latest if latest["summary"] and latest["recommendations"] else None

    latest = wait_until(stored, 30, "precomputed reports")

    assert (latest["summary"]["status"], latest["summary"]["summary"]) == ("empty_window", EMPTY_WINDOW_SUMMARY)
    # REPORT_DEFAULT_TOP defaults to 10, the top the newsletter asks for; only it is precomputed.
    assert [(r["top_n"], r["status"], r["tasks"]) for r in latest["recommendations"]] == [(10, "empty_window", [])]
    assert gemini.calls() == []
    summary = assert_contract(worker.report("/api/summary"), "/api/summary")
    recommendation = assert_contract(worker.report("/api/recommendation", {"top": "10"}), "/api/recommendation")
    assert (summary, recommendation) == (latest["summary"], latest["recommendations"][0])
    assert_contract(worker.owner.get("/api/v1/reports/latest"), "/api/v1/reports/latest")


def test_owner_recompute_summarises_the_window_with_the_range_prompt(worker: Worker, fresh_gemini: GeminiFake) -> None:
    _complete_one(worker)

    report = _recompute(worker, "summary")

    assert (report["status"], report["model"], report["task_count"] >= 1) == ("ok", "model-a", True)
    [call] = [c for c in fresh_gemini.calls() if c.system == SUMMARY_RANGE]
    assert call.response_schema is None
    assert assert_contract(worker.report("/api/summary"), "/api/summary") == report


def test_recommendation_asks_for_json_and_never_pads(worker: Worker, fresh_gemini: GeminiFake) -> None:
    report = _recompute(worker, "recommendation", top=10)

    [call] = [c for c in fresh_gemini.calls() if c.response_schema is not None]
    assert (call.response_mime_type, call.response_schema["maxItems"]) == ("application/json", 10)
    assert (report["status"], report["top_n"], [t["rank"] for t in report["tasks"]]) == ("ok", 10, [1, 2, 3])


def test_unusable_model_output_is_reported_not_passed_through(worker: Worker, fresh_gemini: GeminiFake) -> None:
    fresh_gemini.queue_generate(text_reply("Here are your tasks: 1. do it"))

    report = _recompute(worker, "recommendation", top=2)

    assert (report["status"], report["tasks"], report["top_n"]) == ("model_output_invalid", [], 2)


def test_a_top_nobody_precomputed_is_computed_on_demand(worker: Worker, fresh_gemini: GeminiFake) -> None:
    report = assert_contract(worker.report("/api/recommendation", {"top": "4"}), "/api/recommendation")

    assert (report["status"], report["top_n"]) == ("ok", 4)
    [call] = [c for c in fresh_gemini.calls() if c.response_schema is not None]
    assert call.response_schema["maxItems"] == 4


@pytest.mark.parametrize(("top", "top_n"), [("", 3), ("+03", 3), ("10", 10)])
def test_top_accepts_what_the_go_service_accepted(worker: Worker, top: str, top_n: int) -> None:
    report = assert_contract(worker.report("/api/recommendation", {"top": top}), "/api/recommendation")
    assert report["top_n"] == top_n


@pytest.mark.parametrize("top", ["0", "11", "abc", "1.5"])
def test_top_out_of_range_is_400(worker: Worker, top: str) -> None:
    response = worker.report("/api/recommendation", {"top": top})
    assert (response.status_code, error_code(response)) == (400, "invalid_request")


def test_reports_need_basic_auth_and_live_only_on_the_machine_host(worker: Worker) -> None:
    for auth in (("newsletter", "wrong"), ("someone", "runtime-report-password")):
        response = worker.report("/api/summary", auth=auth)
        assert (response.status_code, error_code(response)) == (401, "unauthorized")
        assert response.headers["www-authenticate"].startswith("Basic")
    assert worker.hooks.get("/api/summary").status_code == 401
    assert worker.owner.get("/api/summary").status_code == 404
