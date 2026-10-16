"""Todoist Plus's caches through the real gateway, Python Durable Object SQLite and D1, with production's five
minutes for metadata reads (the shared test config syncs on every call): incremental metadata Syncs, the
connection check folded into plus_ui, the BASIC view, a cache kept under another list of replaced filter queries
and the rollback switch PLUS_METADATA=full. Synthetic Todoist only; the clock-driven cases are
tests/unit/test_plus_cache.py."""

import json
import sqlite3
import uuid
from collections.abc import Callable, Iterator
from contextlib import closing
from dataclasses import dataclass

import pytest

from tests.fakes.plus_fake import PlusFake
from tests.runtime.harness import CSRF_SIGNING_KEY, Worker, reason, start_gateway

UNKNOWN_TOKEN = "todofy_plus_" + "b" * 43


@dataclass
class Stack:
    worker: Worker
    upstream: PlusFake
    token: str

    def headers(self, token: str | None = None) -> dict[str, str]:
        return {"authorization": "Bearer " + (token or self.token)}

    def plan(self, **params: str) -> dict:
        response = self.worker.hooks.get("/api/plus/v1/plan:read", params=params, headers=self.headers())
        assert response.status_code == 200, response.text
        return response.json()["plan"]

    def task(self, task_id: str) -> dict:
        response = self.worker.hooks.get("/api/plus/v1/tasks", params={"page_size": 200}, headers=self.headers())
        assert response.status_code == 200, response.text
        return next(task for task in response.json()["planning_tasks"] if task["id"] == task_id)

    def set_plan(self, task_id: str, **change: object):
        body = {"task_id": task_id, "etag": self.task(task_id)["etag"], "request_id": str(uuid.uuid4()), **change}
        return self.worker.hooks.post("/api/plus/v1/tasks:setTaskPlan", json=body, headers=self.headers())


def variables(upstream: PlusFake, **extra: str) -> dict[str, str]:
    return {
        "TODOIST_API_BASE": upstream.url,
        "TODOIST_API_KEY": "synthetic-plus-key",
        "PROCESSING_PAUSED": "true",
        "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
        "TODOIST_DEFAULT_PROJECT_ID": "inbox-project",
        **extra,
    }


def connected(worker: Worker) -> str:
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
    return issued.json()["token"]


@pytest.fixture(scope="module")
def stack(tmp_path_factory) -> Iterator[Stack]:
    upstream = PlusFake()
    upstream.add("parent", labels=["office", "candiate", "deep"])
    process = start_gateway(
        tmp_path_factory.mktemp("plus-cache"), variables(upstream, PLUS_METADATA_MAX_AGE_MS="300000")
    )
    try:
        worker = next(process)
        yield Stack(worker, upstream, connected(worker))
    finally:
        process.close()
        upstream.close()


def test_reads_reuse_the_synced_metadata_and_writes_sync_incrementally_first(stack):
    before = len(stack.upstream.sync_requests())
    for _ in range(3):
        stack.plan()
    stack.task("parent")
    assert len(stack.upstream.sync_requests()) == before  # every read within five minutes: no Sync at all
    # A bound label renamed in Todoist: reads keep the synced name for up to five minutes, but a write syncs
    # first and finds the binding changed, so nothing is written under the old name.
    stack.upstream.labels[0]["name"] = "Office"
    assert stack.plan()["enabled"]
    assert reason(stack.set_plan("parent", stage="weekly")) == "ACTION_NOT_ALLOWED"
    assert stack.upstream.commands() == []
    assert not stack.plan().get("enabled", False)  # the write's Sync refreshed what reads see
    requests = stack.upstream.sync_requests()[before:]
    assert requests and all(token.startswith("synthetic-sync-") for token in requests)  # incremental only
    # Renamed back: the first write finds the etag a read showed outdated, and the next read is current.
    stack.upstream.labels[0]["name"] = "office"
    assert reason(stack.set_plan("parent", stage="weekly")) == "ETAG_MISMATCH"
    assert stack.set_plan("parent", stage="weekly").status_code == 200
    assert stack.upstream.tasks["parent"]["labels"] == ["deep", "focus", "office"]


def test_a_lost_object_storage_costs_one_full_sync_and_keeps_the_connections(stack):
    stack.worker.crash_and_restart(lose_object_storage=True)
    stack.plan()
    stack.plan()
    assert stack.upstream.sync_requests()[-1] == "*"  # one full Sync rebuilt the cache, the second read used it
    assert stack.upstream.sync_requests().count("*") == 2  # this and the setup's first read


