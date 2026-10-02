"""Test URL provenance without SDK, redirect or network requests."""

import json
import types

import pytest

import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as newsletter_errors
import tests.support.editor as editor

SHORT_URL = "https://example.org/article/synthetic-123"
CANONICAL_URL = "https://example.org/article/synthetic-news-story-synthetic-123"


@pytest.fixture
def bundle():
    # The same small packet/draft shape as the editor fixtures, with public
    # example URLs and conspicuously synthetic content rather than live data.
    return {
        "draft": {
            "subject": "Synthetic provenance fixture",
            "title": "Synthetic provenance fixture",
            "sections": [
                {
                    "kind": "feature",
                    "heading": "Synthetic statement",
                    "paragraphs": [
                        {
                            "text": "Synthetic evidence only.",
                            "citations": ["supplement-1/s1"],
                        }
                    ],
                }
            ],
        },
        "review": {"passed": True, "findings": ["Synthetic review only."]},
        "supplemental_packets": [
            {
                "id": "supplement-1",
                "content": {
                    "title": "Synthetic source packet",
                    "body": "Synthetic fixture, not a real news report.",
                    "sources": [
                        {
                            "id": "s1",
                            "title": "Synthetic source",
                            "url": CANONICAL_URL,
                            "excerpt": "Synthetic evidence only.",
                            "access_scope": "full_text",
                        }
                    ],
                    "tags": ["fixture"],
                },
            }
        ],
    }


@pytest.mark.parametrize(
    ("source_url", "other_url"),
    [(CANONICAL_URL, SHORT_URL), (SHORT_URL, CANONICAL_URL)],
)
def test_same_host_and_content_id_do_not_prove_exact_source_was_opened(
    bundle, source_url, other_url
):
    bundle["supplemental_packets"][0]["content"]["sources"][0]["url"] = (
        source_url
    )
    text = json.dumps(bundle)
    with pytest.raises(newsletter_errors.EditorError) as error:
        newsletter_editor.parse_editor_result(
            text, [], {other_url}, searched=True
        )
    assert error.value.code == "invalid_output"

    # A possible redirect/canonical relationship is not evidence. Only after
    # the exact cited URL also appears in the observed opens can it be accepted.
    result = newsletter_editor.parse_editor_result(
        text, [], {other_url, source_url}, searched=True
    )
    assert result.review["passed"] is True
    added = result.supplemental_packets[0]
    assert added["content"]["sources"][0]["url"] == source_url
    assert result.draft["sections"][0]["paragraphs"][0]["citations"] == [
        added["id"] + "/s1"
    ]
    contracts.validate_draft(result.draft, result.supplemental_packets)


@pytest.mark.parametrize(
    ("source_url", "opened_url"),
    [
        (CANONICAL_URL + "#table-1", CANONICAL_URL),
        (CANONICAL_URL + "#different-section", CANONICAL_URL),
        (
            CANONICAL_URL + "?edition=first#table-1",
            CANONICAL_URL + "?edition=first",
        ),
    ],
)
def test_fragment_is_the_only_ignored_url_component(
    bundle, source_url, opened_url
):
    bundle["supplemental_packets"][0]["content"]["sources"][0]["url"] = (
        source_url
    )
    # _collect already removes fragments from observed opens before
    # parse_editor_result.
    result = newsletter_editor.parse_editor_result(
        json.dumps(bundle), [], {opened_url}, searched=True
    )
    assert result.review["passed"] is True
    assert (
        result.supplemental_packets[0]["content"]["sources"][0]["url"]
        == source_url
    )
    contracts.validate_draft(result.draft, result.supplemental_packets)


@pytest.mark.parametrize(
    ("source_suffix", "opened_suffix"),
    [
        ("?edition=first", ""),
        ("", "?edition=first"),
        ("?edition=first", "?edition=second"),
        ("?edition=first#table-1", "?edition=second"),
        ("?edition=first&view=full", "?view=full&edition=first"),
    ],
)
def test_query_parameters_are_not_removed_or_normalized(
    bundle, source_suffix, opened_suffix
):
    bundle["supplemental_packets"][0]["content"]["sources"][0]["url"] = (
        CANONICAL_URL + source_suffix
    )
    with pytest.raises(newsletter_errors.EditorError) as error:
        newsletter_editor.parse_editor_result(
            json.dumps(bundle),
            [],
            {CANONICAL_URL + opened_suffix},
            searched=True,
        )
    assert error.value.code == "invalid_output"


