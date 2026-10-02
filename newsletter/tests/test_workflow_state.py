"""Test durable publication with synthetic SQLite data, never real mail."""

import copy
import sqlite3

import pytest

import newsletter.collection.collector as collector
import newsletter.collection.repository as repository
import newsletter.editor as editor
import newsletter.store as newsletter_store
import newsletter.workflow.pipeline as newsletter_workflow_pipeline
import newsletter.workflow.state as newsletter_workflow_state
import tests.support.usage as usage
import tests.support.workflow_state as workflow_state


@pytest.fixture
def store(tmp_path):
    value = newsletter_store.Store(tmp_path / "state.sqlite3", "mock")
    try:
        yield value
    finally:
        value.close()


def test_usage_ledger_upserts_latest_cumulative_snapshot_not_each_notification(
    store,
):
    state = newsletter_workflow_state.WorkflowState(store)
    sink = state.usage_sink("run-one")
    records = usage.record_one()
    for row in records + [records[-1]]:
        sink(row)
    assert (
        store.db.execute("SELECT COUNT(*) FROM model_usage").fetchone()[0] == 1
    )
    assert state.usage("run-one")["usage"]["total_tokens"] == 120
    assert state.usage("run-one")["invocations"] == 1
    assert not state.usage("run-one")["partial"]
    assert state.usage("unrelated")["usage"] is None


def test_usage_scope_cannot_be_reassigned_after_recording(store):
    state = newsletter_workflow_state.WorkflowState(store)
    row = usage.record_one()[-1]
    state.usage_sink("original")(row)
    with pytest.raises(newsletter_store.StoreError) as caught:
        state.usage_sink("other")(row)
    assert caught.value.code == "conflict"
    assert state.usage("original")["usage"]["total_tokens"] == 120
    assert state.usage("other")["usage"] is None


@pytest.mark.parametrize("snapshot", [0, 1, -1])
def test_usage_survives_restart_including_unknown_and_in_flight_snapshots(
    tmp_path, snapshot
):
    path = tmp_path / "restart.sqlite3"
    before = newsletter_store.Store(path, "mock")
    row = usage.record_one()[snapshot]
    newsletter_workflow_state.WorkflowState(before).usage_sink("run-one")(row)
    expected = newsletter_workflow_state.WorkflowState(before).usage("run-one")
    before.close()
    after = newsletter_store.Store(path, "mock")
    try:
        assert (
            newsletter_workflow_state.WorkflowState(after).usage("run-one")
            == expected
        )
        assert expected["partial"] is (snapshot != -1)
        if snapshot == 0:
            assert (
                expected["usage"] is None
                and expected["missing_invocations"] == 1
            )
    finally:
        after.close()


def test_failed_attempts_and_successful_replacement_both_remain_in_usage(store):
    state = newsletter_workflow_state.WorkflowState(store)
    failed = usage.record_one()[-1]
    failed.update(status="failed", partial=True)
    succeeded = usage.record_one(usage.notification(200, 30))[-1]
    sink = state.usage_sink("one-run")
    sink(failed)
    sink(succeeded)
    summary = state.usage("one-run")
    assert summary["invocations"] == 2
    assert summary["usage"]["total_tokens"] == 350 and summary["partial"]


def test_prepare_writes_edition_and_frozen_workflow_binding_atomically(store):
    state = newsletter_workflow_state.WorkflowState(store)
    source = workflow_state.packet(store, "adopted")
    bound = workflow_state.binding("run-one", [source])
    first = store.prepare(
        workflow_state.request("edition", [source]), workflow_binding=bound
    )
    assert state.edition(first["id"]) == {
        "run_id": "run-one",
        "result": bound["result"],
        "required_packets": [source["id"]],
        "projection_required": True,
    }
    assert (
        store.prepare(
            workflow_state.request("edition", [source]),
            workflow_binding=copy.deepcopy(bound),
        )
        == first
    )
    assert store.db.execute("SELECT COUNT(*) FROM editions").fetchone()[0] == 1


def test_binding_insert_failure_rolls_back_new_edition_and_queue_slot(store):
    state = newsletter_workflow_state.WorkflowState(store)
    source = workflow_state.packet(store, "adopted")
    state.bind_edition("existing-binding", "occupied-run", {}, [source["id"]])
    with pytest.raises((sqlite3.IntegrityError, newsletter_store.StoreError)):
        store.prepare(
            workflow_state.request("edition", [source]),
            workflow_binding=workflow_state.binding("occupied-run", [source]),
        )
    assert store.db.execute("SELECT COUNT(*) FROM editions").fetchone()[0] == 0
    assert store.claim() is None
    assert store.prepare(
        workflow_state.request("edition", [source]),
        workflow_binding=workflow_state.binding("other-run", [source]),
    )


