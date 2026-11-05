"""Test durable publication with synthetic SQLite data, never real mail."""

import copy
import hashlib
import json
import pathlib
import sqlite3

import pytest

import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.monitoring_status as monitoring
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as engine
import newsletter.workflow.pipeline as newsletter_workflow_pipeline
import newsletter.workflow.publication as newsletter_workflow_publication
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.state as newsletter_workflow_state
import newsletter.workflow.threads as threads
import tests.support.publication as publication
import tests.support.story_pipeline as story_pipeline
import tests.support.usage as usage
import tests.support.workflow_content as workflow_content
import tests.support.workflow_state as workflow_state


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


def test_legacy_binding_advance_ignores_unused_projection_failures(
    store, tmp_path
):
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
        tmp_path / "workspace",
        editor=editor.ModelEditor(tmp_path / "unused-auth-path"),
    )
    assert pipeline.advance()
    assert runs.get(run["id"])["state"] == "ready"
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0


@pytest.mark.parametrize("projection", ["failed", "unknown"])
def test_legacy_binding_advance_blocks_unconfirmed_adopted_projection(
    store, tmp_path, projection
):
    # Editions frozen by the retired whole-edition recipe still gate sending on
    # their adopted packets; a failed or unknown projection must close the run
    # without a retry and without reserving a send.
    runs = repository.RunRepository(store)
    run = runs.start(
        {"request_key": "run", "issue_date": "2026-09-06"},
        [],
        workflow_snapshot={"fixture": "not executed by this state-only test"},
    )
    adopted = workflow_state.packet(store, "adopted")
    edition = workflow_state.ready(store, "edition", [adopted], run=run["id"])
    assert store.get(edition["id"])["state"] == "ready"
    assert (
        newsletter_workflow_state.WorkflowState(store).edition(edition["id"])[
            "projection_required"
        ]
        is True
    )
    store.projection_result(adopted["id"], projection)
    runs.update(run["id"], state="editing", edition_id=edition["id"])
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        tmp_path / "workspace",
        editor=editor.ModelEditor(tmp_path / "unused-auth-path"),
    )
    assert pipeline.advance()
    blocked = runs.get(run["id"])
    assert blocked["state"] == "blocked"
    assert blocked["error_code"] == "notion_projection_unconfirmed"
    with pytest.raises(newsletter_store.StoreError):
        store.reserve_send(workflow_state.approval(edition))
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0
    # A second pass finds no active run, so nothing changes or retries.
    assert pipeline.advance() is False
    assert runs.get(run["id"]) == blocked
    assert store.get(edition["id"])["state"] == "ready"


def _pending_legacy_run(store, runs):
    run = runs.start(
        {"request_key": "run", "issue_date": "2026-09-06"},
        [],
        workflow_snapshot={"fixture": "not executed by this state-only test"},
    )
    adopted = workflow_state.packet(store, "adopted")
    edition = workflow_state.ready(store, "edition", [adopted], run=run["id"])
    runs.update(run["id"], state="editing", edition_id=edition["id"])
    return run, edition


def test_legacy_binding_closes_when_packet_projection_is_skipped(
    store, tmp_path
):
    # Dual-database deployments never project packets, so the adopted packet
    # stays pending forever; the run must close instead of waiting.
    runs = repository.RunRepository(store)
    run, edition = _pending_legacy_run(store, runs)
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        tmp_path / "workspace",
        editor=editor.ModelEditor(tmp_path / "unused-auth-path"),
        packet_projection=False,
    )
    assert pipeline.advance()
    closed = runs.get(run["id"])
    assert closed["state"] == "blocked"
    assert closed["error_code"] == newsletter_workflow_pipeline.RETIRED_WORKFLOW
    with pytest.raises(newsletter_store.StoreError):
        store.reserve_send(workflow_state.approval(edition))
    assert pipeline.advance() is False
    assert runs.get(run["id"]) == closed


def test_legacy_binding_waits_for_pending_projection_when_it_runs(
    store, tmp_path
):
    # With packet projection enabled the worker will still resolve the
    # pending packet, so the gate keeps waiting rather than closing early.
    runs = repository.RunRepository(store)
    run, _ = _pending_legacy_run(store, runs)
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        tmp_path / "workspace",
        editor=editor.ModelEditor(tmp_path / "unused-auth-path"),
    )
    assert pipeline.advance() is False
    assert runs.get(run["id"])["state"] == "editing"


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


# Cross-day publication threads and the compact candidate index.

ISSUE = "2026-10-20"


