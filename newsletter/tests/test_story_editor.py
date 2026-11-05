"""Local component failures never erase an independently approved story unit."""

import asyncio
import base64
import copy
import datetime
import email.parser as parser
import email.policy as email_policy
import html
import importlib.resources as resources
import io
import json
import pathlib
import re
import uuid

import httpx
import PIL.Image as Image
import pytest

import newsletter.adapters as adapters
import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.rendering as newsletter_rendering
import newsletter.store as newsletter_store
import newsletter.todofy as todofy
import newsletter.usage as newsletter_usage
import newsletter.workflow.components as components
import newsletter.workflow.feed_excerpts as feed_excerpts
import newsletter.workflow.publication as publication
import newsletter.workflow.story_editor as newsletter_workflow_story_editor
import tests.support.publication as publication_support
import tests.support.rendering as rendering
import tests.support.story_editor as story_editor
import tests.support.usage as tests_support_usage


async def test_approved_body_and_signal_freeze_without_repair(rig):
    content, signal = (
        story_editor.story(),
        story_editor.story("仅确认虚构事件；更多细节仍在核验。"),
    )
    rig.replies = [
        story_editor.reply(story_editor.writer(content, signal)),
        story_editor.reply(story_editor.review(signal="approved")),
    ]
    result = await rig.run()
    assert result["content"] == content and result["signal"] == signal
    assert result["reason"] == "approved" and len(rig.calls) == 2
    assert rig.checkpoints == [result]
    assert result["provenance"]["packets_hash"] == contracts.content_hash(
        result["packets"]
    )
    for assessment in result["assessments"]:
        assert uuid.UUID(assessment["writer_job_id"]) != uuid.UUID(
            assessment["reviewer_job_id"]
        )
        assert assessment["opened"] is True and assessment["searched"] is True
    assert len({call["path"] for call in rig.calls}) == 2
    assert all(call["path"].is_dir() for call in rig.calls)
    publication.validate_result(result)


async def test_card_and_chart_can_be_discarded_without_body_repair(rig):
    content = story_editor.story(reading=True, chart=True)
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(
            story_editor.review(reading="blocked", chart="blocked")
        ),
    ]
    result = await rig.run(mode="deep")
    assert result["content"] == components.body_content(content)
    assert len(rig.calls) == 2 and result["reason"] == "approved"
    receipt = next(a for a in result["assessments"] if a["component"] == "body")
    assert receipt["content_hash"] == contracts.content_hash(
        components.body_content(content)
    )
    publication.validate_result(result)


async def test_every_optional_component_has_its_own_hash_and_source_observation(
    rig,
):
    content = story_editor.story(reading=True, chart=True)
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(
            story_editor.review(reading="approved", chart="approved")
        ),
    ]
    result = await rig.run(mode="deep")
    assert result["content"] == content
    expected = {
        "body": components.body_content(content),
        "reading": content["recommended_reading"],
        "chart": content["chart"],
    }
    for item in result["assessments"]:
        if item["component"] in expected:
            assert item["content_hash"] == contracts.content_hash(
                expected[item["component"]]
            )
    publication.validate_result(result)


async def test_reading_support_requires_its_own_source_open(
    rig,
):
    content = story_editor.story(reading=True)
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(
            story_editor.review(reading="approved"), opened={story_editor.URL}
        ),
    ]
    result = await rig.run(mode="deep")
    assert (
        result["content"] == components.body_content(content)
        and len(rig.calls) == 2
    )
    assert (
        next(a for a in result["assessments"] if a["component"] == "reading")[
            "status"
        ]
        == "blocked"
    )


@pytest.mark.parametrize(
    "optional",
    [
        {
            "recommended_reading": {
                "citation": "packet/missing",
                "reason": "invalid",
                "supporting_citations": [],
            }
        },
        {
            "recommended_reading": {
                "citation": ["bad"],
                "reason": "invalid",
                "supporting_citations": [],
            }
        },
        {"recommended_reading": "not an object"},
        {"chart": {"points": "not an array"}},
    ],
)
async def test_malformed_optional_component_never_invalidates_independent_body(
    rig, optional
):
    content = {**story_editor.story(), **optional}
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"] == story_editor.story() and len(rig.calls) == 2
    assert result["issues"][0]["reason"].startswith(
        "component_contract_invalid:"
    )


async def test_bad_body_repairs_once_and_never_changes_approved_signal(rig):
    original, fixed, signal = (
        story_editor.story(),
        story_editor.story("修正后的虚构完整表述。"),
        story_editor.story("虚构事件已确认。"),
    )
    rig.replies = [
        story_editor.reply(story_editor.writer(original, signal)),
        story_editor.reply(
            story_editor.review(body="blocked", signal="approved")
        ),
        story_editor.reply(story_editor.writer(fixed)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"] == fixed and result["signal"] == signal
    assert result["reason"] == "repaired" and len(rig.calls) == 4
    assert (
        rig.checkpoints[0]["content"] is None
        and rig.checkpoints[0]["signal"] == signal
    )
    assert rig.checkpoints[1] == result
    assert {a["round"] for a in result["assessments"]} == {"initial", "repair"}
    assert len({call["path"] for call in rig.calls}) == 4
    for checkpoint in rig.checkpoints:
        publication.validate_result(checkpoint)


async def test_each_story_job_labels_its_model_invocation(rig, monkeypatch):
    purposes = []
    fake = newsletter_editor.ModelEditor.execute

    async def labelled(editor, *args, **kwargs):
        # The purpose a real invocation would record at this call.
        purposes.append(newsletter_usage.ModelUsage("m").record["purpose"])
        return await fake(editor, *args, **kwargs)

    monkeypatch.setattr(newsletter_editor.ModelEditor, "execute", labelled)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
        story_editor.reply(story_editor.writer(story_editor.story("修正。"))),
        story_editor.reply(story_editor.review()),
    ]
    with newsletter_usage.usage_scope(lambda _: None, "briefs:story-a"):
        await rig.run()
    assert purposes == [
        "writer",
        "reviewer",
        "repair_writer",
        "repair_reviewer",
    ]


async def test_second_body_hold_keeps_signal_without_third_attempt(rig):
    signal = story_editor.story("只确认事件存在。")
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story(), signal)),
        story_editor.reply(
            story_editor.review(body="blocked", signal="approved")
        ),
        story_editor.reply(
            story_editor.writer(story_editor.story("修订仍不成立。"))
        ),
        story_editor.reply(story_editor.review(body="blocked")),
    ]
    result = await rig.run()
    assert result["content"] is None and result["signal"] == signal
    assert result["reason"] == "confirmed_signal" and len(rig.calls) == 4


async def test_cancellation_preserves_checkpointed_signal(
    rig,
):
    rig.replies = [
        story_editor.reply(
            story_editor.writer(
                story_editor.story(), story_editor.story("最小事件。")
            )
        ),
        story_editor.reply(
            story_editor.review(body="blocked", signal="approved")
        ),
        asyncio.CancelledError(),
    ]
    with pytest.raises(asyncio.CancelledError):
        await rig.run()
    assert len(rig.checkpoints) == 1 and rig.checkpoints[0][
        "signal"
    ] == story_editor.story("最小事件。")
    assert rig.checkpoints[0]["content"] is None


@pytest.mark.parametrize(
    "error",
    [
        errors.EditorError("authentication"),
        contracts.ContractError("BAD", "fixture"),
        RuntimeError("fixture storage failure"),
    ],
)
async def test_checkpoint_failure_propagates_without_another_model_call(
    rig, error
):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]

    def broken(_):
        raise error

    with pytest.raises(type(error)):
        await rig.run(on_checkpoint=broken)
    assert len(rig.calls) == 2


async def test_checkpoint_is_deep_copy_not_mutable_later_repair_state(rig):
    rig.replies = [
        story_editor.reply(
            story_editor.writer(
                story_editor.story(), story_editor.story("事件已知。")
            )
        ),
        story_editor.reply(
            story_editor.review(body="blocked", signal="approved")
        ),
        story_editor.reply(
            story_editor.writer(story_editor.story("修订内容。"))
        ),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert len(rig.checkpoints[0]["assessments"]) == 4
    result["signal"]["title"] = "caller mutation"
    assert rig.checkpoints[0]["signal"]["title"] != "caller mutation"


@pytest.mark.parametrize("stage", ["writer", "review", "repair"])
async def test_provider_failures_finite_never_promote_unverified_content(
    rig, stage
):
    signal = story_editor.story("已核实最小事件。")
    rig.replies = {
        "writer": [errors.EditorError("unavailable")],
        "review": [
            story_editor.reply(
                story_editor.writer(story_editor.story(), signal)
            ),
            errors.EditorError("timeout"),
        ],
        "repair": [
            story_editor.reply(
                story_editor.writer(story_editor.story(), signal)
            ),
            story_editor.reply(
                story_editor.review(body="blocked", signal="approved")
            ),
            errors.EditorError("unavailable"),
        ],
    }[stage]
    result = await rig.run()
    assert result["content"] is None
    assert result["signal"] == (signal if stage == "repair" else None)
    assert result["issues"][-1]["round"] == "service"


async def test_deep_provider_failure_does_not_mislabel_or_mutate_prior_brief(
    rig,
):
    prior = {
        "content": story_editor.story(),
        "signal": story_editor.story("最小事件。"),
    }
    frozen = copy.deepcopy(prior)
    rig.replies = [errors.EditorError("unavailable")]
    result = await rig.run(mode="deep", prior=prior)
    assert result["content"] is None and result["signal"] is None
    assert prior == frozen
    assert rig.calls[0]["prompt"]["prior_verified_brief_untrusted"] == prior
    publication.validate_result(result)


@pytest.mark.parametrize(
    "opened,searched",
    [
        (set(), True),
        ({story_editor.URL}, False),
        ({story_editor.SECOND_URL}, True),
    ],
)
async def test_missing_fresh_review_actions_block_even_model_self_approval(
    rig, opened, searched
):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(
            story_editor.review(), opened=opened, searched=searched
        ),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(
            story_editor.review(), opened=opened, searched=searched
        ),
    ]
    result = await rig.run()
    assert result["content"] is None and len(rig.calls) == 4
    assert all(a["status"] != "approved" for a in result["assessments"])


async def test_metadata_is_not_a_substitute_for_reading_evidence(rig):
    rig.packet["content"]["sources"][0]["access_scope"] = "metadata"
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"] is None


