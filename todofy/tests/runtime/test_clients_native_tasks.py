"""Actual Python -> TasksApi RPC -> D1 create and read, with no Todoist server."""

import json
import shutil
import uuid
from collections.abc import Iterator
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

from tests.runtime.harness import ROOT, Worker, _run, _wrangler
from todofy.core.native_plan import CANONICAL_MAPPING
from todofy.core.render import FOOTER_PREFIX

EVENT = "6cd0ae26-2222-4222-8222-123456789012"


@pytest.fixture(scope="module")
def native(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    state = tmp_path_factory.mktemp("native-clients")
    stage = state / "caller"
    shutil.copytree(ROOT / "worker" / "todofy", stage / "todofy", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(Path(__file__).with_name("native_tasks_probe") / "entry.py", stage / "entry.py")
    (stage / "python_modules").symlink_to(ROOT / "python_modules", target_is_directory=True)
    caller = stage / "wrangler.json"
    caller.write_text(
        json.dumps(
            {
                "name": "todofy-native-clients-probe",
                "main": "entry.py",
                "compatibility_date": "2026-09-08",
                "compatibility_flags": ["python_workers"],
                "workers_dev": False,
                "preview_urls": False,
                "durable_objects": {"bindings": [{"name": "PLUS", "class_name": "NativePlusProbe"}]},
                "migrations": [{"tag": "v1", "new_sqlite_classes": ["NativePlusProbe"]}],
                "d1_databases": [
                    {
                        "binding": "DB",
                        "database_name": "native-planning-test",
                        "database_id": "00000000-0000-4000-8000-000000000002",
                        "migrations_dir": str(ROOT / "migrations"),
                    }
                ],
                "services": [
                    {
                        "binding": "TASKS",
                        "service": "native-tasks-storage",
                        "entrypoint": "TasksApi",
                        "props": {"access": "read-write"},
                    }
                ],
            }
        )
    )
    storage = state / "storage.json"
    storage.write_text(
        json.dumps(
            {
                "name": "native-tasks-storage",
                "main": str(ROOT.parent / "tasks/worker/src/index.ts"),
                "compatibility_date": "2026-09-08",
                "workers_dev": False,
                "preview_urls": False,
                "d1_databases": [
                    {
                        "binding": "DB",
                        "database_name": "native-tasks-test",
                        "database_id": "00000000-0000-4000-8000-000000000001",
                        "migrations_dir": str(ROOT.parent / "tasks/migrations"),
                    }
                ],
                "vars": {"TIME_ZONE": "America/Los_Angeles", "PUBLIC_HOST": "tasks.localhost"},
            }
        )
    )
    _wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", str(state), "--config", str(storage))
    yield from _run(
        Worker(
            [str(caller), str(storage)],
            str(caller),
            state,
            {
                "TASK_SOURCE": "tasks",
                "TODOIST_API_BASE": "http://127.0.0.1:1",
                "TASKS_PUBLIC_URL": "https://tasks.example.test",
            },
        )
    )


def call(worker: Worker, path: str, body: dict[str, Any]) -> dict[str, Any]:
    result = worker.hooks.post(path, json=body)
    assert result.status_code == 200, result.text
    return result.json()


def rpc(worker: Worker, method: str, body: dict[str, Any]) -> dict[str, Any]:
    return call(worker, "/native/call", {"method": method, "body": body})


def planning(worker: Worker, method: str, **body: Any) -> dict[str, Any]:
    return call(worker, "/native/plan", {"method": method, "body": body})


@pytest.fixture(scope="module")
def ready_plan(native: Worker) -> dict[str, Any]:
    current = planning(native, "ReadPlan")["plan"]
    document = json.dumps({"labels": CANONICAL_MAPPING, "etag": current["etag"]})
    native.d1(
        "INSERT OR REPLACE INTO plus_settings(id,mapping,timezone,week_start,enabled)"
        f" VALUES(1,'{document}','{current['timezone']}','{current['week_start']}',1);"
        "INSERT OR REPLACE INTO plan_settings VALUES ('native','{\"initialized\":true}',1)"
    )
    value = planning(native, "ReadPlan")["plan"]
    assert value["enabled"] is True and value["native_planning"] is True
    assert not value.get("labels") and not value.get("missing_labels")
    return value


def planning_task(worker: Worker, task_id: str) -> dict[str, Any]:
    tasks = planning(worker, "ListPlanningTasks", page_size=100)["planning_tasks"]
    return next(task for task in tasks if task["id"] == task_id)


def test_frozen_native_create_replay_and_full_footer_lookup(native):
    frozen = {
        "title": "Synthetic native mail",
        "description": f"Synthetic summary\n{FOOTER_PREFIX}{EVENT}",
        "request_id": "todofy-fixed-runtime-request",
    }
    first = call(native, "/native/create", frozen)
    repeated = call(native, "/native/create", frozen)
    assert first["result"] == repeated["result"] == "created"
    assert first["task_id"] == repeated["task_id"]
    rows = rpc(native, "ListTasks", {"view": "all", "include_description": True, "page_size": 20})
    assert len(rows["tasks"]) == 1
    assert rows["tasks"][0]["description"] == frozen["description"]
    assert call(native, "/native/find", {"event_id": EVENT})["ids"] == [first["task_id"]]


def test_native_mail_conversion_needs_no_inbox_project_or_planning_setup(native):
    assert not rpc(native, "GetCatalog", {"name": "catalog"}).get("projects")
    assert planning(native, "ReadPlan")["plan"].get("enabled", False) is False
    event_id = str(uuid.uuid4())
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,model)"
        f" VALUES('{event_id}',100,'Synthetic fresh Mail','Synthetic fresh summary','synthetic')"
    )
    [mail] = planning(native, "ListMailItems")["mail_items"]
    filed = planning(native, "ConvertMailItem", event_id=event_id, etag=mail["etag"], request_id=str(uuid.uuid4()))
    assert "task" in filed, filed
    task = rpc(native, "GetTask", {"name": f"tasks/{filed['task']['id']}"})
    assert task.get("project_id", "") == ""
    assert task["id"] in {row["id"] for row in rpc(native, "ListTasks", {"view": "inbox"})["tasks"]}
    assert f"[查看完整邮件摘要](https://tasks.example.test/?mail={event_id}#/mail)" in task["description"]