@pytest.mark.parametrize("field", ["run_id", "result", "required_packets"])
def test_idempotent_prepare_cannot_change_frozen_workflow_binding(store, field):
    state = newsletter_workflow_state.WorkflowState(store)
    source = workflow_state.packet(store, "adopted")
    original = workflow_state.binding("run-one", [source])
    first = store.prepare(
        workflow_state.request("edition", [source]), workflow_binding=original
    )
    changed = copy.deepcopy(original)
    changed[field] = {
        "run_id": "run-two",
        "result": {"draft": {"title": "changed"}},
        "required_packets": [],
    }[field]
    with pytest.raises(newsletter_store.StoreError) as caught:
        store.prepare(
            workflow_state.request("edition", [source]),
            workflow_binding=changed,
        )
    assert caught.value.code == "conflict"
    assert state.edition(first["id"])["result"] == original["result"]


def test_existing_unbound_edition_cannot_silently_ignore_new_workflow_binding(
    store,
):
    source = workflow_state.packet(store, "adopted")
    store.prepare(workflow_state.request("edition", [source]))
    with pytest.raises(newsletter_store.StoreError) as caught:
        store.prepare(
            workflow_state.request("edition", [source]),
            workflow_binding=workflow_state.binding("new-run", [source]),
        )
    assert caught.value.code == "conflict"


@pytest.mark.parametrize(
    "projection", ["pending", "submitting", "unknown", "failed"]
)
def test_adopted_projection_must_be_done_before_send_reservation(
    store, projection
):
    source = workflow_state.packet(store, "adopted")
    edition = workflow_state.ready(store, "edition", [source])
    store.projection_result(source["id"], projection)
    state = newsletter_workflow_state.WorkflowState(store)
    with pytest.raises(newsletter_store.StoreError):
        state.assert_publishable(edition["id"])
    with pytest.raises(newsletter_store.StoreError):
        store.reserve_send(workflow_state.approval(edition))
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0
    assert store.get(edition["id"])["delivery_state"] == "not_requested"
    store.projection_result(source["id"], "done")
    state.assert_publishable(edition["id"])
    assert store.reserve_send(workflow_state.approval(edition))[1] is True


@pytest.mark.parametrize("required", [[], [{"id": "nonexistent-packet"}]])
def test_empty_or_missing_adopted_material_is_not_publishable(store, required):
    source = workflow_state.packet(store, "source")
    edition = workflow_state.ready(
        store, "edition", [source], required=required
    )
    with pytest.raises(newsletter_store.StoreError):
        store.reserve_send(workflow_state.approval(edition))


@pytest.mark.parametrize(
    "unused_state", ["pending", "submitting", "failed", "unknown"]
)
def test_unused_projection_does_not_block_adopted_confirmed_material(
    store, unused_state
):
    adopted, unused = (
        workflow_state.packet(store, "adopted"),
        workflow_state.packet(store, "unused"),
    )
    edition = workflow_state.ready(
        store, "edition", [adopted, unused], required=[adopted]
    )
    store.projection_result(adopted["id"], "done")
    store.projection_result(unused["id"], unused_state)
    newsletter_workflow_state.WorkflowState(store).assert_publishable(
        edition["id"]
    )
    assert store.reserve_send(workflow_state.approval(edition))[1] is True


def test_dag_advance_ignores_unused_projection_failures(store, tmp_path):
    runs = repository.RunRepository(store)
    run = runs.start(
        {"request_key": "run", "issue_date": "2026-09-06"},
        [],
        workflow_snapshot={"fixture": "not executed by this state-only test"},
    )
    adopted, unused = (
        workflow_state.packet(store, "adopted"),
        workflow_state.packet(store, "unused"),
    )
    edition = workflow_state.ready(
        store, "edition", [adopted, unused], required=[adopted], run=run["id"]
    )
    store.projection_result(adopted["id"], "done")
    store.projection_result(unused["id"], "unknown")
    runs.update(run["id"], state="editing", edition_id=edition["id"])
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        collector.MockCollector(),
        tmp_path / "workspace",
        10,
        32,
        editor=editor.CodexEditor(tmp_path / "unused-auth-path"),
    )
    assert pipeline.advance()
    assert runs.get(run["id"])["state"] == "ready"
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0


def test_same_date_new_edition_or_send_key_cannot_duplicate_reservation(store):
    source = workflow_state.packet(store, "adopted")
    first = workflow_state.ready(store, "edition-one", [source])
    second = workflow_state.ready(store, "edition-two", [source])
    store.projection_result(source["id"], "done")
    assert (
        store.reserve_send(workflow_state.approval(first, "first-send"))[1]
        is True
    )
    assert (
        store.reserve_send(workflow_state.approval(first, "first-send"))[1]
        is False
    )
    assert (
        store.reserve_send(workflow_state.approval(first, "different-key"))[1]
        is False
    )
    with pytest.raises(newsletter_store.StoreError):
        store.reserve_send(workflow_state.approval(second, "second-send"))
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 1


def test_restart_unknown_send_is_not_reserved_again(store):
    source = workflow_state.packet(store, "adopted")
    edition = workflow_state.ready(store, "edition", [source])
    store.projection_result(source["id"], "done")
    assert store.reserve_send(workflow_state.approval(edition))[1] is True
    store.recover()
    assert store.get(edition["id"])["delivery_state"] == "unknown"
    assert (
        store.reserve_send(workflow_state.approval(edition, "another-key"))[1]
        is False
    )
