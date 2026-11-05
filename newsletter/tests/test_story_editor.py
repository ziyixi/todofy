"""Local component failures never erase an independently approved story unit."""

import asyncio
import copy
import datetime
import importlib.resources as resources
import json
import pathlib
import re
import uuid

import pytest

import newsletter.collection.instructions as instructions
import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.prompts as prompts
import newsletter.rendering as rendering
import newsletter.usage as newsletter_usage
import newsletter.workflow.components as components
import newsletter.workflow.content as content
import newsletter.workflow.definition as definition
import newsletter.workflow.feed_excerpts as feed_excerpts
import newsletter.workflow.publication as publication
import newsletter.workflow.researcher as researcher
import newsletter.workflow.sources as sources
import newsletter.workflow.story_editor as newsletter_workflow_story_editor
import newsletter.workflow.story_nodes as story_nodes
import tests.support.news_first_policy as policy
import tests.support.publication as publication_support
import tests.support.story_editor as story_editor
import tests.support.workflow_content as workflow_content


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
    sample = story_editor.story(reading=True, chart=True)
    assert components.body_content(sample, copy_values=False) == {
        k: v
        for k, v in sample.items()
        if k not in components.OPTIONAL_COMPONENTS
    }
    assert components.component_content(None, {"story_id": "s"}, "body") is None
    assert components.component_content(sample, None, "unknown") is None
    assert components.component_citations(
        sample["recommended_reading"], "reading"
    ) == [
        sample["recommended_reading"]["citation"],
        *sample["recommended_reading"].get("supporting_citations", []),
    ]
    assert components.component_citations(sample["chart"], "chart") == [
        "pkt-1/s1"
    ]
    assert components.component_citations(sample, "body") == ["pkt-1/s1"]
    assert components.citations(
        [
            {"citation": "a/1"},
            {"citations": ["b/2", 3], "supporting_citations": ["c/3"]},
        ]
    ) == {"a/1", "b/2", "c/3"}
    wrapped = components.validation_draft(
        sample, subject="Subj", title="Title"
    )
    assert "recommended_reading" in wrapped and "chart" in wrapped


def read(path):
    return (
        resources.files("newsletter").joinpath(path).read_text(encoding="utf-8")
    )


def prompt_body(filename):
    return prompts.parse_prompt_document(
        read(f"prompts/{filename}"), source=filename
    ).body


def direction_body(filename):
    return instructions.parse_instruction_document(
        read(f"directions/{filename}"), source=filename
    ).body


def test_editor_prompt_requires_newsroom_value_plain_terms_and_concrete_writing():
    prompt = prompt_body("newsletter_editor.md")
    for required in (
        "先用自然中文把概念讲明白",
        "每个选题必须回答三件事：发生了什么、旧方法卡在哪、这次变化和边界是什么",
        "不得把论文题目、方法缩写、框架名或基准分数直接当导语",
        "任何缩写、专门机制、评测基准、法规简称首次出现时",
        "少写空泛判断，多写读者能抓住的具体事实",
        "不得用“具有重要意义”“引发广泛关注”“推动行业发展”“值得持续跟踪”这类套话收尾",
        "导语先交代今天最值得读的 2 到 3 个具体变化",
        "`briefing` 至少写两段",
        "`feature` 至少写三段",
        "说明它補齐整期哪块背景、实验细节或现实约束",
        "先写坐标轴、单位和直接观察到的差异，再写趋势与原因",
    ):
        assert required in prompt


