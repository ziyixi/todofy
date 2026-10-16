"""Plus replay receipts through the real gateway, Python Durable Object SQLite and D1 (runtime/plus_receipts.py):
each write's receipt in the object with IDs only, nothing new in D1 plus_actions, the read-only fallback to the
receipts the release before wrote there (FlowDay's frozen settlement included) and a lost object storage.
Synthetic Todoist only; the clock-driven cases (the 30-day window) are tests/unit/test_plus_receipts.py.
"""

import json
import sqlite3
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from ziyixi_proto.todofy.ui.v1 import plus_service_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from tests.fakes.plus_fake import PlusFake
from tests.runtime.harness import CSRF_SIGNING_KEY, Worker, reason, start_gateway
from todofy.core import plus

STEP = "Synthetic step title"


@dataclass
class Stack:
    worker: Worker
    upstream: PlusFake
    token: str

    def write(self, action: str, **body: Any):
        body.setdefault("request_id", str(uuid.uuid4()))
        headers = {"authorization": "Bearer " + self.token}
        return self.worker.hooks.post(f"/api/plus/v1/tasks:{action}", json=body, headers=headers)

    def etag(self, task_id: str) -> str:
        cursor = ""
        while True:
            response = self.worker.hooks.get(
                "/api/plus/v1/tasks",
                params={"page_size": 200, "page_token": cursor},
                headers={"authorization": "Bearer " + self.token},
            )
            assert response.status_code == 200, response.text
            for task in response.json().get("planning_tasks", []):
                if task["id"] == task_id:
                    return task["etag"]
            cursor = response.json()["next_page_token"]

    def receipts(self) -> dict[str, dict[str, Any]]:
        """The object's plus_receipts, read from workerd's SQLite file while it runs."""
        [path] = [
            path for path in (self.worker.persist_to / "v3" / "do").rglob("*.sqlite") if path.name != "metadata.sqlite"
        ]
        with sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True) as store:
            store.row_factory = sqlite3.Row
            return {row["request_id"]: dict(row) for row in store.execute("SELECT * FROM plus_receipts")}

    def legacy(self, request_id: str, request_hash: str, commands: Any, response: Any) -> None:
        """A plus_actions row as the release before wrote it, a day ago."""
        values = [request_id, request_hash, json.dumps(commands), None if response is None else json.dumps(response)]
        quoted = ", ".join("NULL" if value is None else "'" + value.replace("'", "''") + "'" for value in values)
        self.worker.d1(f"INSERT INTO plus_actions VALUES ({quoted}, unixepoch() - 86400)")

    def legacy_rows(self) -> list[dict[str, Any]]:
        return self.worker.d1("SELECT request_id, response FROM plus_actions ORDER BY request_id")


def request_hash(method: str, request: dict[str, Any]) -> str:
    """What plus_api.handle fingerprints: the request as the wire profile reads it."""
    message = from_wire(getattr(pb, method + "Request"), request, strict=True).message
    return plus.fingerprint([method, to_wire(message)])