def test_intent_child_inherits_parent_project_without_rewriting_frozen_body(native):
    project = rpc(
        native, "CreateProject", {"project": {"title": "Synthetic native project"}, "request_id": str(uuid.uuid4())}
    )
    parent = call(
        native,
        "/native/create",
        {
            "title": "Synthetic intent parent",
            "description": "Synthetic intent",
            "project_id": project["id"],
            "request_id": str(uuid.uuid4()),
        },
    )
    child = call(
        native,
        "/native/create",
        {
            "title": "Synthetic intent child",
            "description": "Synthetic child",
            "parent_id": parent["task_id"],
            "request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "synthetic-child")),
        },
    )
    assert child["result"] == "created"
    value = rpc(native, "GetTask", {"name": f"tasks/{child['task_id']}"})
    assert value["project_id"] == project["id"]
    assert value["parent_id"] == parent["task_id"]


def test_native_plus_filing_and_decimal_order_use_real_sqlite_receipts_and_tasks_d1(native):
    label = rpc(native, "CreateLabel", {"label": {"title": "Synthetic planning"}, "request_id": str(uuid.uuid4())})
    project = rpc(native, "CreateProject", {"project": {"title": "Synthetic filed"}, "request_id": str(uuid.uuid4())})
    value = rpc(
        native,
        "CreateTask",
        {"task": {"title": "Synthetic mail filing", "sort_order": 1.25}, "request_id": str(uuid.uuid4())},
    )
    commands = [
        {
            "type": "item_update",
            "uuid": str(uuid.uuid4()),
            "args": {"id": value["id"], "labels": [label["title"]], "priority": 3},
            "_native_etag": value["etag"],
        },
        {
            "type": "item_move",
            "uuid": str(uuid.uuid4()),
            "args": {"id": value["id"], "project_id": project["id"]},
            "_native_etag": value["etag"],
        },
    ]
    assert "error" not in call(native, "/native/plus", {"commands": commands})
    filed = rpc(native, "GetTask", {"name": value["name"]})
    assert filed["project_id"] == project["id"] and filed["label_ids"] == [label["id"]] and filed["priority"] == 2
    assert "error" not in call(native, "/native/plus", {"commands": commands})
    assert rpc(native, "GetTask", {"name": value["name"]})["etag"] == filed["etag"]
    reorder = [
        {
            "type": "item_reorder",
            "uuid": str(uuid.uuid4()),
            "args": {"items": [{"id": filed["id"], "child_order": 1.375}]},
            "_native_etags": {filed["id"]: filed["etag"]},
        }
    ]
    assert "error" not in call(native, "/native/plus", {"commands": reorder})
    assert rpc(native, "GetTask", {"name": value["name"]})["sort_order"] == 1.375
    stale = [
        {
            "type": "item_update",
            "uuid": str(uuid.uuid4()),
            "args": {"id": value["id"], "priority": 4},
            "_native_etag": value["etag"],
        }
    ]
    assert call(native, "/native/plus", {"commands": stale}) == {"error": 409}
    assert rpc(native, "GetTask", {"name": value["name"]})["priority"] == 2


