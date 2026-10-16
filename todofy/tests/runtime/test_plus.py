"""Plus through the real gateway, Python DO and D1; all upstream task data is synthetic."""

import json
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, timedelta

import pytest

from tests.fakes.plus_fake import PlusFake
from tests.fakes.server import Reply
from tests.runtime.harness import CSRF_SIGNING_KEY, Worker, reason, start_gateway
from todofy.core import plus


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

    def plan(self):
        response = self.worker.hooks.get("/api/plus/v1/plan:read", headers={"authorization": "Bearer " + self.token})
        assert response.status_code == 200, response.text
        return response.json()["plan"]

    def weeks(self):
        return {row.pop("task_id"): row for row in self.worker.d1("SELECT * FROM plus_weeks")}

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


def bind_retired_bets(worker: Worker) -> None:
    """Make the saved setup the owner's: confirmed before the Bets became text, it also binds the bets label
    (PlusFake's label 3), which Plus keeps as saved; a setup confirmed now binds none."""
    [row] = worker.d1("SELECT mapping, timezone FROM plus_settings WHERE id=1")
    labels = [*json.loads(row["mapping"])["labels"], {"role": "bets", "id": "3", "label": "bets"}]
    mapping = json.dumps({"etag": plus.fingerprint([labels, row["timezone"]]), "labels": labels})
    worker.d1(f"UPDATE plus_settings SET mapping='{mapping}' WHERE id=1")


