"""Plus through the real gateway, Python DO and D1; all upstream task data is synthetic."""

import json
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from tests.fakes.plus_fake import PlusFake
from tests.fakes.server import Reply
from tests.runtime.harness import CSRF_SIGNING_KEY, Worker, reason, start_gateway


@dataclass
class Stack:
    worker: Worker
    upstream: PlusFake
    token: str

    def write(self, action, **body):
        return self.worker.hooks.post(
            f"/api/plus/v1/tasks:{action}",
            json={"request_id": str(uuid.uuid4()), **body},
            headers={"authorization": "Bearer " + self.token},
        )

    def tasks(self):
        records, cursor = [], ""
        while True:
            response = self.worker.hooks.get(
                "/api/plus/v1/tasks",
                params={"page_size": 2, "page_token": cursor},
                headers={"authorization": "Bearer " + self.token},
            )
            assert response.status_code == 200, response.text
            records.extend(response.json().get("planning_tasks", []))
            cursor = response.json().get("next_page_token", "")
            if not cursor:
                return records


@pytest.fixture(scope="module")
def stack(tmp_path_factory) -> Iterator[Stack]:
    upstream = PlusFake()
    upstream.add("parent", labels=["office", "committed", "bets", "deep"], due={"date": "2026-10-01"})
    upstream.add("recurring", labels=["home"], due={"date": "2026-10-13", "is_recurring": True})
    upstream.add("third", labels=["candiate", "home"])
    process = start_gateway(
        tmp_path_factory.mktemp("plus-worker"),
        {
            "TODOIST_API_BASE": upstream.url,
            "TODOIST_API_KEY": "synthetic-plus-key",
            "PROCESSING_PAUSED": "true",
            "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
        },
    )
    try:
        worker = next(process)
        plan = worker.owner.get("/api/plus/v1/plan:read")
        assert plan.status_code == 200, plan.text
        assert not plan.json()["plan"].get("enabled", False)
        assert "api_token" not in plan.text and "synthetic-never-return" not in plan.text
        rejected = worker.post_owner(
            "/api/plus/v1/tasks:setTaskPlan",
            {
                "task_id": "parent",
                "etag": "stale",
                "stage": "monthly",
                "request_id": str(uuid.uuid4()),
            },
        )
        assert reason(rejected) == "ACTION_NOT_ALLOWED"
        assert upstream.commands() == []
        confirmed = worker.post_owner(
            "/api/plus/v1/plan:confirmPlanMapping",
            {
                "etag": plan.json()["plan"]["etag"],
                "request_id": str(uuid.uuid4()),
            },
        )
        assert confirmed.status_code == 200, confirmed.text
        request = {"display_name": "Synthetic Chrome", "request_id": str(uuid.uuid4())}
        issued = worker.post_owner("/api/plus/v1/connections:issueExtensionConnection", request)
        assert issued.status_code == 200, issued.text
        repeated = worker.post_owner("/api/plus/v1/connections:issueExtensionConnection", request)
        assert not repeated.json().get("token")
        token = issued.json()["token"]
        assert token not in json.dumps(worker.d1("SELECT * FROM plus_connections"))
        yield Stack(worker, upstream, token)
    finally:
        process.close()
        upstream.close()


def test_paged_projection_preserves_native_ids_dates_and_private_credentials(stack):
    tasks = stack.tasks()
    assert [task["id"] for task in tasks] == ["parent", "recurring", "third"]
    parent = tasks[0]
    assert parent["stage"] == "committed"
    assert parent["due"] == "2026-10-01" and not parent.get("deadline")
    assert parent["id"] == "parent"
    assert "estimated_minutes" not in parent
    assert (
        stack.worker.hooks.get(
            "/api/plus/v1/connections:read", headers={"authorization": "Bearer " + stack.token}
        ).status_code
        == 401
    )


def test_planning_and_deadline_actions_preserve_other_labels_and_scheduled_date(stack):
    parent = next(task for task in stack.tasks() if task["id"] == "parent")
    changed = stack.write("setTaskPlan", task_id="parent", etag=parent["etag"], stage="monthly")
    assert changed.status_code == 200, changed.text
    assert stack.upstream.tasks["parent"]["labels"] == ["bets", "candiate", "deep", "office"]
    stale = stack.write("setTaskPlan", task_id="parent", etag=parent["etag"], stage="weekly")
    assert reason(stale) == "ETAG_MISMATCH"
    lead = stack.write(
        "setTaskLead", task_id="parent", etag=changed.json()["task"]["etag"], deadline="2026-10-27", lead_days=14
    )
    assert lead.status_code == 200, lead.text
    assert stack.upstream.tasks["parent"]["due"] == {"date": "2026-10-01"}
    assert stack.upstream.tasks["parent"]["deadline"] == {"date": "2026-10-27"}
    assert "deep" in stack.upstream.tasks["parent"]["labels"]