async def test_contradictory_approved_with_unresolved_issue_is_not_accepted(
    rig,
):
    issue = {
        "component": "body",
        "claim": "数字",
        "reason": "数字错误",
        "evidence": ["packet/source"],
        "action": "correct",
    }
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(issues=[issue])),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
    ]
    result = await rig.run()
    assert result["content"] is None and len(rig.calls) == 4


async def test_new_sources_opened_normalized_all_reference_locations_remapped(
    rig,
):
    content = story_editor.story(reading=True, chart=True)
    content["paragraphs"][0]["citations"] = ["supplement-1/source"]
    content["recommended_reading"]["citation"] = "supplement-1/source"
    content["recommended_reading"]["supporting_citations"] = [
        "supplement-1/publication"
    ]
    content["chart"]["points"][0]["citations"] = ["supplement-1/source"]
    supplement = {
        "id": "supplement-1",
        "content": copy.deepcopy(rig.packet["content"]),
    }
    rig.replies = [
        story_editor.reply(
            story_editor.writer(content, supplements=[supplement])
        ),
        story_editor.reply(
            story_editor.review(reading="approved", chart="approved")
        ),
    ]
    result = await rig.run(mode="deep")
    generated = result["packets"][-1]
    uuid.UUID(generated["id"])
    assert generated["is_fixture"] is True and generated[
        "content_hash"
    ] == contracts.content_hash(generated["content"])
    serialized = json.dumps(result["content"])
    assert "supplement-1/" not in serialized and generated["id"] in serialized
    assert (
        generated["id"] + "/publication"
        in result["content"]["recommended_reading"]["supporting_citations"]
    )
    publication.validate_result(result)


async def test_real_story_can_start_with_candidates_and_no_preexisting_packets(
    rig,
):
    content = story_editor.story()
    content["paragraphs"][0]["citations"] = ["supplement-1/source"]
    supplement = {
        "id": "supplement-1",
        "content": copy.deepcopy(rig.packet["content"]),
    }
    rig.replies = [
        story_editor.reply(
            story_editor.writer(content, supplements=[supplement])
        ),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(packets=[], is_fixture=False)
    assert result["content"] is not None and len(result["packets"]) == 1
    assert result["packets"][0]["is_fixture"] is False
    publication.validate_result(result)


async def test_new_sources_without_actual_open_cannot_be_used(rig):
    supplement = {
        "id": "supplement-1",
        "content": copy.deepcopy(rig.packet["content"]),
    }
    rig.replies = [
        story_editor.reply(
            story_editor.writer(story_editor.story(), supplements=[supplement]),
            opened={story_editor.URL},
        )
    ]
    result = await rig.run()
    assert result["content"] is None and len(rig.calls) == 1
    assert len(result["packets"]) == 1


@pytest.mark.parametrize(
    "bad",
    [
        "not JSON",
        (
            '{"content":null,"content":null,"signal":null,"supplemental'
            '_packets":[]}'
        ),
        {
            "content": None,
            "signal": None,
            "supplemental_packets": [],
            "private": "unsupported",
        },
    ],
)
async def test_malformed_model_envelope_is_never_published(rig, bad):
    rig.replies = [story_editor.reply(bad)]
    result = await rig.run()
    assert (
        result["content"] is None
        and result["signal"] is None
        and len(rig.calls) == 1
    )


async def test_malformed_body_can_still_leave_independently_checked_signal(rig):
    bad = story_editor.story()
    bad["paragraphs"][0]["citations"] = ["packet/missing"]
    rig.replies = [
        story_editor.reply(
            story_editor.writer(bad, story_editor.story("事件存在。"))
        ),
        story_editor.reply(
            story_editor.review(body="not_present", signal="approved")
        ),
        story_editor.reply(story_editor.writer(bad)),
    ]
    result = await rig.run()
    assert result["content"] is None and result["signal"] == story_editor.story(
        "事件存在。"
    )
    assert len(rig.calls) == 3
    assert rig.checkpoints[0]["signal"] == story_editor.story("事件存在。")


async def test_unconfirmed_event_produces_no_signal_and_no_fabricated_body(rig):
    rig.replies = [
        story_editor.reply(story_editor.writer()),
        story_editor.reply(story_editor.review(body="not_present")),
    ]
    result = await rig.run()
    assert result["content"] is None and result["signal"] is None
    assert result["reason"] == "withheld" and not rig.checkpoints


@pytest.mark.parametrize("mode,count", [("brief", 3), ("deep", 17)])
async def test_text_bounds_do_not_cut_paragraphs_into_unreviewed_fragments(
    rig, mode, count
):
    content = story_editor.story()
    content["paragraphs"] *= count
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review(body="not_present")),
    ]
    result = await rig.run(mode=mode)
    assert result["content"] is None


async def test_signal_cannot_carry_optional_cards_or_unchecked_two_paragraphs(
    rig,
):
    signal = story_editor.story(reading=True)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story(), signal)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert (
        result["content"] == story_editor.story() and result["signal"] is None
    )


async def test_deep_cannot_rewrite_verified_fallback_signal(rig):
    rig.replies = [
        story_editor.reply(
            story_editor.writer(
                story_editor.story(), story_editor.story("new signal")
            )
        )
    ]
    result = await rig.run(mode="deep")
    assert result["content"] is None and result["signal"] is None


async def test_present_component_marked_absent_is_blocked_not_silently_approved(
    rig,
):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="not_present")),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
    ]
    result = await rig.run()
    assert result["content"] is None and len(rig.calls) == 4


async def test_duplicate_component_review_cannot_omit_another_component(rig):
    bad = story_editor.review()
    bad["assessments"][1] = copy.deepcopy(bad["assessments"][0])
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(bad),
    ]
    result = await rig.run()
    assert result["content"] is None and len(rig.calls) == 2


async def test_title_and_limitations_are_bound_into_body_receipt(rig):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    original_hash = next(
        a["content_hash"]
        for a in result["assessments"]
        if a["component"] == "body"
    )
    for key in ("title", "limitations"):
        modified = copy.deepcopy(result["content"])
        modified[key] += " altered"
        assert (
            contracts.content_hash(components.body_content(modified))
            != original_hash
        )


def test_story_schema_derives_fields_and_reading_sources():
    schema = newsletter_workflow_story_editor.story_writer_schema()
    fields = schema["properties"]["content"]["anyOf"][0]["properties"]
    assert (
        "supporting_citations"
        in fields["recommended_reading"]["anyOf"][0]["properties"]
    )
    assert set(fields) == {
        "story_id",
        "title",
        "kind",
        "paragraphs",
        "limitations",
        "recommended_reading",
        "chart",
    }
    assert fields["kind"]["enum"] == list(contracts.SECTION_KINDS)
    assert set(
        newsletter_workflow_story_editor.story_review_schema()["properties"]
    ) == {
        "assessments",
        "issues",
        "prior_withdrawal",
    }


@pytest.mark.parametrize(
    "mode,repair,paragraph_limit",
    [
        ("brief", False, 2),
        ("brief", True, 2),
        ("deep", False, 16),
        ("deep", True, 16),
    ],
)
def test_writer_schema_matches_runtime_mode_and_signal_bounds(
    mode, repair, paragraph_limit
):
    properties = newsletter_workflow_story_editor.story_writer_schema(
        mode, repair=repair
    )["properties"]
    content = properties["content"]["anyOf"][0]["properties"]
    assert content["paragraphs"]["maxItems"] == paragraph_limit
    if mode == "brief" and not repair:
        signal = properties["signal"]["anyOf"][0]["properties"]
        assert signal["paragraphs"]["maxItems"] == 1
        assert (
            signal["chart"] == signal["recommended_reading"] == {"type": "null"}
        )
    else:
        assert properties["signal"] == {"type": "null"}


async def test_mode_specific_schema_is_used_in_initial_and_repair_jobs(rig):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    await rig.run(mode="brief")
    first, repair = (
        rig.calls[0]["schema"]["properties"],
        rig.calls[2]["schema"]["properties"],
    )
    assert (
        first["content"]["anyOf"][0]["properties"]["paragraphs"]["maxItems"]
        == 2
    )
    assert "anyOf" in first["signal"] and repair["signal"] == {"type": "null"}


@pytest.mark.parametrize(
    "override",
    [{"task": {"id": "bad/id"}}, {"mode": "unknown"}, {"is_fixture": "false"}],
)
async def test_unsafe_input_is_rejected_before_model(rig, override):
    with pytest.raises(errors.EditorError, match="invalid input"):
        await rig.run(**override)
    assert not rig.calls


@pytest.mark.parametrize(
    "code", ["authentication", "configuration", "rate_limit"]
)
@pytest.mark.parametrize("stage", ["writer", "review", "repair"])
async def test_account_level_failure_propagates_to_stop_following_model_jobs(
    rig, code, stage
):
    prefix = {
        "writer": [],
        "review": [
            story_editor.reply(story_editor.writer(story_editor.story()))
        ],
        "repair": [
            story_editor.reply(
                story_editor.writer(
                    story_editor.story(),
                    story_editor.story("事件本身已有证据。"),
                )
            ),
            story_editor.reply(
                story_editor.review(body="blocked", signal="approved")
            ),
        ],
    }[stage]
    rig.replies = [*prefix, errors.EditorError(code)]
    with pytest.raises(errors.EditorError) as error:
        await rig.run()
    assert error.value.code == code
    assert len(rig.calls) == len(prefix) + 1
    assert len(rig.checkpoints) == (1 if stage == "repair" else 0)


async def verified_prior(rig):
    rig.replies = [
        story_editor.reply(
            story_editor.writer(
                story_editor.story(),
                story_editor.story("独立确认的最小事件描述。"),
            )
        ),
        story_editor.reply(story_editor.review(signal="approved")),
    ]
    prior = await rig.run()
    rig.calls.clear()
    rig.checkpoints.clear()
    return prior


def withdrawal(prior, **changes):
    return {
        "target_body_hash": contracts.content_hash(
            components.body_content(prior["content"])
        ),
        "affected_signal_hash": "",
        "claim": prior["content"]["paragraphs"][0]["text"],
        "reason": "离线fixture新来源明确否定旧数字，测试精确撤回而非缺少研究。",
        "evidence": ["packet/publication"],
        **changes,
    }


