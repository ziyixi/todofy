"""Offline source-receipt continuation, never real research or mail."""

import argparse
import concurrent.futures as concurrent_futures
import copy
import datetime
import json
import threading

import fastapi.testclient as testclient
import pytest

import newsletter.admin as admin
import newsletter.app as app
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.workflow.engine as newsletter_workflow_engine
import newsletter.workflow.nodes as nodes
import newsletter.workflow.story_editor as story_editor
import newsletter.workflow.story_replay as story_replay
import tests.support.publication as publication
import tests.support.usage as tests_support_usage
import tests.support.workflow_content as workflow_content


def failed_usage(stage):
    value = tests_support_usage.record_one()[-1]
    value.update(
        stage=stage,
        status="failed",
        usage=None,
        usage_events=0,
        turns_started=1,
        turns_completed=1,  # Failed completion after the provider's HTTP 400.
        turns_with_usage=0,
        partial=True,
    )
    return value


async def blocked_parent(rig, *, fatal=None, record_usage=True):
    rig.tasks = [publication.task(1), publication.task(2)]
    candidates = [
        workflow_content.candidate(
            id=selected["candidate_ids"][0], url=selected["source_urls"][0]
        )
        for selected in rig.tasks
    ]
    outputs = {
        "history": {"candidates": [], "editions": [], "watchlist": []},
        "api_feed": {"candidates": [], "note": "Synthetic metadata"},
        "discovery": {"candidates": candidates, "note": "Synthetic discovery"},
        "deduplicate": {"candidates": candidates, "coverage": []},
        "selection": {
            "research_tasks": rig.tasks,
            "note": "Synthetic selection",
            "coverage": [],
        },
        "story_plan": {"brief_tasks": rig.tasks, "deep_tasks": rig.tasks},
    }
    kinds = {node.id: node.type for node in rig.definition.nodes}

    async def execute(ctx):
        kind = kinds[ctx.node_id]
        if kind == "publish":
            raise newsletter_workflow_engine.NodeError("no_findings")
        if kind == "story_plan":
            rig.publications.save_plan(ctx.run_id, publication.DAY, rig.tasks)
        if kind in {"story_brief", "story_deep"}:
            if record_usage:
                rig.pipeline.state.usage_sink(ctx.run_id)(
                    failed_usage(ctx.node_id + ":" + ctx.item_id)
                )
            if fatal:
                raise newsletter_workflow_engine.NodeError(fatal)
            value = {
                "story_id": ctx.item_id,
                "mode": "brief" if kind == "story_brief" else "deep",
                "content": None,
                "signal": None,
                "packets": [],
                "assessments": [],
                "issues": [
                    {
                        "round": "service",
                        "component": "body",
                        "claim": "",
                        "reason": "writer:unavailable",
                        "evidence": [],
                        "action": "research",
                    }
                ],
                "reason": "editor_unavailable",
                "provenance": {"packets_hash": contracts.content_hash([])},
            }
            rig.publications.save(
                ctx.run_id,
                ctx.item,
                value["mode"],
                value,
                issue_date=publication.DAY,
            )
            return value
        return copy.deepcopy(outputs[kind])

    engine = newsletter_workflow_engine.WorkflowEngine(
        rig.pipeline.repository,
        {node.type: execute for node in rig.definition.nodes},
    )
    await engine.run(rig.run["id"])
    rig.pipeline.finish_graph(
        rig.run,
        rig.definition,
        rig.run["id"],
        rig.pipeline.repository.get(rig.run["id"]),
    )
    assert rig.runs.get(rig.run["id"])["error_code"] == "no_publishable_content"


def request(key="explicit-story-restart"):
    return {"request_key": key, "issue_date": publication.DAY}


