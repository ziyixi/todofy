"""Offline tests only: never start a real app-server or inspect auth files."""

import asyncio
import copy
import dataclasses
import json
import re

import model_router_client as models
import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.instructions as instructions
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as newsletter_errors
import newsletter.model_schema as model_schema
import newsletter.usage as usage
import newsletter.workflow.content as newsletter_workflow_content
import newsletter.workflow.schema as newsletter_workflow_schema
import tests.support.editor as editor


async def test_provenance_correction_requires_real_open_and_preserves_search(
    tmp_path, fake_router, packet
):
    content = copy.deepcopy(packet["content"])
    content["sources"][0]["url"] = "https://example.com/evidence"
    research = {"state": "collected", "note": "fixture", "packets": [content]}
    # First turn searches but does not open this source; second really opens it.
    first = editor.FakeTurn(research)
    first.omit_action = "openPage"
    fake_router.turns = [first, editor.FakeTurn(research)]
    workspace = tmp_path / "job"
    workspace.mkdir()
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", workspace
    )
    assert json.loads(text) == research and searched
    assert opened == {"https://example.com/evidence"}
    assert len(fake_router.prompts) == 2
    assert fake_router.prompts[1]["unverified_urls"] == [
        "https://example.com/evidence"
    ]
    assert fake_router.closed


async def test_provenance_correction_stops_after_one_unverified_attempt(
    tmp_path, fake_router, packet
):
    content = copy.deepcopy(packet["content"])
    content["sources"][0]["url"] = "https://example.com/unread-pdf"
    fake_router.turn = editor.FakeTurn(
        {"state": "collected", "note": "fixture", "packets": [content]}
    )
    workspace = tmp_path / "job"
    workspace.mkdir()
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "fixture", workspace
        )
    assert error.value.code == "invalid_output"
    assert len(fake_router.prompts) == 2 and fake_router.closed


def test_provenance_inspection_includes_only_new_sources():
    assert (
        newsletter_editor._unopened_sources(
            '{"draft":{},"supplemental_packets":[]}', set()
        )
        == []
    )
    payload = {
        "packets": [{"sources": [{"url": "https://example.com/a#table"}]}]
    }
    assert (
        newsletter_editor._unopened_sources(
            json.dumps(payload), {"https://example.com/a"}
        )
        == []
    )
    for invalid in ("[]", '{"packets":null}', '{"packets":[{}]}'):
        with pytest.raises(newsletter_errors.EditorError):
            newsletter_editor._unopened_sources(invalid, set())


def discovery_output(*, url="https://example.com/evidence", scope="abstract"):
    return {
        "candidates": [
            {
                "title": "Synthetic public candidate",
                "url": url,
                "doi": "",
                "version": "",
                "event_key": "",
                "published_at": "",
                "summary": "Only a synthetic test claim.",
                "why_now": (
                    "An offline fixture tests evidence provenance, not "
                    "actual news."
                ),
                "access_scope": scope,
            }
        ],
        "note": "Synthetic discovery only",
    }


@pytest.mark.parametrize("scope", ["abstract", "full_text", "dataset"])
async def test_discovery_missing_open_gets_one_same_thread_correction(
    tmp_path, fake_router, scope
):
    output = discovery_output(scope=scope)
    # Search and the actual source open occur in separate turns. Neither action
    # may be inferred from the candidate's own fields or dropped on correction.
    fake_router.turns = [
        editor.discovery_turn(output, omit_action="openPage"),
        editor.discovery_turn(output, omit_action="search"),
    ]
    content = newsletter_workflow_content.ContentPreparation(
        editor.live_editor(tmp_path)
    )
    result = await content.discover(
        instructions.Instruction(
            "03-world", "Synthetic instruction", "fixture"
        ),
        "2026-09-06",
        tmp_path / "discovery",
    )
    assert result.candidates[0]["url"] == "https://example.com/evidence"
    assert result.candidates[0]["published_at"] == ""
    assert result.candidates[0]["provenance"] == "web_open"
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.prompts[1]["unverified_urls"] == [
        "https://example.com/evidence"
    ]
    assert fake_router.schema == newsletter_workflow_schema.discovery_schema()
    assert fake_router.closed


