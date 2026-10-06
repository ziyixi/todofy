"""The one-time settlement of read-only workflow attempts left as unknown."""

import json
import pathlib
import sqlite3

import newsletter.monitoring_status as monitoring
import newsletter.store as storage
import newsletter.workflow.definition as definition
import newsletter.workflow.engine as engine
import newsletter.workflow.repository as repository

MARKER = "migration:settle_read_only_attempts:v1"


def _attempt(store, identity, state, error_code):
    store.db.execute(
        "INSERT INTO workflow_attempts(id,run_id,node_id,item_id,state,"
        "input_hash,artifact_id,error_code,started_at,finished_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (
            identity,
            "run-1",
            "briefs",
            identity,
            state,
            "hash-" + identity,
            "",
            error_code,
            "2026-09-30T14:00:00+00:00",
            "2026-09-30T14:05:00+00:00",
        ),
    )


def _old_database(path: pathlib.Path, attempts) -> None:
    """Build state written by a release that predates the migration."""
    store = storage.Store(path, "live")
    repository.WorkflowRepository(store)
    store.db.execute(
        "INSERT INTO workflow_runs VALUES('run-1','d','{}','i','{}','{}')"
    )
    for attempt in attempts:
        _attempt(store, *attempt)
    # Unknowns owned by other ledgers must never be rewritten.
    store.db.execute(
        "INSERT INTO packets(id,principal,request_key,digest,body,projection) "
        "VALUES('p1','test','p1','hash','{}','unknown')"
    )
    store.db.execute(
        "INSERT INTO editions VALUES('e1','e1','hash','complete',?,'{}')",
        (json.dumps({"delivery_state": "unknown"}),),
    )
    store.db.execute("DELETE FROM metadata WHERE key=?", (MARKER,))
    store.close()


def _rows(path: pathlib.Path) -> list[tuple]:
    with sqlite3.connect(path) as db:
        return db.execute(
            "SELECT * FROM workflow_attempts ORDER BY id"
        ).fetchall()


def test_settles_only_timed_out_and_interrupted_attempts(tmp_path):
    path = tmp_path / "newsletter.sqlite3"
    _old_database(
        path,
        [
            ("a-timeout", "unknown", "timeout"),
            ("b-interrupted", "unknown", "interrupted"),
            ("c-failed", "failed", "handler_failed"),
            ("d-done", "succeeded", ""),
        ],
    )
    before = _rows(path)
    store = storage.Store(path, "live")
    try:
        after = _rows(path)
        # Only the state column of the two targeted rows changes.
        expected = [
            row[:4] + ("failed",) + row[5:] if row[4] == "unknown" else row
            for row in before
        ]
        assert after == expected
        assert [row[7] for row in after[:2]] == ["timeout", "interrupted"]
        marker = store.db.execute(
            "SELECT value FROM metadata WHERE key=?", (MARKER,)
        ).fetchone()[0]
        assert json.loads(marker)["changed"] == 2
        observed = monitoring.snapshot(store)["unknown_by_kind"]
        assert observed["workflow_attempts"] == 0
        assert observed["packets"] == 1
        assert observed["delivery"] == 1
        assert store.deployment.status()["unknown"]["workflow_attempts"] == 0
    finally:
        store.close()


def test_migration_runs_once_and_never_rewrites_later_unknowns(tmp_path):
    path = tmp_path / "newsletter.sqlite3"
    _old_database(path, [("a-timeout", "unknown", "timeout")])
    storage.Store(path, "live").close()
    migrated = _rows(path)
    storage.Store(path, "live").close()
    assert _rows(path) == migrated
    store = storage.Store(path, "live")
    _attempt(store, "b-later", "unknown", "timeout")
    store.close()
    storage.Store(path, "live").close()
    assert [row[4] for row in _rows(path)] == ["failed", "unknown"]


def test_other_unknown_codes_stay_visible(tmp_path):
    path = tmp_path / "newsletter.sqlite3"
    _old_database(path, [("a-external", "unknown", "external_unknown")])
    store = storage.Store(path, "live")
    try:
        assert [row[4] for row in _rows(path)] == ["unknown"]
        assert (
            monitoring.snapshot(store)["unknown_by_kind"]["workflow_attempts"]
            == 1
        )
    finally:
        store.close()


def test_monitor_revision_is_kept_but_count_drops_to_zero(tmp_path):
    """Fleet raises the Home warning from the count, never the revision."""
    path = tmp_path / "newsletter.sqlite3"
    _old_database(path, [])
    store = storage.Store(path, "live")
    _attempt(store, "a-timeout", "unknown", "timeout")
    store.db.execute("DELETE FROM metadata WHERE key=?", (MARKER,))
    first = monitoring.snapshot(store)
    store.close()
    assert first["unknown_by_kind"]["workflow_attempts"] == 1
    store = storage.Store(path, "live")
    try:
        second = monitoring.snapshot(store)
        assert second["unknown_by_kind"]["workflow_attempts"] == 0
        assert second["unknown_revision"] == first["unknown_revision"]
    finally:
        store.close()


async def test_node_timeout_after_migration_does_not_reopen_warning(tmp_path):
    """The marker settles old rows once, so new timeouts must not be unknown."""
    path = tmp_path / "newsletter.sqlite3"
    _old_database(path, [("a-timeout", "unknown", "timeout")])
    store = storage.Store(path, "live")
    try:
        before = monitoring.snapshot(store)
        assert before["unknown_by_kind"]["workflow_attempts"] == 0
        workflows = repository.WorkflowRepository(store)
        workflows.start(
            "run-2",
            definition.parse_definition(
                {
                    "version": 1,
                    "id": "daily-newsletter",
                    "nodes": [{"id": "discover", "type": "discovery"}],
                }
            ),
            {},
        )

        async def slow(context):
            raise TimeoutError()

        await engine.WorkflowEngine(workflows, {"discovery": slow}).run("run-2")
        after = monitoring.snapshot(store)
        assert after["unknown_by_kind"]["workflow_attempts"] == 0
        assert after["unknown_revision"] == before["unknown_revision"]
        assert [
            (row["state"], row["error_code"])
            for row in workflows.attempts("run-2")
        ] == [("failed", "timeout")]
    finally:
        store.close()


def test_fresh_database_records_the_marker_without_tables(tmp_path):
    store = storage.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        marker = store.db.execute(
            "SELECT value FROM metadata WHERE key=?", (MARKER,)
        ).fetchone()[0]
        assert json.loads(marker)["changed"] == 0
    finally:
        store.close()
