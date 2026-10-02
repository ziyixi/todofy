"""Test the frozen legacy DAG and durable tail with synthetic node outputs.

No live preflight, SDK execution, provider HTTP or mail adapter is used.
Only content handlers are replaced. Scheduling, artifacts, packets,
projection dispatch, binding, rendering, usage and send guards stay real.
"""

import asyncio
import collections
import copy
import datetime
import importlib.resources as resources
import json
import pathlib
import types

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.collection.collector as collector
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.settings as settings
import newsletter.store as newsletter_store
import newsletter.usage as newsletter_usage
import newsletter.worker as worker
import newsletter.workflow.nodes as newsletter_workflow_nodes
import newsletter.workflow.pipeline as pipeline
import newsletter.workflow.state as state

ISSUE_DATE = "2026-09-06"
DISCOVERY_COUNT = 8
# Eight discovery calls; the existing eight downstream model calls are
# unchanged.
BASE_MODEL_INVOCATIONS = DISCOVERY_COUNT + 8
LEGACY_RECIPE = pathlib.Path(
    str(resources.files("newsletter").joinpath("workflows/legacy-daily.yaml"))
)
MODEL_KINDS = {
    "discovery",
    "selection",
    "research",
    "composition",
    "gap_plan",
    "finalization",
    "review",
}


def candidate(direction):
    return {
        "id": direction,
        "direction": direction,
        "title": "Synthetic candidate " + direction,
        "url": "https://example.org/" + direction,
        "doi": "",
        "version": "",
        "event_key": "",
        "published_at": ISSUE_DATE,
        "summary": "离线构造的候选，不是真实研究。",
        "why_now": "仅检验八方向发现、选题和深读之间的数据流。",
        "access_scope": "metadata",
        "provenance": "fixture-handler",
    }


def task(identifier, source=None):
    return {
        "id": identifier,
        "candidate_ids": [source["id"]] if source else [],
        "question": "检验固定材料中的证据边界。",
        "why": "这是离线集成测试，不生成真实报道。",
        "priority": 1,
        "evidence_context": (
            "补查任务可以没有候选 ID，但必须携带明确的证据问题。"
        ),
        "source_urls": [source["url"]]
        if source
        else ["https://example.org/gap"],
    }


def draft(packets):
    adopted = [p for p in packets if "unused" not in p["content"]["tags"]]
    return {
        "subject": "MOCK · DAG 集成验收",
        "title": "只用于离线测试的报纸",
        "introduction": "这些段落不是新闻，不能作为事实证据。",
        "sections": [
            {
                "kind": "feature",
                "heading": "固定研究与补查",
                "paragraphs": [
                    {
                        "text": "这是一个构造的研究结果，只检验引用是否完整。",
                        "citations": [p["id"] + "/source"],
                    }
                    for p in adopted
                ],
                "limitations": "无真实研究结论。",
            }
        ],
        "recommended_reading": {
            "citation": adopted[0]["id"] + "/source",
            "reason": (
                "问题、方法、结果和限制均为测试构造；"
                "这里检验自足介绍卡及出处渲染。"
            ),
        },
        "limitations": "本稿全部为 fixture。",
    }


def record_synthetic_usage():
    # Exercise the real ContextVar sink and cumulative-snapshot replacement.
    with newsletter_usage.codex_usage("synthetic-no-model") as usage:
        usage.start_turn()
        for count in (80, 100, 100):
            newsletter_usage.observe_codex_usage(
                "thread/tokenUsage/updated",
                {
                    "tokenUsage": {
                        "total": {
                            "inputTokens": count,
                            "cachedInputTokens": 40,
                            "outputTokens": 20,
                            "reasoningOutputTokens": 5,
                            "totalTokens": count + 20,
                        }
                    }
                },
            )
        newsletter_usage.observe_codex_usage("turn/completed", {})


class FakeNotion:
    def __init__(self):
        self.calls = []
        self.failed_tags = set()
        self.ambiguous = False

    async def project(self, packet):
        assert packet["is_fixture"] is True
        self.calls.append(packet["id"])
        if self.failed_tags.intersection(packet["content"]["tags"]):
            raise adapters.AdapterError(
                "NOTION_FIXTURE_FAILURE", ambiguous=self.ambiguous
            )


