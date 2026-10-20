"""Actual Python -> TasksApi RPC -> D1 create and read: Todofy's task creates and footer lookup, and Mail's
conversion through its receipt (runtime/plus_api.py) on a real TodofyCore and the Tasks Worker's D1."""

import json
import shutil
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tests.runtime.harness import ROOT, Worker, _run, tasks_config
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
                        "database_name": "native-clients-test",
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
    storage = str(tasks_config(state / "storage.json", "native-tasks-storage", "00000000-0000-4000-8000-000000000001"))
    yield from _run(
        Worker([str(caller), storage], str(caller), state, {"TASKS_PUBLIC_URL": "https://tasks.example.test"}, storage)
    )


def call(worker: Worker, path: str, body: dict[str, Any]) -> dict[str, Any]:
    result = worker.hooks.post(path, json=body)
    assert result.status_code == 200, result.text
    return result.json()


def rpc(worker: Worker, method: str, body: dict[str, Any]) -> dict[str, Any]:
    return call(worker, "/native/call", {"method": method, "body": body})


def plus(worker: Worker, method: str, **body: Any) -> dict[str, Any]:
    """One PlusService rpc as Tasks' Planning channel reaches TodofyCore."""
    return call(worker, "/native/plus", {"method": method, "body": body})


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


def test_native_mail_conversion_needs_no_inbox_project(native):
    assert not rpc(native, "GetCatalog", {"name": "catalog"}).get("projects")
    event_id = str(uuid.uuid4())
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,model)"
        f" VALUES('{event_id}',100,'Synthetic fresh Mail','Synthetic fresh summary','synthetic')"
    )
    [mail] = plus(native, "ListMailItems")["mail_items"]
    filed = plus(native, "ConvertMailItem", event_id=event_id, etag=mail["etag"], request_id=str(uuid.uuid4()))
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


def test_mail_task_operations_replay_through_tasks_receipts(native):
    label = rpc(native, "CreateLabel", {"label": {"title": "Synthetic filing"}, "request_id": str(uuid.uuid4())})
    project = rpc(native, "CreateProject", {"project": {"title": "Synthetic filed"}, "request_id": str(uuid.uuid4())})
    value = rpc(
        native,
        "CreateTask",
        {"task": {"title": "Synthetic mail filing", "sort_order": 1.25}, "request_id": str(uuid.uuid4())},
    )
    filing = [
        {
            "method": "UpdateTask",
            "body": {
                "task": {"name": value["name"], "label_ids": [label["id"]], "priority": 2, "project_id": project["id"]},
                "etag": value["etag"],
                "update_mask": "label_ids,priority,project_id",
                "request_id": str(uuid.uuid4()),
            },
        }
    ]
    assert call(native, "/native/commands", {"commands": filing}) == {"task_ids": [value["id"]]}
    filed = rpc(native, "GetTask", {"name": value["name"]})
    assert filed["project_id"] == project["id"] and filed["label_ids"] == [label["id"]] and filed["priority"] == 2
    # Resent after a lost answer, its etag is stale by now: Tasks' receipt answers it, nothing is written again.
    assert call(native, "/native/commands", {"commands": filing}) == {"task_ids": [value["id"]]}
    assert rpc(native, "GetTask", {"name": value["name"]})["etag"] == filed["etag"]
    stale = [
        {
            "method": "UpdateTask",
            "body": {
                "task": {"name": value["name"], "priority": 4},
                "etag": value["etag"],
                "update_mask": "priority",
                "request_id": str(uuid.uuid4()),
            },
        }
    ]
    assert call(native, "/native/commands", {"commands": stale}) == {"error": "ETAG_MISMATCH"}
    # A receipt started while Todoist was still a store holds a Sync command: refused, never converted.
    envelope = [{"type": "item_update", "uuid": str(uuid.uuid4()), "args": {"id": value["id"], "priority": 4}}]
    assert call(native, "/native/commands", {"commands": envelope}) == {"error": "ACTION_NOT_ALLOWED"}
    assert rpc(native, "GetTask", {"name": value["name"]})["priority"] == 2


@pytest.fixture(scope="module")
def active_label(native):
    return rpc(native, "CreateLabel", {"label": {"title": "active"}, "request_id": str(uuid.uuid4())})


