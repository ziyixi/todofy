"""Test one bounded repair and independent review without providers."""

import copy
import importlib.resources as resources
import json
import types

import pytest

import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.store as newsletter_store
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as engine
import newsletter.workflow.nodes as newsletter_workflow_nodes
import newsletter.workflow.repository as newsletter_workflow_repository


@pytest.fixture
def prior():
    body = {
        "title": "离线测试材料",
        "body": "虚构 fixture，不是真实新闻。",
        "sources": [
            {
                "id": "source",
                "title": "虚构来源",
                "url": "https://example.com/evidence",
                "excerpt": "fixture",
                "access_scope": "full_text",
                "published_at": "",
            }
        ],
        "tags": ["fixture"],
    }
    return {
        "draft": {
            "subject": "离线修订验收",
            "title": "虚构测试稿",
            "introduction": "",
            "sections": [
                {
                    "kind": "feature",
                    "heading": "主读",
                    "paragraphs": [
                        {
                            "text": "需要修正的虚构数字。",
                            "citations": ["packet/source"],
                        }
                    ],
                    "limitations": "仅测试",
                }
            ],
            "limitations": "仅测试",
        },
        "packets": [
            {
                "id": "packet",
                "workflow_id": "fixture",
                "producer_id": "fixture",
                "content": body,
                "content_hash": contracts.content_hash(body),
                "created_at": "2026-09-06T00:00:00Z",
                "is_fixture": True,
            }
        ],
        "review": {
            "passed": False,
            "findings": ["HOLD：虚构数字未得到原始来源支持，应删去。"],
        },
        "author_review": {"passed": False, "findings": ["作者不能确认数字。"]},
        "coverage": [{"stage": "research", "degraded": True}],
    }


def revision_reply(prior, *, passed=True):
    draft = copy.deepcopy(prior["draft"])
    draft["sections"][0]["paragraphs"][0]["text"] = "删除数字后的虚构测试说明。"
    return {
        "draft": draft,
        "review": {
            "passed": passed,
            "findings": [] if passed else ["HOLD：仍不能确认核心结论。"],
        },
        "supplemental_packets": [],
    }


@pytest.fixture
def rig(tmp_path, monkeypatch, prior):
    store = newsletter_store.Store(tmp_path / "revision.sqlite3", "mock")
    definition = newsletter_workflow_definition.parse_definition(
        {
            "version": 1,
            "id": "held-edition-revision",
            "nodes": [
                {"id": "revision", "type": "revision"},
                {
                    "id": "final_review",
                    "type": "final_review",
                    "needs": ["revision"],
                },
            ],
        }
    )
    newsletter_workflow_nodes.validate_revision_subgraph(definition)
    repository = newsletter_workflow_repository.WorkflowRepository(store)
    state = types.SimpleNamespace(
        store=store,
        definition=definition,
        repository=repository,
        replies=[],
        calls=[],
        prior=prior,
        path=tmp_path,
    )

    async def execute(editor, prompt, schema, instructions, workspace):
        state.calls.append(
            {"prompt": json.loads(prompt), "path": workspace, "schema": schema}
        )
        assert state.replies, (
            "No unexpected model invocation or third revision is permitted"
        )
        value, searched, opened = state.replies.pop(0)
        return json.dumps(value), opened, searched

    monkeypatch.setattr(newsletter_editor.CodexEditor, "execute", execute)
    nodes = newsletter_workflow_nodes.EditorialNodes(
        store,
        definition,
        newsletter_editor.CodexEditor(tmp_path / "unused-auth"),
        tmp_path / "jobs",
    )
    state.nodes = nodes
    state.engine = engine.WorkflowEngine(
        repository, {"revision": nodes, "final_review": nodes}
    )

    def start(value=None):
        repository.start(
            "run",
            definition,
            {
                "issue_date": "2026-09-06",
                "prior_review_result": value or prior,
                "policy": {
                    "editorial.md": "Fixture policy.",
                    "reader-profile.md": "Fixture reader.",
                },
            },
        )

    state.start = start
    yield state
    store.close()


async def test_initial_pass_skips_revision_and_second_review_without_model(
    rig, prior
):
    prior["review"] = {"passed": True, "findings": []}
    prior["author_review"] = {"passed": True, "findings": []}
    rig.start()
    result = await rig.engine.run("run")
    assert result["state"] == "succeeded"
    assert all(node["state"] == "skipped" for node in result["nodes"].values())
    assert not rig.calls and not rig.replies
    final = rig.repository.output("run", "final_review")
    assert (
        final["draft"] == prior["draft"] and final["review"] == prior["review"]
    )
    assert final["revision"]["performed"] is False


async def test_failed_review_gets_one_revision_and_independent_review(
    rig, prior
):
    repair = revision_reply(prior)
    rig.replies = [
        (repair, True, {"https://example.com/evidence"}),
        (
            {"passed": True, "findings": []},
            True,
            {"https://example.com/evidence"},
        ),
    ]
    rig.start()
    assert (await rig.engine.run("run"))["state"] == "succeeded"
    final = rig.repository.output("run", "final_review")
    assert (
        final["review"]["passed"] is True
        and final["revision"]["performed"] is True
    )
    assert len(rig.calls) == 2 and rig.calls[0]["path"] != rig.calls[1]["path"]
    assert (
        rig.calls[0]["prompt"]["review_findings_untrusted"] == prior["review"]
    )
    assert (
        rig.calls[0]["prompt"]["prior_author_review_untrusted"]
        == prior["author_review"]
    )
    assert rig.calls[1]["prompt"]["draft_untrusted"] == repair["draft"]
    assert final["packets"] == prior["packets"]
    assert (
        rig.repository.snapshot("run")["inputs"]["prior_review_result"] == prior
    )
    assert await rig.engine.step("run") is False and len(rig.calls) == 2