def story(day, ids, urls=(), title="合成选题"):
    return {
        "issue_date": day,
        "title": title,
        "candidate_ids": list(ids),
        "source_urls": list(urls),
    }


def member(identifier, url, event_key=""):
    return {
        "id": identifier,
        "title": f"Synthetic remembered candidate {identifier}",
        "url": url,
        "doi": "",
        "event_key": event_key,
    }


def key_of(*ids):
    digest = hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest()
    return "thread-" + digest[:12]


def test_stories_sharing_a_source_form_one_thread_with_day_counts():
    candidates = {
        "c1": member("c1", "https://example.org/vote"),
        "c2": member("c2", "https://example.org/vote-result"),
        "c3": member("c3", "https://example.org/quake"),
    }
    built = threads.build(
        [
            story("2026-10-01", ["c1"], title="合成大选开始投票"),
            # Two editions on one day still count as one publication day.
            story("2026-10-12", ["c2"], ["https://example.org/vote"]),
            story("2026-10-12", ["c2"], title="合成大选公布结果"),
            story("2026-10-15", ["c3"], title="合成地震"),
        ],
        candidates,
        ISSUE,
    )
    assert [thread["thread_key"] for thread in built] == [
        key_of("c3"),
        key_of("c1"),
    ]
    vote = threads.prompt_threads(built)[1]
    assert vote == {
        "thread_key": key_of("c1"),
        "title": "合成大选公布结果",
        "first_published": "2026-10-01",
        "last_published": "2026-10-12",
        "times": 2,
        "times_14d": 1,
        "urls": [
            "https://example.org/vote-result",
            "https://example.org/vote",
        ],
    }
    assert "url:https://example.org/vote" in built[1]["keys"]
    assert len(built[1]["keys"]) <= threads.MAX_KEYS


def test_thread_key_survives_its_first_story_leaving_the_window():
    first = story("2026-09-25", ["c1"])
    original = key_of("c1")
    later = story("2026-10-10", ["c2"])
    candidates = {
        "c1": member("c1", "https://example.org/first"),
        # Discovery reused the key as event_key on a new report.
        "c2": member("c2", "https://example.org/second", original),
    }
    built = threads.build([first, later], candidates, ISSUE)
    assert [t["thread_key"] for t in built] == [original]
    # The reused key links the story but is never a matching identity.
    assert not any(key.startswith("event:") for key in built[0]["keys"])
    assert [
        t["thread_key"] for t in threads.build([later], candidates, ISSUE)
    ] == [original]
    # Without a reused key a story starts its own thread.
    candidates["c2"] = member("c2", "https://example.org/second")
    assert [
        t["thread_key"]
        for t in threads.build([first, later], candidates, ISSUE)
    ] == [key_of("c2"), original]


def test_a_reused_key_beats_a_shared_url_and_counts_stay_capped():
    candidates = {
        "old": member("old", "https://example.org/a"),
        "new": member("new", "https://example.org/b"),
    }
    built = threads.build(
        [
            story("2026-10-01", ["old"]),
            story("2026-10-02", ["new"]),
            story(
                "2026-10-03",
                ["x"],
                [f"https://example.org/source-{n}" for n in range(9)],
            ),
        ],
        candidates,
        ISSUE,
    )
    assert built[0]["urls"] == [
        f"https://example.org/source-{n}" for n in range(threads.MAX_URLS)
    ]
    pool = [
        workflow_content.candidate(
            id="claims-old",
            url="https://example.org/b",
            event_key=key_of("old"),
        ),
        workflow_content.candidate(
            id="shares-url", url="https://example.org/b"
        ),
        workflow_content.candidate(id="unrelated", url="https://example.org/z"),
    ]
    # Both stories are older than the 14-day window.
    assert threads.annotate(pool, built) == {
        "claims-old": {
            "thread_key": key_of("old"),
            "last_published": "2026-10-01",
            "times_14d": 0,
        },
        "shares-url": {
            "thread_key": key_of("new"),
            "last_published": "2026-10-02",
            "times_14d": 0,
        },
    }


def publish(repository, run_id, day, tasks, results, state="simulated"):
    repository.save_plan(run_id, day, tasks)
    for task, result in zip(tasks, results, strict=True):
        if result is not None:
            repository.save(run_id, task, "brief", result, issue_date=day)
    built = newsletter_workflow_publication.assemble(
        run_id, day, tasks, [r for r in results if r is not None]
    )
    repository.record_publication(run_id, day, tasks, built)
    publication.delivery_receipt(
        repository, run_id, built, state, issue_date=day
    )