@pytest.fixture(scope="module")
def stack(tmp_path_factory) -> Iterator[Stack]:
    upstream = PlusFake()
    upstream.add("parent", labels=["office", "candiate"])
    for name in ("done", "legacy-open", "settled", "lost"):
        upstream.add(name, labels=["home"])
    process = start_gateway(
        tmp_path_factory.mktemp("plus-receipts"),
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
        confirmed = worker.post_owner(
            "/api/plus/v1/plan:confirmPlanMapping", {"etag": plan["etag"], "request_id": str(uuid.uuid4())}
        )
        assert confirmed.status_code == 200, confirmed.text
        issued = worker.post_owner(
            "/api/plus/v1/connections:issueExtensionConnection",
            {"display_name": "Synthetic Chrome", "request_id": str(uuid.uuid4())},
        )
        assert issued.status_code == 200, issued.text
        yield Stack(worker, upstream, issued.json()["token"])
    finally:
        process.close()
        upstream.close()


def test_each_write_keeps_its_receipt_in_the_object_with_ids_only(stack):
    planned = {"task_id": "parent", "etag": stack.etag("parent"), "stage": "weekly", "request_id": str(uuid.uuid4())}
    steps = {"parent_id": "parent", "steps": [{"title": STEP}], "request_id": str(uuid.uuid4())}
    done = {"task_id": "done", "request_id": str(uuid.uuid4())}
    answers = {}
    for action, body in (("setTaskPlan", planned), ("appendTaskSteps", steps), ("completeTask", done)):
        response = stack.write(action, **body)
        assert response.status_code == 200, response.text
        answers[action] = response.json()
    receipts = stack.receipts()
    assert {receipts[body["request_id"]]["state"] for body in (planned, steps, done)} == {"done"}
    assert all(receipts[body["request_id"]]["commands"] is None for body in (planned, steps, done))
    assert json.loads(receipts[planned["request_id"]]["result"]) == {"task_id": "parent"}
    assert json.loads(receipts[steps["request_id"]]["result"]) == answers["appendTaskSteps"]
    assert json.loads(receipts[done["request_id"]]["result"]) == {"task_id": "done"}
    assert "Synthetic" not in json.dumps(receipts)  # no task or step title
    assert stack.legacy_rows() == []
    # Replays answer from the receipts: no Sync runs again; the planning write reads its task for its answer.
    commands = len(stack.upstream.commands())
    for action, body in (("setTaskPlan", planned), ("appendTaskSteps", steps), ("completeTask", done)):
        replay = stack.write(action, **body)
        assert replay.status_code == 200 and replay.json() == answers[action], replay.text
    assert len(stack.upstream.commands()) == commands and stack.upstream.closed == {"done": 1}


def test_receipts_of_the_release_before_are_read_from_d1_and_never_written(stack):
    # A done SetTaskPlan: its stored answer, as the release before kept it.
    kept = {"task_id": "parent", "etag": "synthetic-etag", "stage": "weekly", "request_id": str(uuid.uuid4())}
    stored = {"task": {"id": "parent", "title": "Synthetic stored answer", "stage": "weekly"}}
    stack.legacy(kept["request_id"], request_hash("SetTaskPlan", kept), [], stored)
    calls = len(stack.upstream.received())
    replay = stack.write("setTaskPlan", **kept)
    assert replay.status_code == 200, replay.text
    assert replay.json()["task"]["title"] == "Synthetic stored answer"
    assert len(stack.upstream.received()) == calls  # no metadata, task or Sync call
    # A started CompleteTask: its frozen command is sent once, and the object records it done.
    started = {"task_id": "legacy-open", "request_id": str(uuid.uuid4())}
    close = {"type": "item_close", "uuid": plus.command_id(started["request_id"]), "args": {"id": "legacy-open"}}
    stack.legacy(started["request_id"], request_hash("CompleteTask", started), [close], None)
    assert stack.write("completeTask", **started).json() == {"task_id": "legacy-open"}
    assert stack.upstream.closed["legacy-open"] == 1
    assert stack.receipts()[started["request_id"]]["state"] == "done"
    # A done CompleteTask with the FlowDay settlement frozen for it: the next settlement attempt copies both
    # into the object (the test servers have no FlowDay, so the attempt itself is UNAVAILABLE).
    settled = {"task_id": "settled", "request_id": str(uuid.uuid4()), "flow_date": "2026-10-14"}
    stack.legacy(settled["request_id"], request_hash("CompleteTask", settled), [], {"task_id": "settled"})
    frozen = {
        "name": "timerSession",
        "request_id": str(uuid.uuid4()),
        "etag": "synthetic-timer-etag",
        "action": "settle",
        "task_id": "settled",
        "flow_date": "2026-10-14",
    }
    stack.legacy("focus:" + settled["request_id"], settled["request_id"], frozen, None)
    assert reason(stack.write("completeTask", **settled)) == "UNAVAILABLE"
    copied = json.loads(stack.receipts()[settled["request_id"]]["result"])
    assert copied == {"task_id": "settled", "focus": frozen}
    assert "settled" not in stack.upstream.closed  # answered from the stored receipt, never closed again
    responses = {row["request_id"]: row["response"] for row in stack.legacy_rows()}
    assert len(responses) == 4 and responses[started["request_id"]] is None  # left as the release before wrote it


def test_a_lost_object_storage_turns_a_replay_into_a_rerun_that_todoist_deduplicates(stack):
    request = {"task_id": "lost", "request_id": str(uuid.uuid4())}
    first = stack.write("completeTask", **request)
    assert first.status_code == 200, first.text
    stack.worker.crash_and_restart(lose_object_storage=True)
    again = stack.write("completeTask", **request)
    assert again.status_code == 200 and again.json() == first.json(), again.text
    assert list(stack.receipts()) == [request["request_id"]]  # the earlier receipts went with the storage
    closes = [command for command in stack.upstream.commands() if command["args"].get("id") == "lost"]
    assert len(closes) == 2 and closes[0]["uuid"] == closes[1]["uuid"]  # the same uuid5, sent twice
    assert stack.upstream.closed["lost"] == 1  # Todoist ran it once
