"""Todoist Plus's caches in the object's SQLite (runtime/plus_cache.py) on host CPython with a controlled clock:
the incremental metadata Sync (plus_todoist.metadata), the full-Sync guard and the rollback switch
PLUS_METADATA=full.

Todoist is a synthetic Sync server that answers each token with what changed since it; D1 and the object's
SQLite are host SQLite (plus_support.py).
"""

import asyncio
import json
import types
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.plus_support import D1, ObjectSql, stubbed_pyodide
from todofy.core import plus

PRIVATE_QUERY = "#Private project & p1"


class SyncServer:
    """Todoist's Sync of user, labels and filters: a token answers what changed since it was issued."""

    def __init__(self, error: type[Exception]) -> None:
        self.error = error
        self.labels = {"1": "office", "2": "committed", "3": "bets"}
        self.filters = {"f1": ("Synthetic Bets", "@bets"), "f2": ("Synthetic private", PRIVATE_QUERY)}
        self.timezone = "America/Los_Angeles"
        self.tokens: dict[str, tuple[dict[str, str], dict[str, tuple[str, str]]]] = {}
        self.requests: list[str] = []
        self.refuse: tuple[str, int] | None = None
        self.full_next = False

    async def call(self, _core: Any, path: str, data: dict[str, Any]) -> dict[str, Any]:
        assert path == "/api/v1/sync" and data["resource_types"] == ["user", "labels", "filters"]
        token = data["sync_token"]
        self.requests.append(token)
        if self.refuse:
            raise self.error(*self.refuse)
        full = token not in self.tokens or self.full_next
        self.full_next = False
        labels, filters = self.tokens.get(token, ({}, {}))
        issued = f"token-{len(self.tokens)}"
        self.tokens[issued] = (dict(self.labels), dict(self.filters))
        answer: dict[str, Any] = {"sync_token": issued, "full_sync": full}
        if full:
            answer["user"] = {"tz_info": {"timezone": self.timezone}, "api_token": "synthetic-never-stored"}
            answer["labels"] = [{"id": key, "name": name} for key, name in self.labels.items()]
            answer["filters"] = [{"id": key, "name": n, "query": q} for key, (n, q) in self.filters.items()]
            return answer
        changed = [{"id": key, "name": name} for key, name in self.labels.items() if labels.get(key) != name]
        gone = [{"id": key, "name": name, "is_deleted": True} for key, name in labels.items() if key not in self.labels]
        answer["labels"] = changed + gone
        answer["filters"] = [
            {"id": key, "name": n, "query": q} for key, (n, q) in self.filters.items() if filters.get(key) != (n, q)
        ]
        return answer


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.server = SyncServer(runtime.todoist.PlusError)
        monkeypatch.setattr(runtime.todoist, "call", self.server.call)
        self.d1 = D1()
        self.sql = ObjectSql()
        for statement in runtime.plus_cache.DO_SCHEMA:
            self.sql.exec(statement)
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, **env),
            sql=self.sql,
            plus_lock=asyncio.Lock(),
        )
        self.at(1_760_000_000)

    def at(self, seconds: float) -> None:
        self.clock["ms"] = int(seconds * 1000)

    def later(self, seconds: float) -> None:
        self.at(self.clock["ms"] / 1000 + seconds)

    def metadata(self, fresh: bool = False) -> dict[str, Any]:
        return asyncio.run(self.runtime.todoist.metadata(self.core, fresh=fresh))

    def cached(self, key: str) -> Any:
        found = self.runtime.plus_cache.get(self.sql, key)
        return None if found is None else found.value

    def handle(self, method: str, request: dict[str, Any]) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])


def stack_with(monkeypatch: pytest.MonkeyPatch, **env: str) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_cache
        from todofy.runtime import plus_todoist as todoist

        monkeypatch.setattr(plus_api.backup, "holds_ledger", lambda *_: False)
        monkeypatch.setattr(plus_api, "account_day", lambda _timezone: "2026-10-14")
        runtime = types.SimpleNamespace(
            plus_api=plus_api, plus_cache=plus_cache, todoist=todoist, clock=stubs["clock"], stubs=stubs
        )
        yield Stack(runtime, monkeypatch, env)


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    yield from stack_with(monkeypatch)