def test_only_delivered_published_stories_count(store):
    repository = newsletter_workflow_publication.PublicationRepository(store)
    sent = [publication.task(1), publication.task(2)]
    publish(
        repository, "sent", "2026-10-10", sent, [publication.result(1), None]
    )
    held = [publication.task(3)]
    publish(
        repository,
        "held",
        "2026-10-11",
        held,
        [publication.result(3)],
        "not_requested",
    )
    old = [publication.task(4)]
    publish(repository, "old", "2026-09-15", old, [publication.result(4)])
    assert repository.published_stories(ISSUE, threads.THREAD_DAYS) == [
        {
            "issue_date": "2026-10-10",
            "title": "Synthetic verified topic 1",
            "candidate_ids": ["candidate-1"],
            "source_urls": [publication.URL],
        }
    ]
    assert repository.published_stories("2026-10-10", 30) == [
        {
            "issue_date": "2026-09-15",
            "title": "Synthetic verified topic 4",
            "candidate_ids": ["candidate-4"],
            "source_urls": [publication.URL],
        }
    ]


def test_recent_index_is_compact_and_bounded_by_days(store):
    state = newsletter_workflow_state.WorkflowState(store)
    long_title = "Synthetic long candidate title " * 5
    rows = [
        (workflow_content.candidate(id="week", title=long_title), "2026-10-14"),
        (
            workflow_content.candidate(
                id="keyed", url="https://example.org/k", event_key="vote"
            ),
            "2026-10-19",
        ),
        (
            workflow_content.candidate(id="stale", url="https://example.org/s"),
            "2026-10-12",
        ),
        (
            workflow_content.candidate(id="today", url="https://example.org/t"),
            ISSUE,
        ),
    ]
    for candidate, day in rows:
        state.remember([candidate], day)
    assert state.recent(ISSUE) == [
        {
            "id": "keyed",
            "title": "Synthetic research candidate",
            "seen": "2026-10-19",
            "status": "seen",
            "event_key": "vote",
        },
        {
            "id": "week",
            "title": long_title[:80],
            "seen": "2026-10-14",
            "status": "seen",
        },
    ]
    assert threads.prompt_index(state.recent(ISSUE))[1] == {
        "title": long_title[:80],
        "seen": "2026-10-14",
        "status": "seen",
    }
    assert set(state.candidates({"keyed", "missing"})) == {"keyed"}


def test_marking_never_downgrades_a_used_candidate(store):
    state = newsletter_workflow_state.WorkflowState(store)
    pool = [
        workflow_content.candidate(id=name, url=f"https://example.org/{name}")
        for name in ("used", "watched", "fresh")
    ]
    state.remember(pool, "2026-10-18")
    state.mark(["used"], "used", "cited")
    state.mark(["watched"], "watch", "legacy")
    state.mark(
        ["used", "watched", "fresh"],
        "seen",
        "not chosen",
        replacing=("seen", "watch"),
    )
    assert {
        row["id"]: (row["disposition"], row["selection_reason"])
        for row in state.history(ISSUE)
    } == {
        "used": ("used", "cited"),
        "watched": ("seen", "not chosen"),
        "fresh": ("seen", "not chosen"),
    }
    with pytest.raises(ValueError, match="disposition"):
        state.mark(["fresh"], "seen", replacing=("archived",))


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
        editor=editor.ModelEditor(tmp_path / "unused-auth"),
    )
    workflow = pipeline.receipt(run["id"])["workflow"]
    assert workflow["id"] == "daily-newsletter"
    assert [item["id"] for item in workflow["continuations"]] == [
        "editorial-repair"
    ]
    assert workflow["continuations"][0]["state"] == "queued"


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
    store = newsletter_store.Store(path, "live")
    newsletter_workflow_repository.WorkflowRepository(store)
    store.db.execute(
        "INSERT INTO workflow_runs VALUES('run-1','d','{}','i','{}','{}')"
    )
    for attempt in attempts:
        _attempt(store, *attempt)
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
    store = newsletter_store.Store(path, "live")
    try:
        after = _rows(path)
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
    newsletter_store.Store(path, "live").close()
    migrated = _rows(path)
    newsletter_store.Store(path, "live").close()
    assert _rows(path) == migrated
    store = newsletter_store.Store(path, "live")
    _attempt(store, "b-later", "unknown", "timeout")
    store.close()
    newsletter_store.Store(path, "live").close()
    assert [row[4] for row in _rows(path)] == ["failed", "unknown"]


