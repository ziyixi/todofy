"""ops-v1 end to end (contracts/ops-v1): a dashboard stand-in calls the gateway's ``Ops``
entrypoint over a service binding, in front of the real gateway, core, D1 and object.

Canary events are processed through (fake) Gemini and end ``ok`` without any Tasks write,
report input, list entry or count; status/setGuard/canaryResult answer values that validate
against the shared schema; a shed guard defers retention and lets it run once it ends. Todofy
offers no reportOps since 2026-10-21: Home creates the daily reminder itself.
"""

import json
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from tests import mail_contract
from tests.fakes.gemini_fake import GeminiFake, error_reply
from tests.runtime import tasks_support as tasks
from tests.runtime.conftest import pipeline_vars
from tests.runtime.harness import error_code, mail_event, transitions, wait_until
from tests.runtime.ops_support import OpsStack, start_ops_stack
from todofy.core import ops
from todofy.core.prompts import SUMMARY_RANGE

CANARY = mail_contract.fixtures()["canary_event"].read_bytes()
CANARY_ID = json.loads(CANARY)["event_id"]
CANARY_TEXT = "synthetic Mail Hero end-to-end canary"
SOURCE = "mail-hero-personal"
StackLaunch = Callable[..., OpsStack]


def canary_event(run_id: str = "canary-2026-09-29") -> tuple[str, bytes]:
    """The golden canary event with fresh IDs (and so different bytes)."""
    document = json.loads(CANARY)
    document["event_id"], document["message"]["id"] = str(uuid.uuid4()), str(uuid.uuid4())
    document["canary"] = {"run_id": run_id}
    return document["event_id"], json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()


def stamp(seconds: float) -> str:
    return ops.timestamp(int(seconds))


def wait_canary(stack: OpsStack, event_id: str, states: set[str], timeout_s: float = 30) -> dict[str, Any]:
    def probe() -> dict[str, Any] | None:
        result = stack.ok("canaryResult", event_id, definition="CanaryResult")
        return result if result["state"] in states else None

    return wait_until(probe, timeout_s, f"canary {event_id} in {states}")


def seed(stack: OpsStack, event_id: str, state: str, *, body: bytes | None, created_at: int, **columns: Any) -> None:
    row = {
        "source_id": SOURCE,
        "event_id": event_id,
        "payload_hash": "0" * 64,
        "payload": None if body is None else body.decode(),
        "state": state,
        "created_at": created_at,
        "updated_at": created_at,
        "canary_run_id": "canary-seeded",
        **columns,
    }

    def literal(value: Any) -> str:
        if value is None:
            return "NULL"
        if isinstance(value, int):
            return str(value)
        return "'" + str(value).replace("'", "''") + "'"

    stack.d1(f"INSERT INTO mail_events ({', '.join(row)}) VALUES ({', '.join(map(literal, row.values()))})")


@pytest.fixture(scope="module")
def launch_stack(tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake) -> Iterator[StackLaunch]:
    running: list[Iterator[OpsStack]] = []

    def start(**overrides: str) -> OpsStack:
        process = start_ops_stack(tmp_path_factory.mktemp("ops"), pipeline_vars(gemini) | overrides)
        running.append(process)
        return next(process)

    yield start
    for process in running:
        process.close()


@pytest.fixture(scope="module")
def stack(launch_stack: StackLaunch) -> OpsStack:
    return launch_stack(GEMINI_EMAIL_MODELS="gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.7-flash")


# ---- status ----------------------------------------------------------------------------------


def test_status_validates_and_carries_no_mail_content(stack: OpsStack) -> None:
    marker = uuid.uuid4().hex
    event_id, body = mail_event(subject=f"机密主题 {marker}", text=f"正文 {marker}")
    body = body.replace(b"sender@example.org", f"leak-{marker}@example.org".encode())
    assert stack.post_event(body).status_code == 204
    stack.wait_event(event_id, {"complete"})

    status = stack.ok("status", definition="OpsStatus")

    assert marker not in json.dumps(status)
    assert (status["app"], status["health"], status["capabilities"]) == ("todofy", "ok", ["canary_consumer", "guard"])
    assert [s["code"] for s in status["signals"]] == ["backup_disabled"]
    assert set(status["modes"]) == {"maintenance", "processing_paused", "backup_active"}
    assert status["counters"]["received_24h"] >= 1
    assert status["ui_url"] == "https://todofy.localhost/"
    assert status["guard"]["level"] == "normal"


# ---- canary ----------------------------------------------------------------------------------