def test_lost_append_response_replays_frozen_uuids_and_does_not_duplicate_children(stack):
    request = {
        "parent_id": "parent",
        "request_id": str(uuid.uuid4()),
        "steps": [
            {"title": "Synthetic next step", "estimated_minutes": 30},
            {"title": "Synthetic longer step", "estimated_minutes": 180},
        ],
    }
    stack.upstream.fail_commands_once = True
    first = stack.write("appendTaskSteps", **request)
    assert first.status_code == 503, first.text
    second = stack.write("appendTaskSteps", **request)
    assert second.status_code == 200, second.text
    ids = second.json()["task_ids"]
    assert len(ids) == len(set(ids)) == 2
    assert all(stack.upstream.tasks[task_id]["parent_id"] == "parent" for task_id in ids)
    assert stack.upstream.tasks[ids[1]]["duration"] == {"amount": 180, "unit": "minute"}
    adds = [command for command in stack.upstream.commands() if command["type"] == "item_add"]
    assert adds[:2] == adds[2:]


def test_recurring_completion_replay_advances_once_and_invalid_day_never_closes(stack):
    bad = stack.write("completeTask", task_id="recurring", flow_date="2026-99-99")
    assert bad.status_code == 400
    assert stack.upstream.closed == {}
    request = {"task_id": "recurring", "request_id": str(uuid.uuid4())}
    stack.upstream.fail_commands_once = True
    assert stack.write("completeTask", **request).status_code == 503
    assert stack.write("completeTask", **request).status_code == 200
    calls = len(stack.upstream.received())
    assert stack.write("completeTask", **request).status_code == 200
    assert len(stack.upstream.received()) == calls
    assert stack.upstream.closed == {"recurring": 1}


def test_late_week_reset_does_not_clear_a_recorded_new_week_decision(stack):
    plan = stack.worker.owner.get("/api/plus/v1/plan:read").json()["plan"]
    stack.upstream.tasks["parent"]["labels"] = ["office", "deep", "committed", "bets", "lead_2w"]
    stack.upstream.tasks["third"]["labels"] = ["home", "bets", "committed"]
    stack.worker.d1(
        "UPDATE plus_settings SET week_start='2000-01-03';"
        "UPDATE plus_weeks SET week_start='2000-01-03', committed=1, bet=1 WHERE task_id='parent';"
        f"INSERT OR REPLACE INTO plus_weeks VALUES('third','{plan['week_start']}',1,1);"
    )
    result = stack.worker.post_owner(
        "/api/plus/v1/plan:confirmPlanMapping",
        {
            "etag": plan["etag"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert result.status_code == 200, result.text
    assert stack.upstream.tasks["parent"]["labels"] == ["deep", "focus", "lead_2w", "office"]
    assert stack.upstream.tasks["third"]["labels"] == ["home", "bets", "committed"]


def test_revocation_stops_only_this_extension_connection(stack):
    [connection] = stack.worker.owner.get("/api/plus/v1/connections:read").json()["connections"]
    assert (
        stack.worker.post_owner(
            "/api/plus/v1/connections:revokeExtensionConnection",
            {
                "connection_id": connection["id"],
                "request_id": str(uuid.uuid4()),
            },
        ).status_code
        == 200
    )
    response = stack.worker.hooks.get("/api/plus/v1/plan:read", headers={"authorization": "Bearer " + stack.token})
    assert response.status_code == 401
    assert stack.worker.owner.get("/api/plus/v1/plan:read").status_code == 200


@pytest.mark.parametrize("paused", [True, False])
def test_plus_respects_force_pause_and_shared_auth_block(tmp_path, paused):
    upstream = PlusFake()
    process = start_gateway(
        tmp_path / "gate",
        {
            "TODOIST_API_BASE": upstream.url,
            "TODOIST_API_KEY": "synthetic-plus-key",
            "FORCE_PAUSE_TODOIST": "true" if paused else "false",
            "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
        },
    )
    try:
        worker = next(process)
        if not paused:
            upstream.queue("POST", "/api/v1/sync", Reply(401, {"error": "synthetic auth refusal"}))
        first = worker.owner.get("/api/plus/v1/plan:read")
        assert reason(first) == "ACTION_NOT_ALLOWED"
        second = worker.owner.get("/api/plus/v1/plan:read")
        assert reason(second) == ("ACTION_NOT_ALLOWED" if paused else "UNAVAILABLE")
        assert len(upstream.received()) == (0 if paused else 1)
    finally:
        process.close()
        upstream.close()