def test_workflow_prompts_enforce_reader_value_selection_and_explanation_audit():
    planner = prompt_body("topic_planner.md")
    for required in (
        "选题标准是新闻性与读者收获",
        "发生了什么、旧方法或旧规则卡在哪、这次改动带来了什么以及边界在哪",
        "只给缩写、新名词或榜单分数、看不出真实问题与证据的条目应落选或降级",
        "`rationale` 用两三句具体中文说明：这个选题解决什么真实问题",
    ):
        assert required in planner

    research = prompt_body("story_research.md")
    for required in (
        "优先补齐能让读者真正看懂来龙去脉的材料",
        "摘录要保留具体机制、实验设定、数字、生效范围或限制条件",
        "如果一手页面或论文能核实作者、机构、发表或预印本状态，以及这项工作具体推进了哪一步",
    ):
        assert required in research

    writer = prompt_body("story_writer.md")
    for required in (
        "读者不需要先懂行话",
        "先用人话交代问题，再引入术语或英文缩写",
        "每个选题写清四件事：具体事件或结果、此前做法卡在哪里、这次怎么改或测出了什么、适用条件与未解限制",
        "`briefing` 至少写 2 段完整中文",
        "`feature` 至少写 3 段完整中文",
        "只要来源支持，在正文中自然交代是谁做的（作者或团队、所属机构、发表场合或预印本状态）",
        "不要为了省事缩成一句口号，也不要用“意义重大”“值得关注”之类空话凑字数",
    ):
        assert required in writer

    reviewer = prompt_body("story_reviewer.md")
    for required in (
        "可读性与信息密度同样属于审稿范围",
        "如果正文堆砌未解释的缩写或术语、只报论文名或跑分却不讲问题与方法",
        "应在 `findings` 指明缺口并将该组件判为 `blocked`",
        "如果来源已经给出作者、机构或具体贡献，正文却写成听不出由来的空泛口号",
    ):
        assert required in reviewer


def test_direction_files_select_explainable_news_over_title_or_score_churn():
    expectations = {
        "01-ai-ml.md": (
            "发生了什么、此前方法卡在哪、这次改动如何验证、代价或失败边界是什么",
            "不要因为换了新缩写、模型代号或榜单刷分就入选",
        ),
        "02-computing-systems.md": (
            "系统瓶颈、工程折中、吞吐/延迟/能耗/成本变化与部署条件",
            "能解释清“原来卡在哪、这次改了哪一层、生产环境付出什么代价”的条目",
        ),
        "03-world-tech-policy.md": (
            "制度变化、执法动作、产业约束、基础设施事件或跨区域影响",
            "把条文、裁决或公告翻译成具体义务、时间表、豁免条件和受影响对象",
        ),
        "04-math-physics-foundations.md": (
            "非专业读者也能看懂“以前卡在哪、这次推进了哪一步、离应用还有多远”",
            "避免只贴定理名、猜想代号或艰深记号却无法交代直观图景的条目",
        ),
        "05-life-health-earth.md": (
            "研究对象、样本或数据规模、对照设计、主要结果和临床/现实距离",
            "避免把动物实验、体外结果或早期相关性写成已经落地的医学结论",
        ),
    }
    for filename, clauses in expectations.items():
        text = direction_body(filename)
        for clause in clauses:
            assert clause in text


def test_newsroom_prompt_policy_aligns_with_configured_workflow_budget():
    workflow = json.loads(read("workflows/default.json"))
    assert workflow["budgets"]["max_stories"] == 6
    nodes = {node["id"]: node for node in workflow["nodes"]}
    assert nodes["plan"]["prompt"] == "topic_planner.md"
    assert nodes["research"]["prompt"] == "story_research.md"
    assert nodes["write"]["writer_prompt"] == "story_writer.md"
    assert nodes["write"]["reviewer_prompt"] == "story_reviewer.md"