def test_other_unknown_codes_stay_visible(tmp_path):
    path = tmp_path / "newsletter.sqlite3"
    _old_database(path, [("a-external", "unknown", "external_unknown")])
    store = newsletter_store.Store(path, "live")
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
    store = newsletter_store.Store(path, "live")
    _attempt(store, "a-timeout", "unknown", "timeout")
    store.db.execute("DELETE FROM metadata WHERE key=?", (MARKER,))
    first = monitoring.snapshot(store)
    store.close()
    assert first["unknown_by_kind"]["workflow_attempts"] == 1
    store = newsletter_store.Store(path, "live")
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
    store = newsletter_store.Store(path, "live")
    try:
        before = monitoring.snapshot(store)
        assert before["unknown_by_kind"]["workflow_attempts"] == 0
        workflows = newsletter_workflow_repository.WorkflowRepository(store)
        workflows.start(
            "run-2",
            newsletter_workflow_definition.parse_definition(
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
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        marker = store.db.execute(
            "SELECT value FROM metadata WHERE key=?", (MARKER,)
        ).fetchone()[0]
        assert json.loads(marker)["changed"] == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_dag_pipeline_collect_next_handles_outer_timeout_and_store_errors(
    store, tmp_path, monkeypatch
):
    settings = newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    state = newsletter_workflow_state.WorkflowState(store)
    instructions, snapshot = newsletter_workflow_pipeline.freeze_workflow(
        settings, state, "2026-09-06"
    )
    runs = repository.RunRepository(store)
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        tmp_path / "workspace",
        editor=editor.ModelEditor(tmp_path / "unused-auth"),
    )

    # 1. Outer TimeoutError before engine.step
    first = runs.start(
        {"request_key": "outer-timeout", "issue_date": "2026-09-06"},
        instructions,
        workflow_snapshot=snapshot,
    )
    monkeypatch.setattr(
        pipeline.repository,
        "start",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError()),
    )
    assert await pipeline.collect_next() is True
    assert runs.get(first["id"])["state"] == "blocked"
    assert runs.get(first["id"])["error_code"] == "workflow_deadline"

    # 2. Non-busy StoreError
    second = runs.start(
        {"request_key": "store-error", "issue_date": "2026-09-06"},
        instructions,
        workflow_snapshot=snapshot,
    )
    monkeypatch.setattr(
        pipeline.repository,
        "start",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            newsletter_store.StoreError("conflict", "db conflict")
        ),
    )
    assert await pipeline.collect_next() is True
    assert runs.get(second["id"])["state"] == "failed"
    assert runs.get(second["id"])["error_code"] == "workflow_storage"


def test_dag_pipeline_archive_candidates_handles_empty_and_populated_pools(
    store, tmp_path
):
    settings = newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    state = newsletter_workflow_state.WorkflowState(store)
    instructions, snapshot = newsletter_workflow_pipeline.freeze_workflow(
        settings, state, "2026-09-06"
    )
    definition = newsletter_workflow_definition.parse_definition(
        snapshot["definition"]
    )
    runs = repository.RunRepository(store)
    run = runs.start(
        {"request_key": "archive-run", "issue_date": "2026-09-06"},
        instructions,
        workflow_snapshot=snapshot,
    )
    pipeline = newsletter_workflow_pipeline.DagPipeline(
        runs,
        tmp_path / "workspace",
        editor=editor.ModelEditor(tmp_path / "unused-auth"),
    )
    pipeline.repository.start(run["id"], definition, snapshot["inputs"])
    dedup_node = next(
        node for node in definition.nodes if node.type == "deduplicate"
    )

    # Empty candidate pool returns early without archiving a packet
    pipeline.repository.output = lambda _run_id, _node_id: {"candidates": []}
    pipeline.archive_candidates(run, definition, [], [])
    assert state.archive(run["id"]) is None

    # Populated candidate pool marks used candidates and writes index packet
    cand = workflow_content.candidate(
        id="cand-1", url="https://example.org/paper-1"
    )
    state.remember([cand], "2026-09-06")
    pipeline.repository.output = lambda _run_id, _node_id: {
        "candidates": [cand]
    }
    pkt = workflow_state.packet(store, "pkt-1")
    pkt["content"]["sources"][0]["url"] = "https://example.org/paper-1"
    pipeline.archive_candidates(run, definition, [pkt["id"]], [pkt])
    archived = state.archive(run["id"])
    assert archived is not None and archived["packet_id"]
    prog = pipeline.graph_progress(run["id"])
    assert prog["id"] == definition.id
    assert any(n["id"] == dedup_node.id for n in prog["nodes"])

