"""Configuration and Quarter through the real gateway, Python DO and D1; synthetic upstream only."""

import json
import uuid
from copy import deepcopy

import pytest

from tests.fakes.plus_fake import PlusFake
from tests.runtime.harness import CSRF_SIGNING_KEY, reason, start_gateway


@pytest.fixture(scope="module")
def account(tmp_path_factory):
    upstream = PlusFake()
    upstream.add(
        "legacy-parent",
        labels=["committed", "bets", "office", "deep"],
        due={"date": "2026-12-01"},
        deadline={"date": "2026-12-20"},
    )
    upstream.add("quarter-task", labels=["quarter", "office", "deep"], due={"date": "2000-01-01"})
    upstream.add("bet-task", labels=["bets"], due={"date": "2000-01-01"})
    process = start_gateway(
        tmp_path_factory.mktemp("plus-label-worker"),
        {
            "TODOIST_API_BASE": upstream.url,
            "TODOIST_API_KEY": "synthetic-plus-key",
            "PROCESSING_PAUSED": "true",
            "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
        },
    )
    try:
        worker = next(process)
        plan = worker.owner.get("/api/plus/v1/plan:read").json()["plan"]
        issued = worker.post_owner(
            "/api/plus/v1/connections:issueExtensionConnection",
            {
                "display_name": "Synthetic planning",
                "request_id": str(uuid.uuid4()),
            },
        )
        assert issued.status_code == 200, issued.text
        token = issued.json()["token"]
        headers = {"authorization": "Bearer " + token}
        initial = worker.hooks.post(
            "/api/plus/v1/plan:updatePlanLabels",
            json={
                "labels": [row for row in plan["labels"] if row["role"] in {"candiate", "focus", "committed"}],
                "etag": plan["etag"],
                "request_id": str(uuid.uuid4()),
            },
            headers=headers,
        )
        assert reason(initial) == "ACTION_NOT_ALLOWED"
        confirmed = worker.post_owner(
            "/api/plus/v1/plan:confirmPlanMapping",
            {
                "etag": plan["etag"],
                "request_id": str(uuid.uuid4()),
            },
        )
        assert confirmed.status_code == 200, confirmed.text
        upstream.labels.extend(
            [
                {"id": "quarter-id", "name": "quarter"},
                {"id": "month-id", "name": "Next month"},
                {"id": "week-id", "name": "This week"},
                {"id": "commit-id", "name": "Commitments"},
            ]
        )
        upstream.filters.append({"id": "filter-committed", "name": "Synthetic committed", "query": "@committed"})
        yield worker, upstream, headers, plan["etag"]
    finally:
        process.close()
        upstream.close()


