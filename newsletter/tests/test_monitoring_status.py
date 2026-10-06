"""Unknown observations are durable without mutating business outcomes."""

import json

import newsletter.monitoring_status as monitoring
import newsletter.store as storage
import newsletter.workflow.definition as workflow_definition
import newsletter.workflow.engine as workflow_engine
import newsletter.workflow.repository as workflow_repository


def test_revision_tracks_new_records_not_counts(tmp_path):
    store = storage.Store(tmp_path / "state.sqlite", "production")
    store.db.execute(
        "INSERT INTO packets(id,principal,request_key,digest,body,projection) "
        "VALUES('one','test','one','hash','{}','unknown')"
    )
    first = monitoring.snapshot(store)
    assert first["unknown_revision"] == 1
    assert first["unknown_by_kind"]["packets"] == 1
    assert monitoring.snapshot(store) == first
    store.db.execute("UPDATE packets SET projection='complete'")
    assert monitoring.snapshot(store)["unknown_revision"] == 1
    store.db.execute(
        "INSERT INTO packets(id,principal,request_key,digest,body,projection) "
        "VALUES('two','test','two','hash','{}','unknown')"
    )
    assert monitoring.snapshot(store)["unknown_revision"] == 2
    assert monitoring.snapshot(store)["unknown_by_kind"]["packets"] == 1
    assert (
        store.db.execute(
            "SELECT projection FROM packets WHERE id='two'"
        ).fetchone()[0]
        == "unknown"
    )


def test_latest_delivery_excludes_fixtures_and_has_no_content(tmp_path):
    store = storage.Store(tmp_path / "state.sqlite", "production")
    for identity, fixture, time in (
        ("live", False, "2026-10-04T10:00:00Z"),
        ("fixture", True, "2026-10-04T11:00:00Z"),
    ):
        body = json.dumps(
            {
                "delivery_state": "provider_accepted",
                "updated_at": time,
                "is_fixture": fixture,
                "draft": {"private": "must not leave"},
            }
        )
        store.db.execute(
            "INSERT INTO editions VALUES(?,?,?,'complete',?,'{}')",
            (identity, identity, "hash", body),
        )
    assert monitoring.snapshot(store)["latest_delivery"] == {
        "state": "provider_accepted",
        "time": "2026-10-04T10:00:00Z",
    }


async def test_node_timeout_does_not_reopen_unknown_monitoring(tmp_path):
    store = storage.Store(tmp_path / "state.sqlite", "production")
    before = monitoring.snapshot(store)
    repository = workflow_repository.WorkflowRepository(store)
    repository.start(
        "run",
        workflow_definition.parse_definition(
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

    await workflow_engine.WorkflowEngine(repository, {"discovery": slow}).run(
        "run"
    )
    after = monitoring.snapshot(store)
    assert after["unknown_by_kind"]["workflow_attempts"] == 0
    assert after["unknown_revision"] == before["unknown_revision"]
