"""Exercise displayed synthetic examples with current editorial validators."""

import copy
import json
import pathlib
import re

import pytest

import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.workflow.components as components
import newsletter.workflow.content as content
import newsletter.workflow.prompt_examples as prompt_examples
import newsletter.workflow.review as review
import newsletter.workflow.schema as schema
import newsletter.workflow.story_editor as story_editor
import tests.support.story_editor as support


def examples(stage, source):
    if source == "authored":
        text = (
            pathlib.Path(__file__).resolve().parents[1]
            / "content-config/prompts"
            / f"{stage}.md"
        ).read_text()
    else:
        text = content_config.packaged_snapshot()["files"][
            f"prompts/{stage}.md"
        ]
    return [
        json.loads(block)
        for block in re.findall(r"```json\n(.*?)\n```", text, re.DOTALL)
    ]


def example_packet():
    source = prompt_examples.writer("brief", False)["input_excerpt"]["source"]
    body = {
        "title": "合成渡轮公告",
        "body": source["excerpt"],
        "tags": ["synthetic"],
        "sources": [
            {
                **source,
                "id": "source",
                "title": "合成公告",
                "published_at": "2026-09-06",
            }
        ],
    }
    return {
        "id": "example-packet",
        "content": body,
        "content_hash": contracts.content_hash(body),
        "created_at": "2026-09-06T00:00:00Z",
        "workflow_id": "synthetic",
        "producer_id": "synthetic",
        "is_fixture": True,
    }


@pytest.mark.parametrize("source", ["authored", "packaged"])
def test_discovery_examples_keep_local_ids_and_require_observed_evidence(
    source,
):
    observed, output, empty = examples("discovery", source)
    opened = {observed["opened_source"]["url"]}
    actual_schema = schema.discovery_schema(classified=True)
    assert set(output) == set(actual_schema["required"])
    assert set(output["candidates"][0]) == set(
        actual_schema["properties"]["candidates"]["items"]["required"]
    )
    parsed = content.parse_discovery(
        json.dumps(output),
        opened,
        True,
        observed["direction"],
        observed["issue_date"],
        classified=True,
    )
    candidate = parsed.candidates[0]
    assert candidate["id"] and candidate["provenance"] == "web_open"
    assert candidate["url"] in opened
    assert parsed.classifications[candidate["id"]]["kind"] == "news"
    assert (
        content.parse_discovery(
            json.dumps(empty),
            set(),
            True,
            observed["direction"],
            observed["issue_date"],
            classified=True,
        ).candidates
        == []
    )
    for seen, searched in ((set(), True), (opened, False)):
        with pytest.raises(errors.EditorError):
            content.parse_discovery(
                json.dumps(output),
                seen,
                searched,
                observed["direction"],
                observed["issue_date"],
                classified=True,
            )


@pytest.mark.parametrize("source", ["authored", "packaged"])
def test_selection_example_references_only_eligible_input_and_keeps_news(
    source,
):
    given, output = examples("selection", source)
    candidates = given["candidates_untrusted"]
    actual_schema = schema.planning_schema(
        [item["id"] for item in candidates],
        [item["url"] for item in candidates],
        given["max_tasks"],
        classified=True,
    )
    assert set(output) == set(actual_schema["required"])
    assert set(output["research_tasks"][0]) == set(
        actual_schema["properties"]["research_tasks"]["items"]["required"]
    )
    limits = content.EditorialLimits(1, 1, 1, 10)
    parsed = content.parse_classified_plan(
        json.dumps(output),
        candidates,
        given["candidate_classifications"],
        given["max_tasks"],
        limits,
    )
    assert len(parsed.research_tasks) == 1 and not parsed.omitted_tasks
    assert parsed.task_classifications == {"example-task": "news"}
    assert parsed.research_tasks[0]["candidate_ids"] == ["example-news"]
    copied = copy.deepcopy(output)
    copied["research_tasks"][0]["candidate_ids"] = ["foreign-example-id"]
    with pytest.raises(errors.EditorError):
        content.parse_classified_plan(
            json.dumps(copied),
            candidates,
            given["candidate_classifications"],
            given["max_tasks"],
            limits,
        )