def parent_receipts(rig):
    return copy.deepcopy(
        {
            "run": rig.runs.get(rig.run["id"]),
            "snapshot": rig.runs.workflow_snapshot(rig.run["id"]),
            "graph": rig.pipeline.repository.get(rig.run["id"]),
            "attempts": rig.pipeline.repository.attempts(rig.run["id"]),
            "artifacts": rig.pipeline.repository.artifacts(rig.run["id"]),
            "results": rig.publications.results(rig.run["id"]),
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("fatal", [None, "configuration"])
async def test_child_reuses_inputs_without_provider_or_mail_replay(
    rig_factory, monkeypatch, fatal
):
    rig = rig_factory(expired=True)
    await blocked_parent(rig, fatal=fatal)
    parent = parent_receipts(rig)
    # This fixture intentionally predates the additive Candidate source fields.
    # Upstream artifact bodies/hashes must survive a newer proto and local
    # replay.
    original_candidates = next(
        item["value"]["candidates"]
        for item in parent["artifacts"]
        if item["node_id"] == "candidates"
    )
    assert all(
        "authors" not in item and "evidence_urls" not in item
        for item in original_candidates
    )
    original_candidate_hash = contracts.content_hash(original_candidates)
    replay = story_replay.StoryReplay(rig.store)
    child = replay.start(rig.run["id"], request())
    assert child["id"] != rig.run["id"]
    child_snapshot = rig.runs.workflow_snapshot(child["id"])
    original_inputs = parent["snapshot"]["inputs"]
    assert child_snapshot["definition"] == parent["snapshot"]["definition"]
    assert {
        key: value
        for key, value in child_snapshot["inputs"].items()
        if key not in {"started_at", "story_replay"}
    } == {
        key: value
        for key, value in original_inputs.items()
        if key != "started_at"
    }
    assert (
        datetime.datetime.now(datetime.UTC)
        - datetime.datetime.fromisoformat(
            child_snapshot["inputs"]["started_at"]
        )
    ).total_seconds() < 10
    assert replay.start(rig.run["id"], request()) == child
    with pytest.raises(newsletter_store.StoreError):
        replay.start(rig.run["id"], request("another-key"))

    async def forbidden(*args, **kwargs):
        raise AssertionError(
            "Continuation cannot call fetch/discovery/selection/legacy editor"
        )

    calls = []

    async def prepare(self, **values):
        calls.append((values["task"]["id"], values["mode"]))
        assert values["candidates"]
        assert all(
            "authors" not in item and "evidence_urls" not in item
            for item in values["candidates"]
        )
        return publication.result(
            values["task"]["priority"], mode=values["mode"]
        )

    monkeypatch.setattr(nodes.EditorialNodes, "execute", forbidden)
    monkeypatch.setattr(story_editor.StoryEditor, "prepare", prepare)
    for _ in range(40):
        if (
            rig.runs.get(child["id"])["state"] != "queued"
            and rig.runs.get(child["id"])["state"] != "collecting"
        ):
            break
        assert await rig.pipeline.collect_next()
    assert rig.runs.get(child["id"])["state"] == "editing"
    assert calls == [
        ("story-1", "brief"),
        ("story-2", "brief"),
        ("story-1", "deep"),
        ("story-2", "deep"),
    ]
    assert rig.publications.plan(child["id"]) == rig.tasks
    assert parent_receipts(rig) == parent
    assert (
        contracts.content_hash(original_candidates) == original_candidate_hash
    )
    assert not rig.notion.calls
    assert rig.store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0
    assert (
        rig.store.db.execute(
            "SELECT COUNT(*) FROM verification_sends"
        ).fetchone()[0]
        == 0
    )
    assert replay.start(rig.run["id"], request())["state"] == "editing"
    with pytest.raises(newsletter_store.StoreError):
        replay.start(child["id"], request("recursive-retry"))


@pytest.mark.asyncio
@pytest.mark.parametrize("fatal", ["authentication", "rate_limit", "timeout"])
async def test_account_failure_or_unknown_attempt_not_config_restart(
    rig_factory, fatal
):
    rig = rig_factory()
    await blocked_parent(rig, fatal=fatal)
    with pytest.raises(newsletter_store.StoreError):
        story_replay.StoryReplay(rig.store).start(rig.run["id"], request())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "artifact",
        "instructions",
        "approved",
        "date",
        "edition",
        "usage",
        "input_hash",
        "map_hash",
        "incomplete_turn",
    ],
)
async def test_changed_or_ineligible_source_never_creates_a_child(
    rig_factory, mutation
):
    rig = rig_factory()
    await blocked_parent(rig)
    payload = request()
    if mutation == "artifact":
        rig.store.db.execute(
            (
                "UPDATE workflow_artifacts SET body=? WHERE run_id=? AND "
                "node_id='selection'"
            ),
            (
                contracts.canonical_json(
                    {"research_tasks": [], "note": "Unreviewed change"}
                ),
                rig.run["id"],
            ),
        )
    elif mutation == "instructions":
        rig.store.db.execute(
            "UPDATE collection_runs SET instructions='[]' WHERE id=?",
            (rig.run["id"],),
        )
    elif mutation == "approved":
        rig.publications.save(
            rig.run["id"],
            rig.tasks[0],
            "brief",
            publication.result(),
            issue_date=publication.DAY,
        )
    elif mutation == "date":
        payload["issue_date"] = "2026-09-07"
    elif mutation == "edition":
        rig.runs.update(rig.run["id"], edition_id="already-edited")
    elif mutation == "input_hash":
        rig.store.db.execute(
            (
                "UPDATE workflow_attempts SET input_hash=? WHERE run_id=? "
                "AND node_id='selection'"
            ),
            ("0" * 64, rig.run["id"]),
        )
    elif mutation == "map_hash":
        graph = rig.pipeline.repository.get(rig.run["id"])
        graph["nodes"]["discovery"]["map_hash"] = "0" * 64
        rig.store.db.execute(
            "UPDATE workflow_runs SET body=? WHERE id=?",
            (contracts.canonical_json(graph), rig.run["id"]),
        )
    elif mutation == "incomplete_turn":
        row = rig.store.db.execute(
            "SELECT body FROM model_usage WHERE scope_id=? LIMIT 1",
            (rig.run["id"],),
        ).fetchone()

        value = json.loads(row[0])
        value["turns_completed"] = 0
        rig.pipeline.state.usage_sink(rig.run["id"])(value)
    else:
        value = tests_support_usage.record_one()[-1]
        value["stage"] = "briefs:story-1"
        rig.pipeline.state.usage_sink(rig.run["id"])(value)
    with pytest.raises(newsletter_store.StoreError):
        story_replay.StoryReplay(rig.store).start(rig.run["id"], payload)
    assert (
        rig.store.db.execute("SELECT COUNT(*) FROM collection_runs").fetchone()[
            0
        ]
        == 1
    )


