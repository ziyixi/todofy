"""Stored repair receipts stay readable after repairs were retired.

The retired whole-edition recipe could start one frozen repair for a held
edition. No new repair is created; old receipts keep their usage lineage and
still appear as the run's continuation.
"""

import pytest

import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.store as newsletter_store
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.pipeline as newsletter_workflow_pipeline
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.state as newsletter_workflow_state
import tests.support.story_pipeline as story_pipeline
import tests.support.usage as usage

REPAIR_DEFINITION = {
    "version": 1,
    "id": "editorial-repair",
    "nodes": [
        {"id": "revision", "type": "revision"},
        {"id": "final_review", "type": "final_review", "needs": ["revision"]},
    ],
}


@pytest.fixture
def source(tmp_path):
    store = newsletter_store.Store(tmp_path / "repair.sqlite3", "mock")
    try:
        yield {
            "store": store,
            "state": newsletter_workflow_state.WorkflowState(store),
            "parent": "fixture-parent",
        }
    finally:
        store.close()


def create(source):
    """Insert a receipt exactly as the retired repair path stored it."""
    receipt = {
        "parent_run_id": source["parent"],
        "source_edition_id": "fixture-edition",
        "child_run_id": source["parent"] + ":repair-1",
        "snapshot": {
            "definition": REPAIR_DEFINITION,
            "inputs": {"issue_date": "2026-09-06"},
        },
    }
    with source["store"].transaction():
        source["store"].db.execute(
            "INSERT INTO workflow_repairs VALUES(?,?,?,?)",
            (
                receipt["parent_run_id"],
                receipt["source_edition_id"],
                receipt["child_run_id"],
                contracts.canonical_json(receipt["snapshot"]),
            ),
        )
    return receipt


def test_parent_child_usage_aggregation_has_no_cross_run_leak(source):
    state, parent = source["state"], source["parent"]
    # Synthetic reported counters use the requested prior total for arithmetic
    # regression; this test never loads a real run, session log or provider.
    prior = usage.record_one(
        usage.notification(5_500_000, 403_990, 4_000_000, 100_000)
    )[-1]
    state.usage_sink(parent)(prior)
    unrelated = usage.record_one(usage.notification(999_000, 1_000))[-1]
    state.usage_sink("unrelated-run")(unrelated)
    child = create(source)["child_run_id"]
    assert state.usage(child)["usage"]["total_tokens"] == 5_903_990
    current = usage.record_one(usage.notification(80_000, 5_000, 50_000, 2_000))
    for row in current + [current[-1]]:
        state.usage_sink(child)(row)
    assert state.usage(parent) == state.usage(child)
    assert state.usage(child)["usage"]["total_tokens"] == 5_988_990
    assert state.usage(child)["invocations"] == 2
    assert not state.usage(child)["partial"]
    assert state.usage("unrelated-run")["usage"]["total_tokens"] == 1_000_000
    with pytest.raises(newsletter_store.StoreError):
        # Do not copy parent rows into the child.
        state.usage_sink(child)(prior)


def test_missing_child_usage_preserves_known_parent_and_partial_status(source):
    source["state"].usage_sink(source["parent"])(usage.record_one()[-1])
    child = create(source)["child_run_id"]
    source["state"].usage_sink(child)(usage.record_one()[0])
    result = source["state"].usage(child)
    assert result["usage"]["total_tokens"] == 120
    assert result["partial"] and result["missing_invocations"] == 1


def test_repair_and_combined_usage_survive_reopening_database(source, tmp_path):
    receipt = create(source)
    source["state"].usage_sink(source["parent"])(usage.record_one()[-1])
    source["state"].usage_sink(receipt["child_run_id"])(usage.record_one()[-1])
    peer = newsletter_store.Store(tmp_path / "repair.sqlite3", "mock")
    try:
        state = newsletter_workflow_state.WorkflowState(peer)
        assert state.repair(source["parent"]) == receipt
        assert (
            state.usage(receipt["child_run_id"])["usage"]["total_tokens"] == 240
        )
    finally:
        peer.close()


def test_stored_repair_is_reported_as_a_continuation(source, tmp_path):
    legacy = newsletter_workflow_definition.load_definition(
        story_pipeline.LEGACY_RECIPE
    )
    inputs = {"issue_date": "2026-09-06"}
    runs = repository.RunRepository(source["store"])
    run = runs.start(
        {"request_key": "legacy-run", "issue_date": inputs["issue_date"]},
        [],
        workflow_snapshot={"definition": legacy.snapshot(), "inputs": inputs},
    )
    newsletter_workflow_repository.WorkflowRepository(source["store"]).start(
        run["id"], legacy, inputs
    )
    source["parent"] = run["id"]
    create(source)
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        tmp_path / "jobs",
        editor=newsletter_editor.CodexEditor(tmp_path / "unused-auth"),
    )
    workflow = pipeline.receipt(run["id"])["workflow"]
    assert workflow["id"] == "daily-newsletter"
    assert [item["id"] for item in workflow["continuations"]] == [
        "editorial-repair"
    ]
    assert workflow["continuations"][0]["state"] == "queued"
