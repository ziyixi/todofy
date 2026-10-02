"""Test offline DAG safety, fanout and durable recovery."""

import asyncio
import dataclasses
import json

import pytest

import newsletter.store as newsletter_store
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as newsletter_workflow_engine
import newsletter.workflow.repository as newsletter_workflow_repository


def definition(*nodes):
    return newsletter_workflow_definition.parse_definition(
        {"version": 1, "id": "daily-newsletter", "nodes": list(nodes)}
    )


def node(identifier="discover", kind="discovery", **fields):
    return {"id": identifier, "type": kind, **fields}


@pytest.fixture
def repo(tmp_path):
    store = newsletter_store.Store(tmp_path / "workflow.sqlite3", "mock")
    repository = newsletter_workflow_repository.WorkflowRepository(store)
    yield repository
    store.close()


def test_literal_yaml_has_immutable_semantic_snapshot():
    loaded = newsletter_workflow_definition.load_definition("""
version: 1
id: daily-newsletter
nodes:
  - id: discover
    type: discovery
    params:
      direction: "literal-${DO_NOT_EXPAND}-$(do_not_execute)"
""")
    assert (
        loaded.nodes[0].params["direction"]
        == "literal-${DO_NOT_EXPAND}-$(do_not_execute)"
    )
    params = loaded.nodes[0].params
    params["direction"] = "changed"
    assert loaded.nodes[0].params != params
    snapshot = loaded.snapshot()
    snapshot["nodes"][0]["params"]["direction"] = "changed"
    assert (
        loaded.digest
        != newsletter_workflow_definition.parse_definition(snapshot).digest
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        loaded.id = "changed"


@pytest.mark.parametrize(
    "bad",
    [
        "version: 1\nversion: 1\nid: test\nnodes: []",
        (
            "version: 1\n"
            "id: test\n"
            "nodes: [{id: n, type: discovery, params: {k: 1, k: 2}}]"
        ),
        "version: 1\nid: test\nnodes: &tasks [{id: n, type: discovery}]",
        "version: 1\nid: test\nnodes: [*alias]",
        "!!python/object/apply:os.system ['DO_NOT_EXECUTE']",
        (
            "version: 1\n"
            "id: test\n"
            "nodes: [{id: n, type: discovery, params: {x: .nan}}]"
        ),
        (
            "version: 1\n"
            "id: test\n"
            "nodes: [{id: n, type: discovery, params: {x: 2026-09-06}}]"
        ),
        "version: 1\nid: test\nnodes: [" + "[" * 30 + "0" + "]" * 30 + "]",
        "not: [valid",
        "\x00",
        b"\xff",
        b"a" * (newsletter_workflow_definition.MAX_DEFINITION_BYTES + 1),
    ],
)
def test_unsafe_yaml_fails_with_safe_diagnostics(bad):
    with pytest.raises(
        newsletter_workflow_definition.DefinitionError
    ) as caught:
        newsletter_workflow_definition.load_definition(bad)
    assert "DO_NOT_EXECUTE" not in str(caught.value)


@pytest.mark.parametrize(
    "nodes",
    [
        [],
        [node(), node()],
        [node(kind="send")],
        [node(kind="shell")],
        [node(extra="unsupported")],
        [node(needs=["missing"])],
        [node(needs=["discover"])],
        [node("a", needs=["b"]), node("b", needs=["a"])],
        [node("a"), node("b", needs=["a", "a"])],
        [node(params={"api_key": "SECRET_SENTINEL"})],
        [node(params={"nested": {"shell": "SECRET_SENTINEL"}})],
        [node("run")],
        [node(map={"from": "missing.items", "max_items": 2})],
        [node(map={"from": "run.items[0]", "max_items": 2})],
        [node(map={"from": "run.__dict__", "max_items": 2})],
        [node(map={"from": "run.items", "max_items": True})],
        [node(map={"from": "run.items", "max_items": 33})],
        [node("a", "review", on_error="continue")],
        [node("a", "selection", on_error="continue")],
        [node("a", "composition", on_error="continue")],
        [node("a", on_error="retry_forever")],
        [
            node(f"node-{index}")
            for index in range(newsletter_workflow_definition.MAX_NODES + 1)
        ],
        [
            node(f"node-{index}", map={"from": "run.items", "max_items": 32})
            for index in range(5)
        ],
    ],
)
def test_invalid_graphs_rejected(nodes):
    with pytest.raises(
        newsletter_workflow_definition.DefinitionError
    ) as caught:
        definition(*nodes)
    assert "SECRET_SENTINEL" not in str(caught.value)


def test_file_loader_rejects_symlinks_and_missing_file(tmp_path):
    actual = tmp_path / "actual.yml"
    actual.write_text("version: 1\nid: test\nnodes: [{id: n, type: discovery}]")
    link = tmp_path / "link.yml"
    link.symlink_to(actual)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        newsletter_workflow_definition.load_definition(link)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        newsletter_workflow_definition.load_definition(tmp_path / "missing.yml")
    assert newsletter_workflow_definition.load_definition(actual).id == "test"


def test_repository_freezes_graph_and_inputs_with_idempotent_start(repo):
    graph = definition(node())
    inputs = {"instructions": [{"id": "ai", "text": "original"}]}
    first = repo.start("run-1", graph, inputs)
    assert repo.start("run-1", graph, inputs) == first
    inputs["instructions"][0]["text"] = "changed"
    assert (
        repo.snapshot("run-1")["inputs"]["instructions"][0]["text"]
        == "original"
    )
    with pytest.raises(newsletter_workflow_repository.WorkflowError) as caught:
        repo.start("run-1", graph, inputs)
    assert caught.value.code == "conflict"
    with pytest.raises(newsletter_workflow_repository.WorkflowError):
        repo.start("run-1", definition(node(params={"limit": 2})), {})


async def test_serial_dependencies_persist_outputs_before_next_handler(repo):
    graph = definition(
        node("later", "selection", needs=["first"]), node("first")
    )
    repo.start("run", graph, {"issue_date": "2026-09-06"})
    seen = []
    external = object()

    async def first(context):
        assert context.context is external
        seen.append("first")
        return {"candidates": [{"id": "candidate"}]}

    async def later(context):
        assert repo.output("run", "first") == context.inputs["first"]
        assert context.dependency_states["first"]["state"] == "succeeded"
        seen.append("later")
        return {"selected": True}

    engine = newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": first, "selection": later}, external
    )
    result = await engine.run("run")
    assert result["state"] == "succeeded" and seen == ["first", "later"]
    assert len(repo.artifacts("run")) == 2
    assert len(repo.attempts("run")) == 2
    assert await engine.step("run") is False
    assert await engine.run("run") == result
    assert seen == ["first", "later"]