def test_news_first_editorial_prompts_state_hierarchy_provenance_and_card_roles():
    expected = {
        "direction_discovery.md": (
            "同日或近 24–72 小时内首次公开、修订、裁决、发布或披露具体数据的事项",
            "若能从打开的一手来源确认，必须填入作者或发布主体、机构、发表或发布状态",
            "摘要先用自然中文说明真实问题，再解释新名词或缩写",
        ),
        "topic_planner.md": (
            "按“当日新闻性 → 证据扎实度 → 读者收获 → 方向平衡”排序",
            "整期体裁要有层次：至少规划 1 个 `feature`",
            "优先把多个方向放进同一期，避免单一领域刷屏",
        ),
        "story_research.md": (
            "核实谁做的（作者或发布团队、机构）、发表在何处或处于什么程序阶段",
            "不能因为想写得好看就补入网页上没写、也没打开核实过的背景常识",
        ),
        "story_writer.md": (
            "先用一两句日常中文把问题讲清楚，再给缩写、机制名、基准名或法规简称补一句自然解释",
            "交代清楚作者或发布团队、所属机构、发表场合或预印本/政策阶段",
            "`feature` 至少 3 段，完整展开背景、关键做法、数字证据与边界",
            "`recommended_reading` 只在某篇核心论文、长报告、法规文本或基准文档值得读者顺着原文继续深读时填写",
            "`signal` 必须精炼、克制、独立可读，用 1–2 段交代已确认事实、为何今天值得知道，以及哪部分细节仍在核验",
        ),
        "story_reviewer.md": (
            "把预印本、动物实验、局部基准或征求意见稿夸大成既定事实",
            "只有缩写和术语堆砌、外行读者看不懂因果链，或用空泛套话充数",
            "`reading` 还要检查它是否解释了“为什么值得读原文、能补哪块细节”",
        ),
        "newsletter_editor.md": (
            "先当科技与学术编辑部主编，再当审校人",
            "自然交代作者或团队、机构、发表场合或阶段，以及这项工作究竟推进了什么",
            "`recommended_reading` 像编辑部的延伸阅读卡：说清这篇原文适合补哪块背景、实验细节或制度条文",
        ),
    }
    for name, phrases in expected.items():
        text = prompt_body(name)
        for phrase in phrases:
            assert phrase in text, f"{name} missing {phrase}"


def test_direction_files_require_source_provenance_and_plain_explanation():
    for name in (
        "01-ai-ml.md",
        "02-computing-systems.md",
        "03-world-tech-policy.md",
        "04-math-physics-foundations.md",
        "05-life-health-earth.md",
    ):
        text = direction_body(name)
        assert "作者" in text or "发布主体" in text
        assert "机构" in text


def test_api_feed_metadata_preserves_provenance_and_plain_source_basis():
    entries = sources.parse_arxiv(policy.ARXIV_ATOM, "01-ai-ml")
    assert len(entries) == 1
    entry = entries[0]
    assert entry["authors"] == "Lin Chen, Maya Patel"
    assert entry["affiliations"] == " Institute for Systems AI"
    assert entry["venue"] == "arXiv cs.LG"
    assert entry["publication_status"] == "预印本"
    assert "Lin Chen" in entry["source_basis"]
    assert "arXiv" in entry["source_basis"]
    assert entry["contribution"].startswith("Separates speculative verification")
    assert entry["evidence_urls"] == [
        "https://arxiv.org/abs/2609.01234v1",
        "https://doi.org/10.48550/arXiv.2609.01234",
    ]


def test_feed_brief_renders_provenance_and_contribution_for_writer_and_reviewer():
    entry = sources.parse_arxiv(policy.ARXIV_ATOM, "01-ai-ml")[0]
    candidate = researcher.normalize_candidate(
        entry,
        direction="01-ai-ml",
        provenance="feed",
        issue_date="2026-09-06",
    )
    assert candidate is not None
    packet = story_nodes.feed_brief([candidate], "story-1")["packets"][0]
    body = packet["content"]["body"]
    for detail in (
        "作者/主体：Lin Chen, Maya Patel",
        "机构：Institute for Systems AI",
        "发表场所：arXiv cs.LG（预印本）",
        "核心贡献：Separates speculative verification",
        "证据依据：arXiv 摘要记录",
    ):
        assert detail in body
    assert packet["content"]["sources"][0]["provenance"] == "feed"


