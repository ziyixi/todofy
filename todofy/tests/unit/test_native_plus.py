"""Native Plus requests with real generated wire codecs and SQLite receipts, synthetic task data only."""

import asyncio
import json
import types
import uuid

import pytest

from tests.unit.plus_support import D1, Storage, stubbed_pyodide
from todofy.core import native_plan as plan_rules


class NativeStore:
    def __init__(self, journal):
        self.journal = journal
        self.sent = []
        self.receipts = {}
        self.revision = "1"
        self.lost = False
        self.applied = 0

    async def call(self, method, text):
        self.journal.append("native.call")
        body = json.loads(text)
        if method == "GetCatalog":
            return types.SimpleNamespace(
                status=200,
                body=json.dumps(
                    {
                        "name": "catalog",
                        "time_zone": "UTC",
                        "labels": [{"id": "work-label", "name": "labels/work-label", "title": "work"}],
                    }
                ),
            )
        self.sent.append((method, body))
        key = body["request_id"]
        if key in self.receipts:
            original, result = self.receipts[key]
            return types.SimpleNamespace(status=200 if original == text else 409, body=json.dumps(result))
        etag = body.get("etag", body.get("task", {}).get("etag"))
        if method != "CreateTask" and etag != self.revision:
            return types.SimpleNamespace(status=409, body="{}")
        self.applied += 1
        self.revision = str(int(self.revision) + 1)
        task_id = body.get("task_id") or body.get("name", body.get("task", {}).get("name", "")).removeprefix("tasks/")
        result = {} if method == "DeleteTask" else {"id": task_id, "name": f"tasks/{task_id}", "etag": self.revision}
        self.receipts[key] = (text, result)
        if self.lost:
            self.lost = False
            raise OSError("synthetic response lost")
        return types.SimpleNamespace(status=200, body=json.dumps(result))


@pytest.fixture
def stack(monkeypatch):
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import native_plus, native_tasks

        journal = []
        storage = Storage(journal)
        storage.sql.exec(native_plus.SCHEMA)
        source = NativeStore(journal)
        core = types.SimpleNamespace(
            env=types.SimpleNamespace(TASK_SOURCE="tasks", TASKS=source),
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )
        yield native_plus, native_tasks, core, source, journal


def update(**fields):
    return {"type": "item_update", "uuid": str(uuid.uuid4()), "args": {"id": "a", **fields}, "_native_etag": "1"}


def test_direct_native_request_replays_frozen_body_after_a_lost_response(stack):
    native, errors, core, store, _ = stack
    operation = {
        "method": "UpdateTask",
        "body": {
            "task": {"name": "tasks/a", "title": "Synthetic direct edit"},
            "etag": "1",
            "update_mask": "title",
            "request_id": str(uuid.uuid4()),
        },
    }
    store.lost = True
    with pytest.raises(errors.NativeTasksError):
        asyncio.run(native.commands(core, [operation]))
    store.revision = "3"
    assert asyncio.run(native.commands(core, [operation])) == {"task_ids": ["a"]}
    assert store.applied == 1 and store.sent[0] == store.sent[1]


def test_stale_pending_state_stops_before_its_task_content_write(stack):
    native, errors, core, store, _ = stack
    from todofy.runtime import native_plan

    core.env.DB = D1()
    state = plan_rules.state_from_labels(["committed"])
    asyncio.run(native_plan.save_fields(core.env, "a", state, 0, str(uuid.uuid4())))
    operation = {
        "method": "UpdateTask",
        "body": {
            "task": {"name": "tasks/a", "deadline": "2030-01-01"},
            "etag": "1",
            "update_mask": "deadline",
            "request_id": str(uuid.uuid4()),
        },
        "planning": {"state": state, "expected_rev": 0},
    }
    with pytest.raises(errors.NativeTasksError) as failure:
        asyncio.run(native.commands(core, [operation]))
    assert failure.value.status == 409 and not store.sent


def test_lost_response_replays_exact_frozen_etag_after_another_edit(stack):
    native, errors, core, store, journal = stack
    command = update(labels=["work"])
    store.lost = True
    with pytest.raises(errors.NativeTasksError):
        asyncio.run(native.resume(core, [command]))
    assert journal.index("storage.sync") < journal.index("native.call", journal.index("storage.sync"))
    store.revision = "3"  # an unrelated task edit after the first write landed
    asyncio.run(native.resume(core, [command]))
    assert store.applied == 1
    assert store.sent[0] == store.sent[1]
    saved = core.sql.exec("SELECT body,finished FROM native_task_requests").toArray()[0]
    assert saved.finished == 1 and saved.body == "{}"  # only IDs remain after confirmation


def test_concurrent_edit_is_rejected_without_freshening_the_original_etag(stack):
    native, errors, core, store, _ = stack
    store.revision = "2"
    with pytest.raises(errors.NativeTasksError) as failure:
        asyncio.run(native.resume(core, [update(deadline={"date": "2026-11-01"})]))
    assert failure.value.status == 409
    assert store.applied == 0
    assert store.sent[0][1]["etag"] == "1"