def test_reading_support_citations_receive_host_owned_ids(
    bundle,
):
    supplement = bundle["supplemental_packets"][0]
    supplement["content"]["sources"].append(
        {
            **supplement["content"]["sources"][0],
            "id": "journal",
            "url": SHORT_URL,
        }
    )
    bundle["draft"]["recommended_reading"] = {
        "citation": "supplement-1/s1",
        "reason": "Synthetic primary reading and journal record.",
        "supporting_citations": ["supplement-1/journal"],
    }
    result = newsletter_editor.parse_editor_result(
        json.dumps(bundle), [], {CANONICAL_URL, SHORT_URL}, searched=True
    )
    identity = result.supplemental_packets[0]["id"]
    reading = result.draft["recommended_reading"]
    assert identity != "supplement-1"
    assert reading["citation"] == identity + "/s1"
    assert reading["supporting_citations"] == [identity + "/journal"]
    contracts.validate_draft(result.draft, result.supplemental_packets)


@pytest.mark.parametrize("component", ["body", "reading", "chart", "signal"])
@pytest.mark.parametrize(
    "opened,searched,expected",
    [
        (set(), False, ["search", "openPage"]),
        ({SHORT_URL}, False, ["search"]),
        (set(), True, ["openPage"]),
        ({SHORT_URL}, True, []),
    ],
)
def test_component_approval_selects_only_missing_observed_actions(
    component, opened, searched, expected
):
    value = {
        "assessments": [
            {"component": component, "status": "approved", "findings": []}
        ],
        "issues": [],
    }
    assert (
        newsletter_editor._unobserved_approval_actions(
            json.dumps(value), opened, searched
        )
        == expected
    )


@pytest.mark.parametrize(
    "assessments",
    [
        [],
        None,
        "approved",
        {"component": "body", "status": "approved"},
        [{"component": "body", "status": "blocked"}],
        [{"component": "body", "status": "not_present"}],
        [{"component": "body", "status": True}],
        [{"component": "body", "status": "APPROVED"}],
        [{"component": "invented", "status": "approved"}],
        [{"component": [], "status": "approved"}],
        [None, "approved"],
    ],
)
def test_honest_component_hold_or_malformed_claim_does_not_trigger_research(
    assessments,
):
    assert (
        newsletter_editor._unobserved_approval_actions(
            json.dumps({"assessments": assessments}), set(), False
        )
        == []
    )


async def test_component_approval_gets_one_same_thread_source_action_correction(
    tmp_path, fake_sdk
):
    value = {
        "assessments": [
            {"component": "body", "status": "approved", "findings": []}
        ],
        "issues": [],
    }
    fake_sdk.turns = [
        editor.FakeTurn(value, research=False),
        editor.FakeTurn(value),
    ]
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job"
    )
    assert json.loads(text) == value and opened and searched
    assert len(fake_sdk.prompts) == 2 and fake_sdk.thread_starts == 1
    correction = fake_sdk.prompts[1]
    assert correction["missing_approval_actions"] == ["search", "openPage"]
    assert "status" in correction["task"] and "blocked" in correction["task"]
    assert "不得增加 passed 字段" in correction["task"]


async def test_self_approval_adds_no_fake_actions_or_third_turn(
    tmp_path, fake_sdk
):
    value = {
        "assessments": [
            {"component": "signal", "status": "approved", "findings": []}
        ],
        "issues": [],
    }
    fake_sdk.turn = editor.FakeTurn(value, research=False)
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job"
    )
    assert not opened and not searched and len(fake_sdk.prompts) == 2
    # The StoryEditor receipt boundary still rejects this unobserved approval.
    assert newsletter_editor._unobserved_approval_actions(
        text, opened, searched
    ) == [
        "search",
        "openPage",
    ]


async def test_all_components_blocked_do_not_spend_an_action_correction(
    tmp_path, fake_sdk
):
    value = {
        "assessments": [
            {
                "component": "body",
                "status": "blocked",
                "findings": ["Cannot confirm"],
            }
        ],
        "issues": [],
    }
    fake_sdk.turn = editor.FakeTurn(value, research=False)
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job"
    )
    assert json.loads(text) == value and not opened and not searched
    assert len(fake_sdk.prompts) == 1


def test_prior_retraction_needs_fresh_actions_without_new_body():
    value = {
        "assessments": [
            {"component": "body", "status": "not_present", "findings": []}
        ],
        "prior_withdrawal": {"target_body_hash": "a" * 64},
    }
    assert newsletter_editor._unobserved_approval_actions(
        json.dumps(value), set(), False
    ) == [
        "search",
        "openPage",
    ]
    assert (
        newsletter_editor._unobserved_approval_actions(
            json.dumps(value), {SHORT_URL}, True
        )
        == []
    )
    value["prior_withdrawal"] = None
    assert (
        newsletter_editor._unobserved_approval_actions(
            json.dumps(value), set(), False
        )
        == []
    )