def test_native_mail_category_is_an_ordinary_tag_on_the_converted_inbox_task(native, active_label):
    label = active_label
    event_id = str(uuid.uuid4())
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,model)"
        f" VALUES('{event_id}',103,'Synthetic mail with a category','Synthetic summary','synthetic')"
    )
    settings = plus(native, "ReadMailSettings")
    assert "destination" not in settings
    saved = plus(
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
    listed = plus(native, "ListMailItems", page_size=50)
    mail = next(item for item in listed["mail_items"] if item["id"] == event_id)
    request = {
        "event_id": event_id,
        "etag": mail["etag"],
        "category_id": saved["categories"][0]["id"],
        "categories_etag": listed["categories_etag"],
        "request_id": str(uuid.uuid4()),
    }
    converted = plus(native, "ConvertMailItem", **request)
    assert "task" in converted, converted
    physical = rpc(native, "GetTask", {"name": f"tasks/{converted['task']['id']}"})
    assert physical.get("project_id", "") == ""
    assert physical["label_ids"] == [label["id"]] and physical["priority"] == 2
    assert plus(native, "ConvertMailItem", **request) == converted
    assert rpc(native, "GetTask", {"name": physical["name"]}) == physical


def test_native_mail_exists_before_task_and_explicit_conversion_creates_only_one_inbox_task(native):
    event_id = str(uuid.uuid4())
    title = "Synthetic deferred mail " + "😀" * 250
    summary = "Full synthetic summary.\n" + "😀" * 9000
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,brief,model)"
        f" VALUES('{event_id}',100,'{title}','{summary}','Synthetic brief.','synthetic')"
    )
    before = rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"]
    listed = plus(native, "ListMailItems", page_size=50)
    mail = next(item for item in listed["mail_items"] if item["id"] == event_id)
    assert mail["title"] == title and "task" not in mail
    assert plus(native, "ReadMailSummary", id=event_id) == {"summary": summary}
    assert rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"] == before
    review = plus(native, "ReadWeeklyReview", week_start="2026-10-12")
    assert review["mailbox_pending_count"] == len(listed["mail_items"])
    request = {"event_id": event_id, "etag": mail["etag"], "request_id": str(uuid.uuid4())}
    assert plus(native, "ConvertMailItem", **{**request, "etag": "stale"}) == {"error": "ETAG_MISMATCH"}
    filed = plus(native, "ConvertMailItem", **request)
    assert "task" in filed, filed
    assert plus(native, "ConvertMailItem", **request) == filed
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
    assert event_id not in {item["id"] for item in plus(native, "ListMailItems").get("mail_items", [])}
    # Recreate the one possible interrupted boundary: Tasks committed but the D1 triage link did not.
    native.d1(f"UPDATE summaries SET task_id='',triaged_at=NULL WHERE event_id='{event_id}'")
    repeated = plus(native, "ConvertMailItem", **{**request, "request_id": str(uuid.uuid4())})
    assert repeated == filed
    assert rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"] == after
    assert plus(native, "ReadMailSummary", id=event_id) == {"summary": summary}


@pytest.mark.parametrize("gone", ["deleted", "completed"])
def test_mail_whose_linked_task_is_gone_becomes_a_new_inbox_task(native, gone):
    old = rpc(
        native,
        "CreateTask",
        {"task": {"title": f"Synthetic {gone} mail task"}, "request_id": str(uuid.uuid4())},
    )
    method = "DeleteTask" if gone == "deleted" else "CompleteTask"
    rpc(native, method, {"name": old["name"], "etag": old["etag"], "request_id": str(uuid.uuid4())})
    event_id = str(uuid.uuid4())
    native.d1(
        "INSERT INTO summaries(event_id,created_at,subject,summary,model,task_id)"
        f" VALUES('{event_id}',102,'Synthetic linked mail','Synthetic summary','synthetic','{old['id']}')"
    )
    listed = plus(native, "ListMailItems", page_size=50)
    mail = next(item for item in listed["mail_items"] if item["id"] == event_id)
    filed = plus(native, "ConvertMailItem", event_id=event_id, etag=mail["etag"], request_id=str(uuid.uuid4()))
    assert "task" in filed, filed
    task = rpc(native, "GetTask", {"name": f"tasks/{filed['task']['id']}"})
    assert task["id"] != old["id"] and not task.get("completed") and task.get("project_id", "") == ""
    [saved] = native.d1(f"SELECT task_id FROM summaries WHERE event_id='{event_id}'")
    assert saved["task_id"] == task["id"]
    if gone == "completed":
        assert rpc(native, "GetTask", {"name": old["name"]})["completed"] is True


def test_native_mail_summary_delete_never_deletes_a_linked_task(native):
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
    assert plus(native, "DeleteMailSummaries", **request) == {"deleted_event_ids": [event_id]}
    assert plus(native, "DeleteMailSummaries", **request) == {"deleted_event_ids": [event_id]}
    assert rpc(native, "GetTask", {"name": task["name"]}) == task
    assert plus(native, "ReadMailSummary", id=event_id) == {}


def test_catalog_metadata_selector_keeps_legacy_default_and_cross_language_false(native):
    full = rpc(native, "GetCatalog", {"name": "catalog"})
    explicit = rpc(native, "GetCatalog", {"name": "catalog", "include_task_counts": True})
    metadata = rpc(native, "GetCatalog", {"name": "catalog", "include_task_counts": False})
    assert explicit == full and full["task_counts"]
    assert metadata == {key: value for key, value in full.items() if key != "task_counts"}