async def test_unopened_discovery_after_correction_has_no_third_turn(
    tmp_path, fake_router
):
    # Opening /evidence never authenticates a different canonical/PDF URL.
    fake_router.turn = editor.FakeTurn(
        discovery_output(url="https://example.com/unread-pdf")
    )
    with pytest.raises(newsletter_errors.EditorError) as caught:
        await newsletter_workflow_content.ContentPreparation(
            editor.live_editor(tmp_path)
        ).discover(
            instructions.Instruction(
                "03-world", "Synthetic instruction", "fixture"
            ),
            "2026-09-06",
            tmp_path / "discovery",
        )
    assert caught.value.code == "invalid_output"
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.closed


async def test_discovery_correction_keeps_original_execute_timeout(
    tmp_path, fake_router
):
    output = discovery_output(url="https://example.com/unread-pdf")
    hanging = editor.FakeTurn(output, hang=True)
    fake_router.turns = [editor.FakeTurn(output), hanging]
    with pytest.raises(newsletter_errors.EditorError) as caught:
        await newsletter_workflow_content.ContentPreparation(
            editor.live_editor(tmp_path, timeout_seconds=0.05)
        ).discover(
            instructions.Instruction(
                "03-world", "Synthetic instruction", "fixture"
            ),
            "2026-09-06",
            tmp_path / "discovery",
        )
    assert caught.value.code == "timeout" and hanging.interrupted
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.closed


@pytest.mark.parametrize("trusted_seed", [False, True])
async def test_metadata_requires_seed_but_no_open_correction(
    tmp_path, fake_router, trusted_seed
):
    output = discovery_output(
        url="https://example.com/feed-only", scope="metadata"
    )
    seed = {
        **output["candidates"][0],
        "id": "fixture-seed",
        "direction": "03-world",
        "provenance": "crossref_metadata",
        "summary": "Original feed title record only.",
    }
    fake_router.turn = editor.FakeTurn(output)
    content = newsletter_workflow_content.ContentPreparation(
        editor.live_editor(tmp_path)
    )
    args = (
        instructions.Instruction(
            "03-world", "Synthetic instruction", "fixture"
        ),
        "2026-09-06",
        tmp_path / "discovery",
    )
    if trusted_seed:
        result = await content.discover(*args, seeds=[seed])
        assert result.candidates[0]["summary"] == seed["summary"]
        assert result.candidates[0]["provenance"] == "crossref_metadata"
    else:
        with pytest.raises(newsletter_errors.EditorError) as caught:
            await content.discover(*args)
        assert caught.value.code == "invalid_output"
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 1
    assert fake_router.closed


def test_discovery_source_inspection_preserves_fragment_and_input_boundaries():
    value = discovery_output(url="https://example.com/evidence#section")
    assert (
        newsletter_editor._unopened_sources(
            json.dumps(value), {"https://example.com/evidence"}
        )
        == []
    )
    assert newsletter_editor._unopened_sources(json.dumps(value), set()) == [
        "https://example.com/evidence#section"
    ]
    # Planning input references/history are not newly claimed evidence.
    unrelated = {
        "research_tasks": [{"source_urls": ["https://example.com/persisted"]}],
        "history_untrusted": [{"url": "https://example.com/history"}],
    }
    assert (
        newsletter_editor._unopened_sources(json.dumps(unrelated), set()) == []
    )
    for invalid in (
        {"candidates": None},
        {"candidates": [None]},
        {"candidates": [{}]},
    ):
        with pytest.raises(newsletter_errors.EditorError):
            newsletter_editor._unopened_sources(json.dumps(invalid), set())


async def test_mock_deterministic_and_conspicuous(tmp_path, packet):
    first = await newsletter_editor.MockEditor().prepare(
        [packet], "2026-09-05", tmp_path / "first"
    )
    second = await newsletter_editor.MockEditor().prepare(
        [packet], "2026-09-05", tmp_path / "second"
    )
    assert first == second
    assert "MOCK" in first.draft["subject"]
    assert (
        packet["content"]["body"]
        in first.draft["sections"][0]["paragraphs"][0]["text"]
    )
    assert {f.name for f in dataclasses.fields(first)} == {"draft", "review"}
    contracts.validate_draft(first.draft, [packet])
    assert (
        json.loads((tmp_path / "first" / "draft.json").read_text())
        == first.draft
    )


async def test_mock_rejects_live_material(tmp_path, packet):
    packet["is_fixture"] = False
    with pytest.raises(
        newsletter_errors.EditorError, match="invalid input"
    ) as error:
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", tmp_path / "job"
        )
    assert error.value.code == "invalid_input"


async def run(adapter, workspace):
    """Drive one model request through the generic execute boundary."""
    workspace.mkdir(parents=True, exist_ok=True)
    return await adapter.execute(
        '{"task":"synthetic"}', {}, "Synthetic fixture policy.", workspace
    )