async def test_prompt_inputs_carry_provenance_fields_into_plan_research_and_write(
    tmp_path,
):
    candidate = policy.rich_candidate()
    assert candidate is not None
    seen = []

    class RecordingEditor:
        async def execute(
            self,
            prompt,
            output_schema,
            activity,
            workspace,
            *,
            require_search=True,
            inspect_sources=False,
            approval_sources=None,
        ):
            seen.append((activity, json.loads(prompt)))
            if activity.endswith("plan"):
                return (
                    json.dumps(
                        {
                            "stories": [
                                {
                                    "story_id": "story-1",
                                    "title": "投机解码把验证延迟从批处理主路径拆开",
                                    "kind": "feature",
                                    "candidate_ids": [candidate["id"]],
                                    "priority": 1,
                                    "rationale": (
                                        "长上下文推理过去被验证停顿拖慢；这项工作给出了可复现的验证拆分实验。"
                                    ),
                                }
                            ],
                            "coverage": [
                                {
                                    "direction": "01-ai-ml",
                                    "status": "planned",
                                    "note": "selected",
                                }
                            ],
                        }
                    ),
                    set(),
                    True,
                )
            return (
                json.dumps(
                    workflow_content.research_payload(
                        url=candidate["url"],
                        scope="abstract",
                        excerpt=candidate["summary"],
                    )
                ),
                {candidate["url"], "https://example.org/lab"},
                True,
            )

    prep = content.ContentPreparation(RecordingEditor())
    planned = await prep.plan(
        [candidate],
        [],
        [instructions.Instruction("01-ai-ml", "AI", "Focus")],
        "2026-09-06",
        3,
        tmp_path / "plan",
    )
    brief = await prep.research(
        planned.stories[0],
        [candidate],
        "2026-09-06",
        tmp_path / "research",
    )
    plan_candidate = seen[0][1]["candidates"][0]
    research_candidate = seen[1][1]["candidates"][0]
    for payload in (plan_candidate, research_candidate):
        assert payload["authors"] == "Lin Chen, Maya Patel"
        assert payload["affiliations"] == "Institute for Systems AI"
        assert payload["venue"] == "arXiv cs.LG"
        assert payload["publication_status"] == "预印本"
        assert "延迟降低 28%" in payload["contribution"]
        assert payload["evidence_urls"] == [
            "https://example.org/spec-decode",
            "https://example.org/lab",
        ]
    assert brief["candidates"][0]["authors"] == "Lin Chen, Maya Patel"


def test_configured_edition_assembler_produces_hierarchical_newsroom_issue():
    workflow = definition.load()
    assemble = next(
        node for node in workflow.nodes if node["type"] == "edition_assembler"
    )
    stories = policy.newsroom_stories()
    assembled = publication.assemble(
        "2026-09-06",
        stories,
        workflow.budgets,
        config=assemble["config"],
    )
    assert assembled.mode == "full"
    draft = assembled.draft
    assert draft["title"] == "2026-09-06 科技与学术日报"
    assert (
        "重点跟进《投机解码把验证开销从主路径拆开》"
        in draft["introduction"]
    )
    assert (
        "并梳理《内核页表批处理压低跨核同步尾延迟》《欧盟人工智能办公室公布通用模型合规核查清单》等方向的新进展"
        in draft["introduction"]
    )
    assert [section["kind"] for section in draft["sections"]] == [
        "feature",
        "briefing",
        "briefing",
    ]
    assert "recommended_reading" in draft and "chart" in draft
    contracts.validate_draft(draft, assembled.packets)
    rendered = rendering.render_edition(draft, assembled.packets, "2026-09-06")
    for visible in (
        "重点解读",
        "简要速览",
        "推荐阅读",
        "延伸阅读与深读理由",
        "数据图表",
        "Institute for Systems AI",
        "Cloud Kernel Lab",
        "European AI Office",
        "局限：",
    ):
        assert visible in rendered.html
        assert visible in rendered.text


def load_json(path: str) -> dict:
    return json.loads(
        resources.files("newsletter").joinpath(path).read_text("utf-8")
    )