def test_native_planning_state_replays_and_rejects_stale_writes_without_changing_task_content(native):
    label = rpc(native, "CreateLabel", {"label": {"title": "Synthetic state context"}, "request_id": str(uuid.uuid4())})
    task = rpc(
        native,
        "CreateTask",
        {
            "task": {
                "title": "Synthetic native planning",
                "label_ids": [label["id"]],
                "due_date": "2026-11-03",
                "deadline": "2026-11-30",
            },
            "request_id": str(uuid.uuid4()),
        },
    )
    assert call(native, "/native/state", {"action": "ready"}) == {"ready": False}
    request = {
        "action": "save",
        "task_id": task["id"],
        "labels": ["committed", "office", "lead_2w", "waiting"],
        "expected_rev": 0,
        "request_id": str(uuid.uuid4()),
    }
    assert call(native, "/native/state", request) == {"revision": 1}
    assert call(native, "/native/state", request) == {"revision": 1}
    assert call(native, "/native/state", {**request, "request_id": str(uuid.uuid4()), "labels": ["quarter"]}) == {
        "error": 409
    }
    assert rpc(native, "GetTask", {"name": task["name"]}) == task
    projected = {"id": task["id"], "labels": [label["title"]], "updated_at": task["update_time"]}
    [first] = call(native, "/native/state", {"action": "overlay", "tasks": [projected]})["tasks"]
    assert set(first["labels"]) == {label["title"], "committed", "office", "lead_2w", "waiting"}
    assert first["_native_plan_rev"] == 1 and first["_native_planning"] is True
    assert call(
        native,
        "/native/state",
        {**request, "expected_rev": 1, "request_id": str(uuid.uuid4()), "labels": ["quarter", "home", "quick"]},
    ) == {"revision": 2}
    # Even the first action cannot overwrite a later plan after its original receipt was lost.
    assert call(native, "/native/state", request) == {"error": 409}
    [changed] = call(native, "/native/state", {"action": "overlay", "tasks": [projected]})["tasks"]
    assert set(changed["labels"]) == {label["title"], "quarter", "home", "quick"}
    assert changed["_native_plan_rev"] == 2
    assert native.d1("SELECT provider FROM plan_tasks WHERE external_id='" + task["id"] + "'") == [
        {"provider": "tasks"}
    ]
    native.d1("INSERT INTO plan_settings VALUES ('native', '{\"initialized\":true}', 1)")
    assert call(native, "/native/state", {"action": "ready"}) == {"ready": True}


def test_missing_native_state_does_not_reinterpret_old_labels(native):
    [task] = call(
        native,
        "/native/state",
        {
            "action": "overlay",
            "tasks": [{"id": "synthetic-unseeded", "labels": ["committed", "home", "ordinary-context"]}],
        },
    )["tasks"]
    assert task["labels"] == ["ordinary-context"]
    assert task["_native_plan_rev"] == 0