async def test_dynamic_fanout_preserves_input_order_and_runs_each_item_once(
    repo,
):
    graph = definition(
        node("discover", map={"from": "run.instructions", "max_items": 3})
    )
    pinned = [{"id": "z", "text": "first"}, {"id": "a", "text": "second"}]
    repo.start("run", graph, {"instructions": pinned})
    seen = []

    async def handler(context):
        seen.append(context.item_id)
        return {"id": context.item_id, "text": context.item["text"]}

    engine = newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": handler}
    )
    assert await engine.step("run") is True
    assert not seen and repo.get("run")["nodes"]["discover"]["map_expanded"]
    repo.expand_map("run", "discover", pinned)
    frozen = repo.get("run")["nodes"]["discover"]
    with pytest.raises(newsletter_workflow_repository.WorkflowError) as caught:
        repo.expand_map("run", "discover", list(reversed(pinned)))
    assert caught.value.code == "conflict"
    assert repo.get("run")["nodes"]["discover"] == frozen
    with pytest.raises(newsletter_workflow_repository.WorkflowError) as caught:
        repo.expand_map("run", "discover", [{"id": "another"}])
    assert caught.value.code == "conflict"
    assert (await engine.run("run"))["state"] == "succeeded"
    assert seen == ["z", "a"] and repo.output("run", "discover") == pinned
    assert len(repo.artifacts("run")) == 3
    attempts = repo.attempts("run")
    assert await engine.step("run") is False
    assert repo.attempts("run") == attempts and seen == ["z", "a"]


