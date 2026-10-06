"""Test one provenance correction with synthetic SDK events and no network.

Approval claims come only from the story review: a component assessment with
status=approved. Writer output carries no approval, so it is corrected only
for unopened new sources.
"""

import json

import pytest

import newsletter.editor as newsletter_editor
import newsletter.errors as newsletter_errors
import tests.support.editor as editor

EVIDENCE_URL = "https://example.com/evidence"


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
    tmp_path, fake_sdk, component, missing
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
    fake_sdk.turns = [limited_turn(value, missing), corrected]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value
    assert searched and opened == {"https://example.com/evidence"}
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2
    correction = fake_sdk.prompts[1]
    assert correction["unverified_urls"] == []
    assert correction["missing_approval_actions"] == (
        ["search", "openPage"] if missing == "both" else [missing]
    )
    assert "blocked" in correction["task"] and "HOLD" in correction["task"]
    assert "review.passed" not in correction["task"]
    assert "实际" in correction["task"] and "web search" in correction["task"]
    assert fake_sdk.closed


@pytest.mark.parametrize("component", ["body", "signal"])
async def test_correction_may_honestly_hold_without_inventing_research(
    tmp_path, fake_sdk, component
):
    held = approval(component, passed=False)
    fake_sdk.turns = [
        editor.FakeTurn(approval(component), research=False),
        editor.FakeTurn(held, research=False),
    ]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == held and not opened and not searched
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2


@pytest.mark.parametrize("component", ["body", "signal"])
@pytest.mark.parametrize("missing", ["search", "openPage", "both"])
async def test_unsupported_second_pass_does_not_get_a_third_turn(
    tmp_path, fake_sdk, component, missing
):
    value = approval(component)
    fake_sdk.turn = limited_turn(value, missing)
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value
    assert newsletter_editor._unobserved_approval_actions(
        text, opened, searched
    )
    # Execute never fabricates successful actions; callers still see the gap.
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2


@pytest.mark.parametrize("corrected_search", [True, False])
async def test_url_and_approval_share_one_correction_budget(
    tmp_path, fake_sdk, corrected_search
):
    value = approval("body")
    sources = newsletter_editor.ApprovalSources({"body": [EVIDENCE_URL]})
    corrected = (
        editor.FakeTurn(value)
        if corrected_search
        else limited_turn(value, "search")
    )
    fake_sdk.turns = [editor.FakeTurn(value, research=False), corrected]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job", approval_sources=sources
    )
    correction = fake_sdk.prompts[1]
    assert correction["unverified_urls"] == [EVIDENCE_URL]
    assert correction["missing_approval_actions"] == ["search", "openPage"]
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2
    assert not newsletter_editor._unopened_approval_sources(
        text, opened, sources
    )
    assert searched is corrected_search
    assert newsletter_editor._unobserved_approval_actions(
        text, opened, searched
    ) == ([] if corrected_search else ["search"])


@pytest.mark.parametrize("component", ["body", "signal"])
async def test_honest_initial_hold_does_not_force_actions(
    tmp_path, fake_sdk, component
):
    value = approval(component, passed=False)
    fake_sdk.turn = editor.FakeTurn(value, research=False)
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value and not opened and not searched
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 1


async def test_unapproved_writer_output_still_corrects_new_unopened_sources(
    tmp_path, fake_sdk, packet
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
    fake_sdk.turns = [
        editor.FakeTurn(value, research=False),
        limited_turn(value, "search"),
    ]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "synthetic", tmp_path / "job"
    )
    assert json.loads(text) == value and opened and not searched
    assert len(fake_sdk.prompts) == 2
    assert fake_sdk.prompts[1]["unverified_urls"] == [EVIDENCE_URL]
    assert fake_sdk.prompts[1]["missing_approval_actions"] == []


@pytest.mark.parametrize("component", ["body", "signal"])
async def test_action_correction_uses_original_timeout(
    tmp_path, fake_sdk, component
):
    value = approval(component)
    hanging = editor.FakeTurn(value, hang=True)
    fake_sdk.turns = [editor.FakeTurn(value, research=False), hanging]
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path, timeout_seconds=0.05).execute(
            "{}", {}, "synthetic", tmp_path / "job"
        )
    assert error.value.code == "timeout" and hanging.interrupted
    assert fake_sdk.thread_starts == 1 and len(fake_sdk.prompts) == 2
    assert fake_sdk.closed


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