def test_actual_native_plan_actions_keep_gtd_state_out_of_task_labels(native, ready_plan):
    label = rpc(native, "CreateLabel", {"label": {"title": "Synthetic content label"}, "request_id": str(uuid.uuid4())})
    project = rpc(
        native, "CreateProject", {"project": {"title": "Synthetic planned work"}, "request_id": str(uuid.uuid4())}
    )
    task = rpc(
        native,
        "CreateTask",
        {
            "task": {
                "title": "Synthetic native commitment",
                "project_id": project["id"],
                "label_ids": [label["id"]],
                "due_date": "2030-01-01",
                "deadline": "2030-01-10",
            },
            "request_id": str(uuid.uuid4()),
        },
    )
    shown = planning_task(native, task["id"])
    request = {
        "task_id": task["id"],
        "etag": shown["etag"],
        "request_id": str(uuid.uuid4()),
        "stage": "committed",
        "area": "work",
        "quick": True,
    }
    planned = planning(native, "SetTaskPlan", **request)["task"]
    assert planned["stage"] == planned["explicit_stage"] == "committed"
    assert planned["area"] == "work" and planned["planning_flags"] == ["quick"]
    assert planned["labels"] == [label["title"]]
    assert rpc(native, "GetTask", {"name": task["name"]}) == task
    assert planning(native, "SetTaskPlan", **request)["task"] == planned
    assert planning(native, "SetTaskPlan", **{**request, "request_id": str(uuid.uuid4()), "stage": "monthly"}) == {
        "error": "ETAG_MISMATCH"
    }

    lead = {
        "task_id": task["id"],
        "etag": planned["etag"],
        "request_id": str(uuid.uuid4()),
        "deadline": "2030-01-12",
        "lead_days": 21,
    }
    updated = planning(native, "SetTaskLead", **lead)["task"]
    assert updated["lead_days"] == 21 and updated["deadline"] == "2030-01-12"
    physical = rpc(native, "GetTask", {"name": task["name"]})
    assert physical["due_date"] == task["due_date"] and physical["label_ids"] == [label["id"]]
    assert physical["deadline"] == "2030-01-12"
    assert planning(native, "SetTaskLead", **lead)["task"] == updated
    assert rpc(native, "GetTask", {"name": task["name"]}) == physical

    steps = {
        "parent_id": task["id"],
        "request_id": str(uuid.uuid4()),
        "steps": [
            {"title": "Synthetic first next step", "estimated_minutes": 45},
            {"title": "Synthetic second next step", "estimated_minutes": 75},
        ],
    }
    created = planning(native, "AppendTaskSteps", **steps)
    assert len(created["task_ids"]) == 2
    assert planning(native, "AppendTaskSteps", **steps) == created
    children = rpc(native, "ListTasks", {"parent_id": task["id"], "page_size": 100})["tasks"]
    assert [child["id"] for child in children] == created["task_ids"]
    assert [child["duration_minutes"] for child in children] == [45, 75]
    assert all(child["kind"] == "step" for child in children)
    subset = planning(native, "ListPlanningTasks", page_size=100, task_ids=created["task_ids"])["planning_tasks"]
    assert {row["id"] for row in subset} == set(created["task_ids"])
    assert all(row["kind"] == "step" for row in subset)
    assert all(child["project_id"] == project["id"] and not child.get("label_ids") for child in children)
    assert all(planning_task(native, child["id"])["parent_id"] == task["id"] for child in children)


def test_native_week_reset_changes_planning_only_and_keeps_next_week_choices(native, ready_plan):
    current = ready_plan["week_start"]
    following = (date.fromisoformat(current) + timedelta(days=7)).isoformat()
    roots = []
    for name in ("Synthetic ended commitment", "Synthetic kept commitment"):
        task = rpc(native, "CreateTask", {"task": {"title": name}, "request_id": str(uuid.uuid4())})
        planned = planning(
            native,
            "SetTaskPlan",
            task_id=task["id"],
            etag=planning_task(native, task["id"])["etag"],
            stage="committed",
            request_id=str(uuid.uuid4()),
        )
        assert planned["task"]["stage"] == "committed"
        roots.append(task)
    for task, week in zip(roots, (current, following), strict=True):
        native.d1(f"INSERT OR REPLACE INTO plus_weeks VALUES ('{task['id']}','{week}',1,0)")
    assert call(native, "/native/reset-week", {"week": following}) == {"complete": True}
    assert planning_task(native, roots[0]["id"])["stage"] == "weekly"
    assert planning_task(native, roots[1]["id"])["stage"] == "committed"
    for task in roots:
        assert rpc(native, "GetTask", {"name": task["name"]}) == task
    assert native.d1(f"SELECT task_id FROM plus_weeks WHERE task_id='{roots[0]['id']}'") == []
    assert native.d1(f"SELECT task_id FROM plus_weeks WHERE task_id='{roots[1]['id']}'") == [
        {"task_id": roots[1]["id"]}
    ]


@pytest.fixture
def mail_project(native, ready_plan):
    project = rpc(
        native,
        "CreateProject",
        {
            "project": {"title": "Synthetic mail project " + str(uuid.uuid4())},
            "request_id": str(uuid.uuid4()),
        },
    )
    previous_vars = dict(native.variables)
    native.stop()
    native.variables["TODOIST_DEFAULT_PROJECT_ID"] = project["id"]
    native.start()
    try:
        yield project
    finally:
        native.stop()
        native.variables.clear()
        native.variables.update(previous_vars)
        native.start()