def test_default_workflow_exposes_operator_tunable_newsroom_parameters():
    raw = load_json("workflows/default.json")
    workflow = definition.load()
    assert raw["version"] == 1
    assert workflow.budgets == {
        "max_Directions": 5,
        "max_queries_per_Direction": 4,
        "max_candidates": 30,
        "max_stories": 6,
        "deep_repair_rounds": 1,
        "minimum_publishable_stories": 2,
    } or workflow.budgets == {
        "max_directions": 5,
        "max_queries_per_direction": 4,
        "max_candidates": 30,
        "max_stories": 6,
        "deep_repair_rounds": 1,
        "minimum_publishable_stories": 2,
    }
    nodes = {node["id"]: node for node in workflow.nodes}
    assert nodes["feeds"]["config"] == {"arxiv_max_results_per_query": 25}
    assert nodes["pool"]["config"] == {"recent_Candidate_days": 14} or (
        nodes["pool"]["config"] == {"recent_candidate_days": 14}
    )
    assert nodes["plan"]["prompt"] == "topic_planner.md"
    assert nodes["plan"]["config"] == {
        "prompt_notes": [
            "优先覆盖多个方向，避免同一期全部落在单一领域。",
            "至少安排一个 feature 深度解读，其余用 briefing 保持信息密度。",
        ]
    }
    assert nodes["research"]["prompt"] == "story_research.md"
    assert nodes["write"]["writer_prompt"] == "story_writer.md"
    assert nodes["write"]["reviewer_prompt"] == "story_reviewer.md"
    assert nodes["write"]["config"]["writer_prompt_notes"]
    assert nodes["write"]["config"]["reviewer_prompt_notes"]
    assert nodes["assemble"]["config"] == {
        "title_template": "{issue_date} 科技与学术日报",
        "subject_prefix": "每日简报",
        "fallback_subject_prefix": "阶段简报",
        "lead_intro_template": "本期共收录 {story_count} 个独立核验选题，重点跟进{lead_titles}，并梳理{other_titles}等方向的新进展。",
        "single_story_intro_template": "本期聚焦{lead_titles}，结合一手来源梳理问题背景、关键证据与适用边界。",
        "fallback_intro_template": "本期共有 {full_count} 个选题完成完整核验，另有 {signal_count} 个选题先发布经独立复核的简要信号。",
        "signal_heading": "已核实速览",
        "signal_limitations": "仅保留已通过独立复核的事实信号；未展开部分待后续补充核查。",
    }


def test_content_config_manifest_tracks_all_tunable_files():
    manifest = content_config.build_manifest()
    assert set(manifest["files"]) == {
        "workflows/default.json",
        "directions/01-ai-ml.md",
        "directions/02-computing-systems.md",
        "directions/03-world-tech-policy.md",
        "directions/04-math-physics-foundations.md",
        "directions/05-life-health-earth.md",
        "prompts/direction_discovery.md",
        "prompts/newsletter_editor.md",
        "prompts/story_research.md",
        "prompts/story_reviewer.md",
        "prompts/story_writer.md",
        "prompts/topic_planner.md",
    }
    assert len(manifest["sha256"]) == 64


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda raw: raw["nodes"][1].update(config={"unknown_knob": 1}),
            "unknown config keys",
        ),
        (
            lambda raw: raw["nodes"][1].update(
                config={"arxiv_max_results_per_query": 0}
            ),
            "arxiv_max_results_per_query",
        ),
        (
            lambda raw: raw["nodes"][2].update(
                config={"recent_candidate_days": 90}
            ),
            "recent_candidate_days",
        ),
        (
            lambda raw: raw["nodes"][3].update(
                config={"prompt_notes": ["   "]}
            ),
            "prompt_notes",
        ),
        (
            lambda raw: raw["nodes"][6].update(
                config={"title_template": "{unknown_field}"}
            ),
            "unsupported template fields",
        ),
    ],
)
def test_workflow_validation_rejects_invalid_node_config(mutate, message):
    raw = copy.deepcopy(load_json("workflows/default.json"))
    mutate(raw)
    with pytest.raises(ValueError, match=message):
        definition.validate(raw)