def component_review(**statuses):
    return {
        "assessments": [
            {"component": key, "status": status, "findings": []}
            for key, status in statuses.items()
        ],
        "issues": [],
        "prior_withdrawal": None,
    }


class SourceTurn(editor.FakeTurn):
    def __init__(self, value, urls, *, searched=True, **kwargs):
        super().__init__(value, research=False, **kwargs)
        self.urls, self.searched = urls, searched

    async def stream(self):
        actions = (
            [{"type": "search", "query": "synthetic"}] if self.searched else []
        ) + [{"type": "openPage", "url": url} for url in self.urls]
        for action in actions:
            yield types.SimpleNamespace(
                method="item/completed",
                payload={"item": {"type": "webSearch", "action": action}},
            )
        async for event in super().stream():
            yield event


def test_only_approved_components_select_code_owned_missing_urls():
    sources = newsletter_editor.ApprovalSources(
        {
            "body": [SHORT_URL, CANONICAL_URL],
            "reading": ["https://example.org/unneeded"],
            "signal": [SHORT_URL],
        }
    )
    value = component_review(
        body="approved",
        reading="blocked",
        chart="not_present",
        signal="approved",
    )
    value["assessments"][0]["url"] = "https://example.org/model-invented"
    assert newsletter_editor._unopened_approval_sources(
        json.dumps(value), {SHORT_URL}, sources
    ) == [CANONICAL_URL]


@pytest.mark.parametrize(
    "status", ["blocked", "not_present", None, True, "APPROVED"]
)
def test_blocked_or_absent_component_never_selects_missing_urls(status):
    sources = newsletter_editor.ApprovalSources({"body": [CANONICAL_URL]})
    assert (
        newsletter_editor._unopened_approval_sources(
            json.dumps(component_review(body=status)), set(), sources
        )
        == []
    )


def test_withdrawal_only_selects_its_declared_known_evidence_not_all_sources():
    sources = newsletter_editor.ApprovalSources(
        {}, {"p/first": SHORT_URL, "p/second": CANONICAL_URL}
    )
    value = component_review(body="not_present")
    value["prior_withdrawal"] = {
        "target_body_hash": "a" * 64,
        "evidence": ["p/second", "https://example.org/model-url", None],
    }
    assert newsletter_editor._unopened_approval_sources(
        json.dumps(value), set(), sources
    ) == [CANONICAL_URL]
    value["prior_withdrawal"] = None
    assert (
        newsletter_editor._unopened_approval_sources(
            json.dumps(value), set(), sources
        )
        == []
    )


def test_review_url_matching_ignores_only_fragments():
    sources = newsletter_editor.ApprovalSources(
        {"body": [SHORT_URL + "?v=1#table", CANONICAL_URL]}
    )
    text = json.dumps(component_review(body="approved"))
    assert (
        newsletter_editor._unopened_approval_sources(
            text, {SHORT_URL + "?v=1", CANONICAL_URL}, sources
        )
        == []
    )
    assert newsletter_editor._unopened_approval_sources(
        text, {SHORT_URL, CANONICAL_URL}, sources
    ) == [SHORT_URL + "?v=1#table"]


async def test_first_open_keeps_second_url_in_one_correction(
    tmp_path, fake_sdk
):
    value = component_review(body="approved", signal="approved")
    fake_sdk.turns = [
        SourceTurn(value, [SHORT_URL]),
        SourceTurn(value, [CANONICAL_URL], searched=False),
    ]
    sources = newsletter_editor.ApprovalSources(
        {"body": [SHORT_URL, CANONICAL_URL], "signal": [SHORT_URL]}
    )
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job", approval_sources=sources
    )
    assert (
        json.loads(text) == value
        and opened == {SHORT_URL, CANONICAL_URL}
        and searched
    )
    assert len(fake_sdk.prompts) == 2 and fake_sdk.thread_starts == 1
    correction = fake_sdk.prompts[1]
    assert correction["unverified_urls"] == [CANONICAL_URL]
    assert correction["missing_approval_actions"] == []
    assert (
        "逐个独立open" in correction["task"]
        and "不要一次调用批量打开" in correction["task"]
    )


async def test_missing_second_url_adds_no_third_turn_or_global_failure(
    tmp_path, fake_sdk
):
    value = component_review(body="approved", reading="approved")
    fake_sdk.turn = SourceTurn(value, [SHORT_URL])
    sources = newsletter_editor.ApprovalSources(
        {"body": [SHORT_URL], "reading": [CANONICAL_URL]}
    )
    text, opened, searched = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job", approval_sources=sources
    )
    assert json.loads(text) == value and opened == {SHORT_URL} and searched
    assert len(fake_sdk.prompts) == 2
    # Caller keeps the independently verified body and blocks the reading card.
    assert newsletter_editor._unopened_approval_sources(
        text, opened, sources
    ) == [CANONICAL_URL]