@pytest.fixture(scope="module")
def active_label(native):
    return rpc(native, "CreateLabel", {"label": {"title": "active"}, "request_id": str(uuid.uuid4())})


def test_native_mail_delete_preserves_dependencies_and_gtd_state_with_real_tasks(native, mail_project, active_label):
    project = mail_project
    tasks = [
        rpc(
            native,
            "CreateTask",
            {
                "task": {
                    "title": f"Synthetic native mail {name}",
                    "project_id": project["id"],
                    "label_ids": [active_label["id"]] if name == "tagged" else [],
                },
                "request_id": str(uuid.uuid4()),
            },
        )
        for name in ("plain", "waiter", "prerequisite", "planned", "tagged")
    ]
    plain, waiter, prerequisite, planned, tagged = tasks
    for task in tasks:
        native.d1(
            "INSERT INTO summaries(event_id,created_at,subject,summary,model,task_id)"
            f" VALUES('{uuid.uuid4()}',1,'Synthetic mail','Synthetic summary','synthetic','{task['id']}')"
        )
    assert "dependencies" in planning(
        native,
        "SetTaskDependency",
        task_id=waiter["id"],
        prerequisite_id=prerequisite["id"],
        waits=True,
        request_id=str(uuid.uuid4()),
    )
    shown = planning_task(native, planned["id"])
    assert "task" in planning(
        native,
        "SetTaskPlan",
        task_id=planned["id"],
        stage="committed",
        etag=shown["etag"],
        request_id=str(uuid.uuid4()),
    )
    # A legacy dependency with the same external ID belongs to a different source.
    native.d1(
        "INSERT INTO plan_tasks(provider,external_id,created_at) VALUES"
        f" ('todoist','{plain['id']}',1),('todoist','synthetic-legacy-waiter',1);"
        "INSERT INTO plan_edges(task_id,prerequisite_id,created_at)"
        " SELECT t.id,p.id,1 FROM plan_tasks t,plan_tasks p"
        " WHERE t.provider='todoist' AND t.external_id='synthetic-legacy-waiter'"
        f" AND p.provider='todoist' AND p.external_id='{plain['id']}'"
    )
    request = {"task_ids": [task["id"] for task in tasks], "request_id": str(uuid.uuid4())}
    answer = planning(native, "DeleteMailItems", **request)
    assert answer == {
        "deleted_task_ids": [plain["id"]],
        "kept_task_ids": [waiter["id"], prerequisite["id"], planned["id"], tagged["id"]],
    }
    assert planning(native, "DeleteMailItems", **request) == answer
    active = rpc(native, "ListTasks", {"view": "project", "project_id": project["id"]})["tasks"]
    assert {task["id"] for task in active} == {waiter["id"], prerequisite["id"], planned["id"], tagged["id"]}
    assert native.d1(f"SELECT count(*) AS n FROM summaries WHERE task_id='{plain['id']}'") == [{"n": 0}]
    for task in tasks[1:]:
        assert native.d1(f"SELECT count(*) AS n FROM summaries WHERE task_id='{task['id']}'") == [{"n": 1}]
    assert rpc(native, "GetTask", {"name": planned["name"]}) == planned


def test_native_mail_category_is_an_ordinary_tag_and_files_with_one_generic_update(native, mail_project, active_label):
    inbox = rpc(
        native,
        "CreateProject",
        {
            "project": {"title": "Synthetic everyday intake"},
            "request_id": str(uuid.uuid4()),
        },
    )
    _wrangler(
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        str(native.persist_to),
        "--config",
        native.configs[1],
        "--command",
        f"UPDATE projects SET inbox=1 WHERE id='{inbox['id']}'",
    )
    label = active_label
    task = rpc(
        native,
        "CreateTask",
        {
            "task": {"title": "Synthetic mail with ordinary active category", "project_id": mail_project["id"]},
            "request_id": str(uuid.uuid4()),
        },
    )
    settings = planning(native, "ReadMailSettings")
    assert "destination" not in settings
    saved = planning(
        native,
        "UpdateMailCategories",
        categories=[
            {
                "label": {"provider": "tasks", "external_id": label["id"]},
                "priority": "p2",
            }
        ],
        etag=settings["etag"],
    )
    assert "error" not in saved, saved
    assert "destination" not in saved and len(saved["categories"]) == 1
    shown = planning_task(native, task["id"])
    request = {
        "task_id": task["id"],
        "etag": shown["etag"],
        "category_id": saved["categories"][0]["id"],
        "categories_etag": saved["etag"],
        "request_id": str(uuid.uuid4()),
    }
    filed = planning(native, "FileMailItem", **request)
    assert "task" in filed, filed
    physical = rpc(native, "GetTask", {"name": task["name"]})
    assert physical["project_id"] == inbox["id"]
    assert physical["label_ids"] == [label["id"]] and physical["priority"] == 2
    assert physical["etag"] == str(int(task["etag"]) + 1)
    projected = planning_task(native, task["id"])
    assert projected["labels"] == ["active"]
    assert "active" not in projected.get("planning_flags", []) and projected["stage"] == "none"
    assert planning(native, "FileMailItem", **request) == filed
    assert rpc(native, "GetTask", {"name": task["name"]}) == physical