async def test_generic_config_preserves_unspecified_effort(
    tmp_path, fake_router
):
    text, opened, searched = await run(
        editor.live_editor(tmp_path), tmp_path / "job"
    )
    assert json.loads(text)["review"]["passed"] and opened and searched
    assert fake_router.closed
    assert fake_router.config.model == "gpt-6.1-sol"
    assert fake_router.config.effort == ""
    assert fake_router.config.web_research
    assert (
        fake_router.config.instructions[0].text == "Synthetic fixture policy."
    )


@pytest.mark.parametrize(
    "raw",
    [
        '{"draft":{},"draft":{},"review":{},"supplemental_packets":[]}',
        '{"draft":NaN,"review":{},"supplemental_packets":[]}',
        "```json\n{}\n```",
        "[]",
    ],
)
async def test_strict_json_rejection(tmp_path, fake_router, raw):
    fake_router.turn.bundle = raw
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(editor.live_editor(tmp_path), tmp_path / "job")
    assert error.value.code == "invalid_output"
    assert fake_router.closed


@pytest.mark.parametrize(
    "failure,code",
    [
        ({"code": 8}, "rate_limit"),
        ({"code": 16}, "authentication"),
        ({"code": 14}, "unavailable"),
    ],
)
async def test_model_error_categories_are_sanitized(
    tmp_path, fake_router, failure, code
):
    fake_router.turn.failure = failure
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(editor.live_editor(tmp_path), tmp_path / "job")
    assert error.value.code == code


async def test_timeout_interrupts_and_closes(tmp_path, fake_router):
    fake_router.turn.hang = True
    with pytest.raises(newsletter_errors.EditorError) as error:
        await run(
            editor.live_editor(tmp_path, timeout_seconds=0.05),
            tmp_path / "job",
        )
    assert error.value.code == "timeout"
    assert fake_router.turn.interrupted and fake_router.closed


async def test_worker_cancellation_interrupts_and_closes(tmp_path, fake_router):
    fake_router.turn.hang = True
    task = asyncio.create_task(
        run(editor.live_editor(tmp_path), tmp_path / "job")
    )
    await fake_router.turn.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_router.turn.interrupted and fake_router.closed


async def test_stale_artifact_not_overwritten(tmp_path, packet):
    workspace = tmp_path / "job"
    workspace.mkdir()
    output = workspace / "draft.json"
    output.write_text("existing-user-data")
    with pytest.raises(newsletter_errors.EditorError):
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", workspace
        )
    assert output.read_text() == "existing-user-data"


async def test_symlink_output_rejected(tmp_path, packet):
    workspace = tmp_path / "job"
    workspace.mkdir()
    target = tmp_path / "outside.json"
    target.write_text("untouched")
    (workspace / "draft.json").symlink_to(target)
    with pytest.raises(newsletter_errors.EditorError):
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", workspace
        )
    assert target.read_text() == "untouched"


async def test_mock_explicit_synthetic_chart(tmp_path, packet):
    packet["content"]["tags"].append("demo-chart")
    packet["content"]["body"] = "显眼的虚构测试数据：A=12, B=8, C=missing"
    packet["content"]["sources"][0].update(
        id="demo", access_scope="dataset", excerpt=packet["content"]["body"]
    )
    result = await newsletter_editor.MockEditor().prepare(
        [packet], "2026-09-05", tmp_path / "job"
    )
    assert "MOCK" in result.draft["chart"]["caption"]
    assert result.draft["chart"]["points"][0]["decimal_value"] == "12"
    assert "decimal_value" not in result.draft["chart"]["points"][2]
    contracts.validate_draft(result.draft, [packet])


async def test_mock_chart_tag_does_not_invent_numbers(tmp_path, packet):
    packet["content"]["tags"].append("demo-chart")
    packet["content"]["sources"][0].update(id="demo", access_scope="dataset")
    with pytest.raises(newsletter_errors.EditorError) as error:
        await newsletter_editor.MockEditor().prepare(
            [packet], "2026-09-05", tmp_path / "job"
        )
    assert error.value.code == "invalid_input"


EVIDENCE_URL = "https://example.com/evidence"
INVALID_ANSWER = {"code": 13, "reason": "MODEL_INVALID_ANSWER"}