@pytest.fixture
def rollback(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    yield from stack_with(monkeypatch, PLUS_METADATA="full")


# ---- the metadata cache ------------------------------------------------------------------------------


def test_reads_use_the_metadata_synced_in_the_last_five_minutes(stack):
    first = stack.metadata()
    assert first["timezone"] == "America/Los_Angeles"
    assert [label["name"] for label in first["labels"]] == ["office", "committed", "bets"]
    stack.later(299)
    assert stack.metadata() == first
    assert stack.server.requests == ["*"]
    stack.later(2)
    stack.metadata()
    assert stack.server.requests == ["*", "token-0"]  # one incremental Sync, never another full one


def test_a_label_write_syncs_first_and_an_incremental_answer_merges_by_id(stack):
    stack.metadata()
    stack.server.labels["2"] = "Commitments"  # renamed in Todoist
    del stack.server.labels["3"]
    stack.server.labels["4"] = "focus"
    assert [label["name"] for label in stack.metadata()["labels"]] == ["office", "committed", "bets"]
    names = {label["id"]: label["name"] for label in stack.metadata(fresh=True)["labels"]}
    assert names == {"1": "office", "2": "Commitments", "4": "focus"}
    assert stack.server.requests == ["*", "token-0"]


def test_only_the_timezone_and_the_replaced_filters_are_kept(stack):
    assert stack.metadata()["filters"] == [{"id": "f1", "query": "@bets"}]
    stored = json.dumps(stack.cached("todoist"))
    assert "synthetic-never-stored" not in stored and "Private" not in stored and "Synthetic Bets" not in stored
    # A kept filter whose query becomes another one leaves the cache instead of keeping its old query.
    stack.server.filters["f1"] = ("Synthetic Bets", PRIVATE_QUERY)
    assert stack.metadata(fresh=True)["filters"] == []
    assert "Private" not in json.dumps(stack.cached("todoist"))


def test_a_full_answer_to_a_token_replaces_the_cache_and_counts_against_the_limit(stack):
    stack.metadata()
    stack.server.labels = {"9": "home"}
    stack.server.full_next = True
    assert stack.metadata(fresh=True)["labels"] == [{"id": "9", "name": "home"}]
    assert stack.cached("full_syncs")["count"] == 2


def test_full_syncs_stop_at_twenty_a_window_and_resume_in_the_next(stack):
    stack.at(1_760_000_100 - 1_760_000_100 % 900)  # the start of a 15-minute window
    for _ in range(20):
        stack.runtime.plus_cache.drop(stack.sql, "todoist")  # a lost cache each time
        stack.metadata()
    stack.runtime.plus_cache.drop(stack.sql, "todoist")
    with pytest.raises(stack.runtime.todoist.PlusError, match="UNAVAILABLE"):
        stack.metadata()
    assert stack.server.requests == ["*"] * 20
    stack.later(900)
    stack.metadata()
    assert stack.server.requests == ["*"] * 21


@pytest.mark.parametrize(("status", "kept"), [(400, False), (410, False), (401, True), (403, True), (429, True)])
def test_a_refused_token_starts_over_but_auth_and_rate_limits_keep_it(stack, status, kept):
    stack.metadata()
    reason = "UNAVAILABLE" if status == 429 else "ACTION_NOT_ALLOWED"
    stack.server.refuse = (reason, status)
    with pytest.raises(stack.runtime.todoist.PlusError, match=reason):
        stack.metadata(fresh=True)
    assert (stack.cached("todoist") is not None) is kept
    stack.server.refuse = None
    stack.metadata(fresh=True)
    assert stack.server.requests[-1] == ("token-0" if kept else "*")


def test_an_answer_of_another_shape_is_unavailable_and_keeps_the_cache(stack, monkeypatch):
    stack.metadata()

    async def broken(*_args: Any) -> dict[str, Any]:
        return {"sync_token": "token-x", "labels": {"not": "a list"}}

    monkeypatch.setattr(stack.runtime.todoist, "call", broken)
    with pytest.raises(stack.runtime.todoist.PlusError, match="UNAVAILABLE"):
        stack.metadata(fresh=True)
    assert stack.cached("todoist")["sync_token"] == "token-0"


def test_the_rollback_switch_syncs_in_full_every_call_and_leaves_the_cache_alone(rollback):
    for _ in range(3):
        assert rollback.metadata()["filters"] == [{"id": "f1", "query": "@bets"}]
    assert rollback.server.requests == ["*", "*", "*"]
    assert rollback.cached("todoist") is None and rollback.cached("full_syncs") is None


@pytest.mark.parametrize("kept", [None, "an-older-list"], ids=["release_before", "another_list"])
def test_a_cache_kept_under_another_list_of_replaced_queries_starts_over_in_full_once(stack, kept):
    """A filter that existed before the list named it never changes, so no incremental Sync would list it."""
    stack.server.filters["f3"] = ("Synthetic quick", "@quick & (no date | 3 days)")
    stack.metadata()
    value = stack.cached("todoist")
    assert value["queries"] == plus.REPLACED_QUERIES_VERSION
    # The release before kept no "queries" (and could not keep the quick filter); another list names another one.
    old = {key: item for key, item in value.items() if key != "queries"}
    old["filters"] = [row for row in old["filters"] if row[0] != "f3"]
    # Synced a moment ago, so only the list, not the age, sends the next read to Todoist.
    stack.runtime.plus_cache.put(stack.sql, "todoist", old if kept is None else {**old, "queries": kept}, 1_760_000_000)
    assert stack.metadata()["filters"] == [
        {"id": "f1", "query": "@bets"},
        {"id": "f3", "query": "@quick&(nodate|3days)"},
    ]
    assert stack.server.requests == ["*", "*"] and stack.cached("full_syncs")["count"] == 2
    stack.later(301)
    stack.metadata()
    assert stack.server.requests == ["*", "*", "token-1"]  # incremental again


def test_merge_keeps_an_unchanged_resource_and_refuses_a_partial_full_answer():
    full = {"sync_token": "a", "user": {"tz_info": {"timezone": "UTC"}}, "labels": [{"id": 1, "name": "x"}]}
    previous = plus.merge_metadata(None, {**full, "filters": []})
    assert previous["queries"] == plus.REPLACED_QUERIES_VERSION
    assert plus.merge_metadata(previous, {"sync_token": "b"}) == {**previous, "sync_token": "b"}
    for broken in ({"sync_token": "c", "labels": []}, {"labels": [], "filters": []}, {"sync_token": ""}):
        with pytest.raises(ValueError):
            plus.merge_metadata(None, broken)


def test_the_basic_view_skips_the_weekly_review_read(stack):
    reads = len(stack.d1.statements)
    stack.handle("ReadPlan", {"view": "basic"})
    basic = len(stack.d1.statements) - reads
    stack.handle("ReadPlan", {})
    # The review batch: two weeks' review tasks, next week's choices, the dependencies, the Bets of three weeks and
    # the Review lanes' order.
    assert len(stack.d1.statements) - reads - basic == basic + 6