def test_native_mail_exists_before_task_and_explicit_conversion_creates_only_one_inbox_task(native, ready_plan):
    event_id = str(uuid.uuid4())
    title = "Synthetic deferred mail " + "😀" * 250
    summary = "Full synthetic summary.\n" + "😀" * 9000
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,brief,model)"
        f" VALUES('{event_id}',100,'{title}','{summary}','Synthetic brief.','synthetic')"
    )
    before = rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"]
    listed = planning(native, "ListMailItems", page_size=50)
    mail = next(item for item in listed["mail_items"] if item["id"] == event_id)
    assert mail["title"] == title and "task" not in mail
    assert planning(native, "ReadMailSummary", id=event_id) == {"summary": summary}
    assert rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"] == before
    plan = planning(native, "ReadPlan")["plan"]
    assert plan["mailbox_pending_count"] == len(listed["mail_items"])
    request = {"event_id": event_id, "etag": mail["etag"], "request_id": str(uuid.uuid4())}
    assert planning(native, "ConvertMailItem", **{**request, "etag": "stale"}) == {"error": "ETAG_MISMATCH"}
    filed = planning(native, "ConvertMailItem", **request)
    assert "task" in filed, filed
    assert planning(native, "ConvertMailItem", **request) == filed
    task = rpc(native, "GetTask", {"name": f"tasks/{filed['task']['id']}"})
    assert task.get("project_id", "") == ""
    assert task["title"].startswith("Synthetic deferred mail") and title.startswith(task["title"])
    assert len(task["title"].encode("utf-16-le")) <= 1000
    assert "Full synthetic summary." in task["description"] and "任务描述已截断" in task["description"]
    assert f"[查看完整邮件摘要](https://tasks.example.test/?mail={event_id}#/mail)" in task["description"]
    assert len(task["description"].encode("utf-16-le")) <= 32000
    after = rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"]
    assert len(after) == len(before) + 1
    [saved] = native.d1(f"SELECT task_id,triaged_at FROM summaries WHERE event_id='{event_id}'")
    assert saved["task_id"] == task["id"] and saved["triaged_at"] > 0
    assert event_id not in {item["id"] for item in planning(native, "ListMailItems").get("mail_items", [])}
    # Recreate the one possible interrupted boundary: Tasks committed but the D1 triage link did not.
    native.d1(f"UPDATE summaries SET task_id='',triaged_at=NULL WHERE event_id='{event_id}'")
    repeated = planning(native, "ConvertMailItem", **{**request, "request_id": str(uuid.uuid4())})
    assert repeated == filed
    assert rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"] == after
    assert planning(native, "ReadMailSummary", id=event_id) == {"summary": summary}


def test_native_mail_summary_delete_never_deletes_a_linked_task(native, ready_plan):
    task = rpc(
        native,
        "CreateTask",
        {"task": {"title": "Synthetic task retained after mail deletion"}, "request_id": str(uuid.uuid4())},
    )
    event_id = str(uuid.uuid4())
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,model,task_id)"
        f" VALUES('{event_id}',101,'Synthetic old mail','Synthetic old summary','synthetic','{task['id']}')"
    )
    request = {"event_ids": [event_id], "request_id": str(uuid.uuid4())}
    assert planning(native, "DeleteMailSummaries", **request) == {"deleted_event_ids": [event_id]}
    assert planning(native, "DeleteMailSummaries", **request) == {"deleted_event_ids": [event_id]}
    assert rpc(native, "GetTask", {"name": task["name"]}) == task
    assert planning(native, "ReadMailSummary", id=event_id) == {}


