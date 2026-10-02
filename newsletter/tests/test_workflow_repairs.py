"""Test one frozen repair and parent/child accounting with SQLite fixtures."""

import concurrent.futures as futures
import copy
import threading

import pytest

import newsletter.collection.repository as repository
import newsletter.store as newsletter_store
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.state as newsletter_workflow_state
import tests.support.usage as usage
import tests.support.workflow_state as workflow_state


@pytest.fixture
def source(tmp_path):
    store = newsletter_store.Store(tmp_path / "repair.sqlite3", "mock")
    state = newsletter_workflow_state.WorkflowState(store)
    runs = repository.RunRepository(store)
    graph = newsletter_workflow_definition.parse_definition(
        {
            "version": 1,
            "id": "fixture-source",
            "nodes": [{"id": "review", "type": "review"}],
        }
    )
    inputs = {
        "issue_date": "2026-09-06",
        "started_at": "2026-09-06T12:00:00Z",
        "timeout_seconds": 5400,
        "model": "fixture-model",
        "policy": {"editorial.md": "Synthetic policy only."},
        "history": [],
    }
    run = runs.start(
        {"request_key": "source-run", "issue_date": inputs["issue_date"]},
        [],
        workflow_snapshot={"definition": graph.snapshot(), "inputs": inputs},
    )
    material = workflow_state.packet(store, "public-fixture")
    frozen = workflow_state.binding(run["id"], [material])
    frozen["result"]["review"] = {
        "passed": False,
        "findings": ["Synthetic review objection."],
    }
    edition = store.prepare(
        workflow_state.request("source-edition", [material]),
        workflow_binding=frozen,
    )
    edition = store.finish(
        edition["id"],
        state="blocked",
        draft=frozen["result"]["draft"],
        review=frozen["result"]["review"],
        error_code="editorial_review_failed",
    )
    run = runs.update(
        run["id"],
        state="blocked",
        edition_id=edition["id"],
        error_code="editorial_review_failed",
    )
    # Real immutable workflow artifact to prove repair creation does not rewrite
    # the failed review or force an original attempt back to pending.
    workflow = newsletter_workflow_repository.WorkflowRepository(store)
    workflow.start(run["id"], graph, inputs)
    attempt = workflow.claim(run["id"], "review", "", inputs)
    workflow.finish(
        attempt, "succeeded", {**frozen["result"], "packets": [material]}
    )
    repair_definition = {
        "version": 1,
        "id": "fixture-repair",
        "nodes": [
            {"id": "revise", "type": "composition"},
            {"id": "review", "type": "review", "needs": ["revise"]},
        ],
    }
    repair_inputs = {
        **inputs,
        "parent_run_id": run["id"],
        "parent_definition_hash": graph.digest,
        "prior_review_result": workflow.output(run["id"], "review"),
    }
    value = {
        "store": store,
        "state": state,
        "runs": runs,
        "run": run,
        "edition": edition,
        "material": material,
        "definition": repair_definition,
        "inputs": repair_inputs,
    }
    try:
        yield value
    finally:
        store.close()


def create(source, **changes):
    return source["state"].create_repair(
        changes.get("parent_run_id", source["run"]["id"]),
        changes.get("source_edition_id", source["edition"]["id"]),
        changes.get("definition", source["definition"]),
        changes.get("inputs", source["inputs"]),
    )


def old_rows(store):
    tables = (
        "collection_runs",
        "collection_workflow_snapshots",
        "workflow_runs",
        "workflow_attempts",
        "workflow_artifacts",
        "editions",
        "workflow_editions",
        "packets",
        "sends",
        "model_usage",
    )
    return {
        name: [
            tuple(row)
            for row in store.db.execute(f"SELECT * FROM {name} ORDER BY rowid")
        ]
        for name in tables
    }


def test_repair_freezes_one_detached_snapshot_without_rewriting_original_state(
    source,
):
    original = old_rows(source["store"])
    receipt = create(source)
    assert receipt == {
        "parent_run_id": source["run"]["id"],
        "source_edition_id": source["edition"]["id"],
        "child_run_id": source["run"]["id"] + ":repair-1",
        "snapshot": {
            "definition": source["definition"],
            "inputs": source["inputs"],
        },
    }
    assert old_rows(source["store"]) == original
    assert create(source) == receipt
    source["inputs"]["policy"]["editorial.md"] = (
        "Caller mutation after freezing."
    )
    receipt["snapshot"]["inputs"]["history"].append("Returned object mutation.")
    persisted = source["state"].repair(source["run"]["id"])
    assert (
        persisted["snapshot"]["inputs"]["policy"]["editorial.md"]
        == "Synthetic policy only."
    )
    assert persisted["snapshot"]["inputs"]["history"] == []
    assert source["state"].repair("unrelated") is None