async def test_format_correction_reuses_research_and_context(
    tmp_path, fake_router, packet
):
    value = {"packets": [packet["content"]]}
    fake_router.turns = [
        editor.FakeTurn("", failure=INVALID_ANSWER),
        editor.FakeTurn(value, research=False),
    ]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value
    assert opened == {EVIDENCE_URL} and searched
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert "JSON Schema" in fake_router.prompts[1]["task"]
    assert fake_router.closed


@pytest.mark.parametrize(
    "failure",
    [
        {"code": 13, "reason": "MODEL_INTERNAL"},
        {"code": 13, "reason": "MODEL_OUTPUT_LIMIT"},
        {"code": 8, "reason": "MODEL_QUOTA_EXCEEDED"},
        {"code": 4, "reason": "MODEL_TIMEOUT"},
        {"code": 16, "reason": "MODEL_UNAUTHENTICATED"},
    ],
)
async def test_other_failures_do_not_spend_a_correction(
    tmp_path, fake_router, failure
):
    fake_router.turn.failure = failure
    with pytest.raises(newsletter_errors.EditorError):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "job"
        )
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 1
    assert fake_router.closed


@pytest.mark.parametrize("first_failure", [True, False])
async def test_format_and_provenance_share_the_second_turn(
    tmp_path, fake_router, packet, first_failure
):
    value = {"packets": [packet["content"]]}
    invalid = editor.FakeTurn("", failure=INVALID_ANSWER, research=False)
    unverified = editor.FakeTurn(value, research=False)
    fake_router.turns = (
        [invalid, unverified] if first_failure else [unverified, invalid]
    )
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "job"
        )
    assert error.value.code == "invalid_output"
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.closed


async def test_two_invalid_answers_stop_without_a_third_turn(
    tmp_path, fake_router
):
    fake_router.turn.failure = INVALID_ANSWER
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "job"
        )
    assert error.value.code == "invalid_output"
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.closed


async def test_format_correction_uses_original_timeout(tmp_path, fake_router):
    hanging = editor.FakeTurn({}, hang=True)
    fake_router.turns = [
        editor.FakeTurn("", failure=INVALID_ANSWER),
        hanging,
    ]
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path, timeout_seconds=0.05).execute(
            "{}", {}, "synthetic", tmp_path / "job"
        )
    assert error.value.code == "timeout" and hanging.interrupted
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.closed


def approval(component, *, passed=True):
    return {
        "prior_withdrawal": None,
        "assessments": [
            {
                "component": component,
                "status": "approved" if passed else "blocked",
                "findings": ["Synthetic review only."],
            }
        ],
        "issues": [],
    }


def limited_turn(value, missing):
    if missing == "both":
        return editor.FakeTurn(value, research=False)
    return editor.discovery_turn(value, omit_action=missing)


@pytest.mark.parametrize("component", ["body", "signal"])
@pytest.mark.parametrize("missing", ["search", "openPage", "both"])
async def test_claimed_pass_gets_same_thread_action_correction(
    tmp_path, fake_router, component, missing
):
    value = approval(component)
    # The second turn supplies only the missing action when possible. Observed
    # provenance must accumulate within this thread, not reset between turns.
    complement = {"search": "openPage", "openPage": "search"}
    corrected = (
        limited_turn(value, complement[missing])
        if missing != "both"
        else editor.FakeTurn(value)
    )
    fake_router.turns = [limited_turn(value, missing), corrected]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value
    assert searched and opened == {"https://example.com/evidence"}
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    correction = fake_router.prompts[1]
    assert correction["unverified_urls"] == []
    assert correction["missing_approval_actions"] == (
        ["search", "openPage"] if missing == "both" else [missing]
    )
    assert "blocked" in correction["task"] and "HOLD" in correction["task"]
    assert "review.passed" not in correction["task"]
    assert "实际" in correction["task"] and "web search" in correction["task"]
    assert fake_router.closed


@pytest.mark.parametrize("component", ["body", "signal"])
async def test_correction_may_honestly_hold_without_inventing_research(
    tmp_path, fake_router, component
):
    held = approval(component, passed=False)
    fake_router.turns = [
        editor.FakeTurn(approval(component), research=False),
        editor.FakeTurn(held, research=False),
    ]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == held and not opened and not searched
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2


@pytest.mark.parametrize("component", ["body", "signal"])
@pytest.mark.parametrize("missing", ["search", "openPage", "both"])
async def test_unsupported_second_pass_does_not_get_a_third_turn(
    tmp_path, fake_router, component, missing
):
    value = approval(component)
    fake_router.turn = limited_turn(value, missing)
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value
    assert newsletter_editor._unobserved_approval_actions(
        text, opened, searched
    )
    # Execute never fabricates successful actions; callers still see the gap.
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2