def test_authored_and_packaged_examples_match_without_equal_editorial_policy():
    for stage in ("discovery", "selection"):
        assert examples(stage, "authored") == examples(stage, "packaged")


@pytest.mark.parametrize("mode", ["brief", "deep"])
@pytest.mark.parametrize("repair", [False, True])
async def test_writer_examples_use_the_current_mode_schema_and_parser(
    rig,
    mode,
    repair,
):
    example = prompt_examples.writer(mode, repair)
    given, output = example["input_excerpt"], example["output"]
    packets = [example_packet()]
    frozen = copy.deepcopy(packets)
    actual_schema = story_editor.story_writer_schema(
        mode,
        repair=repair,
        story_id=given["story_id"],
        packets=packets,
    )
    assert set(output) == set(actual_schema["required"])
    story_schema = actual_schema["properties"]["content"]["anyOf"][0]
    assert set(output["content"]) == set(story_schema["required"])
    assert (
        output["content"]["kind"] in story_schema["properties"]["kind"]["enum"]
    )
    assert bool(output["signal"]) == (mode == "brief" and not repair)
    context = {
        "issue_date": "2026-09-06",
        "story_id": given["story_id"],
        "mode": mode,
    }
    if repair:
        context["repair_untrusted"] = given["repair_untrusted"]
    rig.replies = [
        support.reply(
            output,
            opened=set(given["observed_web"]["opened"]),
        )
    ]
    result, _ = await rig.editor._write(
        context, packets, {}, rig.workspace, True
    )
    assert result["content"] == components.body_content(output["content"])
    assert result["signal"] == (
        components.body_content(output["signal"]) if output["signal"] else None
    )
    assert packets == frozen and not result["issues"]
    assert rig.calls[0]["schema"] == actual_schema
    assert rig.calls[0]["prompt"]["synthetic_example"] == example
    # Examples do not make their citations eligible in another real story.
    with pytest.raises(story_editor.StoryOutputError) as error:
        story_editor.validate_content(
            components.body_content(output["content"]),
            packets,
            "another-story",
            16,
        )
    assert error.value.reason == "story_id_mismatch"


@pytest.mark.parametrize("searched", [True, False])
def test_review_example_blocks_wrong_body_and_binds_signal_to_observation(
    searched,
):
    example = prompt_examples.REVIEW
    output = example["output"]
    assert set(output) == set(story_editor.story_review_schema()["required"])
    review.parse_review(json.dumps(output))
    writer = prompt_examples.writer("brief", False)["output"]
    body = copy.deepcopy(writer["content"])
    body["paragraphs"][0]["text"] = example["input_excerpt"]["body_claim"]
    packet = example_packet()
    value = {"content": body, "signal": writer["signal"], "packets": [packet]}
    sources = {"example-packet/source": packet["content"]["sources"][0]}
    evidence = review.ReviewEvidence(
        sources,
        {sources["example-packet/source"]["url"]},
        searched,
        "initial",
        "writer-example",
        "reviewer-example",
    )
    seen = set()
    assessments = [
        review.assess_component(record, value, seen, evidence)[0]
        for record in output["assessments"]
    ]
    receipt = {"assessments": assessments, "issues": [], "withdrawals": []}
    review.apply_issues(output["issues"], receipt, "initial", sources)
    statuses = {item["component"]: item["status"] for item in assessments}
    assert statuses == {
        "body": "blocked",
        "reading": "not_present",
        "chart": "not_present",
        "signal": "approved" if searched else "blocked",
    }
    assert (
        receipt["issues"][0]["claim"] == example["input_excerpt"]["body_claim"]
    )
    assert receipt["issues"][0]["evidence"] == ["example-packet/source"]


async def test_examples_do_not_change_frozen_real_inputs_or_add_model_rounds(
    rig,
):
    original = support.story()
    frozen_packet = copy.deepcopy(rig.packet)
    rig.replies = [
        support.reply(support.writer(original)),
        support.reply(support.review()),
    ]
    result = await rig.run()
    assert result["content"] == original and len(rig.calls) == 2
    assert rig.packet == frozen_packet
    assert result["provenance"]["packets_hash"] == contracts.content_hash(
        [frozen_packet]
    )
    assert rig.calls[1]["prompt"]["synthetic_example"] == prompt_examples.REVIEW