@pytest.mark.parametrize("changed", ["inputs", "definition", "source"])
def test_existing_repair_rejects_changed_source_or_frozen_inputs(
    source, changed
):
    original = create(source)
    if changed == "inputs":
        inputs = copy.deepcopy(source["inputs"])
        inputs["model"] = "different-fixture-model"
        args = {"inputs": inputs}
    elif changed == "definition":
        definition = copy.deepcopy(source["definition"])
        definition["id"] = "different-repair"
        args = {"definition": definition}
    else:
        args = {"source_edition_id": "different-edition"}
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source, **args)
    assert caught.value.code == "conflict"
    assert source["state"].repair(source["run"]["id"]) == original
    assert (
        source["store"]
        .db.execute("SELECT COUNT(*) FROM workflow_repairs")
        .fetchone()[0]
        == 1
    )


def test_idempotent_receipt_remains_available_after_parent_advances(source):
    receipt = create(source)
    source["runs"].update(
        source["run"]["id"], state="editing", edition_id="new-edition"
    )
    assert create(source) == receipt


def test_repair_cannot_create_a_second_generation(source):
    receipt = create(source)
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source, parent_run_id=receipt["child_run_id"])
    assert caught.value.code == "conflict"
    assert (
        source["store"]
        .db.execute("SELECT COUNT(*) FROM workflow_repairs")
        .fetchone()[0]
        == 1
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"state": "queued"},
        {"state": "failed"},
        {"state": "ready"},
        {"error_code": "workflow_timeout"},
        {"error_code": ""},
        {"edition_id": "another-edition"},
        {"issue_date": "2026-09-07"},
    ],
)
def test_parent_must_still_be_the_expected_review_blocked_run(source, patch):
    source["runs"].update(source["run"]["id"], **patch)
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source)
    assert caught.value.code == "conflict"
    assert source["state"].repair(source["run"]["id"]) is None


@pytest.mark.parametrize(
    "patch",
    [
        {"state": "ready"},
        {"state": "failed"},
        {"review": {"passed": True}},
        {"review": {"passed": 0}},
        {"review": {"passed": "false"}},
        {"review": {}},
        {"delivery_state": "unknown"},
        {"delivery_state": "submitting"},
        {"delivery_state": "provider_accepted"},
        {"issue_date": "2026-09-07"},
    ],
)
def test_source_edition_must_be_review_failed_and_never_submitted(
    source, patch
):
    source["store"].finish(source["edition"]["id"], **patch)
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source)
    assert caught.value.code == "conflict"
    assert source["state"].repair(source["run"]["id"]) is None


@pytest.mark.parametrize("missing", [False, True])
def test_parent_workflow_binding_cannot_be_missing_or_point_to_another_run(
    source, missing
):
    with source["store"].transaction():
        if missing:
            source["store"].db.execute(
                "DELETE FROM workflow_editions WHERE edition_id=?",
                (source["edition"]["id"],),
            )
        else:
            source["store"].db.execute(
                "UPDATE workflow_editions SET run_id=? WHERE edition_id=?",
                ("other-run", source["edition"]["id"]),
            )
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source)
    assert caught.value.code == "conflict"


def test_any_same_date_send_reservation_prevents_a_new_repair(source):
    store = source["store"]
    alternate = workflow_state.ready(
        store, "already-submitted", [source["material"]]
    )
    store.projection_result(source["material"]["id"], "done")
    assert store.reserve_send(workflow_state.approval(alternate))[1]
    before = old_rows(store)
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source)
    assert caught.value.code == "conflict"
    assert old_rows(store) == before


def test_missing_parent_fails_safely_even_before_collection_tables_exist(
    tmp_path,
):
    store = newsletter_store.Store(tmp_path / "empty.sqlite3", "mock")
    try:
        with pytest.raises(newsletter_store.StoreError) as caught:
            newsletter_workflow_state.WorkflowState(store).create_repair(
                "missing-parent",
                "missing-edition",
                {
                    "version": 1,
                    "id": "fixture",
                    "nodes": [{"id": "review", "type": "review"}],
                },
                {"issue_date": "2026-09-06"},
            )
        assert caught.value.code == "not_found"
    finally:
        store.close()


@pytest.mark.parametrize(
    "bad", [None, {"version": 1}, {"unexpected": "synthetic"}]
)
def test_invalid_definition_is_not_frozen(source, bad):
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source, definition=bad)
    assert caught.value.code == "invalid_argument"