@pytest.mark.parametrize("corrected_search", [True, False])
async def test_url_and_approval_share_one_correction_budget(
    tmp_path, fake_router, corrected_search
):
    value = approval("body")
    sources = newsletter_editor.ApprovalSources({"body": [EVIDENCE_URL]})
    corrected = (
        editor.FakeTurn(value)
        if corrected_search
        else limited_turn(value, "search")
    )
    fake_router.turns = [editor.FakeTurn(value, research=False), corrected]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job", approval_sources=sources
    )
    correction = fake_router.prompts[1]
    assert correction["unverified_urls"] == [EVIDENCE_URL]
    assert correction["missing_approval_actions"] == ["search", "openPage"]
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert not newsletter_editor._unopened_approval_sources(
        text, opened, sources
    )
    assert searched is corrected_search
    assert newsletter_editor._unobserved_approval_actions(
        text, opened, searched
    ) == ([] if corrected_search else ["search"])


@pytest.mark.parametrize("component", ["body", "signal"])
async def test_honest_initial_hold_does_not_force_actions(
    tmp_path, fake_router, component
):
    value = approval(component, passed=False)
    fake_router.turn = editor.FakeTurn(value, research=False)
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value and not opened and not searched
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 1


async def test_unapproved_writer_output_still_corrects_new_unopened_sources(
    tmp_path, fake_router, packet
):
    # The story writer claims no approval, but its new supplemental sources
    # still need an independent open.
    value = {
        "content": {"body": "Synthetic draft only."},
        "signal": None,
        "supplemental_packets": [
            {"id": "supplement-1", "content": packet["content"]}
        ],
    }
    fake_router.turns = [
        editor.FakeTurn(value, research=False),
        limited_turn(value, "search"),
    ]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value and opened and not searched
    assert len(fake_router.prompts) == 2
    assert fake_router.prompts[1]["unverified_urls"] == [EVIDENCE_URL]
    assert fake_router.prompts[1]["missing_approval_actions"] == []


@pytest.mark.parametrize("component", ["body", "signal"])
async def test_action_correction_uses_original_timeout(
    tmp_path, fake_router, component
):
    value = approval(component)
    hanging = editor.FakeTurn(value, hang=True)
    fake_router.turns = [editor.FakeTurn(value, research=False), hanging]
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path, timeout_seconds=0.05).execute(
            "{}", {}, "synthetic", tmp_path / "job"
        )
    assert error.value.code == "timeout" and hanging.interrupted
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert fake_router.closed


@pytest.mark.parametrize(
    "value",
    [
        {},
        # Legacy whole-edition approval shapes are no longer produced, so
        # they never spend the correction opportunity.
        {"passed": True},
        {"review": {"passed": True}},
        {"assessments": [{"component": "body", "status": "blocked"}]},
        {"prior_withdrawal": None},
    ],
)
def test_action_inspection_requires_an_exact_true_claim(value):
    assert (
        newsletter_editor._unobserved_approval_actions(
            json.dumps(value), set(), False
        )
        == []
    )


def test_action_inspection_rejects_non_object():
    with pytest.raises(newsletter_errors.EditorError) as error:
        newsletter_editor._unobserved_approval_actions("[]", set(), False)
    assert error.value.code == "invalid_output"


def draft_schema():
    return model_schema.message_schema(editorial_pb2.Draft.DESCRIPTOR)


@pytest.fixture
def enum_fields():
    schema_draft = draft_schema()["properties"]
    source = model_schema.packet_body_schema()["properties"]["sources"][
        "items"
    ]["properties"]
    return {
        "section_kind": schema_draft["sections"]["items"]["properties"]["kind"],
        "chart_kind": schema_draft["chart"]["anyOf"][0]["properties"]["kind"],
        "source_access_scope": source["access_scope"],
    }


@pytest.fixture
def schema_packet():
    return editorial_pb2.Packet(
        id="fixture-packet",
        content=editorial_pb2.PacketBody(
            title="Synthetic research fixture",
            body="A synthetic value used only for offline validation.",
            sources=[
                editorial_pb2.Source(
                    id="fixture-source",
                    title="Synthetic source",
                    url="https://example.org/fixture",
                    excerpt="Synthetic value: 12.",
                    access_scope="full_text",
                )
            ],
        ),
    )


