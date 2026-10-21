"""Actual Python -> TasksApi RPC -> D1 create and read: Todofy's task creates and footer lookup on the Tasks
Worker's D1."""

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


def test_catalog_metadata_selector_keeps_legacy_default_and_cross_language_false(native):
    full = rpc(native, "GetCatalog", {"name": "catalog"})
    explicit = rpc(native, "GetCatalog", {"name": "catalog", "include_task_counts": True})
    metadata = rpc(native, "GetCatalog", {"name": "catalog", "include_task_counts": False})
    assert explicit == full and full["task_counts"]
    assert metadata == {key: value for key, value in full.items() if key != "task_counts"}
