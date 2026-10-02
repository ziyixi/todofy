"""The GTD ledger through the shipped Worker (docs/gtd-features.md): the coordinator's alarm takes
the daily Todoist snapshot, ops-v1 status() carries its counters (validated against contracts/ops-v1),
the owner API serves the series, and an owner recompute of the recommendation carries still-open
mail tasks. A paused Todoist makes no GTD call. Synthetic tasks only."""

import json
import time
import uuid
from collections.abc import Callable, Iterator

import pytest
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import TodoistFake, stamp
from tests.runtime.conftest import pipeline_vars
from tests.runtime.harness import wait_until
from tests.runtime.ops_support import OpsStack, start_ops_stack
from tests.runtime.owner_support import assert_message
from todofy.core import gtd

NOW = int(time.time())
DAY = 86_400
SENTINEL = "SENTINEL-alarm-3b7d"
StackLaunch = Callable[..., OpsStack]


def wake(stack: OpsStack) -> None:
    """Run the object's alarm: a stored ops report wakes it (the probe primary has no cron)."""
    report = {"generated_at": gtd.rfc3339(int(time.time())), "items": []}
    assert stack.ok("reportOps", report, definition="OpsReportReceipt")["stored"] is True


@pytest.fixture(scope="module")
def launch_stack(
    tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake
) -> Iterator[StackLaunch]:
    running: list[Iterator[OpsStack]] = []

    def start(**overrides: str) -> OpsStack:
        variables = pipeline_vars(gemini, todoist) | {"GTD_COLLECT_UTC": "00:00"} | overrides
        process = start_ops_stack(tmp_path_factory.mktemp("gtd"), variables)
        running.append(process)
        return next(process)

    yield start
    for process in running:
        process.close()


@pytest.fixture(scope="module")
def seeded(todoist: TodoistFake) -> list[str]:
    """Tasks in Todoist before the Worker starts: its first alarm takes the snapshot."""
    todoist.reset()
    ids = [
        todoist.add_task(SENTINEL, SENTINEL, added_at=stamp(NOW - 3 * DAY), due={"date": gtd.day_of(NOW - 2 * DAY)}).id,
        todoist.add_task(SENTINEL, SENTINEL, added_at=stamp(NOW - 40 * DAY)).id,
        todoist.add_task(SENTINEL, SENTINEL, project_id="work").id,
    ]
    done = todoist.add_task(SENTINEL, SENTINEL, added_at=stamp(NOW - DAY))
    todoist.complete(done.id, NOW - 3600)
    return ids


@pytest.fixture(scope="module")
def stack(launch_stack: StackLaunch, seeded: list[str]) -> OpsStack:
    stack = launch_stack()
    # Mail tasks from before the 24 h window, one still open in Todoist.
    stack.d1(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id) VALUES"
        f" ('old-open', {NOW - 3 * DAY}, 's', '三天前的提醒', 'm', '{seeded[0]}'),"
        f" ('old-closed', {NOW - 4 * DAY}, 's', '已完成', 'm', 'closed-task')"
    )
    wake(stack)
    wait_until(
        lambda: stack.d1("SELECT status FROM gtd_snapshots WHERE status != 'collecting'") or None, 60, "snapshot"
    )
    return stack


def test_the_alarm_takes_the_daily_snapshot(stack: OpsStack, todoist: TodoistFake) -> None:
    [snapshot] = stack.d1("SELECT day, status, task_count FROM gtd_snapshots")
    assert snapshot == {"day": gtd.day_of(int(time.time())), "status": "ok", "task_count": 3}
    daily = {row["scope"]: row for row in stack.d1("SELECT * FROM gtd_daily")}
    assert (daily["all"]["open"], daily["all"]["overdue"], daily["all"]["mail_open"]) == (3, 1, 1)
    assert (daily["inbox"]["open"], daily["inbox"]["oldest_days"], daily["inbox"]["completed_7d"]) == (2, 40, 1)
    assert len(todoist.lists()) == 1 and len(todoist.completed_lists()) == 1


def test_status_carries_the_gtd_counters(stack: OpsStack) -> None:
    status = stack.ok("status", definition="OpsStatus")
    counters = status["counters"]
    assert {name: counters[name] for name in ("inbox_open", "inbox_oldest_days", "overdue", "carryover_open")} == {
        "inbox_open": 2,
        "inbox_oldest_days": 40,
        "overdue": 1,
        "carryover_open": 1,
    }
    assert counters["completed_7d"] == 1 and "review_age_days" not in counters  # the review is off here
    codes = [signal["code"] for signal in status["signals"]]
    assert "gtd_snapshot_stale" not in codes and "review_overdue" not in codes
    assert len(counters) <= 32 and SENTINEL not in json.dumps(status)


def test_the_owner_api_serves_the_series(stack: OpsStack) -> None:
    body = assert_message(stack.owner.get("/api/v1/gtdDays", params={"page_size": "3"}), pb.ListGtdDaysResponse)
    days = body["gtd_days"]
    assert [day.get("recorded", False) for day in days] == [True, False, False]
    assert days[0]["inbox"]["open_count"] == 2
    reviews = assert_message(
        stack.owner.get("/api/v1/gtdReviews", params={"page_size": "1"}), pb.ListGtdReviewsResponse
    )
    assert reviews == {}
    assert SENTINEL not in json.dumps(body)
    for bad in ("-1", "x"):
        assert stack.owner.get("/api/v1/gtdDays", params={"page_size": bad}).status_code == 400


def test_an_owner_recompute_carries_the_open_mail_task(stack: OpsStack, gemini: GeminiFake) -> None:
    body = {"kind": "recommendation", "request_id": str(uuid.uuid4())}
    answer = assert_message(stack.post_owner("/api/v1/latestReports:recompute", body), pb.RecomputeReportResponse)
    report = answer["recommendation"]
    assert (report["new_count"], report["carryover_count"]) == (0, 1)
    [call] = gemini.calls_mentioning("三天前的提醒")
    assert "[3 天前] 三天前的提醒" in call.user and "已完成" not in call.user


def test_the_snapshot_holds_no_task_text(stack: OpsStack) -> None:
    rows = stack.d1("SELECT * FROM gtd_snapshot_tasks")
    assert len(rows) == 3 and SENTINEL not in json.dumps(rows)
    log = (stack.persist_to / "dev.log").read_text(errors="replace")
    assert SENTINEL not in log


def test_a_paused_todoist_makes_no_gtd_call(launch_stack: StackLaunch, todoist: TodoistFake) -> None:
    todoist.reset()
    todoist.add_task(SENTINEL)
    paused = launch_stack(FORCE_PAUSE_TODOIST="true")
    wake(paused)
    time.sleep(3)
    assert todoist.received("GET") == [] and paused.d1("SELECT day FROM gtd_snapshots") == []
    status = paused.ok("status", definition="OpsStatus")
    # Paused on purpose: the snapshot is not called stale, and there are no counters to report.
    assert "gtd_snapshot_stale" not in [signal["code"] for signal in status["signals"]]
    assert "inbox_open" not in status["counters"]