def test_mail_filing_updates_labels_priority_and_project_in_one_native_request(stack):
    native, _, core, store, _ = stack
    command = update(labels=["work"], priority=3)
    move = {
        "type": "item_move",
        "uuid": str(uuid.uuid4()),
        "args": {"id": "a", "project_id": "inbox"},
        "_native_etag": "1",
    }
    asyncio.run(native.resume(core, [command, move]))
    assert store.applied == 1
    method, body = store.sent[0]
    assert method == "UpdateTask"
    assert body["etag"] == "1"
    assert body["task"] == {
        "name": "tasks/a",
        "label_ids": ["work-label"],
        "priority": 2,
        "project_id": "inbox",
    }
    assert body["task"].get("parent_id", "") == ""
    assert body["task"].get("section_id", "") == ""
    assert set(body["update_mask"].split(",")) == {"label_ids", "priority", "project_id", "parent_id", "section_id"}


def test_step_replay_keeps_new_identity_and_skips_a_confirmed_native_call(stack):
    native, _, core, store, _ = stack
    task_id = str(uuid.uuid4())
    command = {
        "type": "item_add",
        "uuid": str(uuid.uuid4()),
        "temp_id": task_id,
        "args": {
            "content": "Synthetic small step",
            "project_id": "inbox",
            "parent_id": "parent",
            "duration": {"amount": 45, "unit": "minute"},
        },
    }
    assert asyncio.run(native.resume(core, [command])) == {"temp_id_mapping": {task_id: task_id}}
    assert asyncio.run(native.resume(core, [command])) == {"temp_id_mapping": {task_id: task_id}}
    assert store.applied == 1 and len(store.sent) == 1


def test_oversized_operation_and_old_receipt_stop_before_any_write(stack):
    native, errors, core, store, _ = stack
    with pytest.raises(errors.NativeTasksError):
        asyncio.run(native.resume(core, [update(deadline=None) for _ in range(201)]))
    old = update(deadline=None)
    del old["_native_etag"]
    with pytest.raises(errors.NativeTasksError):
        asyncio.run(native.resume(core, [old]))
    assert not store.sent


def test_native_owner_entrypoint_refuses_partial_source_deploy_before_dispatch(monkeypatch):
    import sys

    with stubbed_pyodide(monkeypatch):
        monkeypatch.setattr(sys.modules["workers"], "DurableObject", object, raising=False)
        monkeypatch.setattr(sys.modules["workers"], "Response", object, raising=False)
        from todofy.runtime import plus_api
        from todofy.runtime.coordinator import TodofyCore

        calls = []

        async def handled(core, method, text):
            calls.append((method, text))
            return {"ok": "{}"}

        monkeypatch.setattr(plus_api, "handle", handled)
        for env in (
            types.SimpleNamespace(TASK_SOURCE="todoist", TASKS=object()),
            types.SimpleNamespace(TASK_SOURCE="tasks"),
        ):
            core = types.SimpleNamespace(env=env)
            assert asyncio.run(TodofyCore.plus_native_ui(core, "CompleteTask", "{}")) == {"error": "UNAVAILABLE"}
        assert not calls
        core = types.SimpleNamespace(env=types.SimpleNamespace(TASK_SOURCE="tasks", TASKS=object()))
        assert asyncio.run(TodofyCore.plus_native_ui(core, "ReadPlan", "{}")) == {"ok": "{}"}
        assert calls == [("ReadPlan", "{}")]


def test_native_completion_page_counts_only_the_window_and_preserves_project_and_created_time(monkeypatch):
    with stubbed_pyodide(monkeypatch):
        from tests.unit.plus_support import D1
        from todofy.core import gtd as rules
        from todofy.runtime import gtd, native_tasks

        now = 1792252800
        since = now - rules.COMPLETED_WINDOW
        seen = []

        async def completions(env, method, body):
            seen.append((method, body))
            if method == "GetCatalog":
                return {"projects": [{"id": "account-inbox", "title": "Inbox", "inbox": True}]}
            assert method == "ListCompletions"
            return {
                "completions": [
                    {
                        "task_id": "a",
                        "project_id": "",
                        "complete_time": rules.rfc3339(now - 10),
                        "task_create_time": rules.rfc3339(now - 100),
                    },
                    {
                        "task_id": "b",
                        "project_id": "work",
                        "complete_time": rules.rfc3339(now - 20),
                        "task_create_time": rules.rfc3339(since - 100),
                    },
                    {"task_id": "old", "project_id": "mail", "complete_time": rules.rfc3339(since - 1)},
                ],
                "next_page_token": "older-pages",
            }

        monkeypatch.setattr(native_tasks, "call", completions)
        env = types.SimpleNamespace(TASK_SOURCE="tasks", TODOIST_DEFAULT_PROJECT_ID="retired-mail-project", DB=D1())
        state = gtd.State()
        state.started = now
        state.tally = rules.CompletedTally().dumps()
        core = types.SimpleNamespace(record_step=lambda *args: None)
        asyncio.run(gtd._completed_page(env, core, state, now))
        tally = rules.CompletedTally.loads(state.tally)
        assert tally.total == 2 and tally.inbox == 1 and tally.added_recent_total == tally.added_recent_inbox == 1
        assert state.phase == gtd.AGGREGATE and not state.cursor
        assert seen == [
            ("GetCatalog", {"name": "catalog", "include_task_counts": False}),
            ("ListCompletions", {"page_token": "", "page_size": 100}),
        ]