def attach(rig):
    rig.runs = repository.RunRepository(rig.store)
    rig.pipeline = pipeline.DagPipeline(
        rig.runs,
        collector.MockCollector(),
        rig.path / "collection",
        10,
        32,
        editor=newsletter_editor.CodexEditor(
            rig.path / "nonexistent-auth-home"
        ),
        recipe_path=LEGACY_RECIPE,
    )
    rig.worker = worker.Worker(
        rig.store,
        newsletter_editor.MockEditor(),
        rig.notion,
        rig.path / "editor",
        10,
        pipeline=rig.pipeline,
    )


@pytest.fixture
def rig(tmp_path, monkeypatch, request):
    rig = types.SimpleNamespace(
        path=tmp_path,
        store=newsletter_store.Store(tmp_path / "state.sqlite3", "mock"),
        notion=FakeNotion(),
        calls=collections.Counter(),
        forbidden_calls=[],
        review_passed=True,
        revision_passed=True,
        final_review_passed=True,
        tail_model_calls=[],
    )

    async def forbidden(*args, **kwargs):
        rig.forbidden_calls.append("model-or-legacy-collector")
        raise AssertionError(
            "The frozen DAG must never run an SDK or a second editor"
        )

    async def synthetic_tail(editor, prompt, schema, policy, path):
        # Only the new tail may reach this explicit SDK boundary substitute.
        # Its real handlers still enforce skip/provenance/author-HOLD rules.
        value = json.loads(prompt)
        assert path.is_dir() and policy
        if "prior_draft_untrusted" in value:
            kind = "revision"
            packets = value["research_packets_untrusted"]
            revised = copy.deepcopy(value["prior_draft_untrusted"])
            revised["title"] += " · synthetic revision"
            output = {
                "draft": revised,
                "review": {
                    "passed": rig.revision_passed,
                    "findings": []
                    if rig.revision_passed
                    else ["HOLD: author still uncertain"],
                },
                "supplemental_packets": [],
            }
        elif "prior_review_findings_untrusted" in value:
            kind = "final_review"
            packets = value["packets_untrusted"]
            output = {
                "passed": rig.final_review_passed,
                "findings": []
                if rig.final_review_passed
                else ["HOLD: final synthetic finding"],
            }
        else:
            return await forbidden()
        assert all(packet["is_fixture"] for packet in packets)
        assert value["issue_date"] == ISSUE_DATE
        rig.tail_model_calls.append((kind, value))
        record_synthetic_usage()
        opened = {
            source["url"] for p in packets for source in p["content"]["sources"]
        }
        return json.dumps(output, ensure_ascii=False), opened, True

    monkeypatch.setattr(
        newsletter_editor.CodexEditor, "execute", synthetic_tail
    )
    monkeypatch.setattr(newsletter_editor.CodexEditor, "prepare", forbidden)
    monkeypatch.setattr(newsletter_editor.MockEditor, "prepare", forbidden)
    monkeypatch.setattr(collector.MockCollector, "collect", forbidden)

    real_execute = newsletter_workflow_nodes.EditorialNodes.execute

    async def execute(nodes, kind, ctx, path):
        rig.calls[(ctx.node_id, ctx.item_id)] += 1
        assert path.is_dir()
        if kind in {"revision", "final_review"}:
            return await real_execute(nodes, kind, ctx, path)
        if kind in MODEL_KINDS:
            record_synthetic_usage()
        if kind == "history":
            return {"candidates": [], "editions": [], "watchlist": []}
        if kind == "api_feed":
            return {
                "candidates": [],
                "diagnostics": ["offline fixture: no HTTP"],
            }
        if kind == "discovery":
            return {
                "candidates": [candidate(ctx.item["id"])],
                "note": "fixture",
            }
        if kind == "deduplicate":
            candidates = [
                c
                for batch in nodes.one(ctx, "discovery")
                for c in batch["candidates"]
            ]
            nodes.state.remember(candidates, ISSUE_DATE)
            return {"candidates": candidates}
        if kind == "selection":
            candidates = nodes.one(ctx, "deduplicate")["candidates"]
            return {
                "research_tasks": [
                    task("adopted", candidates[0]),
                    task("unused", candidates[1]),
                ],
                "note": "只选两项，不凑满默认八项。",
            }
        if kind == "research":
            supplied = ctx.item
            packet = nodes.store.put_packet(
                {
                    "request_key": (
                        f"{ctx.run_id}:{ctx.node_id}:{supplied['id']}"
                    ),
                    "workflow_id": ctx.node_id,
                    "content": {
                        "title": "Synthetic " + supplied["id"],
                        "body": "仅用于离线流程验收。",
                        "sources": [
                            {
                                "id": "source",
                                "title": "Synthetic source",
                                "url": supplied["source_urls"][0],
                                "excerpt": "",
                                "access_scope": "full_text",
                                "published_at": ISSUE_DATE,
                            }
                        ],
                        "tags": ["fixture", supplied["id"]],
                    },
                },
                principal="workflow-research",
            )
            return {
                "packets": [packet],
                "note": "fixture",
                "candidate_ids": supplied["candidate_ids"],
            }
        if kind in {"composition", "finalization"}:
            packets = nodes.packets(ctx)
            return {
                "draft": draft(packets),
                "packets": packets,
                "review": {"passed": True, "findings": []},
            }
        if kind == "gap_plan":
            return {
                "research_tasks": [task("gap")],
                "note": "只执行一轮有界补查。",
            }
        if kind == "review":
            result = copy.deepcopy(nodes.one(ctx, "finalization"))
            result["review"] = {
                "passed": rig.review_passed,
                "findings": []
                if rig.review_passed
                else ["HOLD: synthetic unresolved evidence"],
            }
            return result
        raise AssertionError("Unexpected registered node type")

    monkeypatch.setattr(
        newsletter_workflow_nodes.EditorialNodes, "execute", execute
    )
    attach(rig)
    instructions, snapshot = pipeline.freeze_workflow(
        settings.Settings(data_dir=tmp_path, workflow_file=LEGACY_RECIPE),
        rig.pipeline.state,
        ISSUE_DATE,
    )
    assert len(instructions) == DISCOVERY_COUNT
    rig.current_recipe = rig.pipeline.recipe_path
    if getattr(request, "param", None) == "legacy":
        snapshot["definition"]["nodes"] = [
            node
            for node in snapshot["definition"]["nodes"]
            if node["type"] not in {"revision", "final_review"}
        ]
        rig.pipeline.recipe_path = tmp_path / "legacy.yaml"
        # JSON is valid YAML. No SQL mutations or nonpublic snapshot rewrites.
        rig.pipeline.recipe_path.write_text(
            json.dumps(snapshot["definition"]), encoding="utf-8"
        )
    rig.instructions = instructions
    rig.snapshot = snapshot
    rig.run = rig.runs.start(
        {"request_key": "synthetic-daily", "issue_date": ISSUE_DATE},
        instructions,
        workflow_snapshot=snapshot,
    )
    try:
        yield rig
    finally:
        rig.store.close()