def test_assembler_applies_custom_editorial_templates():
    stories = [
        publication_support.approved_story(
            "story-1", "新型稀疏注意力降低长文本推理显存", priority=1
        ),
        publication_support.approved_story(
            "story-2", "Linux 调度器补丁缩短尾延迟", priority=2
        ),
    ]
    stories[0]["content"]["kind"] = "feature"
    result = publication.assemble(
        "2026-09-06",
        stories,
        {"minimum_publishable_stories": 2},
        config={
            "title_template": "{issue_date} 焦点研报（{story_count} 篇）",
            "subject_prefix": "研报精选",
            "lead_intro_template": "主打：{lead_titles}；同场关注：{other_titles}。",
        },
    )
    assert result.mode == "full"
    assert result.draft["title"] == "2026-09-06 焦点研报（2 篇）"
    assert result.draft["subject"].startswith(
        "研报精选 · 2026-09-06 · 新型稀疏注意力降低长文本推理显存"
    )
    assert result.draft["introduction"] == (
        "主打：《新型稀疏注意力降低长文本推理显存》；"
        "同场关注：《Linux 调度器补丁缩短尾延迟》。"
    )


def test_direction_front_matter_is_validated_and_stripped_from_prompt_body():
    instructions_list = instructions.load_instructions()
    assert [item.slug for item in instructions_list] == [
        "01-ai-ml",
        "02-computing-systems",
        "03-world-tech-policy",
        "04-math-physics-foundations",
        "05-life-health-earth",
    ]
    for item in instructions_list:
        assert not item.body.startswith("---")
        assert "Selection criteria:" in item.body
        assert "Explainability bar:" in item.body


def test_direction_parser_rejects_missing_front_matter():
    with pytest.raises(ValueError, match="front matter"):
        instructions.parse_instruction_document(
            "# Missing metadata\nBody only.\n", source="broken.md"
        )


def test_prompt_front_matter_is_validated_and_stripped_from_rendered_prompts():
    expected = {
        "direction_discovery.md": {
            "stage": "discovery",
            "schema": "discovery_schema",
            "placeholders": ("direction_instructions", "issue_date", "name"),
        },
        "topic_planner.md": {
            "stage": "planning",
            "schema": "plan_schema",
            "placeholders": (
                "candidates_json",
                "directions_json",
                "issue_date",
                "max_stories",
                "recent_issues_json",
            ),
        },
        "story_research.md": {
            "stage": "research",
            "schema": "brief_schema",
            "placeholders": ("candidates_json", "issue_date", "story_json"),
        },
        "story_writer.md": {
            "stage": "writing",
            "schema": "story_writer_schema",
            "placeholders": (
                "brief_json",
                "issue_date",
                "mode",
                "prior_attempt_json",
                "story_json",
            ),
        },
        "story_reviewer.md": {
            "stage": "review",
            "schema": "story_review_schema",
            "placeholders": (
                "brief_json",
                "issue_date",
                "proposal_json",
                "story_json",
            ),
        },
        "newsletter_editor.md": {
            "stage": "monolithic_editor",
            "schema": "output_schema",
            "placeholders": ("issue_date", "packets_json", "section_kinds"),
        },
    }
    for name, meta in expected.items():
        raw = resources.files("newsletter").joinpath(f"prompts/{name}").read_text("utf-8")
        document = prompts.parse_prompt_document(raw, source=name)
        assert document.name == name.removesuffix(".md")
        assert document.stage == meta["stage"]
        assert document.schema == meta["schema"]
        assert document.placeholders == meta["placeholders"]
        assert not document.body.startswith("---")
        assert "## 写作与核查要求" in document.body or "## 核查与输出要求" in document.body


def test_prompt_parser_rejects_undeclared_placeholder():
    raw = (
        "---\n"
        "name: sample\n"
        "stage: writing\n"
        "schema: story_writer_schema\n"
        "placeholders:\n"
        "  - issue_date\n"
        "---\n"
        "Date: {issue_date}, Unexpected: {story_json}\n"
    )
    with pytest.raises(ValueError, match="placeholders do not match"):
        prompts.parse_prompt_document(raw, source="sample.md")