async def test_engine_runs_selected_research_by_frozen_priority_not_item_id(
    repo,
):
    repo.start(
        "run",
        definition(
            node("selection", "selection"),
            node(
                "research",
                "research",
                needs=["selection"],
                map={"from": "selection.research_tasks", "max_items": 2},
            ),
        ),
        {},
    )
    tasks = [{"id": "methane", "priority": 1}, {"id": "bhutan", "priority": 2}]
    seen = []

    async def selection(context):
        return {"research_tasks": tasks}

    async def research(context):
        seen.append((context.item_id, context.item["priority"]))
        return context.item

    engine = newsletter_workflow_engine.WorkflowEngine(
        repo, {"selection": selection, "research": research}
    )
    assert await engine.step("run") is True  # Selection result persisted.
    assert await engine.step("run") is True  # Map expansion persisted.
    assert await engine.step("run") is True  # Highest priority runs first.
    assert seen == [("methane", 1)]
    assert (await engine.run("run"))["state"] == "succeeded"
    assert seen == [("methane", 1), ("bhutan", 2)]
    assert repo.output("run", "research") == tasks


async def test_existing_expanded_map_order_is_not_migrated_or_recomputed(repo):
    original = [{"id": "z", "priority": 1}, {"id": "a", "priority": 2}]
    old_order = list(reversed(original))
    repo.start(
        "run",
        definition(node(map={"from": "run.items", "max_items": 2})),
        {"items": original},
    )
    # Simulate an already persisted expansion from the old ID-sorting executor.
    repo.expand_map("run", "discover", old_order)
    frozen_hash = repo.get("run")["nodes"]["discover"]["map_hash"]
    seen = []

    async def handler(context):
        seen.append(context.item_id)
        return context.item

    assert (
        await newsletter_workflow_engine.WorkflowEngine(
            repo, {"discovery": handler}
        ).run("run")
    )["state"] == "succeeded"
    assert seen == ["a", "z"] and repo.output("run", "discover") == old_order
    assert repo.get("run")["nodes"]["discover"]["map_hash"] == frozen_hash
    assert repo.snapshot("run")["inputs"]["items"] == original


async def test_empty_supplement_map_skips_but_finalization_still_runs(repo):
    graph = definition(
        node("plan", "gap_plan"),
        node(
            "supplements",
            "research",
            needs=["plan"],
            map={"from": "plan.research_tasks", "max_items": 3},
        ),
        node("final", "finalization", needs=["plan", "supplements"]),
    )
    repo.start("run", graph, {})
    research_calls = []

    async def plan(context):
        return {"research_tasks": []}

    async def research(context):
        research_calls.append(context)
        return {}

    async def final(context):
        assert context.inputs["supplements"] == []
        assert context.dependency_states["supplements"]["state"] == "skipped"
        return {"draft": "completed"}

    result = await newsletter_workflow_engine.WorkflowEngine(
        repo, {"gap_plan": plan, "research": research, "finalization": final}
    ).run("run")
    assert result["state"] == "succeeded" and not research_calls
    assert len(repo.attempts("run")) == 2


@pytest.mark.parametrize(
    "items",
    [
        None,
        {},
        ["bad"],
        [{"id": "bad/id"}],
        [{"id": "x"}, {"id": "x"}],
        [{"id": "a"}, {"id": "b"}, {"id": "c"}],
    ],
)
async def test_invalid_map_input_fails_without_handler_call(repo, items):
    graph = definition(node(map={"from": "run.items", "max_items": 2}))
    repo.start("run", graph, {"items": items})
    calls = []

    async def handler(context):
        calls.append(context)

    result = await newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": handler}
    ).run("run")
    assert result["state"] == "failed" and not calls
    assert repo.attempts("run")[0]["error_code"] == "invalid_input"


async def test_explicit_optional_map_failure_preserves_failed_children(repo):
    graph = definition(
        node(
            "research",
            "research",
            on_error="continue",
            map={"from": "run.items", "max_items": 3},
        ),
        node("compose", "composition", needs=["research"]),
    )
    repo.start(
        "run",
        graph,
        {"items": [{"id": "bad"}, {"id": "good"}, {"id": "uncertain"}]},
    )

    async def research(context):
        if context.item_id == "bad":
            raise newsletter_workflow_engine.NodeError("unavailable")
        if context.item_id == "uncertain":
            raise newsletter_workflow_engine.NodeError(
                "external_unknown", ambiguous=True
            )
        return {"id": "good", "evidence": "verified"}

    async def compose(context):
        assert context.inputs["research"] == [
            {"id": "good", "evidence": "verified"}
        ]
        status = context.dependency_states["research"]
        assert status["degraded"] and status["error_code"] == "partial_failure"
        assert [item["state"] for item in status["items"]] == [
            "failed",
            "succeeded",
            "unknown",
        ]
        return {"coverage_checked": True}

    result = await newsletter_workflow_engine.WorkflowEngine(
        repo, {"research": research, "composition": compose}
    ).run("run")
    assert result["state"] == "succeeded"
    attempts = repo.attempts("run")
    assert sorted(item["state"] for item in attempts) == [
        "failed",
        "succeeded",
        "succeeded",
        "unknown",
    ]