def receipt(rig):
    value = rig.pipeline.receipt(rig.run["id"])
    # Exact public API conversion, including uint64 usage counts and optional
    # data.
    message = contracts.parse_message(value, editorial_pb2.CollectionRun)
    assert (
        contracts.parse_message(
            contracts.to_dict(message), editorial_pb2.CollectionRun
        )
        == message
    )
    assert message.id == rig.run["id"]
    assert message.is_fixture
    return value


async def drain(rig):
    for _ in range(100):
        receipt(rig)
        if not await rig.worker.step():
            assert not rig.forbidden_calls
            return receipt(rig)
    pytest.fail("Offline DAG did not reach a bounded terminal state")


def approval(edition):
    return {
        "id": edition["id"],
        "request_key": "synthetic-approval",
        "expected_render_hash": edition.get("rendered", {}).get(
            "render_hash", "not-rendered"
        ),
    }


def assert_no_mail(rig):
    assert rig.store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 0
    assert not list(rig.path.rglob("*.eml"))
    assert not rig.forbidden_calls


def expire_budget(rig, monkeypatch):
    frozen = rig.snapshot["inputs"]
    deadline = datetime.datetime.fromisoformat(
        frozen["started_at"]
    ) + datetime.timedelta(seconds=frozen["timeout_seconds"] + 1)

    class PastDeadline(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return deadline.astimezone(tz or datetime.UTC)

    monkeypatch.setattr(datetime, "datetime", PastDeadline)


async def legacy_hold(rig):
    rig.review_passed = False
    held = await drain(rig)
    assert (
        held["state"] == "blocked"
        and held["error_code"] == "editorial_review_failed"
    )
    assert held["usage"]["invocations"] == BASE_MODEL_INVOCATIONS
    assert rig.pipeline.state.repair(rig.run["id"]) is None
    assert not rig.tail_model_calls
    return held


@pytest.mark.asyncio
async def test_default_dag_persists_ready_edition_usage_and_receipt(
    rig,
):
    assert receipt(rig)["state"] == "queued"
    finished = await drain(rig)
    assert finished["state"] == "ready", finished
    assert finished["workflow"]["state"] == "succeeded"
    assert finished["workflow"]["candidate_count"] == DISCOVERY_COUNT
    assert finished["workflow"]["research_count"] == 3
    states = {
        node["id"]: node["state"] for node in finished["workflow"]["nodes"]
    }
    assert states["revision"] == states["final_review"] == "skipped"
    assert not rig.tail_model_calls
    assert all(count == 1 for count in rig.calls.values())
    edition = rig.store.get(finished["edition_id"])
    bound = state.WorkflowState(rig.store).edition(edition["id"])
    packets = rig.pipeline.repository.output(rig.run["id"], "review")["packets"]
    contracts.validate_draft(edition["draft"], packets)
    assert (
        len(edition["packet_ids"]) == 3 and len(bound["required_packets"]) == 2
    )
    assert (
        edition["state"] == "ready"
        and edition["delivery_state"] == "not_requested"
    )
    assert edition["review"]["passed"] and edition["is_fixture"]
    assert (
        "补查任务" not in edition["rendered"]["text"]
    )  # No internal task prompts rendered.
    assert "https://example.org/gap" in edition["rendered"]["text"]
    assert "MOCK · 用量统计仅为流程演示" in edition["rendered"]["html"]
    assert "MOCK · 用量统计仅为流程演示" in edition["rendered"]["text"]
    # 8 discovery + selection + 3 research + composition + gap + final + review.
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS
    assert (
        finished["usage"]["usage"]["total_tokens"]
        == BASE_MODEL_INVOCATIONS * 120
    )
    assert not finished["usage"]["partial"]
    assert (
        int(edition["usage"]["usage"]["total_tokens"])
        == BASE_MODEL_INVOCATIONS * 120
    )
    assert (
        len(rig.notion.calls) == 4
    )  # Three research packets plus optional candidate index.
    assert_no_mail(rig)

    with pytest.raises(newsletter_store.StoreError):
        rig.store.reserve_send(
            {**approval(edition), "expected_render_hash": "wrong"}
        )
    adopted = bound["required_packets"][0]
    rig.store.projection_result(adopted, "pending")
    with pytest.raises(newsletter_store.StoreError):
        rig.store.reserve_send(approval(edition))
    assert_no_mail(rig)
    rig.store.projection_result(adopted, "done")
    assert rig.store.reserve_send(approval(edition))[1] is True
    assert rig.store.reserve_send(approval(edition))[1] is False
    rig.store.recover()
    assert rig.store.reserve_send(approval(edition))[1] is False
    assert rig.store.get(edition["id"])["delivery_state"] == "unknown"
    assert not list(
        rig.path.rglob("*.eml")
    )  # Reservations are not adapter calls.


@pytest.mark.asyncio
async def test_restart_preserves_completed_research_without_repeating(
    rig,
):
    for _ in range(40):
        assert await rig.worker.step()
        if ("research", "adopted") in rig.calls:
            break
    else:
        pytest.fail("First selected research item was never executed")
    before_calls = rig.calls.copy()
    before_artifacts = rig.pipeline.repository.artifacts(rig.run["id"])
    before_attempts = rig.pipeline.repository.attempts(rig.run["id"])
    frozen = rig.runs.workflow_snapshot(rig.run["id"])
    rig.store.close()
    rig.store = newsletter_store.Store(rig.path / "state.sqlite3", "mock")
    attach(rig)
    rig.store.recover()
    rig.runs.recover()
    rig.pipeline.recover()
    assert rig.runs.workflow_snapshot(rig.run["id"]) == frozen == rig.snapshot
    assert rig.pipeline.repository.artifacts(rig.run["id"]) == before_artifacts
    assert (await drain(rig))["state"] == "ready"
    assert all(
        rig.calls[key] == count == 1 for key, count in before_calls.items()
    )
    attempts = rig.pipeline.repository.attempts(rig.run["id"])
    assert all(attempt in attempts for attempt in before_attempts)
    assert all(count == 1 for count in rig.calls.values())
    assert len(rig.notion.calls) == len(set(rig.notion.calls)) == 4
    assert receipt(rig)["usage"]["invocations"] == BASE_MODEL_INVOCATIONS
    assert_no_mail(rig)


@pytest.mark.asyncio
async def test_independent_review_hold_blocks_worker_render_and_send(rig):
    rig.review_passed = False
    rig.final_review_passed = False
    finished = await drain(rig)
    assert finished["state"] == "blocked", finished
    assert finished["error_code"] == "editorial_review_failed"
    edition = rig.store.get(finished["edition_id"])
    assert edition["state"] == "blocked" and not edition["review"]["passed"]
    assert not edition.get("rendered")
    assert [kind for kind, _ in rig.tail_model_calls] == [
        "revision",
        "final_review",
    ]
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS + 2
    assert (
        finished["usage"]["usage"]["total_tokens"]
        == (BASE_MODEL_INVOCATIONS + 2) * 120
    )
    assert rig.pipeline.state.repair(rig.run["id"]) is None
    assert await rig.worker.step() is False
    with pytest.raises(newsletter_store.StoreError):
        rig.store.reserve_send(approval(edition))
    assert_no_mail(rig)


@pytest.mark.asyncio
async def test_initial_hold_revises_once_then_gets_independent_review(
    rig,
):
    rig.review_passed = False
    finished = await drain(rig)
    assert finished["state"] == "ready", finished
    edition = rig.store.get(finished["edition_id"])
    original = rig.pipeline.repository.output(rig.run["id"], "review")
    revised = rig.pipeline.repository.output(rig.run["id"], "revision")
    final = rig.pipeline.repository.output(rig.run["id"], "final_review")
    assert not original["review"]["passed"]
    assert revised["prior_review"] == original["review"]
    assert revised["revision"]["performed"] is True
    assert final["review"]["passed"] and edition["review"]["passed"]
    assert edition["draft"]["title"].endswith("synthetic revision")
    assert [kind for kind, _ in rig.tail_model_calls] == [
        "revision",
        "final_review",
    ]
    assert rig.tail_model_calls[1][1]["draft_untrusted"] == revised["draft"]
    assert (
        rig.tail_model_calls[1][1]["prior_review_findings_untrusted"]
        == original["review"]
    )
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS + 2
    assert (
        int(edition["usage"]["usage"]["total_tokens"])
        == (BASE_MODEL_INVOCATIONS + 2) * 120
    )
    assert len(rig.notion.calls) == 4
    assert rig.pipeline.state.repair(rig.run["id"]) is None
    assert await rig.worker.step() is False
    assert_no_mail(rig)


@pytest.mark.asyncio
async def test_passing_final_review_cannot_overrule_author_hold(
    rig,
):
    rig.review_passed = rig.revision_passed = False
    finished = await drain(rig)
    assert (
        finished["state"] == "blocked"
        and finished["error_code"] == "editorial_review_failed"
    )
    edition = rig.store.get(finished["edition_id"])
    assert not edition["review"]["passed"]
    assert any(
        "定稿总编仍报告" in finding for finding in edition["review"]["findings"]
    )
    assert [kind for kind, _ in rig.tail_model_calls] == [
        "revision",
        "final_review",
    ]
    assert not edition.get("rendered")
    assert await rig.worker.step() is False
    with pytest.raises(newsletter_store.StoreError):
        rig.store.reserve_send(approval(edition))
    assert_no_mail(rig)


@pytest.mark.asyncio
@pytest.mark.parametrize("rig", ["legacy"], indirect=True)
async def test_legacy_upgrade_preserves_source_and_combines_child_usage(
    rig,
):
    held = await legacy_hold(rig)
    original_edition = rig.store.get(held["edition_id"])
    original_artifacts = rig.pipeline.repository.artifacts(rig.run["id"])
    original_graph = rig.pipeline.repository.snapshot(rig.run["id"])
    original_calls = rig.calls.copy()
    original_projections = list(rig.notion.calls)
    rig.pipeline.recipe_path = rig.current_recipe
    assert rig.pipeline.advance() is True
    repair = rig.pipeline.state.repair(rig.run["id"])
    child = repair["child_run_id"]
    assert child == rig.run["id"] + ":repair-1"
    assert repair["source_edition_id"] == held["edition_id"]
    frozen = repair["snapshot"]["inputs"]
    assert all(
        frozen[key] == value for key, value in rig.snapshot["inputs"].items()
    )
    assert frozen["prior_review_result"] == rig.pipeline.repository.output(
        rig.run["id"], "review"
    )
    # A collecting repair must not be put back in HOLD by its original edition.
    assert rig.pipeline.advance() is False
    assert rig.runs.get(rig.run["id"])["state"] == "collecting"
    assert len(receipt(rig)["workflow"]["continuations"]) == 1

    # Reopen all repositories at the durable parent/child handoff boundary.
    rig.store.close()
    rig.store = newsletter_store.Store(rig.path / "state.sqlite3", "mock")
    attach(rig)
    rig.store.recover()
    rig.runs.recover()
    rig.pipeline.recover()
    finished = await drain(rig)
    assert finished["state"] == "ready", finished
    assert finished["id"] == held["id"] and finished["issue_date"] == ISSUE_DATE
    assert finished["edition_id"] != held["edition_id"]
    assert (
        rig.runs.start(
            {"request_key": "synthetic-daily", "issue_date": ISSUE_DATE},
            rig.instructions,
            workflow_snapshot=rig.snapshot,
        )["id"]
        == held["id"]
    )
    assert rig.runs.workflow_snapshot(rig.run["id"]) == rig.snapshot
    assert rig.pipeline.repository.snapshot(rig.run["id"]) == original_graph
    assert (
        rig.pipeline.repository.artifacts(rig.run["id"]) == original_artifacts
    )
    assert rig.store.get(held["edition_id"]) == original_edition
    assert all(rig.calls[key] == count for key, count in original_calls.items())
    assert rig.notion.calls == original_projections
    assert [kind for kind, _ in rig.tail_model_calls] == [
        "revision",
        "final_review",
    ]
    edition = rig.store.get(finished["edition_id"])
    assert edition["issue_date"] == original_edition["issue_date"]
    assert edition["packet_ids"] == original_edition["packet_ids"]
    assert rig.pipeline.state.edition(edition["id"])["run_id"] == child
    assert finished["usage"] == rig.pipeline.state.usage(child)
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS + 2
    assert (
        int(edition["usage"]["usage"]["total_tokens"])
        == (BASE_MODEL_INVOCATIONS + 2) * 120
    )
    continuation = finished["workflow"]["continuations"][0]
    assert continuation["state"] == "succeeded"
    assert [node["type"] for node in continuation["nodes"]] == [
        "revision",
        "final_review",
    ]
    assert_no_mail(rig)
    with pytest.raises(newsletter_store.StoreError):
        rig.store.reserve_send(approval(original_edition))
    assert rig.store.reserve_send(approval(edition))[1] is True
    assert rig.store.reserve_send(approval(edition))[1] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("rig", ["legacy"], indirect=True)
async def test_legacy_final_hold_is_terminal_without_a_third_round(
    rig,
):
    held = await legacy_hold(rig)
    rig.final_review_passed = False
    rig.pipeline.recipe_path = rig.current_recipe
    finished = await drain(rig)
    assert (
        finished["state"] == "blocked"
        and finished["error_code"] == "editorial_review_failed"
    )
    assert finished["edition_id"] != held["edition_id"]
    assert finished["workflow"]["continuations"][0]["state"] == "succeeded"
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS + 2
    assert [kind for kind, _ in rig.tail_model_calls] == [
        "revision",
        "final_review",
    ]
    assert await rig.worker.step() is False
    for identifier in (held["edition_id"], finished["edition_id"]):
        edition = rig.store.get(identifier)
        assert not edition.get("rendered")
        with pytest.raises(newsletter_store.StoreError):
            rig.store.reserve_send(approval(edition))
    assert_no_mail(rig)


@pytest.mark.asyncio
@pytest.mark.parametrize("rig", ["legacy"], indirect=True)
async def test_expired_legacy_hold_does_not_start_a_new_repair(
    rig, monkeypatch
):
    await legacy_hold(rig)
    rig.pipeline.recipe_path = rig.current_recipe
    expire_budget(rig, monkeypatch)
    assert await rig.worker.step() is False
    assert rig.pipeline.state.repair(rig.run["id"]) is None
    assert not rig.tail_model_calls
    assert_no_mail(rig)


@pytest.mark.asyncio
@pytest.mark.parametrize("rig", ["legacy"], indirect=True)
async def test_completed_repair_recovers_after_deadline_without_models(
    rig, monkeypatch
):
    await legacy_hold(rig)
    rig.pipeline.recipe_path = rig.current_recipe

    def interrupted_tail(*args, **kwargs):
        raise newsletter_store.StoreError(
            "busy", "Synthetic interruption before edition receipt"
        )

    monkeypatch.setattr(rig.pipeline, "queue_edition", interrupted_tail)
    for _ in range(20):
        assert await rig.worker.step()
        repair = rig.pipeline.state.repair(rig.run["id"])
        if (
            repair
            and rig.pipeline.repository.get(repair["child_run_id"])["state"]
            == "succeeded"
        ):
            break
    else:
        pytest.fail("Repair did not complete before the interrupted local tail")
    assert rig.runs.get(rig.run["id"])["state"] == "collecting"
    calls = list(rig.tail_model_calls)
    projections = list(rig.notion.calls)
    expire_budget(rig, monkeypatch)
    rig.store.close()
    rig.store = newsletter_store.Store(rig.path / "state.sqlite3", "mock")
    attach(rig)
    rig.store.recover()
    rig.runs.recover()
    rig.pipeline.recover()
    finished = await drain(rig)
    assert finished["state"] == "ready", finished
    assert rig.tail_model_calls == calls and rig.notion.calls == projections
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS + 2
    assert_no_mail(rig)


@pytest.mark.asyncio
@pytest.mark.parametrize("rig", ["legacy"], indirect=True)
async def test_repair_receipt_recovers_after_deadline_without_models(
    rig, monkeypatch
):
    held = await legacy_hold(rig)
    rig.pipeline.recipe_path = rig.current_recipe

    def crash_before_child_start(*args, **kwargs):
        raise KeyboardInterrupt("Synthetic crash after durable repair record")

    with monkeypatch.context() as crash:
        crash.setattr(
            rig.pipeline.repository, "start", crash_before_child_start
        )
        with pytest.raises(KeyboardInterrupt):
            rig.pipeline.advance()
    repair = rig.pipeline.state.repair(rig.run["id"])
    assert repair is not None
    expire_budget(rig, monkeypatch)
    finished = await drain(rig)
    assert (
        finished["state"] == "blocked"
        and finished["error_code"] == "workflow_deadline"
    )
    assert finished["edition_id"] == held["edition_id"]
    assert rig.pipeline.state.repair(rig.run["id"]) == repair
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS
    assert not rig.tail_model_calls
    assert_no_mail(rig)


@pytest.mark.asyncio
@pytest.mark.parametrize("rig", ["legacy"], indirect=True)
@pytest.mark.parametrize("failure", ["invalid_output", "interrupted"])
async def test_terminal_repair_retains_failure_before_deadline_check(
    rig, monkeypatch, failure
):
    await legacy_hold(rig)
    rig.pipeline.recipe_path = rig.current_recipe
    assert rig.pipeline.advance()
    attempted = []

    async def failed_model(*args, **kwargs):
        attempted.append(failure)
        record_synthetic_usage()
        if failure == "interrupted":
            raise asyncio.CancelledError
        raise errors.EditorError("invalid_output")

    original_finish = rig.pipeline.finish_graph

    def crash_after_failed_artifact(run, definition, execution_id, status):
        if status["state"] == "failed":
            raise KeyboardInterrupt(
                "Synthetic crash before parent failure receipt"
            )
        return original_finish(run, definition, execution_id, status)

    monkeypatch.setattr(newsletter_editor.CodexEditor, "execute", failed_model)
    monkeypatch.setattr(
        rig.pipeline, "finish_graph", crash_after_failed_artifact
    )
    with pytest.raises(
        asyncio.CancelledError
        if failure == "interrupted"
        else KeyboardInterrupt
    ):
        await rig.worker.step()
    assert attempted == [failure]
    expire_budget(rig, monkeypatch)
    rig.store.close()
    rig.store = newsletter_store.Store(rig.path / "state.sqlite3", "mock")
    attach(rig)
    rig.store.recover()
    rig.runs.recover()
    rig.pipeline.recover()
    finished = await drain(rig)
    assert finished["state"] == "blocked"
    assert finished["error_code"] == "workflow_" + failure
    assert attempted == [
        failure
    ]  # Neither failure nor uncertain cancellation is retried.
    assert finished["usage"]["invocations"] == BASE_MODEL_INVOCATIONS + 1
    assert_no_mail(rig)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["write", "projection"])