def test_native_weekly_bet_and_dependencies_persist_and_real_completion_releases_waiting(native, ready_plan):
    plan = planning(native, "ReadPlan")["plan"]
    current = next(
        (
            bet
            for bet in plan.get("weekly_bets", [])
            if bet["week_start"] == plan["week_start"] and bet["area"] == "work"
        ),
        {},
    )
    before = rpc(native, "ListTasks", {"view": "all", "page_size": 100})
    request = {
        "week_start": plan["week_start"],
        "area": "work",
        "etag": current.get("etag", ""),
        "text": "Finish the synthetic weekly outcome",
    }
    saved = planning(native, "SetWeeklyBet", **request)["weekly_bet"]
    assert saved["text"] == request["text"] and saved["etag"]
    assert planning(native, "SetWeeklyBet", **request) == {"weekly_bet": saved}
    assert saved in planning(native, "ReadPlan")["plan"]["weekly_bets"]
    assert rpc(native, "ListTasks", {"view": "all", "page_size": 100}) == before
    waiter, prerequisite = [
        rpc(native, "CreateTask", {"task": {"title": title}, "request_id": str(uuid.uuid4())})
        for title in ("Synthetic dependency waiter", "Synthetic dependency prerequisite")
    ]
    dependency = {
        "task_id": waiter["id"],
        "prerequisite_id": prerequisite["id"],
        "waits": True,
        "request_id": str(uuid.uuid4()),
    }
    added = planning(native, "SetTaskDependency", **dependency)
    [edge] = added["dependencies"]
    assert (
        edge["task_id"] == waiter["id"]
        and edge["prerequisite_id"] == prerequisite["id"]
        and not edge.get("done", False)
    )
    assert planning(native, "SetTaskDependency", **dependency) == added
    assert edge in planning(native, "ReadPlan")["plan"]["dependencies"]
    assert planning(
        native,
        "SetTaskDependency",
        task_id=prerequisite["id"],
        prerequisite_id=waiter["id"],
        waits=True,
        request_id=str(uuid.uuid4()),
    ) == {"error": "ACTION_NOT_ALLOWED"}
    assert rpc(native, "GetTask", {"name": waiter["name"]}) == waiter
    assert rpc(native, "GetTask", {"name": prerequisite["name"]}) == prerequisite
    complete = {"task_id": prerequisite["id"], "request_id": str(uuid.uuid4())}
    assert planning(native, "CompleteTask", **complete) == {"task_id": prerequisite["id"]}
    assert planning(native, "CompleteTask", **complete) == {"task_id": prerequisite["id"]}
    assert rpc(native, "GetTask", {"name": prerequisite["name"]})["completed"] is True
    assert len(rpc(native, "ListCompletions", {"task_id": prerequisite["id"]})["completions"]) == 1
    resolved = planning(
        native, "ResolveDependencies", task_ids=[waiter["id"], prerequisite["id"]], request_id=str(uuid.uuid4())
    )
    released = next(item for item in resolved["dependencies"] if item["task_id"] == waiter["id"])
    assert released["done"] is True and released in planning(native, "ReadPlan")["plan"]["dependencies"]
    assert rpc(native, "GetTask", {"name": waiter["name"]}) == waiter


def test_native_planning_missing_task_reports_source_error(native, ready_plan):
    assert planning(
        native,
        "SetTaskPlan",
        task_id="synthetic-does-not-exist",
        etag="missing",
        stage="weekly",
        request_id=str(uuid.uuid4()),
    ) == {"error": "NOT_FOUND"}


def test_native_hundred_siblings_reorder_through_one_atomic_tasks_operation(native, ready_plan):
    parent = rpc(
        native, "CreateTask", {"task": {"title": "Synthetic hundred-step parent"}, "request_id": str(uuid.uuid4())}
    )
    _wrangler(
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        str(native.persist_to),
        "--config",
        native.configs[1],
        "--command",
        "WITH RECURSIVE sequence(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM sequence WHERE i<99)"
        " INSERT INTO tasks(id,title,parent_id,sort_order,created_at,updated_at)"
        " SELECT 'synthetic-reorder-'||i,'Synthetic reorder step',"
        f" '{parent['id']}',i+0.25,1,1 FROM sequence",
    )
    ids = [f"synthetic-reorder-{index}" for index in reversed(range(100))]
    request = {"task_ids": ids, "task_id": ids[0], "request_id": str(uuid.uuid4())}
    answer = planning(native, "ReorderTasks", **request)
    assert "tasks" in answer, answer
    assert [task["id"] for task in answer["tasks"]] == ids
    assert [task["sort_order"] for task in answer["tasks"]] == [index + 0.25 for index in range(100)]
    actual = rpc(native, "ListTasks", {"parent_id": parent["id"], "page_size": 100})["tasks"]
    assert [task["id"] for task in actual] == ids and all(task["etag"] == "2" for task in actual)
    assert planning(native, "ReorderTasks", **request) == answer
    assert rpc(native, "ListTasks", {"parent_id": parent["id"], "page_size": 100})["tasks"] == actual