def test_the_core_checks_the_token_the_gateway_hashes(stack):
    unknown = stack.headers(UNKNOWN_TOKEN)
    assert stack.worker.hooks.get("/api/plus/v1/plan:read", headers=unknown).status_code == 401
    flow = stack.worker.hooks.get("/api/plus/flowday/api/v1/timerSession", headers=unknown)
    assert flow.status_code == 401
    assert stack.plan()["enabled"]


def test_the_basic_view_leaves_out_the_weekly_review_ids(stack):
    full = stack.plan()
    assert full["inbox_project_id"] == "inbox-project"
    basic = stack.plan(view="basic")
    assert "inbox_project_id" not in basic and basic["etag"] == full["etag"]
    assert stack.plan(view="full") == full
    invalid = stack.worker.hooks.get("/api/plus/v1/plan:read", params={"view": "BASIC"}, headers=stack.headers())
    assert reason(invalid) == "BAD_REQUEST"  # a wire enum name is lower case, without its prefix


def rewrite_object_cache(worker: Worker, change: Callable[[dict], dict]) -> None:
    """Rewrite the object's cached Todoist metadata in its SQLite on disk, with workerd stopped."""
    worker.stop()
    try:
        rewritten = 0
        for path in (worker.persist_to / "v3" / "do").rglob("*.sqlite"):
            with closing(sqlite3.connect(path)) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'plus_cache'").fetchone() is None:
                    continue
                [value] = db.execute("SELECT value FROM plus_cache WHERE key = 'todoist'").fetchone()
                db.execute(
                    "UPDATE plus_cache SET value = ?, refreshed_at = 0 WHERE key = 'todoist'",
                    (json.dumps(change(json.loads(value))),),
                )
                db.commit()
                rewritten += 1
        assert rewritten == 1, rewritten
    finally:
        worker.start()


def test_a_filter_kept_before_the_replaced_queries_changed_is_hidden_after_one_full_sync(stack):
    """The release before kept neither the quick nor the parked filter, and an incremental Sync lists a filter only
    when it changes: the cache it left starts over in full, once."""
    filters = [
        {"id": "filter-quick", "name": "Synthetic quick", "query": "@quick & (no date | 3 days)"},
        {"id": "filter-parked", "name": "Synthetic parked", "query": "@parked"},
    ]
    stack.upstream.labels.append({"id": "parked-label", "name": "parked"})
    stack.upstream.filters += filters
    # A label write syncs first: the token it keeps already knows both filters.
    assert stack.set_plan("parent", area="work").status_code == 200
    assert {"filter-quick", "filter-parked"} <= set(stack.plan()["hidden_filter_ids"])

    def before(value: dict) -> dict:
        kept = [row for row in value["filters"] if row[0] not in {"filter-quick", "filter-parked"}]
        return {key: item for key, item in value.items() if key != "queries"} | {"filters": kept}

    rewrite_object_cache(stack.worker, before)
    full = stack.upstream.sync_requests().count("*")
    assert {"filter-quick", "filter-parked"} <= set(stack.plan()["hidden_filter_ids"])
    assert stack.upstream.sync_requests().count("*") == full + 1
    stack.plan()
    assert stack.upstream.sync_requests().count("*") == full + 1


def test_the_rollback_switch_syncs_in_full_on_every_call(tmp_path):
    upstream = PlusFake()
    process = start_gateway(tmp_path / "full", variables(upstream, PLUS_METADATA="full"))
    try:
        worker = next(process)
        token = connected(worker)
        headers = {"authorization": "Bearer " + token}
        for _ in range(2):
            assert worker.hooks.get("/api/plus/v1/plan:read", headers=headers).status_code == 200
        assert set(upstream.sync_requests()) == {"*"} and len(upstream.sync_requests()) >= 4
        revoked = worker.post_owner(
            "/api/plus/v1/connections:revokeExtensionConnection",
            {"connection_id": worker.owner.get("/api/plus/v1/connections:read").json()["connections"][0]["id"]},
        )
        assert revoked.status_code == 200, revoked.text
        assert worker.hooks.get("/api/plus/v1/plan:read", headers=headers).status_code == 401
    finally:
        process.close()
        upstream.close()