def reader_issue_stories():
    ai = publication_support.approved_story(
        "story-ai",
        "分块验证把长文本推理的首字延迟压低三成",
        priority=1,
        reading=True,
        chart=True,
    )
    ai["content"].update(
        kind="feature",
        paragraphs=[
            {
                "text": (
                    "大语言模型在生成长回答时，往往先用小模型猜出候选词，再由大模型逐段复核，这一步叫“投机解码”。"
                    "过去验证阶段仍要反复读写整段键值缓存（KV cache，用来暂存历史上下文的显存区域），"
                    "当输入拉长到数万字时，显存带宽会先成为瓶颈 [ai-packet/s1]。"
                ),
                "citations": ["ai-packet/s1"],
            },
            {
                "text": (
                    "System AI Lab 的 Lin Chen 与 Maya Patel 在预印本中把验证拆成固定长度的小块，"
                    "只对命中率下降的片段回退重算，其余块直接复用缓存摘要 [ai-packet/s1]。"
                    "这样做的关键不是换更大的模型，而是减少验证失败时的连带重算范围 [ai-packet/s1]。"
                ),
                "citations": ["ai-packet/s1"],
            },
            {
                "text": (
                    "在 32K 上下文基准上，吞吐从 82 tok/s 提升到 114 tok/s，P95 延迟从 410 ms 降到 295 ms [ai-packet/s1]。"
                    "但当代码或数学推理任务里候选命中率低于 55% 时，额外记账会让收益缩到 6% 以内 [ai-packet/s1]。"
                ),
                "citations": ["ai-packet/s1"],
            },
        ],
        limitations="实验集中在单机 8 卡 A100 与英文长文档；跨节点张量并行和极短问答尚未验证 [ai-packet/s1]。",
        recommended_reading={
            "title": "Chunked Speculative Verification for Long-Context Decoding",
            "reason": (
                "原文第 4 节给出了命中率退化曲线和缓存块大小消融实验，适合对照生产负载评估何时关闭投机分支 [ai-packet/s1]。"
            ),
            "citation": "ai-packet/s1",
        },
        chart={
            "title": "32K 上下文下的解码吞吐对比",
            "subtitle": "合成验收样本",
            "kind": "bar",
            "unit": "tok/s",
            "source_label": "System AI Lab 预印本基准",
            "caption": (
                "横轴为方法、单位为 tok/s；分块验证把吞吐从 82 提到 114，主要因为失败回退不再重扫整段缓存 [ai-packet/s1]。"
            ),
            "points": [
                {
                    "series": "32K 吞吐",
                    "category": "基线验证",
                    "decimal_value": "82",
                    "citations": ["ai-packet/s1"],
                },
                {
                    "series": "32K 吞吐",
                    "category": "分块验证",
                    "decimal_value": "114",
                    "citations": ["ai-packet/s1"],
                },
            ],
        },
    )
    ai["packets"][0]["id"] = "ai-packet"
    ai["packets"][0]["content"].update(
        title=ai["content"]["title"],
        body=ai["content"]["paragraphs"][0]["text"]
        + ai["content"]["paragraphs"][1]["text"]
        + ai["content"]["paragraphs"][2]["text"]
        + ai["content"]["limitations"]
        + ai["content"]["recommended_reading"]["reason"]
        + ai["content"]["chart"]["caption"],
    )
    ai["packets"][0]["content"]["sources"][0].update(
        id="s1",
        title="Chunked Speculative Verification for Long-Context Decoding",
        url="https://example.com/ai-paper",
        access_scope="full_text",
        provenance="web_open",
        excerpt=ai["packets"][0]["content"]["body"],
    )
    ai["packets"][0]["content_hash"] = contracts.content_hash(
        ai["packets"][0]["content"]
    )
    ai["provenance"] = {
        "packets_hash": contracts.content_hash(ai["packets"])
    }
    for item in ai["assessments"]:
        target = components.component_content(
            ai["content"], ai["signal"], item["component"]
        )
        if target is not None:
            item["content_hash"] = contracts.content_hash(target)

    policy_story = publication_support.approved_story(
        "story-policy",
        "欧盟公布通用大模型合规清单，明确训练数据摘要与事故上报时限",
        priority=2,
    )
    policy_story["content"].update(
        kind="briefing",
        paragraphs=[
            {
                "text": (
                    "围绕通用人工智能模型（GPAI，指可被下游改装用于多种任务的底座模型）的监管细则此前停留在原则条文，"
                    "模型提供方并不清楚训练数据披露要细到什么粒度、系统性风险事故要在多久内通报 [policy-packet/s1]。"
                ),
                "citations": ["policy-packet/s1"],
            },
            {
                "text": (
                    "欧盟人工智能办公室此次发布的执行清单要求：算力超过阈值的通用模型须提交按数据源类别汇总的训练语料说明，"
                    "并在发生严重安全事件后 72 小时内提交初报；开源权重模型若不涉及系统性风险，可豁免部分商业机密备案 [policy-packet/s1]。"
                ),
                "citations": ["policy-packet/s1"],
            },
        ],
        limitations="清单属于配套执行指南，成员国监管机构在罚款裁量与跨境取证协作上仍保留解释空间 [policy-packet/s1]。",
    )
    policy_story["packets"][0]["id"] = "policy-packet"
    policy_story["packets"][0]["content"].update(
        title=policy_story["content"]["title"],
        body=policy_story["content"]["paragraphs"][0]["text"]
        + policy_story["content"]["paragraphs"][1]["text"]
        + policy_story["content"]["limitations"],
    )
    policy_story["packets"][0]["content"]["sources"][0].update(
        id="s1",
        title="EU AI Office GPAI Compliance Checklist",
        url="https://example.com/eu-gpai-checklist",
        access_scope="full_text",
        provenance="web_open",
        excerpt=policy_story["packets"][0]["content"]["body"],
    )
    policy_story["packets"][0]["content_hash"] = contracts.content_hash(
        policy_story["packets"][0]["content"]
    )
    policy_story["provenance"] = {
        "packets_hash": contracts.content_hash(policy_story["packets"])
    }
    for item in policy_story["assessments"]:
        target = components.component_content(
            policy_story["content"], policy_story["signal"], item["component"]
        )
        if target is not None:
            item["content_hash"] = contracts.content_hash(target)
    return [ai, policy_story]