@pytest.fixture
def schema_draft():
    return editorial_pb2.Draft(
        subject="Synthetic subject",
        title="Synthetic title",
        sections=[
            editorial_pb2.Section(
                kind="feature",
                heading="Synthetic heading",
                paragraphs=[
                    editorial_pb2.Paragraph(
                        text="Synthetic statement.",
                        citations=["fixture-packet/fixture-source"],
                    )
                ],
            )
        ],
        chart=editorial_pb2.Chart(
            kind="bar",
            question="What is the synthetic value?",
            metric="Synthetic measurement",
            unit="fixture units",
            period="Synthetic period",
            caption="Synthetic data only.",
            alt_text="Synthetic value is 12.",
            points=[
                editorial_pb2.ChartPoint(
                    label="A",
                    decimal_value="12",
                    citations=["fixture-packet/fixture-source"],
                )
            ],
        ),
    )


def test_schema_enums_exactly_match_shared_contract_values(enum_fields):
    assert contracts.SECTION_KINDS == (
        "world",
        "feature",
        "context",
        "ai_ml",
        "science",
        "economy",
        "technology",
        "health",
    )
    assert contracts.CHART_KINDS == ("bar", "line")
    assert contracts.SOURCE_ACCESS_SCOPES == (
        "metadata",
        "abstract",
        "full_text",
        "dataset",
    )
    for field, values in (
        ("section_kind", contracts.SECTION_KINDS),
        ("chart_kind", contracts.CHART_KINDS),
        ("source_access_scope", contracts.SOURCE_ACCESS_SCOPES),
    ):
        assert enum_fields[field] == {"type": "string", "enum": list(values)}


@pytest.mark.parametrize("section_kind", contracts.SECTION_KINDS)
@pytest.mark.parametrize("chart_kind", contracts.CHART_KINDS)
@pytest.mark.parametrize("access_scope", contracts.SOURCE_ACCESS_SCOPES)
def test_every_schema_enum_combination_is_accepted_by_contracts(
    enum_fields,
    schema_packet,
    schema_draft,
    section_kind,
    chart_kind,
    access_scope,
):
    schema_draft.sections[0].kind = section_kind
    schema_draft.chart.kind = chart_kind
    schema_packet.content.sources[0].access_scope = access_scope
    assert section_kind in enum_fields["section_kind"]["enum"]
    assert chart_kind in enum_fields["chart_kind"]["enum"]
    assert access_scope in enum_fields["source_access_scope"]["enum"]
    contracts.validate_packet_body(schema_packet.content)
    contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize(
    "kind", ["world_brief", "main_read", "innovation_radar"]
)
def test_real_run_section_aliases_are_rejected_by_schema_and_contracts(
    enum_fields, schema_packet, schema_draft, kind
):
    # Literal values observed in the failed live run, not an imported live
    # artifact.
    assert kind not in enum_fields["section_kind"]["enum"]
    schema_draft.sections[0].kind = kind
    with pytest.raises(
        contracts.ContractError, match="Unsupported section kind"
    ):
        contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize("kind", ["pie", "BAR", ""])
def test_invalid_chart_kinds_are_rejected_by_schema_and_contracts(
    enum_fields, schema_packet, schema_draft, kind
):
    assert kind not in enum_fields["chart_kind"]["enum"]
    schema_draft.chart.kind = kind
    with pytest.raises(contracts.ContractError, match="Unsupported chart kind"):
        contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize("scope", ["fulltext", "FULL_TEXT", ""])
def test_invalid_source_scopes_are_rejected_by_schema_and_contracts(
    enum_fields, schema_packet, scope
):
    assert scope not in enum_fields["source_access_scope"]["enum"]
    schema_packet.content.sources[0].access_scope = scope
    with pytest.raises(
        contracts.ContractError, match="Unsupported source access_scope"
    ):
        contracts.validate_packet_body(schema_packet.content)


def test_schema_enum_arrays_are_fresh_and_do_not_mutate_contract_constants(
    enum_fields,
):
    enum_fields["section_kind"]["enum"].append("world_brief")
    fresh = draft_schema()["properties"]["sections"]["items"]["properties"]
    assert fresh["kind"]["enum"] == list(contracts.SECTION_KINDS)
    assert "world_brief" not in contracts.SECTION_KINDS