def test_a_canary_is_summarised_and_ends_ok_without_any_side_effect(stack: OpsStack, fresh_gemini: GeminiFake) -> None:
    assert stack.ok("canaryResult", CANARY_ID, definition="CanaryResult") == {"state": "not_seen"}
    before = stack.overview()

    assert stack.post_event(CANARY).status_code == 204
    result = wait_canary(stack, CANARY_ID, {"ok", "failed"})

    assert result["state"] == "ok", result
    [call] = fresh_gemini.calls_mentioning(CANARY_TEXT)
    assert call.system.strip() and call.model == "gemini-3.5-flash-lite"
    assert tasks.created(stack) == []
    event = stack.event(CANARY_ID)
    assert (event["state"], event["canary"], event["allowed_actions"], event["summary"]) == ("complete", True, [], None)
    assert transitions(event) == [
        (None, "pending", None, "worker"),
        ("pending", "summarizing", None, "worker"),
        ("summarizing", "complete", None, "worker"),
    ]
    assert stack.d1(f"SELECT count(*) AS n FROM summaries WHERE event_id = '{CANARY_ID}'") == [{"n": 0}]
    # Never listed or counted as mail.
    for params in ({"page_size": "100"}, {"attention": "true", "page_size": "100"}):
        page = stack.owner.get("/api/v1/mailEvents", params=params).json()
        assert f"mailEvents/{CANARY_ID}" not in [item["name"] for item in page.get("mail_events", [])]
    after = stack.overview()
    assert (after["received_last_day_count"], after["active_counts"]) == (
        before["received_last_day_count"],
        before["active_counts"],
    )
    # Not report input: the newsletter's reports read only summaries, which a canary never writes.
    fresh_gemini.reset()
    for path in ("/api/summary", "/api/recommendation"):
        assert stack.report(path).status_code == 200
    report_calls = [c for c in fresh_gemini.calls() if c.system == SUMMARY_RANGE or c.response_schema is not None]
    assert report_calls and not [c for c in report_calls if "Mail Hero canary" in c.user]
    # The usual webhook idempotency.
    assert stack.post_event(CANARY).status_code == 204
    changed = CANARY.replace(b"Mail Hero canary", b"Mail Hero canary 2")
    response = stack.post_event(changed)
    assert (response.status_code, error_code(response)) == (409, "event_conflict")


def test_a_canary_whose_summary_keeps_failing_ends_failed_after_three_attempts(
    stack: OpsStack, fresh_gemini: GeminiFake
) -> None:
    for _ in range(9):  # three steps, each trying all three email models
        fresh_gemini.queue_generate(error_reply(503))
    event_id, body = canary_event()

    assert stack.post_event(body).status_code == 204
    result = wait_canary(stack, event_id, {"ok", "failed"})

    assert (result["state"], result["error_code"]) == ("failed", "summary_failed")
    event = stack.event(event_id)
    assert (event["state"], event["attempt_count"], event["allowed_actions"]) == ("ignored", 3, [])
    assert len(fresh_gemini.calls_mentioning(CANARY_TEXT)) == 9
    assert tasks.created(stack) == []
    assert stack.ok("status", definition="OpsStatus")["counters"]["attention_events"] == 0


def test_an_interrupted_canary_ends_failed_where_mail_would_wait_for_the_owner(stack: OpsStack) -> None:
    crashed = str(uuid.uuid4())
    _, body = canary_event()
    seed(stack, crashed, "summarizing", body=body, created_at=int(time.time()) - 60, crashes=2)

    real_id, real = mail_event()  # wakes the alarm loop, which first settles interrupted rows
    assert stack.post_event(real).status_code == 204
    stack.wait_event(real_id, {"complete"})

    assert stack.wait_event(crashed, {"ignored"})["error_code"] == "processing_interrupted_limit"
    result = stack.ok("canaryResult", crashed, definition="CanaryResult")
    assert (result["state"], result["error_code"]) == ("failed", "processing_interrupted_limit")
    assert tasks.created(stack) == []


def test_canary_result_of_a_real_mail_or_a_bad_id(stack: OpsStack) -> None:
    event_id, body = mail_event()
    assert stack.post_event(body).status_code == 204
    assert stack.ok("canaryResult", event_id, definition="CanaryResult") == {"state": "not_seen"}
    for bad in ("not-a-uuid", event_id.upper(), 7):
        assert stack.ops("canaryResult", bad) == {"error": "invalid_input", "name": "Error"}


# ---- reportOps ---------------------------------------------------------------------------------


def test_report_ops_is_not_offered(stack: OpsStack) -> None:
    """Home creates the daily reminder in Tasks itself; Todofy implements no OpsDigestService."""
    report = {"generated_at": stamp(time.time() - 60), "items": []}
    answer = stack.ops("reportOps", report)
    assert "ok" not in answer and answer["error"]
    assert "ops_digest" not in stack.ok("status", definition="OpsStatus")["capabilities"]