@pytest.mark.parametrize(
    "author_passed,review_passed,searched,opened",
    [
        (False, True, True, {"https://example.com/evidence"}),
        (True, False, True, {"https://example.com/evidence"}),
        (True, True, False, {"https://example.com/evidence"}),
        (True, True, True, set()),
    ],
)
async def test_second_hold_or_missing_evidence_never_starts_a_third_attempt(
    rig, prior, author_passed, review_passed, searched, opened
):
    rig.replies = [
        (
            revision_reply(prior, passed=author_passed),
            True,
            {"https://example.com/evidence"},
        ),
        (
            {
                "passed": review_passed,
                "findings": [] if review_passed else ["HOLD：仍有错误。"],
            },
            searched,
            opened,
        ),
    ]
    rig.start()
    await rig.engine.run("run")
    assert (
        rig.repository.output("run", "final_review")["review"]["passed"]
        is False
    )
    assert len(rig.calls) == 2 and await rig.engine.step("run") is False


async def test_actual_repair_even_identical_text_requires_independent_review(
    rig, prior
):
    repair = revision_reply(prior)
    repair["draft"] = copy.deepcopy(prior["draft"])
    rig.replies = [
        (repair, True, {"https://example.com/evidence"}),
        (
            {"passed": False, "findings": ["HOLD：未完成修正。"]},
            True,
            {"https://example.com/evidence"},
        ),
    ]
    rig.start()
    await rig.engine.run("run")
    assert len(rig.calls) == 2
    assert (
        rig.repository.output("run", "final_review")["review"]["passed"]
        is False
    )


async def test_revision_cannot_add_new_material(rig, prior):
    repair = revision_reply(prior)
    repair["supplemental_packets"] = [
        {"id": "supplement-1", "content": prior["packets"][0]["content"]}
    ]
    rig.replies = [(repair, True, {"https://example.com/evidence"})]
    rig.start()
    result = await rig.engine.run("run")
    assert (
        result["state"] == "failed"
        and result["nodes"]["final_review"]["state"] == "pending"
    )
    assert len(rig.calls) == 1


async def test_model_cannot_inject_skip_metadata(rig, prior):
    repair = revision_reply(prior)
    repair["revision"] = {"performed": False, "initial_review_passed": True}
    rig.replies = [(repair, True, {"https://example.com/evidence"})]
    rig.start()
    assert (await rig.engine.run("run"))["state"] == "failed"
    assert len(rig.calls) == 1


async def test_forged_skip_requires_actual_skipped_dependency_and_original_hash(
    rig, prior
):
    prior["review"] = {"passed": True, "findings": []}
    result = {
        **prior,
        "revision": {
            "performed": False,
            "initial_review_passed": True,
            "source_hash": rig.nodes.result_hash(prior),
        },
    }
    ctx = engine.NodeContext(
        "run",
        "final_review",
        "",
        {},
        {"revision": result},
        {"issue_date": "2026-09-06"},
        {"revision": {"state": "succeeded"}},
    )
    with pytest.raises(engine.NodeError):
        await rig.nodes.execute("final_review", ctx, rig.path)
    ctx.dependency_states["revision"]["state"] = "skipped"
    result["draft"] = {
        **prior["draft"],
        "title": "Changed after initial review",
    }
    with pytest.raises(engine.NodeError):
        await rig.nodes.execute("final_review", ctx, rig.path)
    assert not rig.calls


async def test_complete_recipe_never_uses_recovery_input_not_review_dependency(
    rig, prior
):
    definition = newsletter_workflow_definition.load_definition(
        resources.files("newsletter")
        .joinpath("workflows/legacy-daily.yaml")
        .read_bytes()
    )
    nodes = newsletter_workflow_nodes.EditorialNodes(
        rig.store,
        definition,
        newsletter_editor.CodexEditor(rig.path / "unused-auth"),
        rig.path,
    )
    alternate = copy.deepcopy(prior)
    alternate["review"] = {"passed": True, "findings": []}
    ctx = engine.NodeContext(
        "run",
        "revision",
        "",
        {},
        {},
        {
            "issue_date": "2026-09-06",
            "prior_review_result": alternate,
            "policy": {
                "editorial.md": "Fixture policy.",
                "reader-profile.md": "Fixture reader.",
            },
        },
    )
    with pytest.raises(engine.NodeError):
        await nodes.execute("revision", ctx, rig.path)
    assert not rig.calls
    ctx.inputs["review"] = prior
    rig.replies = [
        (revision_reply(prior), True, {"https://example.com/evidence"})
    ]
    result = await nodes.execute("revision", ctx, rig.path)
    assert result["revision"]["performed"] is True
    assert (
        rig.calls[0]["prompt"]["review_findings_untrusted"] == prior["review"]
    )