@pytest.mark.parametrize("changed_index", range(2))
def test_material_schema_consumers_own_independent_mutable_trees(changed_index):
    expected = model_schema.packet_body_schema()
    materials = [
        model_schema.packet_body_schema(),
        model_schema.packet_body_schema(),
    ]
    changed = materials[changed_index]
    changed["required"].append("fixture-only")
    changed["properties"]["sources"]["items"]["properties"]["access_scope"][
        "enum"
    ].clear()
    assert materials[1 - changed_index] == expected
    assert model_schema.packet_body_schema() == expected


@pytest.fixture
def identifier_fields():
    return [
        model_schema.packet_body_schema()["properties"]["sources"]["items"][
            "properties"
        ]["id"]
    ]


def test_source_schema_explains_the_shared_local_id_grammar(identifier_fields):
    assert contracts.IDENTIFIER_PATTERN == r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}"
    for field in identifier_fields:
        assert field["type"] == "string"
        assert field["pattern"] == "^" + contracts.IDENTIFIER_PATTERN + "$"
        assert (
            isinstance(field["description"], str)
            and field["description"].strip()
        )


@pytest.mark.parametrize(
    "identifier", ["s1", "paper-1", "A.b_c:2026", "0", "A" * 128]
)
def test_safe_ids_match_schema_and_are_accepted_by_strict_contracts(
    identifier_fields, schema_packet, schema_draft, identifier
):
    assert all(
        re.search(field["pattern"], identifier) is not None
        for field in identifier_fields
    )
    schema_packet.id = identifier
    schema_packet.content.sources[0].id = identifier
    citation = identifier + "/" + identifier
    schema_draft.sections[0].paragraphs[0].citations[:] = [citation]
    schema_draft.chart.points[0].citations[:] = [citation]
    contracts.validate_packet_body(schema_packet.content)
    contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize(
    "identifier",
    [
        "",
        "fixture/source",
        "10.0000/synthetic-doi",
        "https://example.org/synthetic",
        "A" * 129,
        "来源一",
        "évidence",
        "_source",
        "source label",
    ],
)
def test_invalid_ids_do_not_satisfy_schema_or_backend(
    identifier_fields, schema_packet, schema_draft, identifier
):
    assert all(
        re.search(field["pattern"], identifier) is None
        for field in identifier_fields
    )
    schema_packet.content.sources[0].id = identifier
    with pytest.raises(
        contracts.ContractError, match=r"source\.id is not a valid identifier"
    ):
        contracts.validate_packet_body(schema_packet.content)
    schema_packet.content.sources[0].id = "fixture-source"
    schema_packet.id = identifier
    with pytest.raises(
        contracts.ContractError, match=r"packet\.id is not a valid identifier"
    ):
        contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_backend_identifier_validation_still_rejects_trailing_newlines(
    schema_packet, schema_draft, ending
):
    # JSON Schema's ^/$ anchors may accept a final newline in some regex
    # engines.
    # They guide model output; backend fullmatch remains the strict authority.
    schema_packet.content.sources[0].id = "fixture-source" + ending
    with pytest.raises(
        contracts.ContractError, match=r"source\.id is not a valid identifier"
    ):
        contracts.validate_packet_body(schema_packet.content)
    schema_packet.content.sources[0].id = "fixture-source"
    schema_packet.id += ending
    with pytest.raises(
        contracts.ContractError, match=r"packet\.id is not a valid identifier"
    ):
        contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize("location", ["paragraph", "chart", "reading"])
@pytest.mark.parametrize(
    "citation", ["supplement-1/missing-source", "supplement-2/fixture-source"]
)
def test_supplement_citations_require_real_packet_sources(
    schema_packet, schema_draft, location, citation
):
    schema_packet.id = "supplement-1"
    existing = "supplement-1/fixture-source"
    schema_draft.sections[0].paragraphs[0].citations[:] = [existing]
    schema_draft.chart.points[0].citations[:] = [existing]
    if location == "paragraph":
        schema_draft.sections[0].paragraphs[0].citations[:] = [citation]
    elif location == "chart":
        schema_draft.chart.points[0].citations[:] = [citation]
    else:
        schema_draft.recommended_reading.CopyFrom(
            editorial_pb2.RecommendedReading(
                citation=citation, reason="Fixture"
            )
        )
    with pytest.raises(
        contracts.ContractError,
        match="Citation does not identify an available packet/source",
    ):
        contracts.validate_draft(schema_draft, [schema_packet])


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_backend_citation_existence_remains_strict_about_trailing_newlines(
    schema_packet, schema_draft, ending
):
    schema_draft.sections[0].paragraphs[0].citations[:] = [
        "fixture-packet/fixture-source" + ending
    ]
    with pytest.raises(
        contracts.ContractError,
        match="Citation does not identify an available packet/source",
    ):
        contracts.validate_draft(schema_draft, [schema_packet])