def read_plan(worker, headers):
    response = worker.hooks.get("/api/plus/v1/plan:read", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["plan"]


def update(worker, headers, plan, labels, request_id=None):
    body = {"labels": labels, "etag": plan["etag"], "request_id": request_id or str(uuid.uuid4())}
    return worker.hooks.post("/api/plus/v1/plan:updatePlanLabels", json=body, headers=headers), body


def columns(plan):
    return [row for row in plan["labels"] if row["role"] in {"quarter", "candiate", "focus", "committed"}]


def tasks(worker, headers):
    result, cursor = [], ""
    while True:
        response = worker.hooks.get(
            "/api/plus/v1/tasks", params={"page_size": 2, "page_token": cursor}, headers=headers
        )
        assert response.status_code == 200, response.text
        result.extend(response.json().get("planning_tasks", []))
        cursor = response.json().get("next_page_token", "")
        if not cursor:
            return {task["id"]: task for task in result}


def test_optional_quarter_keeps_the_confirmed_legacy_identity(account):
    worker, _, headers, old_etag = account
    plan = read_plan(worker, headers)
    assert plan["enabled"] and plan["etag"] == old_etag
    assert not any(row["role"] == "quarter" for row in plan["labels"])
    assert {"id": "quarter-id", "label": "quarter"} in plan["available_labels"]


def test_config_only_mapping_has_durable_receipts_and_does_not_retag_tasks(account):
    worker, upstream, headers, _ = account
    old = read_plan(worker, headers)
    before = deepcopy(upstream.tasks)
    first_labels = [*columns(old), {"role": "quarter", "id": "quarter-id", "label": "quarter"}]
    first, first_body = update(worker, headers, old, first_labels)
    assert first.status_code == 200, first.text
    first_plan = first.json()["plan"]
    assert first_plan["hidden_filter_ids"] == ["filter-bets", "filter-committed"]
    replacements = {
        "candiate": ("month-id", "Next month"),
        "focus": ("week-id", "This week"),
        "committed": ("commit-id", "Commitments"),
    }
    next_labels = [
        {**row, "id": replacements[row["role"]][0], "label": replacements[row["role"]][1]}
        if row["role"] in replacements
        else row
        for row in columns(first_plan)
    ]
    second, _ = update(worker, headers, first_plan, next_labels)
    assert second.status_code == 200, second.text
    second_plan = second.json()["plan"]
    assert second_plan["hidden_filter_ids"] == ["filter-bets"]
    replay = worker.hooks.post("/api/plus/v1/plan:updatePlanLabels", json=first_body, headers=headers)
    assert replay.status_code == 200 and replay.json()["plan"]["etag"] == first_plan["etag"]
    assert read_plan(worker, headers)["etag"] == second_plan["etag"]
    assert upstream.tasks == before and upstream.commands() == []
    saved = worker.d1("SELECT mapping FROM plus_settings WHERE id=1")[0]["mapping"]
    assert json.loads(saved)["labels"] == second_plan["labels"]
    assert [
        row for row in second_plan["labels"] if row["role"] not in replacements and row["role"] != "quarter"
    ] == old["labels"][:3] + old["labels"][6:]


def test_bound_names_drive_projection_and_preserve_native_dates_and_unrelated_labels(account):
    worker, upstream, headers, _ = account
    upstream.add(
        "configured-parent",
        labels=["Commitments", "bets", "office", "deep"],
        due={"date": "2026-12-01"},
        deadline={"date": "2026-12-20"},
    )
    records = tasks(worker, headers)
    assert records["quarter-task"]["stage"] == "quarterly"
    assert records["bet-task"]["stage"] == "none"
    assert records["configured-parent"]["stage"] == "committed"
    changed = worker.hooks.post(
        "/api/plus/v1/tasks:setTaskPlan",
        json={
            "task_id": "configured-parent",
            "etag": records["configured-parent"]["etag"],
            "stage": "quarterly",
            "request_id": str(uuid.uuid4()),
        },
        headers=headers,
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["task"]["stage"] == "quarterly"
    assert upstream.tasks["configured-parent"]["labels"] == ["bets", "deep", "office", "quarter"]
    assert upstream.tasks["configured-parent"]["due"] == {"date": "2026-12-01"}
    assert upstream.tasks["configured-parent"]["deadline"] == {"date": "2026-12-20"}


def test_stale_or_invalid_mapping_is_rejected_before_configuration_or_task_writes(account):
    worker, upstream, headers, _ = account
    plan = read_plan(worker, headers)
    before = deepcopy(upstream.tasks)
    selected = columns(plan)
    for replacement in (
        {"id": "1", "label": "office"},
        {"id": "missing-id", "label": "quarter"},
        {"id": "quarter-id", "label": "wrong name"},
    ):
        invalid = [{**row, **replacement} if row["role"] == "quarter" else row for row in selected]
        response, _ = update(worker, headers, plan, invalid)
        assert reason(response) == "BAD_REQUEST"
    stale, _ = update(worker, headers, {**plan, "etag": "stale"}, selected)
    assert reason(stale) == "ETAG_MISMATCH"
    assert read_plan(worker, headers)["etag"] == plan["etag"] and upstream.tasks == before


def test_ended_week_uses_old_bound_names_before_a_configuration_change(account):
    worker, upstream, headers, _ = account
    upstream.add("ended-parent", labels=["Commitments", "bets", "office", "deep"])
    tasks(worker, headers)
    plan = read_plan(worker, headers)
    quarter_before = deepcopy(upstream.tasks["quarter-task"])
    worker.d1(
        "UPDATE plus_settings SET week_start='2000-01-03';"
        "UPDATE plus_weeks SET week_start='2000-01-03', committed=1, bet=1 WHERE task_id='ended-parent';"
    )
    legacy_ids = {row["name"]: str(row["id"]) for row in upstream.labels}
    selected = [
        {**row, "id": legacy_ids[row["role"]], "label": row["role"]}
        if row["role"] in {"candiate", "focus", "committed"}
        else row
        for row in columns(plan)
    ]
    response, _ = update(worker, headers, plan, selected)
    assert response.status_code == 200, response.text
    assert upstream.tasks["ended-parent"]["labels"] == ["This week", "deep", "office"]
    assert upstream.tasks["quarter-task"] == quarter_before
    assert response.json()["plan"]["enabled"]