@pytest.mark.asyncio
async def test_first_config_failure_before_usage_allows_restart(
    rig_factory,
):
    rig = rig_factory()
    await blocked_parent(rig, fatal="configuration", record_usage=False)
    child = story_replay.StoryReplay(rig.store).start(rig.run["id"], request())
    assert child["state"] == "queued"


@pytest.mark.asyncio
async def test_concurrent_requests_create_only_one_child_reopen_never_reset_it(
    rig_factory,
):
    rig = rig_factory()
    await blocked_parent(rig)
    original = parent_receipts(rig)
    barrier = threading.Barrier(2, timeout=5)

    def start():
        store = newsletter_store.Store(rig.path / "newsletter.sqlite3", "mock")
        try:
            replay = story_replay.StoryReplay(store)
            barrier.wait()
            return replay.start(rig.run["id"], request())
        finally:
            store.close()

    with concurrent_futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(start), pool.submit(start)]
        children = [future.result(timeout=10) for future in futures]
    assert children[0] == children[1]
    assert (
        rig.store.db.execute("SELECT COUNT(*) FROM collection_runs").fetchone()[
            0
        ]
        == 2
    )
    assert (
        rig.store.db.execute(
            "SELECT COUNT(*) FROM workflow_story_replays"
        ).fetchone()[0]
        == 1
    )
    child = children[0]
    snapshot = rig.runs.workflow_snapshot(child["id"])
    reopened = newsletter_store.Store(rig.path / "newsletter.sqlite3", "mock")
    try:
        reopened.recover()
        assert (
            story_replay.StoryReplay(reopened).start(rig.run["id"], request())
            == child
        )
    finally:
        reopened.close()
    assert rig.runs.workflow_snapshot(child["id"]) == snapshot
    assert parent_receipts(rig) == original