async def test_nonmapped_optional_provider_failure_has_explicit_empty_artifact(
    repo,
):
    repo.start(
        "run", definition(node(kind="api_feed", on_error="continue")), {}
    )

    async def fail(context):
        raise newsletter_workflow_engine.NodeError("unavailable")

    result = await newsletter_workflow_engine.WorkflowEngine(
        repo, {"api_feed": fail}
    ).run("run")
    assert result["state"] == "succeeded"
    status = result["nodes"]["discover"]
    assert (
        status["state"] == "skipped"
        and status["degraded"]
        and status["failure_state"] == "failed"
    )
    assert repo.output("run", "discover") is None
    assert repo.attempts("run")[0]["state"] == "failed"


@pytest.mark.parametrize(
    "ambiguous,expected", [(False, "failed"), (True, "unknown")]
)
async def test_required_failure_blocks_downstream_and_does_not_retry(
    repo, ambiguous, expected
):
    repo.start(
        "run",
        definition(node("first"), node("review", "review", needs=["first"])),
        {},
    )
    calls = []

    async def fail(context):
        calls.append(context.node_id)
        raise newsletter_workflow_engine.NodeError(
            "unavailable", ambiguous=ambiguous
        )

    engine = newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": fail, "review": fail}
    )
    assert (await engine.run("run"))["state"] == expected
    assert await engine.step("run") is False and calls == ["first"]


async def test_restart_recovers_inflight_to_unknown_without_replaying(tmp_path):
    path = tmp_path / "durable.sqlite3"
    store = newsletter_store.Store(path, "mock")
    repo = newsletter_workflow_repository.WorkflowRepository(store)
    repo.start(
        "run",
        definition(node(map={"from": "run.items", "max_items": 2})),
        {"items": [{"id": "a"}, {"id": "b"}]},
    )
    repo.expand_map("run", "discover", [{"id": "a"}, {"id": "b"}])
    first = repo.claim("run", "discover", "a", {})
    repo.finish(first, "succeeded", {"id": "a"})
    inflight = repo.claim("run", "discover", "b", {})
    store.close()
    store = newsletter_store.Store(path, "mock")
    repo = newsletter_workflow_repository.WorkflowRepository(store)
    assert repo.recover() == 1 and repo.recover() == 0
    assert repo.get("run")["state"] == "unknown"
    assert len(repo.artifacts("run")) == 1
    calls = []

    async def forbidden(context):
        calls.append(context)

    assert (
        await newsletter_workflow_engine.WorkflowEngine(
            repo, {"discovery": forbidden}
        ).step("run")
        is False
    )
    assert not calls
    with pytest.raises(newsletter_workflow_repository.WorkflowError):
        repo.finish(inflight, "succeeded", {"id": "b"})
    store.close()


async def test_cancellation_records_unknown_before_propagating(repo):
    repo.start("run", definition(node()), {})

    async def canceled(context):
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await newsletter_workflow_engine.WorkflowEngine(
            repo, {"discovery": canceled}
        ).run("run")
    assert repo.get("run")["state"] == "unknown"
    assert repo.attempts("run")[0]["error_code"] == "interrupted"


