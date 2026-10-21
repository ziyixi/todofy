"""The Tasks adapters keep the existing event identities; synthetic tasks only."""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.host_support import D1, stubbed_pyodide
from todofy.core import native_task_view
from todofy.core.classify import TaskResult
from todofy.core.render import FOOTER_PREFIX
from todofy.core.todoist_request import build_task_request

EVENT = "a28f924a-1111-4111-8111-123456789012"
CATALOG = {
    "name": "catalog",
    "time_zone": "America/Los_Angeles",
    "projects": [{"id": "inbox", "name": "projects/inbox", "title": "Inbox", "inbox": True}],
    "labels": [{"id": "label-one", "name": "labels/label-one", "title": "Committed"}],
}


def native_row(task_id: str, description: str = "") -> dict[str, Any]:
    return {
        "id": task_id,
        "name": f"tasks/{task_id}",
        "title": "Synthetic task",
        "description": description,
        "etag": "3",
    }


class Service:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.pages: list[dict[str, Any]] = []
        self.error: Exception | None = None
        self.status = 200
        self.body: str | None = None

    async def call(self, method: str, body: str) -> Any:
        request = json.loads(body)
        self.calls.append((method, request))
        if self.error:
            raise self.error
        result: dict[str, Any]
        if method == "GetCatalog":
            result = CATALOG
        elif method == "ListTasks":
            result = self.pages.pop(0)
        else:
            result = native_row("native-one", request.get("task", {}).get("description", ""))
        return types.SimpleNamespace(
            status=self.status, body=self.body if self.body is not None else json.dumps(result)
        )


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import native_tasks

        yield types.SimpleNamespace(native=native_tasks)


def test_create_keeps_frozen_body_and_reuses_one_native_request_identity(runtime):
    service = Service()
    env = types.SimpleNamespace(TASKS=service)
    original = build_task_request(
        "Synthetic title", f"Synthetic body\n{FOOTER_PREFIX}{EVENT}", "project-one", "todofy-frozen-mail-key"
    )
    first = asyncio.run(runtime.native.create_task(env, original, budget_ms=1000))
    second = asyncio.run(runtime.native.create_task(env, original, budget_ms=1000))
    assert first.verdict.result == second.verdict.result == TaskResult.CREATED
    assert first.task_id == second.task_id == "native-one"
    assert first.attempts == second.attempts == 1
    assert service.calls[0] == service.calls[1]
    method, sent = service.calls[0]
    assert method == "CreateTask"
    assert sent["task"] == {
        "title": "Synthetic title",
        "description": f"Synthetic body\n{FOOTER_PREFIX}{EVENT}",
        "project_id": "project-one",
    }
    assert uuid.UUID(sent["request_id"]).version == 5
    assert original.headers["X-Request-Id"] == "todofy-frozen-mail-key"
    assert json.loads(original.body)["content"] == "Synthetic title"


def test_existing_uuid_and_parent_identity_are_not_replaced(runtime):
    service = Service()
    env = types.SimpleNamespace(TASKS=service)
    identity = str(uuid.uuid5(uuid.NAMESPACE_URL, "synthetic-intent"))
    request = build_task_request("Child", "Synthetic", "ignored-project", identity, parent_id="native-parent")
    asyncio.run(runtime.native.create_task(env, request, budget_ms=1000))
    _, sent = service.calls[0]
    assert sent["request_id"] == identity
    assert sent["task"]["parent_id"] == "native-parent"
    assert "project_id" not in sent["task"]


def test_native_delete_acknowledges_generated_empty_response_without_repeating_the_write(runtime):
    service = Service()
    service.body = "{}"
    env = types.SimpleNamespace(TASKS=service)
    body = {"name": "tasks/native-one", "etag": "3", "request_id": str(uuid.uuid4())}
    assert asyncio.run(runtime.native.call(env, "DeleteTask", body)) == {}
    assert len(service.calls) == 1
    service.body = '{"unexpected":"value"}'
    with pytest.raises(runtime.native.NativeTasksError) as refused:
        asyncio.run(runtime.native.call(env, "DeleteTask", body))
    assert refused.value.status == 502