async def test_deep_review_withdraws_disproved_brief_without_extra_call(
    rig,
):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(
            story_editor.writer(
                story_editor.story("新证据支持的独立完整报道。")
            )
        ),
        story_editor.reply(
            story_editor.review(prior_withdrawal=withdrawal(prior))
        ),
    ]
    result = await rig.run(mode="deep", prior=prior, packets=prior["packets"])
    assert len(rig.calls) == 2 and result["content"] is not None
    item = result["withdrawals"][0]
    assert item["content_hash"] == contracts.content_hash(
        components.body_content(prior["content"])
    )
    assert item["affected_signal_hash"] == "" and item["mode"] == "brief"
    assert item["reviewer_job_id"] in {
        r["reviewer_job_id"] for r in result["assessments"]
    }
    assert rig.calls[1]["prompt"]["prior_verified_brief_untrusted"] == prior
    assert rig.checkpoints == [result]
    publication.validate_result(result)


async def test_withdrawal_checkpoint_survives_missing_deep_body(
    rig,
):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(story_editor.writer()),
        story_editor.reply(
            story_editor.review(
                body="not_present", prior_withdrawal=withdrawal(prior)
            )
        ),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert result["content"] is None and result["signal"] is None
    assert len(result["withdrawals"]) == 1 and rig.checkpoints == [result]
    assert len(rig.calls) == 2
    publication.validate_result(result)


async def test_withdrawal_survives_later_deep_repair_cancellation(rig):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(
            story_editor.writer(
                story_editor.story("新深读尚未正确，不可替代旧文。")
            )
        ),
        story_editor.reply(
            story_editor.review(
                body="blocked", prior_withdrawal=withdrawal(prior)
            )
        ),
        asyncio.CancelledError(),
    ]
    with pytest.raises(asyncio.CancelledError):
        await rig.run(mode="deep", prior=prior)
    assert len(rig.checkpoints) == 1 and rig.checkpoints[0]["withdrawals"]
    assert rig.checkpoints[0]["content"] is None
    publication.validate_result(rig.checkpoints[0])


async def test_review_can_explicitly_bind_the_same_error_in_paraphrased_signal(
    rig,
):
    prior = await verified_prior(rig)
    proposal = withdrawal(
        prior, affected_signal_hash=contracts.content_hash(prior["signal"])
    )
    rig.replies = [
        story_editor.reply(story_editor.writer()),
        story_editor.reply(
            story_editor.review(body="not_present", prior_withdrawal=proposal)
        ),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert result["withdrawals"][0][
        "affected_signal_hash"
    ] == contracts.content_hash(prior["signal"])
    publication.validate_result(result)


@pytest.mark.parametrize(
    "changes",
    [
        {"target_body_hash": "0" * 64},
        {"claim": "too short"},
        {"claim": "这一段根本不是任何旧简讯的逐字摘录。"},
        {"reason": ""},
        {"reason": " "},
        {"evidence": []},
        {"evidence": ["packet/missing"]},
        {"evidence": ["packet/publication", "packet/publication"]},
        {"affected_signal_hash": "0" * 64},
        {"affected_signal_hash": None},
    ],
)
async def test_unsupported_withdrawal_preserves_old_and_new_bodies(
    rig, changes
):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(
            story_editor.review(prior_withdrawal=withdrawal(prior, **changes))
        ),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert "withdrawals" not in result and result["content"] is not None
    assert any(
        issue["reason"] == "invalid_prior_withdrawal"
        for issue in result["issues"]
    )
    publication.validate_result(result)


@pytest.mark.parametrize(
    "opened,searched",
    [
        ({story_editor.URL}, True),
        ({story_editor.URL, story_editor.SECOND_URL}, False),
        (set(), True),
    ],
)
async def test_prior_withdrawal_requires_fresh_open_of_its_specific_evidence(
    rig, opened, searched
):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(story_editor.writer()),
        story_editor.reply(
            story_editor.review(
                body="not_present", prior_withdrawal=withdrawal(prior)
            ),
            opened=opened,
            searched=searched,
        ),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert "withdrawals" not in result and not rig.checkpoints


async def test_metadata_evidence_cannot_withdraw_independently_approved_brief(
    rig,
):
    prior = await verified_prior(rig)
    rig.packet["content"]["sources"][1]["access_scope"] = "metadata"
    rig.packet["content_hash"] = contracts.content_hash(rig.packet["content"])
    rig.replies = [
        story_editor.reply(story_editor.writer()),
        story_editor.reply(
            story_editor.review(
                body="not_present", prior_withdrawal=withdrawal(prior)
            )
        ),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert "withdrawals" not in result


@pytest.mark.parametrize(
    "mutation", ["other_story", "tampered_receipt", "not_brief"]
)
async def test_withdrawal_requires_a_genuinely_bound_prior_brief(rig, mutation):
    prior = await verified_prior(rig)
    if mutation == "other_story":
        prior["story_id"] = "other-story"
    elif mutation == "tampered_receipt":
        prior["assessments"][0]["searched"] = False
    else:
        prior["mode"] = "deep"
    rig.replies = [
        story_editor.reply(story_editor.writer()),
        story_editor.reply(
            story_editor.review(
                body="not_present", prior_withdrawal=withdrawal(prior)
            )
        ),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert "withdrawals" not in result
    assert len(rig.calls) == 1


async def test_ordinary_deep_hold_never_implicitly_withdraws_verified_brief(
    rig,
):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
    ]
    result = await rig.run(mode="deep", prior=prior)
    assert result["content"] is None and "withdrawals" not in result
    assert rig.calls[-1]["prompt"]["prior_verified_brief_untrusted"] is None


async def test_brief_stage_cannot_issue_a_prior_withdrawal(rig):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(
            story_editor.review(prior_withdrawal=withdrawal(prior))
        ),
    ]
    result = await rig.run(mode="brief", prior=prior)
    assert "withdrawals" not in result and result["content"] is not None


async def test_review_gets_code_owned_body_and_reading_urls(
    rig,
):
    rig.replies = [
        story_editor.reply(
            story_editor.writer(story_editor.story(reading=True, chart=True))
        ),
        story_editor.reply(
            story_editor.review(reading="approved", chart="approved")
        ),
    ]
    result = await rig.run(mode="deep")
    publication.validate_result(result)
    expected = rig.calls[1]["approval_sources"]
    assert expected.components["body"] == [story_editor.URL]
    assert expected.components["reading"] == [
        story_editor.URL,
        story_editor.SECOND_URL,
    ]
    assert expected.components["chart"] == [story_editor.URL]
    assert expected.evidence == {} and rig.calls[0]["approval_sources"] is None


async def test_missing_url_diagnostic_identifies_exact_component_reference_url(
    rig,
):
    rig.replies = [
        story_editor.reply(
            story_editor.writer(story_editor.story(reading=True))
        ),
        story_editor.reply(
            story_editor.review(reading="approved"), opened={story_editor.URL}
        ),
    ]
    result = await rig.run(mode="deep")
    assert result["content"] == story_editor.story() and len(rig.calls) == 2
    assert any(
        story_editor.SECOND_URL in finding
        for assessment in result["assessments"]
        if assessment["component"] == "reading"
        for finding in assessment["findings"]
    )
    assert any(
        issue["component"] == "reading"
        and "missing_review_open_url" in issue["reason"]
        and issue["evidence"] == ["packet/publication"]
        for issue in result["issues"]
    )
    publication.validate_result(result)


async def test_metadata_diagnostic_guides_repair_without_scope_upgrade(
    rig,
):
    rig.packet["content"]["sources"][0]["access_scope"] = "metadata"
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"] is None
    first = next(a for a in result["assessments"] if a["component"] == "body")
    assert any(
        "metadata_citations_not_publishable: packet/source" in finding
        for finding in first["findings"]
    )
    assert not any(
        "missing_review_open" in finding for finding in first["findings"]
    )
    repair = rig.calls[2]["prompt"]["repair_untrusted"]
    assert any(
        "metadata_citations_not_publishable" in issue["reason"]
        and issue["action"] == "remove"
        for issue in repair["issues"]
    )
    rules = rig.calls[0]["prompt"]["output_rules"]
    assert "不得为了过审把来源access_scope标高" in rules
    assert "必须另外写出1段最小signal" in rules
    assert "只有事件本身无法确认时signal才为null" in rules


async def test_missing_search_diagnostic_is_distinct_from_url_or_scope_problem(
    rig,
):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(), searched=False),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(), searched=False),
    ]
    result = await rig.run()
    first = next(a for a in result["assessments"] if a["component"] == "body")
    assert any(
        "missing_review_search" in finding for finding in first["findings"]
    )
    assert not any(
        "missing_review_open" in finding or "metadata_citations" in finding
        for finding in first["findings"]
    )
    assert any(
        "missing_review_search" in issue["reason"]
        and issue["action"] == "research"
        for issue in result["issues"]
    )


async def test_only_deep_initial_review_receives_withdrawal_evidence_lookup(
    rig,
):
    prior = await verified_prior(rig)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review(body="blocked")),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    await rig.run(mode="deep", prior=prior)
    assert rig.calls[1]["approval_sources"].evidence == {
        "packet/source": story_editor.URL,
        "packet/publication": story_editor.SECOND_URL,
    }
    assert rig.calls[3]["approval_sources"].evidence == {}


def test_schema_binds_current_story_id_exact_citations_and_excludes_metadata(
    rig,
):
    rig.packet["content"]["sources"][1]["access_scope"] = "metadata"
    schema = newsletter_workflow_story_editor.story_writer_schema(
        "brief", story_id="story-a", packets=[rig.packet]
    )
    props = schema["properties"]["content"]["anyOf"][0]["properties"]
    assert props["story_id"]["enum"] == ["story-a"]
    pattern = props["paragraphs"]["items"]["properties"]["citations"]["items"][
        "pattern"
    ]
    for ref in (
        "packet/source",
        "supplement-1/primary",
        "supplement-6/source-2",
    ):
        assert re.fullmatch(pattern, ref)
    for ref in (
        "packet/publication",
        "packet/missing",
        "wrong/source",
        "supplement-7/source",
        story_editor.URL,
    ):
        assert not re.fullmatch(pattern, ref)
    signal = schema["properties"]["signal"]["anyOf"][0]["properties"]
    assert signal["story_id"]["enum"] == ["story-a"]
    assert (
        signal["paragraphs"]["items"]["properties"]["citations"]["items"][
            "pattern"
        ]
        == pattern
    )