async def test_failures_never_persist_exception_text(repo, capsys):
    sentinel = "SECRET_SENTINEL_DO_NOT_LOG"
    repo.start("failure", definition(node()), {})

    async def bad(context):
        raise ValueError(sentinel)

    assert (
        await newsletter_workflow_engine.WorkflowEngine(
            repo, {"discovery": bad}
        ).run("failure")
    )["state"] == "failed"
    assert sentinel not in json.dumps(repo.get("failure")) + json.dumps(
        repo.attempts("failure")
    )
    assert sentinel not in str(capsys.readouterr())
    repo.start("oversized", definition(node()), {})

    async def oversized(context):
        return "x" * (newsletter_workflow_repository.MAX_ARTIFACT_BYTES + 1)

    assert (
        await newsletter_workflow_engine.WorkflowEngine(
            repo, {"discovery": oversized}
        ).run("oversized")
    )["state"] == "failed"
    assert not repo.artifacts("oversized")


async def test_explicit_skip_differs_from_failure(repo):
    repo.start("run", definition(node()), {})

    async def skip(context):
        return newsletter_workflow_engine.NodeResult.skipped(
            {"candidates": []}, "no_findings"
        )

    result = await newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": skip}
    ).run("run")
    assert (
        result["state"] == "succeeded"
        and result["nodes"]["discover"]["state"] == "skipped"
    )
    assert repo.attempts("run")[0]["state"] == "skipped"


def test_claims_are_serialized_across_engine_instances_and_respect_dependencies(
    repo,
):
    repo.start(
        "run", definition(node("a"), node("b"), node("c", needs=["a"])), {}
    )
    assert repo.claim("run", "c", "", {}) is None
    attempt = repo.claim("run", "a", "", {})
    assert attempt and repo.claim("run", "b", "", {}) is None
    repo.finish(attempt, "succeeded", {})
    assert repo.claim("run", "b", "", {})


def test_unknown_handler_registry_type_rejected(repo):
    with pytest.raises(newsletter_workflow_engine.NodeError):
        newsletter_workflow_engine.WorkflowEngine(
            repo, {"send": lambda _: None}
        )


async def test_invalid_map_does_not_spin_when_another_run_holds_execution_claim(
    repo,
):
    repo.start("active", definition(node()), {})
    assert repo.claim("active", "discover", "", {})
    repo.start(
        "invalid",
        definition(node(map={"from": "run.items", "max_items": 2})),
        {},
    )

    async def forbidden(context):
        pytest.fail("An unclaimed node must not invoke its handler")

    engine = newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": forbidden}
    )
    assert await engine.run_step("invalid") is False
    assert repo.get("invalid")["state"] == "queued"
    assert repo.attempts("invalid") == []


def test_map_aggregate_cannot_bypass_children_or_unmet_dependencies(repo):
    repo.start(
        "run",
        definition(
            node("first"),
            node(
                "mapped",
                needs=["first"],
                map={"from": "run.items", "max_items": 2},
            ),
        ),
        {"items": [{"id": "one"}]},
    )
    with pytest.raises(newsletter_workflow_repository.WorkflowError):
        repo.expand_map("run", "mapped", [{"id": "one"}])
    attempt = repo.claim("run", "first", "", {})
    repo.finish(attempt, "succeeded", {})
    repo.expand_map("run", "mapped", [{"id": "one"}])
    assert repo.claim("run", "mapped", "", {}) is None
    assert repo.claim("run", "mapped", "one", {})


@pytest.mark.parametrize(
    "code", ["authentication", "configuration", "rate_limit"]
)
@pytest.mark.parametrize("mapped", [False, True])
@pytest.mark.parametrize("ambiguous", [False, True])
async def test_shared_prerequisite_failures_cannot_continue(
    repo, code, mapped, ambiguous
):
    options = {"map": {"from": "run.items", "max_items": 2}} if mapped else {}
    repo.start(
        "run",
        definition(
            node("discovery", on_error="continue", **options),
            node("next", "review", needs=["discovery"]),
        ),
        {"items": [{"id": "a"}, {"id": "b"}]},
    )
    calls = []

    async def fail(context):
        calls.append((context.node_id, context.item_id))
        raise newsletter_workflow_engine.NodeError(code, ambiguous=ambiguous)

    engine = newsletter_workflow_engine.WorkflowEngine(
        repo, {"discovery": fail, "review": fail}
    )
    result = await engine.run("run")
    assert result["state"] == ("unknown" if ambiguous else "failed")
    assert calls == [("discovery", "a" if mapped else "")]
    assert result["nodes"]["next"]["state"] == "pending"
    assert len(repo.attempts("run")) == 1
    assert await engine.run_step("run") is False