@pytest.mark.asyncio
async def test_source_hash_is_checked_again_when_child_locally_reuses_it(
    rig_factory,
):
    rig = rig_factory()
    await blocked_parent(rig)
    child = story_replay.StoryReplay(rig.store).start(rig.run["id"], request())
    rig.store.db.execute(
        (
            "UPDATE workflow_artifacts SET body='{}' WHERE run_id=? "
            "AND node_id='selection'"
        ),
        (rig.run["id"],),
    )
    assert await rig.pipeline.collect_next()
    assert rig.runs.get(child["id"])["state"] == "blocked"
    assert not rig.publications.results(child["id"])
    assert not rig.pipeline.state.usage(child["id"])["usage"]


@pytest.mark.asyncio
async def test_usage_keeps_parent_costs_missing_records_once_keeps_them(
    rig_factory,
):
    rig = rig_factory()
    await blocked_parent(rig)
    usage = tests_support_usage.record_one()[-1]
    usage["stage"] = "discovery:synthetic"
    rig.pipeline.state.usage_sink(rig.run["id"])(usage)
    parent_rows = [
        tuple(row)
        for row in rig.store.db.execute("SELECT * FROM model_usage").fetchall()
    ]
    child = story_replay.StoryReplay(rig.store).start(rig.run["id"], request())
    next_usage = tests_support_usage.record_one()[-1]
    next_usage["stage"] = "briefs:story-1"
    rig.pipeline.state.usage_sink(child["id"])(next_usage)
    summary = rig.pipeline.state.usage(child["id"])
    assert summary["usage"]["total_tokens"] == 240
    assert summary["invocations"] == 6
    assert summary["missing_invocations"] == 4 and summary["partial"]
    assert rig.pipeline.state.usage(rig.run["id"]) == summary
    assert [
        tuple(row)
        for row in rig.store.db.execute(
            "SELECT * FROM model_usage WHERE scope_id=?", (rig.run["id"],)
        )
    ] == parent_rows


@pytest.mark.asyncio
async def test_offline_admin_is_idempotent_and_never_sends(rig_factory):
    rig = rig_factory()
    await blocked_parent(rig)
    before = parent_receipts(rig)
    settings = newsletter_settings.Settings(
        data_dir=rig.path,
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    with testclient.TestClient(
        app.create_app(settings, editor=editor.MockEditor(), start_worker=False)
    ) as client:
        url = f"/v1/runs/{rig.run['id']}/retry-stories"
        assert (
            client.post(
                url,
                json=request(),
                headers={"Authorization": "Bearer " + "s" * 32},
            ).status_code
            == 404
        )
        with pytest.raises(RuntimeError, match="data is busy"):
            admin.execute(
                argparse.Namespace(
                    operation="retry-stories",
                    parent_run_id=rig.run["id"],
                    **request(),
                ),
                settings,
            )
    args = argparse.Namespace(
        operation="retry-stories",
        parent_run_id=rig.run["id"],
        **request(),
    )
    args.issue_date = "2026-09-07"
    with pytest.raises(newsletter_store.StoreError):
        admin.execute(args, settings)
    args.issue_date = publication.DAY
    first = admin.execute(args, settings)
    child_id = first["id"]
    assert child_id != rig.run["id"]
    assert admin.execute(args, settings) == first
    args.request_key = "another-key"
    with pytest.raises(newsletter_store.StoreError):
        admin.execute(args, settings)
    args.parent_run_id = child_id
    args.request_key = "recursive"
    with pytest.raises(newsletter_store.StoreError):
        admin.execute(args, settings)
    assert not list((rig.path / "outbox").glob("*.eml"))
    assert parent_receipts(rig) == before