# ---- setGuard ----------------------------------------------------------------------------------


def test_set_guard_is_idempotent_bounded_and_expires(stack: OpsStack) -> None:
    now = time.time()
    shed = {"level": "shed", "reason": "d1_reads_high", "until": stamp(now + 3600)}
    first = stack.ok("setGuard", shed, definition="GuardState")
    assert (first["level"], first["reason"], first["until"]) == ("shed", "d1_reads_high", shed["until"])
    assert first["deferred"] == ["weekly_backup", "retention", "metrics_rollup"]
    time.sleep(1.1)
    assert stack.ok("setGuard", shed, definition="GuardState") == first  # same set_at
    status = stack.ok("status", definition="OpsStatus")
    assert status["guard"] == first
    assert "guard_shed" in [signal["code"] for signal in status["signals"]]

    for bad in (
        shed | {"until": stamp(now + 37 * 3600)},
        shed | {"until": stamp(now - 60)},
        shed | {"reason": "Reads high"},
        {"level": "normal", "reason": "ok", "until": stamp(now + 60)},
        {"level": "shed", "reason": "x"},
    ):
        assert stack.ops("setGuard", bad) == {"error": "invalid_input", "name": "Error"}
    assert stack.ok("status", definition="OpsStatus")["guard"] == first

    short = stack.ok("setGuard", shed | {"until": stamp(time.time() + 2)}, definition="GuardState")
    assert short["level"] == "shed"
    time.sleep(3)
    normal = {"level": "normal", "reason": None, "until": None, "set_at": None, "deferred": []}
    assert stack.ok("status", definition="OpsStatus")["guard"] == normal
    assert stack.ok("setGuard", {"level": "normal", "reason": "done", "until": None}, definition="GuardState") == normal


def test_shed_defers_retention_until_the_guard_ends(stack: OpsStack) -> None:
    # Retention ran at this server's first alarm; an expired counter row is its next work.
    old_hour = "2020-01-01T00"
    stack.d1(f"INSERT INTO auth_failures (hour, count) VALUES ('{old_hour}', 1)")
    until = stamp(time.time() + 3600)
    stack.ok("setGuard", {"level": "shed", "reason": "first", "until": until}, definition="GuardState")
    # Changing a shed guard makes its deferred jobs due again, to be judged under the new one.
    stack.ok("setGuard", {"level": "shed", "reason": "second", "until": until}, definition="GuardState")
    time.sleep(4)
    assert stack.d1(f"SELECT count FROM auth_failures WHERE hour = '{old_hour}'") == [{"count": 1}]

    stack.ok("setGuard", {"level": "normal", "reason": "quota_ok", "until": None}, definition="GuardState")

    wait_until(
        lambda: stack.d1(f"SELECT count(*) AS n FROM auth_failures WHERE hour = '{old_hour}'") == [{"n": 0}] or None,
        30,
        "retention after the guard ended",
    )


# ---- switches ------------------------------------------------------------------------------------


def test_a_processing_pause_holds_a_canary_as_processing_never_failed(launch_stack: StackLaunch) -> None:
    paused = launch_stack(PROCESSING_PAUSED="true")
    event_id, body = canary_event()
    assert paused.post_event(body).status_code == 204
    held = {"state": "processing", "waiting_code": "processing_paused"}
    assert wait_canary(paused, event_id, {"processing"}) == held
    time.sleep(3)
    assert paused.ok("canaryResult", event_id, definition="CanaryResult") == held

    status = paused.ok("status", definition="OpsStatus")
    assert (status["health"], status["modes"]["processing_paused"]) == ("degraded", True)
    assert ("processing_paused", "warning") in [(s["code"], s["severity"]) for s in status["signals"]]


def test_maintenance_reads_as_down_and_the_surface_keeps_working(launch_stack: StackLaunch) -> None:
    down = launch_stack(MAINTENANCE_MODE="true")
    event_id, body = canary_event()
    seed(down, event_id, "pending", body=body, created_at=int(time.time()))

    status = down.ok("status", definition="OpsStatus")
    assert (status["health"], status["modes"]["maintenance"]) == ("down", True)
    assert status["signals"][0] == {"code": "maintenance_mode", "severity": "critical", "metrics": {}}
    assert down.ok("canaryResult", event_id, definition="CanaryResult") == {
        "state": "processing",
        "waiting_code": "maintenance",
    }
    guard = {"level": "shed", "reason": "maintenance", "until": stamp(time.time() + 600)}
    assert down.ok("setGuard", guard, definition="GuardState")["level"] == "shed"