def test_schema_text_and_chart_bounds_match_runtime_contract(rig):
    props = newsletter_workflow_story_editor.story_writer_schema(
        "brief", packets=[rig.packet]
    )["properties"]["content"]["anyOf"][0]["properties"]
    assert (
        props["title"]["maxLength"] == 300
        and props["limitations"]["maxLength"] == 4000
    )
    paragraph = props["paragraphs"]["items"]["properties"]
    assert paragraph["text"]["maxLength"] == 8000
    assert paragraph["citations"]["minItems"] == 1
    assert "uniqueItems" not in paragraph["citations"]
    reading = props["recommended_reading"]["anyOf"][0]["properties"]
    assert reading["reason"]["maxLength"] == 1000
    assert reading["supporting_citations"]["maxItems"] == 31
    assert "uniqueItems" not in reading["supporting_citations"]
    chart = props["chart"]["anyOf"][0]["properties"]
    assert chart["points"]["maxItems"] == 32
    assert all(
        chart[key]["maxLength"] == 1000
        for key in (
            "question",
            "metric",
            "unit",
            "period",
            "caption",
            "alt_text",
        )
    )
    point = next(
        item["properties"]
        for item in chart["points"]["items"]["anyOf"]
        if "decimal_value" in item["properties"]
    )
    assert point["citations"]["minItems"] == 1
    for value in ("-2.3", "0", "5.9", "1e-3"):
        assert re.fullmatch(point["decimal_value"]["pattern"], value)
    for value in ("23%", "1,000", "NaN", "Infinity", "2万人"):
        assert not re.fullmatch(point["decimal_value"]["pattern"], value)


def test_supplement_source_and_body_schema_are_bounded_like_contract():
    props = newsletter_workflow_story_editor.story_writer_schema()[
        "properties"
    ]["supplemental_packets"]["items"]["properties"]["content"]["properties"]
    assert props["body"]["maxLength"] == 65536
    assert (
        props["sources"]["minItems"] == 1 and props["sources"]["maxItems"] == 32
    )
    source = props["sources"]["items"]["properties"]
    assert (
        source["url"]["maxLength"] == 2048
        and source["excerpt"]["maxLength"] == 20000
    )


async def test_exact_duplicate_references_removed_preserves_any_prose(
    rig,
):
    content = story_editor.story(reading=True, chart=True)
    original = copy.deepcopy(content)
    content["paragraphs"][0]["citations"] = ["packet/source", "packet/source"]
    content["recommended_reading"]["supporting_citations"] = [
        "packet/source",
        "packet/publication",
        "packet/publication",
    ]
    content["chart"]["points"][0]["citations"] *= 2
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(
            story_editor.review(reading="approved", chart="approved")
        ),
    ]
    result = await rig.run()
    assert result["content"] == original and len(rig.calls) == 2
    publication.validate_result(result)


@pytest.mark.parametrize(
    "kind",
    [
        "world",
        "feature",
        "context",
        "ai_ml",
        "science",
        "economy",
        "technology",
        "health",
    ],
)
async def test_semantic_story_kind_survives_writer_validation_and_review(
    rig, kind
):
    content = story_editor.story()
    content["kind"] = kind
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"]["kind"] == kind
    publication.validate_result(result)


async def test_writer_schema_excludes_metadata_citations(
    rig,
):
    rig.packet["content"]["sources"][1]["access_scope"] = "metadata"
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"] is not None
    assert rig.calls[0]["schema"]["properties"]["content"]["anyOf"][0][
        "properties"
    ]["story_id"]["enum"] == ["story-a"]
    assert rig.calls[0]["prompt"]["available_citations"] == ["packet/source"]


@pytest.mark.parametrize(
    "mutation,expected",
    [
        ("id", "story_id_mismatch"),
        ("long_title", "title exceeds its length limit"),
        ("paragraphs", "paragraph_count_outside_mode_limit"),
        ("no_citation", "paragraph_missing_citation"),
        ("unknown_citation", "INVALID_CITATION"),
    ],
)
async def test_invalid_body_gets_safe_diagnostic_repair_and_review(
    rig, mutation, expected
):
    content = story_editor.story()
    if mutation == "id":
        content["story_id"] = "wrong-id"
    elif mutation == "long_title":
        content["title"] = "private-like-invalid-payload-" * 20
    elif mutation == "paragraphs":
        content["paragraphs"] *= 3
    elif mutation == "no_citation":
        content["paragraphs"][0]["citations"] = []
    else:
        content["paragraphs"][0]["citations"] = ["packet/missing"]
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(
            story_editor.writer(
                story_editor.story("经过修复并等待独审的正文。")
            )
        ),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["reason"] == "repaired" and result["content"] is not None
    assert len(rig.calls) == 3 and len(rig.checkpoints) == 1
    assert expected in result["issues"][0]["reason"]
    assert (
        expected
        in rig.calls[1]["prompt"]["repair_untrusted"]["issues"][0]["reason"]
    )
    assert "private-like-invalid-payload" not in json.dumps(result)
    assert all(
        receipt["round"] == "repair" for receipt in result["assessments"]
    )
    publication.validate_result(result)


async def test_malformed_signal_can_be_repaired_into_a_reviewed_brief(
    rig,
):
    malformed = story_editor.story("仅用于测试的最小事件。")
    malformed["story_id"] = "wrong-id"
    rig.replies = [
        story_editor.reply(story_editor.writer(None, malformed)),
        story_editor.reply(
            story_editor.writer(story_editor.story("格式修正后的简版事实。"))
        ),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["reason"] == "repaired" and result["signal"] is None
    assert (
        rig.calls[1]["prompt"]["repair_untrusted"]["source_component"]
        == "signal"
    )
    assert len(rig.calls) == 3 and all(
        r["round"] == "repair" for r in result["assessments"]
    )
    publication.validate_result(result)


async def test_second_bad_signal_cannot_get_approval_or_third_writer(
    rig,
):
    malformed = story_editor.story()
    malformed["paragraphs"][0]["citations"] = ["unknown/source"]
    rig.replies = [
        story_editor.reply(story_editor.writer(None, malformed)),
        story_editor.reply(story_editor.writer(malformed)),
    ]
    result = await rig.run()
    assert result["content"] is None and result["signal"] is None
    assert (
        len(rig.calls) == 2
        and not result["assessments"]
        and not rig.checkpoints
    )
    assert (
        sum(
            "component_contract_invalid" in issue["reason"]
            for issue in result["issues"]
        )
        == 2
    )


async def test_signal_checkpoint_precedes_body_repair_and_review(
    rig,
):
    malformed = story_editor.story()
    malformed["story_id"] = "wrong-id"
    signal = story_editor.story("可独立核实的最小事件。")
    rig.replies = [
        story_editor.reply(story_editor.writer(malformed, signal)),
        story_editor.reply(
            story_editor.review(body="not_present", signal="approved")
        ),
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert len(rig.calls) == 4 and result["content"] is not None
    assert (
        rig.checkpoints[0]["content"] is None
        and rig.checkpoints[0]["signal"] == signal
    )
    assert rig.checkpoints[-1]["content"] == story_editor.story()


@pytest.mark.parametrize("mode", ["brief", "deep"])
async def test_empty_writer_without_verifiable_prior_never_spend_review_call(
    rig, mode
):
    rig.replies = [story_editor.reply(story_editor.writer())]
    result = await rig.run(mode=mode)
    assert len(rig.calls) == 1 and result["reason"] == "withheld"
    assert (
        result["assessments"] == []
        and result["issues"][0]["reason"] == "empty_component_review_skipped"
    )
    assert not rig.checkpoints


async def test_invalid_writer_output_is_not_mislabeled_as_provider_outage(rig):
    rig.replies = [story_editor.reply({"content": None})]
    result = await rig.run(mode="deep")
    assert result["reason"] == "invalid_output"
    assert result["issues"][0]["reason"] == "writer:writer_envelope_invalid"


async def test_bad_review_records_phase_without_publication(
    rig,
):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply({"prose": "I approve everything"}),
    ]
    result = await rig.run()
    assert result["reason"] == "invalid_output" and result["content"] is None
    assert result["issues"][0]["reason"].startswith("review:")


async def test_meaningful_same_source_chart_can_be_prepared_approved_in_brief(
    rig,
):
    content = story_editor.story(chart=True)
    content["chart"]["points"][1]["decimal_value"] = "-2"
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review(chart="approved")),
    ]
    result = await rig.run(mode="brief")
    assert (
        result["content"]["chart"] == content["chart"] and len(rig.calls) == 2
    )
    rules = rig.calls[0]["prompt"]["output_rules"]
    assert "brief和deep都要检查" in rules and "2–6个同口径数据点" in rules
    assert "需要看清什么差异、用什么参照、理解后意味着什么" in rules
    assert "只有数值图确实比文字更能解释这个问题" in rules
    assert "作者自设门槛、运行次数不自动具有图表价值" in rules
    assert "缺少解释价值就chart=null" in rules
    assert "若有就在本轮给chart" not in rules
    assert "不能把同比与环比" in rules and "没有合适数据就null" in rules
    publication.validate_result(result)