def test_assembled_issue_meets_reader_explainability_and_density_bar():
    workflow = definition.load()
    assemble_cfg = next(
        node["config"]
        for node in workflow.nodes
        if node["id"] == "assemble"
    )
    stories = reader_issue_stories()
    result = publication.assemble(
        "2026-09-06",
        stories,
        workflow.budgets,
        config=assemble_cfg,
    )
    assert result.mode == "full"
    draft = result.draft
    contracts.validate_draft(draft, result.packets)
    rendered = rendering.render_edition(draft, result.packets, "2026-09-06")

    assert draft["title"] == "2026-09-06 科技与学术日报"
    assert "重点跟进《分块验证把长文本推理的首字延迟压低三成》" in draft["introduction"]
    assert "《欧盟公布通用大模型合规清单，明确训练数据摘要与事故上报时限》" in draft["introduction"]

    feature, briefing = draft["sections"]
    assert feature["kind"] == "feature" and len(feature["paragraphs"]) >= 3
    assert briefing["kind"] == "briefing" and len(briefing["paragraphs"]) >= 2

    full_text = rendered.text
    for explained_term in (
        "这一步叫“投机解码”",
        "KV cache，用来暂存历史上下文的显存区域",
        "GPAI，指可被下游改装用于多种任务的底座模型",
    ):
        assert explained_term in full_text

    for banned_cliche in (
        "具有重要意义",
        "引发广泛关注",
        "推动行业发展",
        "值得持续跟踪",
    ):
        assert banned_cliche not in full_text

    assert "第 4 节给出了命中率退化曲线" in draft["recommended_reading"]["reason"]
    assert "横轴为方法、单位为 tok/s" in draft["chart"]["caption"]
    assert "重点解读" in rendered.html and "简要速览" in rendered.html