async def test_correction_reuses_context_and_adds_per_call_usage(
    tmp_path, fake_router, packet
):
    value = {"packets": [packet["content"]]}
    first = editor.FakeTurn(value, research=False)
    first.usage = models.Usage(
        available=True, input_tokens=100, output_tokens=20
    )
    second = editor.FakeTurn(value)
    second.usage = models.Usage(
        available=True, input_tokens=150, output_tokens=50
    )
    fake_router.turns = [first, second]
    records = []
    with usage.usage_scope(records.append, "synthetic"):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert fake_router.thread_starts == 1 and len(fake_router.prompts) == 2
    assert usage.summarize_usage(records)["usage"]["total_tokens"] == 320
    assert records[-1]["turns_started"] == 2
    # Both Router traces of the one invocation, for the owner console.
    assert [request["name"] for request in records[-1]["requests"]] == [
        "requests/synthetic-1",
        "requests/synthetic-2",
    ]
    assert "failure" not in records[-1] and records[-1]["finished_at"]


@pytest.mark.parametrize("first_usage_available", [True, False])
async def test_format_recovery_retains_both_usage_receipts(
    tmp_path, fake_router, first_usage_available
):
    first = editor.FakeTurn(
        "", failure={"code": 13, "reason": "MODEL_INVALID_ANSWER"}
    )
    if first_usage_available:
        first.usage = models.Usage(
            available=True, input_tokens=100, output_tokens=20
        )
    second = editor.FakeTurn({})
    second.usage = models.Usage(
        available=True, input_tokens=150, output_tokens=50
    )
    fake_router.turns = [first, second]
    records = []
    with usage.usage_scope(records.append, "writer"):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    summary = usage.summarize_usage(records)
    assert summary["usage"]["total_tokens"] == (
        320 if first_usage_available else 200
    )
    assert records[-1]["turns_started"] == 2
    assert records[-1]["turns_completed"] == 2
    assert len(records[-1]["requests"]) == 2
    assert records[-1]["status"] == "completed"
    assert summary["partial"] is not first_usage_available


async def test_bad_output_retains_known_usage(tmp_path, fake_router):
    fake_router.turn.bundle = "not JSON"
    fake_router.turn.usage = models.Usage(
        available=True, input_tokens=100, output_tokens=20
    )
    records = []
    with (
        pytest.raises(newsletter_errors.EditorError),
        usage.usage_scope(records.append, "synthetic"),
    ):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert usage.summarize_usage(records)["usage"]["total_tokens"] == 120
    assert records[-1]["status"] == "failed"
    assert records[-1]["failure"] == "invalid_output"


@pytest.mark.parametrize(
    ("failure", "code"),
    [({"code": 8}, "rate_limit"), ({"code": 16}, "authentication")],
)
async def test_router_failure_records_its_safe_category(
    tmp_path, fake_router, failure, code
):
    fake_router.turn.failure = failure
    records = []
    with (
        pytest.raises(newsletter_errors.EditorError),
        usage.usage_scope(records.append, "synthetic"),
    ):
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert records[-1]["failure"] == code
    assert records[-1]["requests"] == [
        {"name": "requests/synthetic-1", "model": ""}
    ]


async def test_editor_timeout_records_timeout(tmp_path, fake_router):
    fake_router.turn.hang = True
    records = []
    with (
        pytest.raises(newsletter_errors.EditorError),
        usage.usage_scope(records.append, "selection"),
    ):
        await editor.live_editor(tmp_path, timeout_seconds=0.05).execute(
            "{}", {}, "synthetic", tmp_path / "workspace"
        )
    assert records[-1]["failure"] == "timeout"
    assert records[-1]["turns_completed"] == 0


async def test_outer_cancellation_records_interrupted(tmp_path, fake_router):
    # A node budget or worker stop cancels the call from outside the editor.
    fake_router.turn.hang = True
    records = []

    async def run():
        with usage.usage_scope(records.append, "selection"):
            await editor.live_editor(tmp_path).execute(
                "{}", {}, "synthetic", tmp_path / "workspace"
            )

    task = asyncio.create_task(run())
    await fake_router.turn.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert records[-1]["status"] == "failed"
    assert records[-1]["failure"] == "interrupted"
    assert records[-1]["purpose"] == "selection"