@pytest.mark.parametrize("mode", ["brief", "deep"])
async def test_chart_guidance_reaches_writer_and_independent_review(rig, mode):
    """Check prompt plumbing, not chart clarity from a simulated approval."""
    content = story_editor.story(chart=True)
    content["chart"]["unit"] = "Cohen's d（离线虚构比较）"
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review(chart="approved")),
    ]
    result = await rig.run(mode=mode, policy=reader_policy())
    author, reviewer = rig.calls
    assert (
        author["prompt"]["chart_guidance"]
        == newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert "独立图题" in newsletter_workflow_story_editor._CHART_GUIDANCE
    assert (
        "模型名、组名不能替代背景"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "比较基线是谁必须在图内说清"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert "数据或实验时期" in newsletter_workflow_story_editor._CHART_GUIDANCE
    assert (
        "caption先说一个主要洞见"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "零点及方向，不把它当百分比"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "不自行加入“大/中/小效果”等统计阈值"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "图片看不到时仍有意义"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "limitations只留影响这张图结论的关键边界"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "已有材料不足以支持自足比较就chart=null"
        in newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    review_rules = reviewer["prompt"]["chart_review_rules"]
    assert review_rules.startswith(
        newsletter_workflow_story_editor._CHART_GUIDANCE
    )
    assert (
        "先遮住正文" in review_rules
        and "不能只核对数字与来源相等" in review_rules
    )
    assert "只将chart标blocked" in review_rules
    assert "单纯措辞偏好留findings" in review_rules
    assert "图卡应脱离正文自足" in author["instructions"]
    # Statistical labels are not lexical vetoes: source-backed review decides.
    assert result["content"] == content and len(rig.calls) == 2
    publication.validate_result(result)


async def test_ambiguous_chart_review_drops_chart_without_extra_call(
    rig,
):
    """Reproduce opaque titles with an explicitly simulated review finding."""
    content = story_editor.story(chart=True)
    content["chart"].update(
        question="哪一层情境意识改善最大",
        metric="Cohen's d",
        unit="Cohen's d",
        caption="离线虚构说明，仅描述哪根柱最高。",
    )
    issue = {
        "component": "chart",
        "claim": content["chart"]["question"],
        "reason": (
            "离线模拟：图中缺少对象、比较基线及尺度方向，正文不能替图补全。"
        ),
        "evidence": ["packet/source"],
        "action": "remove",
    }
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(
            story_editor.review(chart="blocked", issues=[issue])
        ),
    ]
    result = await rig.run()
    assert (
        result["content"] == components.body_content(content)
        and len(rig.calls) == 2
    )
    assert result["reason"] == "approved"
    assert result["issues"][0]["component"] == "chart"
    assert result["issues"][0]["reason"] == issue["reason"]
    publication.validate_result(result)


async def test_absent_chart_adds_no_review_instruction_or_call(
    rig,
):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["content"] == story_editor.story() and len(rig.calls) == 2
    assert "chart_review_rules" not in rig.calls[1]["prompt"]
    assert next(a for a in result["assessments"] if a["component"] == "chart")[
        "status"
    ] == ("not_present")
    publication.validate_result(result)


def reader_policy():
    directory = (
        pathlib.Path(__file__).resolve().parents[1] / "src/newsletter/policy"
    )
    return {
        "editorial.md": (directory / "story-editorial.md").read_text(
            encoding="utf-8"
        ),
        "reader-profile.md": (directory / "reader-profile.md").read_text(
            encoding="utf-8"
        ),
    }


@pytest.mark.parametrize(
    "mode,kind",
    [
        ("brief", "ai_ml"),
        ("deep", "ai_ml"),
        ("brief", "economy"),
        ("deep", "world"),
    ],
)
async def test_reader_first_guidance_reaches_writer_without_new_review_gate(
    rig, mode, kind
):
    """Offline prompt plumbing, not evidence that an LLM writes better prose."""
    content = {**story_editor.story(), "kind": kind}
    policy = reader_policy()
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(mode=mode, policy=policy)
    assert result["content"] == content and len(rig.calls) == 2
    author, reviewer = rig.calls
    assert (
        author["prompt"]["writing_guidance"]
        == newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert author["prompt"]["reader_profile"] == policy["reader-profile.md"]
    assert all(
        call["instructions"] == policy["editorial.md"] for call in rig.calls
    )
    assert (
        "先交代背景、要解决的问题和原来怎么做"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert (
        "世界新闻和经济报道"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert (
        "术语或缩写首次出现"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert (
        "只保留能帮助理解变化的少量数字"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert (
        "而不是扩写摘要、增加数字、术语或段数"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert (
        "不要把搜索/open、JSON、审校/修订经过倒进报道"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert (
        "不是新增字数、术语或背景的审校阻断条件"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert "writing_guidance" not in reviewer["prompt"]
    assert "不因为文风或可有可无扩展研究阻断" in reviewer["prompt"]["rules"]
    paragraphs = author["schema"]["properties"]["content"]["anyOf"][0][
        "properties"
    ]["paragraphs"]
    assert paragraphs["minItems"] == 1
    assert paragraphs["maxItems"] == (2 if mode == "brief" else 16)
    publication.validate_result(result)


@pytest.mark.parametrize("known", [True, False])
async def test_source_identity_and_contribution_remain_untrusted_writer_context(
    rig, known
):
    """New candidate fields propagate without becoming citations or approval."""
    details = {
        "authors": "Fixture Author",
        "affiliations": "Fixture Research Institute",
        "venue": "Fixture Conference",
        "publication_status": "Fixture preprint, not an acceptance claim",
        "contribution": "A different way to examine a fictional bottleneck",
        "source_basis": "Fixture discovery lead; not a quality judgement",
    }
    candidate = {
        "id": "candidate-a",
        **{name: value if known else "" for name, value in details.items()},
        "evidence_urls": [story_editor.URL] if known else [],
    }
    original = copy.deepcopy(candidate)
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(candidates=[candidate])
    prompt = rig.calls[0]["prompt"]
    assert (
        prompt["candidates_untrusted"] == [original] and candidate == original
    )
    assert prompt["available_citations"] == [
        "packet/source",
        "packet/publication",
    ]
    assert "只是待核线索，不是发表引用或质量背书" in prompt["writing_guidance"]
    assert "不得把网页发布方当作者单位" in prompt["writing_guidance"]
    assert len(rig.calls) == 2
    publication.validate_result(result)


async def test_repair_keeps_reader_guidance_and_approved_signal(
    rig,
):
    """Keep the four-call repair path bounded and separately reviewed."""
    original, fixed = (
        story_editor.story(),
        story_editor.story("修正后的虚构事件，不是真实报道。"),
    )
    signal = story_editor.story("仅确认虚构事件存在。")
    policy = reader_policy()
    rig.replies = [
        story_editor.reply(story_editor.writer(original, signal)),
        story_editor.reply(
            story_editor.review(body="blocked", signal="approved")
        ),
        story_editor.reply(story_editor.writer(fixed)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(policy=policy)
    assert result["content"] == fixed and result["signal"] == signal
    assert len(rig.calls) == 4 and len(rig.checkpoints) == 2
    assert (
        rig.checkpoints[0]["content"] is None
        and rig.checkpoints[0]["signal"] == signal
    )
    for index in (0, 2):
        prompt = rig.calls[index]["prompt"]
        assert (
            prompt["writing_guidance"]
            == newsletter_workflow_story_editor._WRITING_GUIDANCE
        )
        assert (
            prompt["chart_guidance"]
            == newsletter_workflow_story_editor._CHART_GUIDANCE
        )
        assert prompt["reader_profile"] == policy["reader-profile.md"]
    assert (
        "repair只在原修订范围内改善解释"
        in newsletter_workflow_story_editor._WRITING_GUIDANCE
    )
    assert "不得更改已批准的简讯" in rig.calls[2]["prompt"]["task"]
    assert len({call["path"] for call in rig.calls}) == 4
    for checkpoint in rig.checkpoints:
        publication.validate_result(checkpoint)


async def test_abstract_brief_has_no_length_or_background_gate(
    rig,
):
    """Keep simulated review decisions independent of stylistic validators."""
    rig.packet["content"]["sources"][0]["access_scope"] = "abstract"
    rig.packet["content_hash"] = contracts.content_hash(rig.packet["content"])
    content = story_editor.story("离线虚构事件。")
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(policy=reader_policy())
    assert result["content"] == content and result["issues"] == []
    assert len(rig.calls) == 2
    publication.validate_result(result)


@pytest.mark.parametrize("kind", ["ai_ml", "economy"])
async def test_explainer_guidance_has_no_formula_or_statistic_gate(rig, kind):
    """Check targeted guidance without censoring model-approved text."""
    content = {
        **story_editor.story(
            "离线虚构统计记录：参数λ、78.64%、样本期；不是实际研究结论。"
        ),
        "kind": kind,
    }
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(policy=reader_policy())
    guidance = rig.calls[0]["prompt"]["writing_guidance"]
    assert "帮助读者想明白的解释者" in guidance
    assert "定义术语只是起点" in guidance
    assert "本篇相对原有认识的增量" in guidance
    assert "把公式换成另一种数学写法也不等于解释了机制" in guidance
    assert "AI例：" in guidance and "金融例：" in guidance
    assert "只是表达对照，不是本题证据" in guidance
    assert "不编造真实应用或实验" in guidance
    assert "不以通俗为由抹去必要限制" in guidance
    assert result["content"] == content and result["issues"] == []
    assert len(rig.calls) == 2
    assert "writing_guidance" not in rig.calls[1]["prompt"]
    publication.validate_result(result)


# Frozen headline excerpts: code pins each consensus group's feed excerpts
# by sha256 at fetch time. A brief may confirm the event in one paragraph
# citing two outlets' excerpts; the body, a lone outlet, an edited excerpt or
# a writer's own packet keeps the must-open rule, and publication checks the
# same binding again.

NOW = datetime.datetime(2026, 9, 6, 6, 0, tzinfo=datetime.UTC)
# Synthetic outlets reporting one fictional election.
REPORTS = (
    (
        "Synthetic Wire",
        "https://wire.example.org/freedonia-vote",
        "Liberty Party wins majority in Freedonia election",
        "Voters handed the Liberty Party a parliamentary majority.",
    ),
    (
        "Synthetic Daily",
        "https://daily.example.org/world/freedonia",
        "Freedonia's ruling coalition ousted",
        "",
    ),
    (
        "Synthetic Radio",
        "https://radio.example.org/2026/09/06/freedonia",
        "Liberty Party leader claims victory",
        "Official results give the Liberty Party a majority of seats.",
    ),
)


def frozen_group(reports=REPORTS):
    return {
        "lead": "candidate-vote",
        "items": [
            feed_excerpts.excerpt(
                outlet,
                url,
                title,
                NOW - datetime.timedelta(minutes=10 * number),
                text,
            )
            for number, (outlet, url, title, text) in enumerate(reports)
        ],
    }


def cited(text, *numbers, packet_id):
    value = story_editor.story(text)
    value["paragraphs"][0]["citations"] = [
        f"{packet_id}/excerpt-{number}" for number in numbers
    ]
    return value


@pytest.fixture
def excerpts(rig):
    """Give the rig the pins and packets the story node would build."""
    groups = [frozen_group()]
    rig.editor = newsletter_workflow_story_editor.StoryEditor(
        rig.editor.editor, pins=feed_excerpts.pins(groups)
    )
    return feed_excerpts.packets(groups, is_fixture=True)


def signal_receipt(result):
    return next(a for a in result["assessments"] if a["component"] == "signal")


async def confirmed(rig, packets):
    signal = cited(
        "据Synthetic Wire、Synthetic Radio报道，虚构的自由党赢得议会多数。",
        1,
        3,
        packet_id=packets[0]["id"],
    )
    rig.replies = [
        story_editor.reply(story_editor.writer(None, signal), opened=set()),
        story_editor.reply(
            story_editor.review(body="not_present", signal="approved"),
            opened=set(),
        ),
    ]
    return signal, await rig.run(packets=packets)


def test_excerpts_are_pinned_and_the_packet_is_the_same_every_time():
    group = frozen_group()
    wire, daily, _ = group["items"]
    assert wire == {
        "outlet": "Synthetic Wire",
        "url": REPORTS[0][1],
        "title": REPORTS[0][2],
        "published_at": "2026-09-06T06:00:00Z",
        "text": REPORTS[0][2] + "\n" + REPORTS[0][3],
        "sha256": feed_excerpts.digest(REPORTS[0][2] + "\n" + REPORTS[0][3]),
    }
    # A headline with no description is still the outlet's own words.
    assert daily["text"] == REPORTS[1][2]
    (packet,) = feed_excerpts.packets([group], is_fixture=True)
    assert packet == feed_excerpts.packet(copy.deepcopy(group), is_fixture=True)
    assert packet["id"].startswith("feed-") and len(packet["id"]) == 37
    assert packet["created_at"] == wire["published_at"]
    assert feed_excerpts.is_packet(packet)
    contracts.validate_packet_body(packet["content"])
    assert [
        (source["title"], source["access_scope"])
        for source in packet["content"]["sources"]
    ] == [(f"{outlet}：{title}", "abstract") for outlet, _, title, _ in REPORTS]
    pins = feed_excerpts.pins([group])
    assert feed_excerpts.pinned([packet], pins) == {
        f"{packet['id']}/excerpt-{n}": outlet
        for n, (outlet, *_) in enumerate(REPORTS, 1)
    }
    # The same text in a writer's own packet is never a frozen excerpt.
    writer = {**packet, "workflow_id": "story-research"}
    assert feed_excerpts.pinned([writer], pins) == {}
    edited = copy.deepcopy(packet)
    edited["content"]["sources"][0]["excerpt"] += " Edited."
    assert list(feed_excerpts.pinned([edited], pins)) == [
        f"{packet['id']}/excerpt-2",
        f"{packet['id']}/excerpt-3",
    ]


def test_only_intact_groups_a_url_points_at_travel_on():
    group, other = frozen_group(), frozen_group(REPORTS[1:])
    other["lead"] = "candidate-other"
    for item in other["items"]:
        item["url"] = item["url"].replace(".org/", ".org/other/")
    tampered = frozen_group()
    tampered["items"][0]["text"] += " Edited."
    tampered["items"][1]["sha256"] = "0" * 64
    found = feed_excerpts.covered(
        [group, other, tampered, "not a group", {"items": None}],
        ["https://daily.example.org/world/freedonia?utm_source=x"],
    )
    # The tampered copy keeps one outlet, too few to confirm anything.
    assert found == [group]
    assert feed_excerpts.covered([group], ["https://example.org/x"]) == []
    assert feed_excerpts.covered(None, [REPORTS[0][1]]) == []


async def test_two_outlets_pinned_excerpts_confirm_a_signal_without_open(
    rig, excerpts
):
    signal, result = await confirmed(rig, excerpts)
    assert result["signal"] == signal and result["content"] is None
    assert result["reason"] == "confirmed_signal" and len(rig.calls) == 2
    receipt = signal_receipt(result)
    assert receipt["status"] == "approved" and receipt["opened"] is False
    assert receipt["excerpts"] == [
        {
            "url": url,
            "sha256": feed_excerpts.digest(f"{title}\n{text}"),
            "outlet": outlet,
        }
        for outlet, url, title, text in sorted(
            (REPORTS[0], REPORTS[2]), key=lambda report: report[1]
        )
    ]
    # Code never asks the review to open what it reads from the frozen text.
    assert rig.calls[1]["approval_sources"].components == {"signal": []}
    for call in rig.calls:
        assert "feed_excerpt_rules" in call["prompt"]
    assert "据X、Y报道" in rig.calls[0]["prompt"]["feed_excerpt_rules"]
    assert "仍须本轮search" in rig.calls[1]["prompt"]["feed_excerpt_rules"]
    publication.validate_result(result)
    built = publication.assemble(
        "run-1",
        "2026-09-06",
        [publication_support.task(1, id="story-a")],
        [result],
    )
    assert built["coverage"]["stories"][0]["disposition"] == "watch"
    assert built["packets"] == excerpts


async def test_one_outlets_excerpt_cannot_confirm_a_signal(rig, excerpts):
    signal = cited(
        "据Synthetic Wire报道，虚构的自由党赢得议会多数。",
        1,
        packet_id=excerpts[0]["id"],
    )
    rig.replies = [
        story_editor.reply(story_editor.writer(None, signal), opened=set()),
        story_editor.reply(
            story_editor.review(body="not_present", signal="approved"),
            opened=set(),
        ),
    ]
    result = await rig.run(packets=excerpts)
    assert result["signal"] is None and result["reason"] == "withheld"
    receipt = signal_receipt(result)
    assert receipt["status"] == "blocked"
    assert any(
        "single_outlet_excerpt_signal" in finding
        for finding in receipt["findings"]
    )
    publication.validate_result(result)


async def test_a_body_citing_excerpts_still_needs_the_open(rig, excerpts):
    packet_id = excerpts[0]["id"]
    body = cited("虚构的自由党赢得议会多数。", 1, 3, packet_id=packet_id)
    signal = cited(
        "据两家虚构媒体报道，选举已有结果。", 1, 3, packet_id=packet_id
    )
    rig.replies = [
        story_editor.reply(story_editor.writer(body, signal), opened=set()),
        story_editor.reply(
            story_editor.review(signal="approved"), opened=set()
        ),
        # The one repair gives up without a body: nothing left to review.
        story_editor.reply(story_editor.writer(None), opened=set()),
    ]
    result = await rig.run(packets=excerpts)
    assert result["content"] is None and result["signal"] == signal
    assert len(rig.calls) == 3
    receipt = next(a for a in result["assessments"] if a["component"] == "body")
    assert receipt["status"] == "blocked" and "excerpts" not in receipt
    assert any(
        f"missing_review_open_url: {REPORTS[0][1]}" == finding
        for finding in receipt["findings"]
    )
    assert set(rig.calls[1]["approval_sources"].components["body"]) == {
        REPORTS[0][1],
        REPORTS[2][1],
    }
    # A repair writes no new signal, so it only hears the must-open rule.
    rules = rig.calls[2]["prompt"]["feed_excerpt_rules"]
    assert "仍须本轮独立open" in rules and "据X、Y报道" not in rules
    publication.validate_result(result)


QUAKE = (
    (
        "Synthetic Post",
        "https://post.example.org/sylvania-quake",
        "Earthquake kills 12 in Sylvania capital",
        "A magnitude 6.8 earthquake killed 12 people in the capital.",
    ),
    (
        "Synthetic Times",
        "https://times.example.org/world/sylvania",
        "Sylvania quake leaves thousands displaced",
        "Officials said 1,250 people were displaced by the 6.8 quake.",
    ),
)


def vote_and_quake(rig):
    """Give the rig two frozen groups: the vote and an unrelated quake."""
    vote, quake = frozen_group(), frozen_group(QUAKE)
    quake["lead"] = "candidate-quake"
    rig.editor = newsletter_workflow_story_editor.StoryEditor(
        rig.editor.editor, pins=feed_excerpts.pins([vote, quake])
    )
    return feed_excerpts.packets([vote, quake], is_fixture=True)


def signal_only(signal):
    return [
        story_editor.reply(story_editor.writer(None, signal), opened=set()),
        story_editor.reply(
            story_editor.review(body="not_present", signal="approved"),
            opened=set(),
        ),
    ]


@pytest.mark.parametrize(
    "refs",
    [
        # One outlet from each of two groups, which may be two events.
        [(0, 1), (1, 1)],
        # Two outlets back the vote, but the quake rests on one.
        [(0, 1), (0, 3), (1, 2)],
    ],
)
async def test_each_cited_group_needs_two_of_its_own_outlets(
    rig, monkeypatch, refs
):
    packets = vote_and_quake(rig)
    signal = story_editor.story(
        "据Synthetic Wire、Synthetic Post报道，虚构事件。"
    )
    signal["paragraphs"][0]["citations"] = [
        f"{packets[group]['id']}/excerpt-{number}" for group, number in refs
    ]
    rig.replies = signal_only(signal)
    result = await rig.run(packets=packets)
    assert result["signal"] is None and result["reason"] == "withheld"
    assert any(
        "single_outlet_excerpt_signal" in finding
        for finding in signal_receipt(result)["findings"]
    )
    # Publication refuses the same pairing even under an approving receipt.
    with monkeypatch.context() as patch:
        patch.setattr(feed_excerpts, "corroborated", lambda pinned: True)
        rig.replies = signal_only(signal)
        forged = await rig.run(
            packets=packets, workspace=rig.workspace.parent / "forged"
        )
    assert forged["signal"] == signal
    with pytest.raises(publication.PublicationError):
        publication.validate_result(forged)


@pytest.mark.parametrize(
    ("text", "refused"),
    [
        # Numbers from the excerpts (1,250 written either way) and the
        # reports' date.
        (
            "9月6日，据两家虚构媒体报道，6.8级地震致12人死亡、1250人流离失所。",
            [],
        ),
        ("据两家虚构媒体报道，6.8级地震致12人死亡、1,250人流离失所。", []),
        (
            "据两家虚构媒体报道，6.8级地震致15人死亡、2000人流离失所。",
            ["15", "2000"],
        ),
    ],
)
async def test_an_excerpt_only_signal_writes_only_the_excerpts_numbers(
    rig, text, refused
):
    packets = vote_and_quake(rig)
    signal = cited(text, 1, 2, packet_id=packets[1]["id"])
    rig.replies = signal_only(signal)
    result = await rig.run(packets=packets)
    receipt = signal_receipt(result)
    if refused:
        assert result["signal"] is None and receipt["status"] == "blocked"
        assert ("excerpt_signal_numbers: " + "、".join(refused)) in " ".join(
            receipt["findings"]
        )
    else:
        assert result["signal"] == signal and receipt["status"] == "approved"
        publication.validate_result(result)


def test_an_excerpt_report_time_of_day_allows_no_numbers():
    cited = [
        {
            "excerpt": "Synthetic vote count continues.",
            "published_at": "2026-11-04T19:40:20Z",
        },
        {
            "excerpt": "Synthetic results awaited.",
            "published_at": "2026-11-04T07:05:33Z",
        },
    ]
    signal = {
        "title": "",
        "paragraphs": [
            {"text": "11月4日，据两家虚构媒体报道，至少19人当选，40人待定。"}
        ],
    }
    assert feed_excerpts.unsupported_numbers(signal, cited) == ["19", "40"]


async def test_an_edited_excerpt_is_no_longer_read_from_its_text(rig, excerpts):
    packet = excerpts[0]
    packet["content"]["sources"][0]["excerpt"] += " Edited after freezing."
    packet["content_hash"] = contracts.content_hash(packet["content"])
    signal, result = await confirmed(rig, excerpts)
    receipt = signal_receipt(result)
    assert result["signal"] is None and receipt["status"] == "blocked"
    assert f"missing_review_open_url: {REPORTS[0][1]}" in receipt["findings"]
    assert rig.calls[1]["approval_sources"].components == {
        "signal": [REPORTS[0][1]]
    }
    assert receipt["excerpts"] == [
        {
            "url": REPORTS[2][1],
            "sha256": feed_excerpts.digest(f"{REPORTS[2][2]}\n{REPORTS[2][3]}"),
            "outlet": "Synthetic Radio",
        }
    ]


async def test_a_review_without_search_cannot_confirm_from_excerpts(
    rig, excerpts
):
    signal = cited(
        "据Synthetic Wire、Synthetic Radio报道，虚构的自由党赢得议会多数。",
        1,
        3,
        packet_id=excerpts[0]["id"],
    )
    rig.replies = [
        story_editor.reply(story_editor.writer(None, signal), opened=set()),
        story_editor.reply(
            story_editor.review(body="not_present", signal="approved"),
            opened=set(),
            searched=False,
        ),
    ]
    result = await rig.run(packets=excerpts)
    assert result["signal"] is None
    assert any(
        "missing_review_search" in finding
        for finding in signal_receipt(result)["findings"]
    )


async def test_stories_without_frozen_excerpts_keep_their_prompts(rig):
    rig.replies = [
        story_editor.reply(story_editor.writer(story_editor.story())),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run()
    assert result["reason"] == "approved"
    assert all("feed_excerpt_rules" not in call["prompt"] for call in rig.calls)
    assert all("excerpts" not in a for a in result["assessments"])


@pytest.mark.parametrize(
    "forge",
    [
        "receipt_hash",
        "edited_text",
        "writer_packet",
        "one_outlet",
        "body_receipt",
    ],
)
async def test_publication_checks_the_pinned_binding_again(
    rig, excerpts, forge
):
    _, result = await confirmed(rig, excerpts)
    publication.validate_result(result)
    forged = copy.deepcopy(result)
    receipt = signal_receipt(forged)
    packet = forged["packets"][0]
    if forge == "receipt_hash":
        receipt["excerpts"][0]["sha256"] = "0" * 64
    elif forge == "edited_text":
        packet["content"]["sources"][0]["excerpt"] += " Edited."
        packet["content_hash"] = contracts.content_hash(packet["content"])
    elif forge == "writer_packet":
        packet["workflow_id"] = "story-research"
    elif forge == "one_outlet":
        receipt["excerpts"] = receipt["excerpts"][:1]
    else:
        # A body bound to the same excerpts still needs its opens.
        forged["content"] = copy.deepcopy(forged["signal"])
        forged["assessments"].append(
            {
                **copy.deepcopy(receipt),
                "component": "body",
                "content_hash": contracts.content_hash(
                    components.body_content(forged["content"])
                ),
            }
        )
    forged["provenance"] = {
        "packets_hash": contracts.content_hash(forged["packets"])
    }
    with pytest.raises(publication.PublicationError):
        publication.validate_result(forged)


def test_components_helpers_handle_none_unknown_and_nested_citations():
    assert components.component_content(None, None, "signal") is None
    assert components.component_content({}, {}, "unknown") is None
    assert components.component_citations({}, "signal") == []
    assert components.component_citations({}, "unknown") == []
    sample = story_editor.story(reading=True, chart=True)
    assert components.component_citations(
        sample["recommended_reading"], "reading"
    ) == [
        sample["recommended_reading"]["citation"],
        *sample["recommended_reading"].get("supporting_citations", []),
    ]
    assert components.component_citations(sample["chart"], "chart") == [
        "packet/source"
    ]
    assert components.component_citations(sample, "body") == ["packet/source"]
    assert components.citations(
        [
            {"citation": "a/1"},
            {"citations": ["b/2", 3], "supporting_citations": ["c/3"]},
        ]
    ) == {"a/1", "b/2", "c/3"}
    wrapped = components.validation_draft(sample, subject="Subj", title="Title")
    assert "recommended_reading" in wrapped and "chart" in wrapped


@pytest.fixture
def reader_profile():
    return (
        resources.files("newsletter")
        .joinpath("policy/reader-profile.md")
        .read_text(encoding="utf-8")
    )


def test_news_profile_excludes_legacy_research_reservations(reader_profile):
    assert "高优先级" in reader_profile and "不排他" in reader_profile
    assert "研究没有固定保留席位" in reader_profile
    assert "默认全期最多一个以研究为主体" in reader_profile
    assert "候选继续采集和归档" in reader_profile
    assert "接受短刊" in reader_profile
    assert "公共健康" in reader_profile and "经济" in reader_profile


@pytest.mark.parametrize(
    "source",
    ["NeurIPS", "ICML", "ICLR", "ACL", "CVPR", "Nature", "Science", "arXiv"],
)
def test_research_discovery_accepts_multiple_venues_without_venue_as_proof(
    reader_profile, source
):
    assert source in reader_profile
    assert "声誉不等于证据" in reader_profile
    assert "顶级研究组" in reader_profile


def test_legacy_whole_edition_policy_is_not_packaged():
    assert not (
        resources.files("newsletter").joinpath("policy/editorial.md").is_file()
    )


@pytest.mark.parametrize("direction", ["01-ai-ml.md", "02-science.md"])
def test_research_guides_require_read_scope_and_clear_overview(
    direction,
):
    instruction = (
        resources.files("newsletter")
        .joinpath(f"instructions/{direction}")
        .read_text(encoding="utf-8")
    )
    assert "摘要页或落地页不等于 PDF 正文" in instruction
    assert "full_text 只用于实际读到全文的来源" in instruction
    assert "同步调整 URL、access_scope、excerpt 和 body" in instruction
    assert "删除未读方法与数字，不能仅替换 URL" in instruction
    assert "缺少支撑核心结论的证据时返回 no_findings" in instruction
    assert "2–3 句自足概览" in instruction
    assert "不点击链接也应知道研究做了什么" in instruction


@pytest.fixture
def newsroom_config(tmp_path):
    authored = pathlib.Path(__file__).resolve().parents[1] / "content-config"
    snapshot = content_config.build_directory(authored, "a" * 40)
    root = tmp_path / "configuration"
    content_config.install_snapshot(root, snapshot)
    loaded = content_config.load_active(root)
    assert loaded == snapshot
    return loaded


@pytest.mark.parametrize("mode", ["brief", "deep"])
@pytest.mark.parametrize(
    "limitation", ["", "该虚构服务仅向已登记的测试用户开放。"]
)
async def test_authored_policy_allows_empty_or_specific_context(
    rig, newsroom_config, mode, limitation
):
    """Keep both paths publishable without adding model rounds or text gates."""
    policy = {
        name: newsroom_config["files"]["policy/" + name]
        for name in ("editorial.md", "reader-profile.md")
    }
    content = story_editor.story("虚构机构开放了一个离线测试服务。")
    content.update(kind="technology", limitations=limitation)
    original = copy.deepcopy(content)
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(mode=mode, policy=policy)
    assert result["content"] == original
    assert result["issues"] == []
    assert len(rig.calls) == 2 and not rig.replies
    writer, reviewer = rig.calls
    assert writer["instructions"] == policy["editorial.md"]
    assert reviewer["instructions"] == policy["editorial.md"]
    assert writer["prompt"]["reader_profile"] == policy["reader-profile.md"]
    assert reviewer["prompt"]["content_untrusted"] == original
    assert writer["path"] != reviewer["path"]
    publication.validate_result(result)
    assembled = publication.assemble(
        "newsroom-test",
        "2026-09-06",
        [publication_support.task(id="story-a")],
        [result],
    )
    section = assembled["draft"]["sections"][0]
    assert section["heading"] == original["title"]
    assert section["paragraphs"] == original["paragraphs"]
    assert section["limitations"] == limitation
    assert assembled["review"]["passed"] is True


@pytest.mark.parametrize(
    "limitation",
    [
        "",
        "仅适用于虚构测试组 A & B。\n<b>这里是原文，不是 HTML。</b>",
        "此虚构测试没有对照组，现有证据无法证明改善由这项措施造成。",
    ],
)
def test_authored_email_preserves_context_and_optional_sections(
    newsroom_config, limitation
):
    draft = copy.deepcopy(rendering.SAMPLE_DRAFT)
    draft["sections"][0]["limitations"] = ""
    draft["sections"][1]["limitations"] = limitation
    original = copy.deepcopy(draft)
    summary = newsletter_usage.summarize_usage(tests_support_usage.record_one())
    rendered = newsletter_rendering.render_edition(
        draft,
        rendering.SAMPLE_PACKETS,
        "2026-09-06",
        is_fixture=True,
        personal_digest=todofy.unavailable_digest(),
        usage=summary,
        template_source=newsroom_config["files"]["templates/edition.html.j2"],
    )
    parsed = rendering.ParsedEmail(rendered["html"])
    visible = "".join(parsed.text)
    assert draft == original
    assert 'class="story-note"' not in rendered["html"]
    assert rendered["html"].count('class="story-context ink"') == bool(
        limitation
    )
    if limitation:
        assert limitation in rendered["text"]
        for line in limitation.splitlines():
            assert html.escape(line) in rendered["html"]
            assert line in visible
        assert "<b>这里是原文，不是 HTML。</b>" not in rendered["html"]
    for section in draft["sections"]:
        for paragraph in section["paragraphs"]:
            assert paragraph["text"] in visible
            assert paragraph["text"] in rendered["text"]
    assert rendered["chart_png"]
    assert any(
        image["src"] == newsletter_rendering.CHART_CID
        for image in parsed.images
    )
    assert "图表说明：" + draft["chart"]["limitations"] in visible
    for source in rendering.SAMPLE_PACKETS[0]["content"]["sources"]:
        assert source["url"] in parsed.links
        assert source["url"] in rendered["text"]
    footer = newsletter_usage.usage_footer(summary, is_fixture=True)
    for output in (visible, rendered["text"]):
        for paragraph in draft["recommended_reading"]["reason"].split("\n\n"):
            assert paragraph in output
        assert output.index(draft["chart"]["limitations"]) < output.index(
            "TODOFY / 与你有关"
        )
        assert output.index("来源与核对") < output.index("TODOFY / 与你有关")
        assert output.index("TODOFY / 与你有关") < output.index(footer)
        assert output.rstrip().endswith(footer)


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Reader acceptance attempted real network access")

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", forbidden
    )


@pytest.mark.parametrize("chart_status", ["approved", "blocked", "not_present"])
async def test_degraded_mail_keeps_topic_identity_and_chart_audit(
    tmp_path, rig, chart_status
):
    science = story_editor.story(chart=chart_status != "not_present")
    science.update(kind="science", title="离线科学样题：两组观测意味着什么")
    proposed_chart = copy.deepcopy(science.get("chart"))
    rig.replies = [
        story_editor.reply(story_editor.writer(science)),
        story_editor.reply(story_editor.review(chart=chart_status)),
    ]
    science_result = await rig.run(mode="deep")
    assert (
        len(rig.calls) == 2
    )  # A rejected optional chart cannot trigger body repair.

    tasks = [
        publication_support.task(1),
        publication_support.task(2, id="story-a"),
        publication_support.task(3),
        publication_support.task(4),
    ]
    values = [
        publication_support.result(
            1,
            content=publication_support.story(
                1,
                kind="ai_ml",
                title="离线 AI 样题：已审简讯保留",
                limitations="AI 样题的独立边界。",
            ),
        ),
        publication_support.result(
            1, "deep", content=False, reason="editor_unavailable"
        ),
        science_result,
        publication_support.result(
            3,
            content=publication_support.story(
                3,
                kind="world",
                title="离线世界样题：独立公共事件",
                limitations="世界样题的独立边界。",
            ),
        ),
        publication_support.result(4, content=False),
    ]
    store = newsletter_store.Store(tmp_path / "reader.sqlite3", "mock")
    try:
        repository = publication.PublicationRepository(store)
        repository.save_plan("reader-release", publication_support.DAY, tasks)
        tasks_by_id = {item["id"]: item for item in tasks}
        for value in values:
            repository.save(
                "reader-release",
                tasks_by_id[value["story_id"]],
                value["mode"],
                value,
                issue_date=publication_support.DAY,
            )
        built = publication.assemble(
            "reader-release",
            publication_support.DAY,
            tasks,
            repository.results("reader-release"),
            reason="workflow_deadline",
        )
        repository.record_publication(
            "reader-release", publication_support.DAY, tasks, built
        )
    finally:
        store.close()

    # Diagnostics must survive the freeze and a process restart, not just exist
    # in an in-memory fixture. They are operator audit, not invented reader
    # copy.
    store = newsletter_store.Store(tmp_path / "reader.sqlite3", "mock")
    try:
        repository = publication.PublicationRepository(store)
        assert repository.get_publication("reader-release") == built
        saved = next(
            value
            for value in repository.results("reader-release")
            if value["story_id"] == "story-a"
        )
        audit = next(
            item
            for item in saved["assessments"]
            if item["component"] == "chart"
        )
        assert audit["status"] == chart_status
        if chart_status == "blocked":
            assert audit["findings"] == ["fixture finding"]
        if chart_status == "not_present":
            assert audit["content_hash"] == ""
    finally:
        store.close()

    assert built["coverage"]["mode"] == "partial"
    assert [item["disposition"] for item in built["coverage"]["stories"]] == [
        "brief",
        "deep",
        "brief",
        "deferred",
    ]
    personal = await todofy.FakeTodofy().fetch(publication_support.DAY)
    rendered = newsletter_rendering.render_edition(
        built["draft"],
        built["packets"],
        publication_support.DAY,
        is_fixture=True,
        personal_digest=personal,
        usage=newsletter_usage.summarize_usage(
            tests_support_usage.record_one()
        ),
    )
    panels = rendered["html"].split('class="story-panel"')[1:]
    sections = built["draft"]["sections"]
    assert len(panels) == 3
    for panel, section, label in zip(
        panels, sections, ["AI / ML 进展", "科学进展", "世界简报"], strict=True
    ):
        assert label in panel
        assert f">{section['heading']}</h2>" in panel
        assert section["limitations"] in panel
        assert f"{label}｜{section['heading']}" in rendered["text"]
        for paragraph in section["paragraphs"]:
            assert paragraph["text"] in panel
        for other in sections:
            if other is not section:
                assert other["heading"] not in panel
                assert other["limitations"] not in panel
    assert "今日简讯" not in rendered["html"]
    assert "另有 1 个入选选题暂未刊出" in rendered["text"]
    for output in (rendered["html"], rendered["text"]):
        assert output.index("TODOFY / 与你有关") > output.index(
            sections[-1]["heading"]
        )
        assert output.index("TODOFY / 与你有关") > output.index(
            "https://example.org/research/3"
        )
        if chart_status == "approved":
            assert output.index("TODOFY / 与你有关") > output.index(
                proposed_chart["question"]
            )
        assert output.index(personal["items"][-1]["detail"]) < output.index(
            "MOCK · 用量"
        )
    public_html = rendered["html"].split("TODOFY / 与你有关", 1)[0]
    assert personal["items"][0]["detail"] not in public_html

    edition = {
        "id": "reader-fixture",
        "is_fixture": True,
        "state": "ready",
        "draft": built["draft"],
        "rendered": rendered,
    }
    mail = adapters.FakeMail(tmp_path / "mail")
    sent = await mail.send(edition, "reader-fixture")
    artifact = next((tmp_path / "mail").glob("*.eml"))
    frozen_bytes = artifact.read_bytes()
    message = parser.BytesParser(policy=email_policy.default).parsebytes(
        frozen_bytes
    )
    assert sent["delivery_state"] == "simulated"
    assert message["X-Newsletter-Simulated"] == "true"
    # MIME uses CRLF transport line endings; no text or inline styling may
    # change.
    for subtype, field in (("html", "html"), ("plain", "text")):
        decoded = message.get_body(preferencelist=(subtype,)).get_content()
        assert decoded.replace("\r\n", "\n").rstrip("\n") == rendered[
            field
        ].rstrip("\n")
    images = [
        part
        for part in message.walk()
        if part.get_content_type() == "image/png"
    ]
    parsed = rendering.ParsedEmail(rendered["html"])
    if chart_status == "approved":
        assert built["draft"]["chart"] == proposed_chart
        assert len(images) == len(parsed.images) == 1
        assert parsed.images[0]["src"] == newsletter_rendering.CHART_CID
        assert parsed.images[0]["alt"] == proposed_chart["alt_text"]
        assert images[0]["Content-ID"] == "<newsletter-chart>"
        png = base64.b64decode(rendered["chart_png"])
        assert images[0].get_payload(decode=True) == png
        image = Image.open(io.BytesIO(png))
        assert image.format == "PNG" and image.width == 1280
        assert (
            newsletter_rendering.CHART_CID
            not in newsletter_rendering.preview_html(rendered)
        )
        assert "data:image/png;base64," in newsletter_rendering.preview_html(
            rendered
        )
    else:
        assert "chart" not in built["draft"]
        assert not images and not parsed.images and rendered["chart_png"] == ""
        assert newsletter_rendering.CHART_CID not in rendered["html"]
        assert "一图看懂" not in rendered["html"]
    assert await mail.send(edition, "reader-fixture") == sent
    assert artifact.read_bytes() == frozen_bytes
    assert len(list((tmp_path / "mail").glob("*.eml"))) == 1


def test_wide_reader_layout_has_utf8_headroom_and_disjoint_partial_usage():
    """Guard representative HTML size, not every Gmail client's behavior."""
    draft = copy.deepcopy(rendering.SAMPLE_DRAFT)
    draft["title"] = draft["subject"] = "八题离线验收样张，不是真实新闻"
    kinds = [
        "ai_ml",
        "science",
        "economy",
        "technology",
        "health",
        "world",
        "feature",
        "context",
    ]
    draft["sections"] = [
        {
            "kind": kind,
            "heading": f"第{number}题：离线长标题说明已知变化与仍需核验的边界",
            "paragraphs": [
                {
                    "text": (
                        f"第{number}题第{part}段。"
                        + "这是离线中文材料，比较方法与结果并保留不确定性。" * 8
                    ),
                    "citations": ["sample-packet/methods"],
                }
                for part in range(1, 5 if number <= 2 else 3)
            ],
            "limitations": (
                f"第{number}题仅为离线样张，不能当作事实或推断因果。"
            ),
        }
        for number, kind in enumerate(kinds, 1)
    ]
    packets = copy.deepcopy(rendering.SAMPLE_PACKETS)
    # Exercise production footer formatting without sending or claiming these
    # synthetic source/usage values came from a real account.
    packets[0]["is_fixture"] = False
    usage = newsletter_usage.summarize_usage(
        tests_support_usage.record_one(
            tests_support_usage.notification(
                6_000_000, 90_000, cached=5_000_000
            )
        )
    )
    usage["partial"] = True
    rendered = newsletter_rendering.render_edition(
        draft,
        packets,
        publication_support.DAY,
        personal_digest=todofy.unavailable_digest(),
        usage=usage,
    )
    html_bytes = len(rendered["html"].encode("utf-8"))
    assert html_bytes < 90 * 1024, (
        f"Representative email HTML grew to {html_bytes} UTF-8 bytes"
    )
    assert html_bytes > len(
        rendered["html"]
    )  # Count bytes, not Chinese characters.
    assert (
        "data:image/png;base64," not in rendered["html"]
    )  # CID data isn't inlined into HTML.
    assert rendered["html"].count('class="story-panel"') == 8
    for output in (rendered["html"], rendered["text"]):
        assert (
            "非缓存输入 1,000,000 · 缓存输入 5,000,000 · 输出 90,000" in output
        )
        assert "6,090,000 tokens" in output and "11,090,000" not in output
        assert "部分用量，未含未返回用量的调用" in output
        assert "Todofy/Gemini 用量未计入" in output
        assert output.index("TODOFY / 与你有关") < output.index("模型已记录")
        assert "plan" not in output.lower()