@pytest.mark.parametrize("bad", ["wrong-date", None])
def test_frozen_repair_cannot_change_or_omit_issue_date(source, bad):
    inputs = {**source["inputs"], "issue_date": bad}
    with pytest.raises(newsletter_store.StoreError) as caught:
        create(source, inputs=inputs)
    assert caught.value.code == "conflict"


@pytest.mark.parametrize("mode", ["too_large", "nonfinite", "cycle"])
def test_invalid_or_oversized_snapshot_has_fixed_non_secret_diagnostics(
    source, mode
):
    inputs = copy.deepcopy(source["inputs"])
    inputs["private_fixture"] = "DO_NOT_INCLUDE_IN_ERROR"
    if mode == "too_large":
        inputs["padding"] = "中" * (
            newsletter_workflow_state.MAX_REPAIR_SNAPSHOT_BYTES // 2
        )
    elif mode == "nonfinite":
        inputs["number"] = float("nan")
    else:
        inputs["recursive"] = inputs
    with pytest.raises(
        newsletter_store.StoreError, match=r"^Invalid repair snapshot$"
    ) as caught:
        create(source, inputs=inputs)
    assert (
        caught.value.code == "invalid_argument"
        and caught.value.__suppress_context__
    )
    assert source["state"].repair(source["run"]["id"]) is None


def test_parent_child_usage_aggregation_has_no_cross_run_leak(
    source,
):
    state, parent = source["state"], source["run"]["id"]
    # Synthetic reported counters use the requested prior total for arithmetic
    # regression; this test never loads a real run, session log or provider.
    prior = usage.record_one(
        usage.notification(5_500_000, 403_990, 4_000_000, 100_000)
    )[-1]
    state.usage_sink(parent)(prior)
    unrelated = usage.record_one(usage.notification(999_000, 1_000))[-1]
    state.usage_sink("unrelated-run")(unrelated)
    receipt = create(source)
    child = receipt["child_run_id"]
    assert state.usage(child)["usage"]["total_tokens"] == 5_903_990
    current = usage.record_one(usage.notification(80_000, 5_000, 50_000, 2_000))
    for row in current + [current[-1]]:
        state.usage_sink(child)(row)
    assert state.usage(parent) == state.usage(child)
    assert state.usage(child)["usage"]["total_tokens"] == 5_988_990
    assert state.usage(child)["invocations"] == 2
    assert not state.usage(child)["partial"]
    assert state.usage("unrelated-run")["usage"]["total_tokens"] == 1_000_000
    assert (
        source["store"]
        .db.execute("SELECT COUNT(*) FROM model_usage")
        .fetchone()[0]
        == 3
    )
    with pytest.raises(newsletter_store.StoreError):
        state.usage_sink(child)(
            prior
        )  # Do not copy parent rows into the child.


def test_missing_child_usage_preserves_known_parent_and_partial_status(source):
    parent = source["run"]["id"]
    source["state"].usage_sink(parent)(usage.record_one()[-1])
    child = create(source)["child_run_id"]
    source["state"].usage_sink(child)(usage.record_one()[0])
    result = source["state"].usage(child)
    assert result["usage"]["total_tokens"] == 120
    assert result["partial"] and result["missing_invocations"] == 1


def test_repair_and_combined_usage_survive_reopening_database(source, tmp_path):
    receipt = create(source)
    source["state"].usage_sink(source["run"]["id"])(usage.record_one()[-1])
    source["state"].usage_sink(receipt["child_run_id"])(usage.record_one()[-1])
    peer = newsletter_store.Store(tmp_path / "repair.sqlite3", "mock")
    try:
        state = newsletter_workflow_state.WorkflowState(peer)
        assert state.repair(source["run"]["id"]) == receipt
        assert (
            state.usage(receipt["child_run_id"])["usage"]["total_tokens"] == 240
        )
    finally:
        peer.close()


def test_concurrent_identical_requests_create_one_repair_row(source, tmp_path):
    gate = threading.Barrier(2)

    def create_peer(_):
        peer = newsletter_store.Store(tmp_path / "repair.sqlite3", "mock")
        try:
            state = newsletter_workflow_state.WorkflowState(peer)
            gate.wait(timeout=5)
            return state.create_repair(
                source["run"]["id"],
                source["edition"]["id"],
                source["definition"],
                source["inputs"],
            )
        finally:
            peer.close()

    with futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(create_peer, range(2)))
    assert results[0] == results[1]
    assert (
        source["store"]
        .db.execute("SELECT COUNT(*) FROM workflow_repairs")
        .fetchone()[0]
        == 1
    )
