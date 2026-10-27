"""Independent persisted model routes and immutable completed mail history."""

import uuid

import pytest

from tests.fakes.model_router_fake import ModelRouterFake, text_reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event
from todofy.core.prompts import SUMMARY_RANGE

EMAIL_ROUTE = "models/gemini-email"
REPORT_ROUTE = "models/gemini-report"
SOL_ROUTE = "models/sol-6-1"


def arrive(worker: Worker) -> str:
    identifier, body = mail_event()
    assert worker.post_event(body).status_code == 204
    return identifier


def settings(worker: Worker) -> dict:
    response = worker.owner.get("/api/v1/modelSettings")
    assert response.status_code == 200, response.text
    return response.json()["settings"]


def update(worker: Worker, current: dict, **values) -> dict:
    response = worker.owner.patch(
        "/api/v1/modelSettings",
        params={"request_id": str(uuid.uuid4()), "etag": current["etag"]},
        json={key: value for key, value in (current | values).items() if key not in {"name", "etag"}},
        headers=worker.csrf_headers(),
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_initial_routes_are_independent_saved_settings(worker: Worker, fresh_gemini: ModelRouterFake):
    selected = settings(worker)
    assert selected["email_model"] == EMAIL_ROUTE and selected["report_model"] == REPORT_ROUTE
    identifier = arrive(worker)
    event = worker.wait_event(identifier, {"complete"})
    [call] = fresh_gemini.calls_mentioning(identifier)
    assert call.requested_model == EMAIL_ROUTE and event["summary_model"] == "model-a"
    budget = worker.overview()["gemini"]
    assert (budget["email_models"], budget["models"]) == ([EMAIL_ROUTE], [REPORT_ROUTE])
    assert budget["reserved_tokens"] == 0 and budget["used_tokens"] > 0


def test_router_fallback_receipt_is_kept_without_an_app_side_chain(worker: Worker, fresh_gemini: ModelRouterFake):
    fresh_gemini.queue_generate(text_reply("Final summary", model="reported-fallback", attempts=3))
    identifier = arrive(worker)
    event = worker.wait_event(identifier, {"complete"})
    assert event["summary_model"] == "reported-fallback"
    assert len(fresh_gemini.calls_mentioning(identifier)) == 1


@pytest.mark.parametrize("kind,top_n", [("summary", None), ("recommendation", 5), ("recommendation", 10)])
def test_reports_use_the_saved_report_route(
    worker: Worker, fresh_gemini: ModelRouterFake, kind: str, top_n: int | None
):
    worker.wait_event(arrive(worker), {"complete"})
    body = {"kind": kind, "request_id": str(uuid.uuid4())}
    if top_n is not None:
        body["top_n"] = top_n
    response = worker.post_owner("/api/v1/latestReports:recompute", body)
    assert response.status_code == 200, response.text
    calls = [call for call in fresh_gemini.calls() if call.system == SUMMARY_RANGE or call.response_schema is not None]
    assert [call.requested_model for call in calls] == [REPORT_ROUTE]
    if top_n is not None:
        assert calls[0].response_schema["maxItems"] == top_n


def test_selecting_sol_changes_future_mail_but_preserves_completed_history(
    launch: Launch, fresh_gemini: ModelRouterFake
):
    worker = launch()
    identifier = arrive(worker)
    old = worker.wait_event(identifier, {"complete"})
    current = settings(worker)
    chosen = update(worker, current, email_model=SOL_ROUTE)
    assert chosen["email_model"] == SOL_ROUTE and chosen["report_model"] == REPORT_ROUTE
    fresh_gemini.reset()
    next_id = arrive(worker)
    assert worker.wait_event(next_id, {"complete"})["summary_model"] == SOL_ROUTE
    assert [call.requested_model for call in fresh_gemini.calls_mentioning(next_id)] == [SOL_ROUTE]
    unchanged = worker.event(identifier)
    assert (unchanged["summary"], unchanged["summary_model"]) == (old["summary"], old["summary_model"])
    assert fresh_gemini.calls_mentioning(identifier) == []


def test_model_settings_reject_stale_etag_and_unknown_catalog_route(worker: Worker):
    initial = settings(worker)
    changed = update(worker, initial, report_model=SOL_ROUTE)
    response = worker.owner.patch(
        "/api/v1/modelSettings",
        params={"request_id": str(uuid.uuid4()), "etag": initial["etag"]},
        json={key: value for key, value in initial.items() if key not in {"name", "etag"}},
        headers=worker.csrf_headers(),
    )
    assert response.status_code == 409, response.text
    unknown = worker.owner.patch(
        "/api/v1/modelSettings",
        params={"request_id": str(uuid.uuid4()), "etag": changed["etag"]},
        json={
            key: value
            for key, value in (changed | {"email_model": "models/not-configured"}).items()
            if key not in {"name", "etag"}
        },
        headers=worker.csrf_headers(),
    )
    assert unknown.status_code == 400
    update(worker, changed, report_model=REPORT_ROUTE)


def test_masked_update_preserves_identity_and_etag_outside_resource_mask(worker: Worker):
    current = settings(worker)
    response = worker.owner.patch(
        "/api/v1/modelSettings",
        params={"request_id": str(uuid.uuid4()), "etag": current["etag"], "update_mask": "email_model"},
        json={"email_model": SOL_ROUTE, "report_model": SOL_ROUTE},
        headers=worker.csrf_headers(),
    )
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed["email_model"] == SOL_ROUTE and changed["report_model"] == current["report_model"]
    update(worker, changed, email_model=current["email_model"])