async def test_optional_projection_failures_allow_adopted_packets(
    rig, monkeypatch, failure
):
    rig.notion.failed_tags.add("unused")
    if failure == "write":
        put_packet = newsletter_store.Store.put_packet

        def fail_only_archive(store, request, principal="ingest"):
            if request["workflow_id"] == "candidate-index":
                raise OSError("synthetic optional archive failure")
            return put_packet(store, request, principal)

        monkeypatch.setattr(
            newsletter_store.Store, "put_packet", fail_only_archive
        )
    else:
        rig.notion.failed_tags.add("candidate-index")
    finished = await drain(rig)
    assert finished["state"] == "ready", finished
    edition = rig.store.get(finished["edition_id"])
    binding = rig.pipeline.state.edition(edition["id"])
    assert rig.runs.projection_states(binding["required_packets"]) == [
        "done",
        "done",
    ]
    unused = set(edition["packet_ids"]) - set(binding["required_packets"])
    assert rig.runs.projection_states(list(unused)) == ["failed"]
    archive = rig.store.db.execute(
        "SELECT * FROM workflow_archives WHERE run_id=?", (rig.run["id"],)
    ).fetchone()
    if failure == "write":
        assert archive["error_code"] == "candidate_archive_failed"
    else:
        assert rig.runs.projection_states([archive["packet_id"]]) == ["failed"]
    assert_no_mail(rig)
    assert rig.store.reserve_send(approval(edition))[1] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("ambiguous", [False, True])
async def test_adopted_projection_failure_blocks_without_retry(rig, ambiguous):
    rig.notion.failed_tags.add("adopted")
    rig.notion.ambiguous = ambiguous
    finished = await drain(rig)
    assert finished["state"] == "blocked", finished
    assert finished["error_code"] == "notion_projection_unconfirmed"
    edition = rig.store.get(finished["edition_id"])
    assert (
        edition["state"] == "ready"
    )  # Rendering success alone does not authorize sending.
    with pytest.raises(newsletter_store.StoreError):
        rig.store.reserve_send(approval(edition))
    calls = list(rig.notion.calls)
    rig.store.recover()
    rig.runs.recover()
    rig.pipeline.recover()
    assert await rig.worker.step() is False
    assert rig.notion.calls == calls
    assert len(calls) == len(set(calls)) == 4
    assert_no_mail(rig)