@pytest.mark.parametrize("failure", ["transport", "invalid_response", "timeout"])
def test_uncertain_native_writes_never_fall_back_or_become_safe_retries(runtime, failure):
    service = Service()
    if failure == "transport":
        service.error = OSError("synthetic response lost")
    elif failure == "invalid_response":
        service.body = "not-json"
    else:

        async def slow_call(_method: str, _body: str) -> None:
            await asyncio.sleep(1)

        service.call = slow_call
    env = types.SimpleNamespace(TASKS=service)
    request = build_task_request("Synthetic", "Synthetic", "", "todofy-stable")
    result = asyncio.run(runtime.native.create_task(env, request, budget_ms=10))
    assert result.verdict.result == TaskResult.UNKNOWN
    assert result.task_id == ""
    assert result.attempts == 1


def test_an_absent_binding_sends_nothing_and_retries_later(runtime):
    request = build_task_request("Synthetic", "Synthetic", "", "todofy-stable")
    result = asyncio.run(runtime.native.create_task(types.SimpleNamespace(), request, budget_ms=1000))
    assert result.verdict.result == TaskResult.RETRY_LATER
    assert result.attempts == 0


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_binding_is_an_outage_retried_later(runtime, status):
    service = Service()
    service.status, service.body = status, "{}"
    request = build_task_request("Synthetic", "Synthetic", "", "todofy-stable")
    result = asyncio.run(runtime.native.create_task(types.SimpleNamespace(TASKS=service), request, budget_ms=1000))
    assert (result.verdict.result, result.verdict.code) == (TaskResult.RETRY_LATER, "todoist_unavailable")
    assert result.attempts == 1


def test_footer_search_reads_complete_descriptions_and_verifies_original_predicate(runtime):
    service = Service()
    service.pages = [
        {
            "tasks": [
                native_row("match", f"{FOOTER_PREFIX}{EVENT}"),
                native_row("suffix", f"{FOOTER_PREFIX}{EVENT}-different"),
            ]
        }
    ]
    env = types.SimpleNamespace(TASKS=service, TODOIST_DEFAULT_PROJECT_ID="project-one", DB=D1())
    assert asyncio.run(runtime.native.find_footer_tasks(env, EVENT)) == ["match"]
    assert service.calls[0] == ("GetCatalog", {"name": "catalog", "include_task_counts": False})
    method, request = service.calls[1]
    assert method == "ListTasks"
    assert request["query"] == f"{FOOTER_PREFIX}{EVENT}"
    assert request["include_description"] is True
    assert request["page_size"] == 20


def test_incomplete_native_scan_cannot_claim_no_matching_task(runtime):
    service = Service()
    service.pages = [{"next_page_token": str(i)} for i in range(1, 11)]
    env = types.SimpleNamespace(TASKS=service)
    assert asyncio.run(runtime.native.find_tasks(env, lambda _description: False)) is None
    assert len(service.calls) == 11


def test_projection_keeps_task_semantics_and_native_concurrency():
    source = native_row("native-one") | {
        "label_ids": ["label-one"],
        "priority": 1,
        "sort_order": 2.5,
        "completed": True,
        "archived": True,
        "complete_time": "2026-10-17T12:00:00Z",
        "completed_count": 5,
        "due_date": "2026-10-20",
        "recurrence": "every Tuesday",
        "deadline": "2026-10-30",
    }
    task = native_task_view.task(source, CATALOG)
    assert (task["priority"], task["labels"], task["project_id"]) == (4, ["Committed"], "inbox")
    assert task["checked"] and task["archived"]
    assert task["completed_at"] == "2026-10-17T12:00:00Z"
    assert task["_native_etag"] == "3"
    assert task["sort_order"] == 2.5
    assert task["due"]["is_recurring"]
    assert native_task_view.metadata(CATALOG)["timezone"] == "America/Los_Angeles"


@pytest.mark.parametrize(
    ("status", "tasks_reason"),
    [(400, "BAD_REQUEST"), (409, "ETAG_MISMATCH"), (404, "NOT_FOUND"), (503, "UNAVAILABLE"), (403, "")],
)
def test_tasks_error_reasons_are_kept(runtime, status, tasks_reason):
    service = Service()
    service.status = status
    details = [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": tasks_reason}] if tasks_reason else []
    service.body = json.dumps({"error": {"code": status, "message": "Synthetic", "details": details}})
    env = types.SimpleNamespace(TASKS=service)
    with pytest.raises(runtime.native.NativeTasksError) as failure:
        asyncio.run(runtime.native.call(env, "GetTask", {"name": "tasks/native-one"}))
    assert failure.value.reason == tasks_reason