async def test_correction_can_block_only_unverifiable_component_and_keep_body(
    tmp_path, fake_sdk
):
    first, final = (
        component_review(body="approved", reading="approved"),
        component_review(body="approved", reading="blocked"),
    )
    fake_sdk.turns = [
        SourceTurn(first, [SHORT_URL]),
        SourceTurn(final, [], searched=False),
    ]
    sources = newsletter_editor.ApprovalSources(
        {"body": [SHORT_URL], "reading": [CANONICAL_URL]}
    )
    text, opened, _ = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job", approval_sources=sources
    )
    assert json.loads(text) == final and len(fake_sdk.prompts) == 2
    assert (
        newsletter_editor._unopened_approval_sources(text, opened, sources)
        == []
    )


async def test_source_packet_and_component_misses_share_one_correction_slot(
    tmp_path, fake_sdk, bundle
):
    value = component_review(body="approved")
    value["supplemental_packets"] = bundle["supplemental_packets"]
    third_url = "https://example.org/third-source"
    fake_sdk.turns = [
        SourceTurn(value, [SHORT_URL]),
        SourceTurn(value, [CANONICAL_URL, third_url]),
    ]
    sources = newsletter_editor.ApprovalSources({"body": [third_url]})
    _, opened, _ = await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job", approval_sources=sources
    )
    assert len(fake_sdk.prompts) == 2
    assert set(fake_sdk.prompts[1]["unverified_urls"]) == {
        CANONICAL_URL,
        third_url,
    }
    assert opened == {SHORT_URL, CANONICAL_URL, third_url}


async def test_withdrawal_missing_specific_evidence_gets_existing_correction(
    tmp_path, fake_sdk
):
    value = component_review(body="not_present")
    value["prior_withdrawal"] = {
        "target_body_hash": "a" * 64,
        "evidence": ["p/second"],
    }
    fake_sdk.turns = [
        SourceTurn(value, [SHORT_URL]),
        SourceTurn(value, [CANONICAL_URL]),
    ]
    sources = newsletter_editor.ApprovalSources(
        {}, {"p/first": SHORT_URL, "p/second": CANONICAL_URL}
    )
    await editor.live_editor(tmp_path).execute(
        "{}", {}, "fixture", tmp_path / "job", approval_sources=sources
    )
    assert fake_sdk.prompts[1]["unverified_urls"] == [CANONICAL_URL]


async def test_missing_component_url_correction_stays_inside_original_timeout(
    tmp_path, fake_sdk
):
    value = component_review(body="approved")
    fake_sdk.turns = [
        SourceTurn(value, [SHORT_URL]),
        SourceTurn(value, [], hang=True),
    ]
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path, timeout_seconds=0.01).execute(
            "{}",
            {},
            "fixture",
            tmp_path / "job",
            approval_sources=newsletter_editor.ApprovalSources(
                {"body": [CANONICAL_URL]}
            ),
        )
    assert error.value.code == "timeout" and len(fake_sdk.prompts) == 2


@pytest.mark.parametrize(
    "sources",
    [
        {"body": [SHORT_URL]},
        newsletter_editor.ApprovalSources({"unknown": [SHORT_URL]}),
        newsletter_editor.ApprovalSources({"body": SHORT_URL}),
        newsletter_editor.ApprovalSources(
            {"body": ["http://127.0.0.1/private"]}
        ),
        newsletter_editor.ApprovalSources({"body": [SHORT_URL] * 1025}),
        newsletter_editor.ApprovalSources({}, {"no-slash": SHORT_URL}),
        newsletter_editor.ApprovalSources(
            {}, {"p/s": "https://user:secret@example.org/private"}
        ),
    ],
)
async def test_invalid_review_source_configuration_fails_before_starting_sdk(
    tmp_path, fake_sdk, sources
):
    with pytest.raises(newsletter_errors.EditorError) as error:
        await editor.live_editor(tmp_path).execute(
            "{}", {}, "fixture", tmp_path / "job", approval_sources=sources
        )
    assert error.value.code == "invalid_input" and not fake_sdk.started


def test_review_source_snapshot_cannot_be_changed_by_later_caller_mutation():
    urls, evidence = [SHORT_URL], {"p/first": SHORT_URL}
    frozen = newsletter_editor._approval_snapshot(
        newsletter_editor.ApprovalSources({"body": urls}, evidence)
    )
    urls.append(CANONICAL_URL)
    evidence["p/second"] = CANONICAL_URL
    assert frozen.components == {"body": (SHORT_URL,)} and frozen.evidence == {
        "p/first": SHORT_URL
    }