@pytest.fixture(scope="module")
def stack(tmp_path_factory) -> Iterator[Stack]:
    upstream = PlusFake()
    upstream.add(
        "parent",
        labels=["office", "committed", "bets", "deep"],
        due={"date": "2026-10-01"},
        updated_at="2026-10-14T09:30:05.123456Z",
    )
    upstream.add("recurring", labels=["home"], due={"date": "2026-10-13", "is_recurring": True})
    upstream.add("third", labels=["candiate", "home"])
    process = start_gateway(
        tmp_path_factory.mktemp("plus-worker"),
        {
            "TODOIST_API_BASE": upstream.url,
            "TODOIST_API_KEY": "synthetic-plus-key",
            "PROCESSING_PAUSED": "true",
            "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
            "TODOIST_DEFAULT_PROJECT_ID": "inbox-project",
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
        bind_retired_bets(worker)
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
    # Todoist's updated_at in whole seconds; a task without one has no update_time.
    assert parent["update_time"] == "2026-10-14T09:30:05Z" and "update_time" not in tasks[1]
    assert (
        stack.worker.hooks.get(
            "/api/plus/v1/connections:read", headers={"authorization": "Bearer " + stack.token}
        ).status_code
        == 401
    )


def test_planning_and_deadline_actions_preserve_other_labels_and_scheduled_date(stack):
    assert stack.plan()["enabled"]
    parent = next(task for task in stack.tasks() if task["id"] == "parent")
    assert parent["bet"]  # still labelled Bets, under the retired binding
    # Plus never writes the retired Bets label again; the request writes nothing.
    sent = len(stack.upstream.commands())
    refused = stack.write("setTaskPlan", task_id="parent", etag=parent["etag"], bet=False)
    assert reason(refused) == "BAD_REQUEST" and len(stack.upstream.commands()) == sent
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


def shifted(day: str, days: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


def iso_week(day: str) -> str:
    return "{:04d}-W{:02d}".format(*date.fromisoformat(day).isocalendar()[:2])


def test_plan_answers_carry_the_review_targets_ids_only(stack):
    week = stack.plan()["week_start"]
    stack.worker.d1(
        "INSERT INTO gtd_reviews (week, state, project_id, task_id, subject, body, created_at, updated_at) VALUES "
        f"('{iso_week(shifted(week, -7))}', 'created', 'inbox-project', 'review-before', 's', 'b', 1, 1),"
        f"('{iso_week(week)}', 'unknown', 'inbox-project', '', 's', 'b', 1, 1);"
    )
    plan = stack.plan()
    assert plan["inbox_project_id"] == "inbox-project"
    # This week's review has no known task yet, so the newest created one is last week's.
    assert plan["review_task_id"] == "review-before"
    stack.worker.d1(f"UPDATE gtd_reviews SET state='created', task_id='review-now' WHERE week='{iso_week(week)}'")
    assert stack.plan()["review_task_id"] == "review-now"
    stack.worker.d1("DELETE FROM gtd_reviews")
    assert "review_task_id" not in stack.plan()  # the wire profile omits an empty string


def test_only_the_owner_verifies_the_planning_store_and_gets_counts_only(stack):
    path = "/api/plus/v1/plan:verifyPlanStore"
    clean = stack.worker.owner.get(path)
    assert clean.status_code == 200 and clean.json() == {}  # every count zero: the profile omits each
    assert stack.worker.hooks.get(path, headers={"authorization": "Bearer " + stack.token}).status_code == 401
    stack.worker.d1(
        "INSERT INTO plan_tasks (provider, external_id, created_at) VALUES ('todoist', 'synthetic-a', 1);"
        "INSERT INTO plan_marks VALUES (999, 'kept', '2026-10-12', 1);"
    )
    try:
        assert stack.worker.owner.get(path).json() == {
            "task_row_count": 1,
            "mark_row_count": 1,
            "orphan_mark_count": 1,
        }
    finally:
        stack.worker.d1("DELETE FROM plan_marks; DELETE FROM plan_tasks;")


def test_sunday_choices_survive_monday_while_ended_week_commitments_reset(stack):
    stack.upstream.add("sunday-pick", labels=["home", "committed", "bets"])
    stack.upstream.add("weekday-pick", labels=["office", "committed"])
    stack.upstream.add("unfinished", labels=["office", "committed", "bets", "deep"])
    week = stack.plan()["week_start"]
    # On this week's Sunday: one choice recorded for next week, two commitments made earlier in the week.
    stack.worker.d1(
        f"UPDATE plus_settings SET week_start='{week}';"
        f"INSERT OR REPLACE INTO plus_weeks VALUES ('sunday-pick', '{shifted(week, 7)}', 1, 1),"
        f"('weekday-pick', '{week}', 1, 0), ('unfinished', '{week}', 1, 1);"
    )
    # Every task page and the cron's own page remember them under this week; the choice stays.
    stack.tasks()
    assert stack.worker.trigger_cron().status_code == 200
    assert stack.weeks()["sunday-pick"] == {"week_start": shifted(week, 7), "committed": 1, "bet": 1}
    assert stack.plan()["next_week_task_ids"] == ["sunday-pick"]
    # The same rows one week earlier: their week has ended, and the reset runs before the next decision.
    stack.worker.d1(
        f"UPDATE plus_settings SET week_start='{shifted(week, -7)}';"
        "UPDATE plus_weeks SET week_start=date(week_start, '-7 days')"
        " WHERE task_id IN ('sunday-pick', 'weekday-pick', 'unfinished');"
    )
    plan = stack.plan()
    result = stack.worker.post_owner(
        "/api/plus/v1/plan:confirmPlanMapping", {"etag": plan["etag"], "request_id": str(uuid.uuid4())}
    )
    assert result.status_code == 200, result.text
    assert stack.upstream.tasks["sunday-pick"]["labels"] == ["home", "committed", "bets"]
    assert stack.upstream.tasks["weekday-pick"]["labels"] == ["focus", "office"]
    assert stack.upstream.tasks["unfinished"]["labels"] == ["deep", "focus", "office"]
    weeks = stack.weeks()
    assert weeks["sunday-pick"]["week_start"] == week
    assert "weekday-pick" not in weeks and "unfinished" not in weeks
    assert "next_week_task_ids" not in stack.plan()


def test_a_plus_commitment_waits_for_the_week_it_was_chosen_for(stack):
    stack.upstream.add("chosen", labels=["office", "candiate"])
    task = next(task for task in stack.tasks() if task["id"] == "chosen")
    plan = stack.plan()
    committed = stack.write("setTaskPlan", task_id="chosen", etag=task["etag"], stage="committed")
    assert committed.status_code == 200, committed.text
    # The real clock decides the branch: next week on the account's Sunday, this week on other days.
    sunday = plan["today"] == shifted(plan["week_start"], 6)
    expected = shifted(plan["week_start"], 7) if sunday else plan["week_start"]
    assert stack.weeks()["chosen"] == {"week_start": expected, "committed": 1, "bet": 0}
    # A later write that chooses nothing (here, the area) never moves the row back.
    area = stack.write("setTaskPlan", task_id="chosen", etag=committed.json()["task"]["etag"], area="personal")
    assert area.status_code == 200, area.text
    assert stack.weeks()["chosen"] == {"week_start": expected, "committed": 1, "bet": 0}


def test_mark_in_progress_writes_only_an_existing_active_label_and_keeps_a_sunday_choice(stack):
    stack.upstream.add("deadline", labels=["office", "committed", "lead_1w", "deep"], deadline={"date": "2026-10-20"})
    task = next(task for task in stack.tasks() if task["id"] == "deadline")
    week = stack.plan()["week_start"]
    # Kept on Sunday for next week.
    stack.worker.d1(f"INSERT OR REPLACE INTO plus_weeks VALUES ('deadline', '{shifted(week, 7)}', 1, 0)")
    before = len(stack.upstream.commands())
    # The account has no `active` label yet: nothing is written, and no label is created.
    refused = stack.write("setTaskPlan", task_id="deadline", etag=task["etag"], active=True)
    assert reason(refused) == "ACTION_NOT_ALLOWED"
    assert len(stack.upstream.commands()) == before
    stack.upstream.labels.append({"id": "active-label", "name": "active"})
    try:
        marked = stack.write("setTaskPlan", task_id="deadline", etag=task["etag"], active=True)
        assert marked.status_code == 200, marked.text
        assert stack.upstream.tasks["deadline"]["labels"] == ["active", "committed", "deep", "lead_1w", "office"]
        assert stack.upstream.tasks["deadline"]["deadline"] == {"date": "2026-10-20"}
        view = marked.json()["task"]
        assert "active" in view["labels"] and not view.get("must_start") and not view.get("missing_lead")
        assert stack.weeks()["deadline"] == {"week_start": shifted(week, 7), "committed": 1, "bet": 0}
        cleared = stack.write("setTaskPlan", task_id="deadline", etag=view["etag"], active=False)
        assert cleared.status_code == 200, cleared.text
        assert stack.upstream.tasks["deadline"]["labels"] == ["committed", "deep", "lead_1w", "office"]
        assert stack.weeks()["deadline"]["week_start"] == shifted(week, 7)
    finally:
        stack.upstream.labels.pop()


def test_weekly_bets_are_text_in_d1_written_by_compare_and_set_without_todoist(stack):
    def bet(**body):
        response = stack.worker.hooks.post(
            "/api/plus/v1/weeklyBets:setWeeklyBet", json=body, headers={"authorization": "Bearer " + stack.token}
        )
        return response.json()["weekly_bet"] if response.status_code == 200 else reason(response)

    week = stack.plan()["week_start"]
    following, ended = shifted(week, 7), shifted(week, -7)
    calls = len(stack.upstream.received())
    created = bet(week_start=week, area="work", text="  Ship the\nsynthetic draft ")
    assert created["text"] == "Ship the synthetic draft" and created["etag"] == "1"
    # Sending the saved text again (a lost answer) answers it as saved, whatever the etag.
    assert bet(week_start=week, area="work", text="Ship the synthetic draft") == created
    changed = bet(week_start=week, area="work", text="Ship it to review", etag="1")
    assert changed["etag"] == "2"
    assert bet(week_start=week, area="work", text="From an older tab", etag="1") == "ETAG_MISMATCH"
    cleared = bet(week_start=week, area="work", text="", etag="2")
    assert cleared["etag"] == "3" and "text" not in cleared
    assert bet(week_start=following, area="personal", text="Next week's synthetic line")["etag"] == "1"
    assert bet(week_start=ended, area="work", text="Too late") == "ACTION_NOT_ALLOWED"
    assert bet(week_start=week, area="office", text="A label is no area") == "BAD_REQUEST"
    assert len(stack.upstream.received()) == calls  # no Todoist call, no metadata Sync
    # The cleared row stays at its rev, so an old etag can never overwrite it unseen.
    assert stack.worker.d1("SELECT period, area, body, rev FROM plan_notes WHERE kind = 'bets' ORDER BY period") == [
        {"period": week, "area": "work", "body": "", "rev": 3},
        {"period": following, "area": "personal", "body": "Next week's synthetic line", "rev": 1},
    ]
    shown = [(row["week_start"], row["area"], row.get("text", "")) for row in stack.plan()["weekly_bets"]]
    assert shown == [(week, "work", ""), (following, "personal", "Next week's synthetic line")]
    stack.worker.d1("DELETE FROM plan_notes")


def test_parking_writes_only_an_existing_parked_label_and_sets_the_task_aside(stack):
    stack.upstream.add("aside", labels=["office", "committed", "active", "deep"])
    task = next(task for task in stack.tasks() if task["id"] == "aside")
    before = len(stack.upstream.commands())
    # The account has no `parked` label yet: nothing is written, and no label is created.
    assert reason(stack.write("setTaskPlan", task_id="aside", etag=task["etag"], parked=True)) == "ACTION_NOT_ALLOWED"
    assert len(stack.upstream.commands()) == before
    stack.upstream.labels.append({"id": "parked-label", "name": "parked"})
    try:
        parked = stack.write("setTaskPlan", task_id="aside", etag=task["etag"], parked=True)
        assert parked.status_code == 200, parked.text
        assert stack.upstream.tasks["aside"]["labels"] == ["deep", "office", "parked"]
        assert "aside" not in stack.weeks()  # no commitment left to reset
        back = stack.write(
            "setTaskPlan", task_id="aside", etag=parked.json()["task"]["etag"], stage="monthly", parked=False
        )
        assert back.status_code == 200, back.text
        assert stack.upstream.tasks["aside"]["labels"] == ["candiate", "deep", "office"]
    finally:
        stack.upstream.labels.pop()


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
