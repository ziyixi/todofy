"""Independent email/report chains, including an upgrade on persisted local D1/DO state."""

import json
import time
import uuid

import pytest

from tests.fakes.gemini_fake import GeminiFake, error_reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import ROOT, Worker, mail_event, sha256_hex
from tests.runtime.owner_support import event_row, seed
from todofy.core.prompts import SUMMARY_RANGE

EMAIL_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash"]
REPORT_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"]


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    return launch(GEMINI_MODELS=",".join(REPORT_MODELS), GEMINI_EMAIL_MODELS=",".join(EMAIL_MODELS))


def arrive(worker: Worker) -> str:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    return event_id


def restart_with(worker: Worker, **variables: str) -> None:
    """Change only the generated local core config; its persisted D1 and DO survive the upgrade."""
    worker.stop()
    config = ROOT / worker.d1_config
    document = json.loads(config.read_text())
    document["vars"] |= variables
    config.write_text(json.dumps(document))
    worker.start()
    assert worker.trigger_cron().status_code == 200


def test_lite_success_ends_the_email_chain_and_status_lists_both_orders(worker: Worker, fresh_gemini: GeminiFake):
    event_id = arrive(worker)
    event = worker.wait_event(event_id, {"complete"})

    assert [call.model for call in fresh_gemini.calls_mentioning(event_id)] == [EMAIL_MODELS[0]]
    assert event["summary_model"] == EMAIL_MODELS[0]
    budget = worker.overview()["gemini"]
    assert (budget["email_models"], budget["models"]) == (EMAIL_MODELS, REPORT_MODELS)
    assert budget["reserved_tokens"] == 0 and budget["used_tokens"] > 0


def test_email_falls_back_in_its_order(worker: Worker, fresh_gemini: GeminiFake):
    fresh_gemini.queue_generate(error_reply(429), model=EMAIL_MODELS[0])
    fresh_gemini.queue_generate(error_reply(503), model=EMAIL_MODELS[1])
    event_id = arrive(worker)
    event = worker.wait_event(event_id, {"complete"})

    assert [call.model for call in fresh_gemini.calls_mentioning(event_id)] == EMAIL_MODELS
    assert event["summary_model"] == EMAIL_MODELS[-1]


@pytest.mark.parametrize(("kind", "top_n"), [("summary", None), ("recommendation", 5), ("recommendation", 10)])
def test_daily_summary_and_top_recommendations_keep_flash_first(
    worker: Worker, fresh_gemini: GeminiFake, kind: str, top_n: int | None
):
    worker.wait_event(arrive(worker), {"complete"})
    body = {"kind": kind, "request_id": str(uuid.uuid4())}
    if top_n is not None:
        body["top_n"] = top_n
    response = worker.post_owner("/api/v1/latestReports:recompute", body)
    assert response.status_code == 200, response.text
    report = response.json()[kind]

    calls = [c for c in fresh_gemini.calls() if c.system == SUMMARY_RANGE or c.response_schema is not None]
    assert [call.model for call in calls] == [REPORT_MODELS[0]]
    assert (report["status"], report["model"]) == ("ok", REPORT_MODELS[0])
    if top_n is not None:
        assert calls[0].response_schema["maxItems"] == top_n


def test_upgrade_preserves_completed_and_frozen_summaries_but_pending_and_owner_retry_use_lite(
    launch: Launch, fresh_gemini: GeminiFake
):
    # This instance starts without the new var, just like the previous release.
    worker = launch(GEMINI_MODELS=",".join(REPORT_MODELS))
    completed = arrive(worker)
    original = worker.wait_event(completed, {"complete"})
    assert original["summary_model"] == REPORT_MODELS[0]

    restart_with(worker, PROCESSING_PAUSED="true")
    pending = arrive(worker)
    assert worker.event(pending)["state"] == "pending"
    failed, failed_body = mail_event()
    frozen, frozen_body = mail_event()
    seed(
        worker,
        "mail_events",
        [
            event_row(
                failed,
                "failed_summary",
                int(time.time()),
                payload=failed_body.decode(),
                payload_hash=sha256_hex(failed_body),
                last_error_code="summary_failed",
            ),
        ],
    )
    seed(
        worker,
        "mail_events",
        [
            event_row(
                frozen,
                "summarized",
                int(time.time()),
                payload=frozen_body.decode(),
                payload_hash=sha256_hex(frozen_body),
                summary="Already accepted summary",
                summary_model=REPORT_MODELS[0],
                todo_body="Frozen task body",
                todoist_request_id=f"todofy-{uuid.uuid4().hex[:26]}",
            ),
        ],
    )
    fresh_gemini.reset()

    restart_with(worker, PROCESSING_PAUSED="false", GEMINI_EMAIL_MODELS=",".join(EMAIL_MODELS))
    assert worker.wait_event(pending, {"complete"})["summary_model"] == EMAIL_MODELS[0]
    unchanged = worker.wait_event(frozen, {"complete"})
    assert (unchanged["summary"], unchanged["summary_model"]) == ("Already accepted summary", REPORT_MODELS[0])
    assert worker.reconcile(failed, "retry_summary").status_code == 200
    assert worker.wait_event(failed, {"complete"})["summary_model"] == EMAIL_MODELS[0]

    assert worker.event(completed)["summary"] == original["summary"]
    assert worker.event(completed)["summary_model"] == original["summary_model"]
    assert fresh_gemini.calls_mentioning(completed) == fresh_gemini.calls_mentioning(frozen) == []
    for event_id in (pending, failed):
        assert [call.model for call in fresh_gemini.calls_mentioning(event_id)] == [EMAIL_MODELS[0]]