@pytest.mark.parametrize("recurring", [False, True])
def test_generic_completion_replays_exactly_through_core_for_focus_without_advancing_again(
    native, ready_plan, recurring
):
    task = rpc(
        native,
        "CreateTask",
        {
            "task": {
                "title": "Synthetic independently completed task",
                "due_date": "2030-01-01",
                **({"recurrence": "every day"} if recurring else {}),
            },
            "request_id": str(uuid.uuid4()),
        },
    )
    request_id = str(uuid.uuid4())
    http_request = {
        "method": "POST",
        "path": f"/api/tasks/v1/{task['name']}:complete",
        "body": {"etag": task["etag"], "request_id": request_id},
    }
    completed = call(native, "/native/http", http_request)
    # The browser can lose this response and repeat the same HTTP completion safely.
    assert call(native, "/native/http", http_request) == completed
    proof = {
        "task_id": task["id"],
        "task_etag": task["etag"],
        "request_id": request_id,
        "flow_task_id": task["id"],
        "flow_date": "2026-10-17",
    }
    assert planning(native, "CompleteTask", **proof) == {"task_id": task["id"]}
    assert planning(native, "CompleteTask", **proof) == {"task_id": task["id"]}
    current = rpc(native, "GetTask", {"name": task["name"]})
    assert current == completed and current["completed_count"] == 1
    if recurring:
        assert not current.get("completed") and current["due_date"] == completed["due_date"]


def test_completion_focus_target_must_be_a_completed_descendant(native, ready_plan):
    parent = rpc(
        native, "CreateTask", {"task": {"title": "Synthetic completed outcome"}, "request_id": str(uuid.uuid4())}
    )
    child = rpc(
        native,
        "CreateTask",
        {
            "task": {"title": "Synthetic timed step", "parent_id": parent["id"], "kind": "step"},
            "request_id": str(uuid.uuid4()),
        },
    )
    unrelated = rpc(
        native, "CreateTask", {"task": {"title": "Synthetic unrelated action"}, "request_id": str(uuid.uuid4())}
    )
    request_id = str(uuid.uuid4())
    rpc(native, "CompleteTask", {"name": parent["name"], "etag": parent["etag"], "request_id": request_id})
    proof = {
        "task_id": parent["id"],
        "task_etag": parent["etag"],
        "request_id": request_id,
        "flow_task_id": child["id"],
        "flow_date": "2026-10-16",
    }
    assert planning(native, "CompleteTask", **proof) == {"task_id": parent["id"]}
    assert rpc(native, "GetTask", {"name": child["name"]})["completed"]
    assert planning(
        native, "CompleteTask", **{**proof, "request_id": str(uuid.uuid4()), "flow_task_id": unrelated["id"]}
    ) == {"error": "ACTION_NOT_ALLOWED"}
    assert not rpc(native, "GetTask", {"name": unrelated["name"]}).get("completed")
    rpc(native, "CompleteTask", {"name": unrelated["name"], "etag": unrelated["etag"], "request_id": str(uuid.uuid4())})
    assert planning(
        native, "CompleteTask", **{**proof, "request_id": str(uuid.uuid4()), "flow_task_id": unrelated["id"]}
    ) == {"error": "ACTION_NOT_ALLOWED"}
    assert rpc(native, "GetTask", {"name": parent["name"]})["completed_count"] == 1


def test_catalog_metadata_selector_keeps_legacy_default_and_cross_language_false(native):
    full = rpc(native, "GetCatalog", {"name": "catalog"})
    explicit = rpc(native, "GetCatalog", {"name": "catalog", "include_task_counts": True})
    metadata = rpc(native, "GetCatalog", {"name": "catalog", "include_task_counts": False})
    assert explicit == full and full["task_counts"]
    assert metadata == {key: value for key, value in full.items() if key != "task_counts"}
