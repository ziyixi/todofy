"""Offline tests only: never start a real app-server or inspect auth files."""

import asyncio
import copy
import dataclasses
import json

import pytest

import newsletter.collection.instructions as instructions
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as newsletter_errors
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
    assert fake_router.config.model == "models/sol-6-1"
    assert fake_router.config.parameters is None
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
