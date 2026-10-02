"""Test publication admission, stable checkpoints and next-day topic memory."""

import copy

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.workflow.components as components
import newsletter.workflow.publication as newsletter_workflow_publication
import newsletter.workflow.story_nodes as story_nodes
import tests.support.publication as publication

NEXT_DAY = "2026-09-07"


def withdrawal_result(prior=None, *, signal=False, content=False):
    prior = prior or publication.result(signal=True)
    value = publication.result(mode="deep", content=content)
    reviewed = publication.receipt(
        "body",
        components.body_content(prior["content"]),
        value["packets"],
        status="blocked",
        writer_job_id="deep-writer",
        reviewer_job_id="deep-reviewer",
    )
    if content:
        value["assessments"][0]["reviewer_job_id"] = "deep-reviewer"
    else:
        value["assessments"].append(reviewed)
    value["withdrawals"] = [
        {
            "story_id": prior["story_id"],
            "mode": "brief",
            "content_hash": contracts.content_hash(
                components.body_content(prior["content"])
            ),
            "affected_signal_hash": contracts.content_hash(prior["signal"])
            if signal
            else "",
            "claim": prior["content"]["paragraphs"][0]["text"],
            "reason": (
                "A fresh independent source check establishes a concrete "
                "factual error."
            ),
            "evidence": ["packet-1/original"],
            "searched": True,
            "opened": True,
            "opened_urls": [publication.URL + "/1"],
            "writer_job_id": "writer-job",
            "reviewer_job_id": "deep-reviewer",
        }
    ]
    return value


@pytest.fixture
def repository(tmp_path):
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    yield newsletter_workflow_publication.PublicationRepository(store)
    store.close()


def test_approved_story_and_summary_use_public_proto():
    value = publication.result()
    newsletter_workflow_publication.validate_result(value)
    contracts.parse_message(value["content"], editorial_pb2.StoryContent)
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [value]
    )
    contracts.parse_message(built["coverage"], editorial_pb2.PublicationSummary)
    contracts.validate_draft(built["draft"], built["packets"])
    assert built["review"]["passed"] is True
    assert built["notion_required"] is False
    section = built["draft"]["sections"][0]
    assert section["heading"] == value["content"]["title"]
    assert section["paragraphs"] == value["content"]["paragraphs"]
    assert section["limitations"] == value["content"]["limitations"]
    assert (
        value == publication.result()
    )  # Assembly cannot mutate an approved source object.


@pytest.mark.parametrize(
    "edit",
    [
        lambda r: r.update(assessments=[]),
        lambda r: r["content"].update(title="Unreviewed replacement title"),
        lambda r: r["content"].update(limitations="Changed limitation"),
        lambda r: r["content"]["paragraphs"][0].update(
            text="New unreviewed claim"
        ),
        lambda r: r["content"].update(story_id="other-story"),
        lambda r: r["assessments"][0].update(status="blocked"),
        lambda r: r["assessments"][0].update(searched=False),
        lambda r: r["assessments"][0].update(opened=False),
        lambda r: r["assessments"][0].update(opened_urls=[]),
        lambda r: r["assessments"][0].update(
            opened_urls=["https://example.org/other"]
        ),
        lambda r: r["assessments"][0].update(
            writer_job_id="independent-reviewer-job"
        ),
        lambda r: r["assessments"][0].update(reviewer_job_id=""),
        lambda r: r["assessments"][0].update(round="manually-approved"),
        lambda r: r["packets"][0]["content"]["sources"][0].update(
            url="https://example.org/changed"
        ),
        lambda r: r.update(provenance={"packets_hash": "0" * 64}),
        lambda r: r.update(extra_field="not part of the internal contract"),
    ],
)
def test_naked_passes_and_mutated_content_evidence_or_review_do_not_admit_text(
    edit,
):
    value = publication.result()
    edit(value)
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        newsletter_workflow_publication.validate_result(value)


def test_same_round_unresolved_issue_cannot_coexist_with_component_approval():
    value = publication.result(
        issues=[
            {
                "round": "initial",
                "component": "body",
                "claim": "Synthetic result 1",
                "reason": "The number is incorrect",
                "evidence": ["packet-1/original"],
                "action": "correct",
            }
        ]
    )
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        newsletter_workflow_publication.validate_result(value)
    value["assessments"][0]["round"] = "repair"
    newsletter_workflow_publication.validate_result(value)


def test_receipt_cannot_certify_unknown_or_metadata_evidence():
    for ref, scope in (
        ("unknown/source", "full_text"),
        ("packet-1/original", "metadata"),
    ):
        value = publication.result()
        value["content"]["paragraphs"][0]["citations"] = [ref]
        value["packets"][0]["content"]["sources"][0]["access_scope"] = scope
        value["assessments"][0] = publication.receipt(
            "body", value["content"], value["packets"]
        )
        value["provenance"]["packets_hash"] = contracts.content_hash(
            value["packets"]
        )
        with pytest.raises(newsletter_workflow_publication.PublicationError):
            newsletter_workflow_publication.validate_result(value)


def test_unapproved_extra_never_sneaks_into_approved_body():
    value = publication.result()
    value["content"]["recommended_reading"] = {
        "citation": "packet-1/original",
        "reason": "A new unreviewed claim attached to an approved body.",
        "supporting_citations": [],
    }
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        newsletter_workflow_publication.validate_result(value)
    value["content"].pop("recommended_reading")
    newsletter_workflow_publication.validate_result(value)


def test_multiple_reading_sources_all_need_independent_open_receipt():
    value = publication.result()
    value["packets"].append(publication.packet(2))
    reading = {
        "citation": "packet-1/original",
        "reason": (
            "One primary reading link, with an additional fact "
            "supported separately."
        ),
        "supporting_citations": ["packet-2/original"],
    }
    value["content"]["recommended_reading"] = reading
    value["assessments"].append(
        publication.receipt("reading", reading, value["packets"])
    )
    value["provenance"]["packets_hash"] = contracts.content_hash(
        value["packets"]
    )
    newsletter_workflow_publication.validate_result(value)
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [value]
    )
    assert len(built["packets"]) == 2
    value["assessments"][-1]["opened_urls"] = [publication.URL + "/1"]
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        newsletter_workflow_publication.validate_result(value)


def test_topic_dispositions_survive_other_story_failures():
    tasks = [publication.task(i) for i in range(1, 6)]
    values = [
        publication.result(1),
        publication.result(1, "deep"),
        publication.result(2),
        publication.result(2, "deep", content=False),
        publication.result(3, content=False, signal=True),
        publication.result(4, content=False),
        publication.result(5, assessments=[]),
    ]
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, tasks, values, reason="deadline"
    )
    assert [s["disposition"] for s in built["coverage"]["stories"]] == [
        "deep",
        "brief",
        "watch",
        "deferred",
        "deferred",
    ]
    assert [s["story_id"] for s in built["coverage"]["stories"]] == [
        t["id"] for t in tasks
    ]
    assert built["coverage"]["mode"] == "partial"
    assert built["coverage"]["reason"] == "deadline"
    assert len(built["draft"]["sections"]) == 3
    assert [s["kind"] for s in built["draft"]["sections"]] == ["feature"] * 3
    assert [s["heading"] for s in built["draft"]["sections"]] == [
        values[1]["content"]["title"],
        values[2]["content"]["title"],
        values[4]["signal"]["title"],
    ]
    assert {p["id"] for p in built["packets"]} == {
        "packet-1",
        "packet-2",
        "packet-3",
    }
    assert "Synthetic research question 4" not in str(built["draft"])
    assert "2 个入选选题暂未刊出" in built["draft"]["introduction"]
    assert "Synthetic research question 4" not in built["draft"]["introduction"]


def test_deadline_disclosure_keeps_deep_brief_distinction():
    built = newsletter_workflow_publication.assemble(
        "run-1",
        publication.DAY,
        [publication.task()],
        [publication.result(mode="deep")],
        reason="deadline",
    )
    assert built["coverage"]["mode"] == "partial"
    assert "已完成独立核验" in built["draft"]["introduction"]
    assert "简讯" not in built["draft"]["introduction"]
    assert built["coverage"]["stories"][0]["disposition"] == "deep"


def test_only_two_priority_deeps_and_other_complete_briefs_are_preserved():
    tasks = [
        publication.task(3),
        publication.task(2),
        publication.task(1),
        publication.task(4),
    ]
    values = [
        publication.result(i, mode)
        for i in range(1, 5)
        for mode in ("brief", "deep")
    ]
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, tasks, values
    )
    assert [s["story_id"] for s in built["coverage"]["stories"]] == [
        "story-1",
        "story-2",
        "story-3",
        "story-4",
    ]
    assert [s["disposition"] for s in built["coverage"]["stories"]] == [
        "deep",
        "deep",
        "brief",
        "brief",
    ]
    assert len(built["draft"]["sections"]) == 4
    assert (
        built["draft"]["sections"][0]["paragraphs"]
        == values[1]["content"]["paragraphs"]
    )


def test_failed_or_corrupt_result_keeps_prior_approval():
    initial = publication.result(content=False, signal=True)
    good = publication.result()
    failed = publication.result(content=False, reason="provider_timeout")
    corrupted = publication.result(
        content=publication.story(title="Unreviewed new text"), assessments=[]
    )
    for values, disposition in (
        ([initial, failed], "watch"),
        ([good, failed, corrupted], "brief"),
    ):
        built = newsletter_workflow_publication.assemble(
            "run-1", publication.DAY, [publication.task()], values
        )
        assert built["coverage"]["stories"][0]["disposition"] == disposition
        assert "Unreviewed new text" not in str(built["draft"])


def test_exact_body_withdrawal_keeps_confirmed_signal():
    prior = publication.result(signal=True)
    correction = withdrawal_result(prior)
    newsletter_workflow_publication.validate_result(correction)
    built = newsletter_workflow_publication.assemble(
        "run-1",
        publication.DAY,
        [publication.task(), publication.task(2)],
        [prior, correction, publication.result(2)],
    )
    assert [s["disposition"] for s in built["coverage"]["stories"]] == [
        "watch",
        "brief",
    ]
    assert "Confirmed event, uncertain significance" in str(built["draft"])
    assert "Synthetic verified topic 1" not in str(built["draft"])


def test_signal_is_removed_only_when_its_exact_hash_is_explicitly_affected():
    prior = publication.result(signal=True)
    correction = withdrawal_result(prior, signal=True)
    built = newsletter_workflow_publication.assemble(
        "run-1",
        publication.DAY,
        [publication.task(), publication.task(2)],
        [prior, correction, publication.result(2)],
    )
    assert [s["disposition"] for s in built["coverage"]["stories"]] == [
        "deferred",
        "brief",
    ]
    assert "明确事实错误" in built["coverage"]["stories"][0]["reason"]
    assert "Confirmed event" not in str(built["draft"])


def test_approved_corrected_deep_survives_withdrawal_of_an_old_brief():
    prior = publication.result(signal=True)
    corrected = publication.story(
        paragraphs=[
            {
                "text": (
                    "A new independently verified correction; the exact "
                    "old body is withdrawn."
                ),
                "citations": ["packet-1/original"],
            }
        ]
    )
    correction = withdrawal_result(prior, signal=True, content=corrected)
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [prior, correction]
    )
    assert built["coverage"]["stories"][0]["disposition"] == "deep"
    assert "A new independently verified correction" in str(built["draft"])


@pytest.mark.parametrize(
    "change",
    [
        {"content_hash": "0" * 64},
        {"claim": "A different long claim not present in the old body."},
        {"writer_job_id": "not-the-original-author"},
        {"affected_signal_hash": "0" * 64},
    ],
)
def test_withdrawal_cannot_target_unknown_body_signal_author_or_unquoted_claim(
    change,
):
    prior = publication.result(signal=True)
    correction = withdrawal_result(prior)
    correction["withdrawals"][0].update(change)
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [prior, correction]
    )
    assert built["coverage"]["stories"][0]["disposition"] == "brief"


@pytest.mark.parametrize(
    "change",
    [
        {"searched": False},
        {"opened": False},
        {"opened_urls": []},
        {"evidence": []},
        {"evidence": ["unknown/source"]},
        {"claim": "too short"},
        {"reason": ""},
        {"reviewer_job_id": "writer-job"},
        {"reviewer_job_id": "unobserved-review"},
        {"story_id": "another-story"},
        {"mode": "deep"},
    ],
)
def test_unverified_withdrawal_or_failure_keeps_good_brief(
    change,
):
    prior = publication.result(signal=True)
    correction = withdrawal_result(prior)
    correction["withdrawals"][0].update(change)
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        newsletter_workflow_publication.validate_result(correction)
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [prior, correction]
    )
    assert built["coverage"]["stories"][0]["disposition"] == "brief"


def test_withdrawal_works_across_checkpoint_replay_and_next_deep_prior(
    repository,
):
    prior = publication.result(signal=True)
    correction = withdrawal_result(prior)
    repository.save(
        "run-1", publication.task(), "brief", prior, issue_date=publication.DAY
    )
    repository.save(
        "run-1",
        publication.task(),
        "deep",
        correction,
        issue_date=publication.DAY,
    )
    prior_view = repository.best_result("run-1", "story-1")
    assert prior_view["content"] is None
    assert prior_view["signal"] == prior["signal"]
    newsletter_workflow_publication.validate_result(prior_view)
    assert (
        repository.results("run-1")[0] == prior
    )  # Immutable audit version remains intact.
    both = withdrawal_result(prior, signal=True)
    repository.save(
        "run-1", publication.task(), "deep", both, issue_date=publication.DAY
    )
    assert repository.best_result("run-1", "story-1") is None


def test_latest_complete_approval_wins_without_splicing():
    initial = publication.result()
    revised = publication.result(
        content=publication.story(
            paragraphs=[
                {
                    "text": (
                        "A complete independently reviewed replacement, "
                        "with all boundaries."
                    ),
                    "citations": ["packet-1/original"],
                }
            ]
        )
    )
    revised["assessments"][0]["round"] = "repair"
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [initial, revised]
    )
    text = str(built["draft"])
    assert "complete independently reviewed replacement" in text
    assert "Synthetic result 1" not in text


def test_capacity_defers_topics_without_cutting_paragraphs():
    tasks = [publication.task(i) for i in range(1, 19)]
    built = newsletter_workflow_publication.assemble(
        "run-1",
        publication.DAY,
        tasks,
        [publication.result(i) for i in range(1, 19)],
    )
    coverage = built["coverage"]["stories"]
    assert len(coverage) == 18
    assert [s["disposition"] for s in coverage[: contracts.MAX_SECTIONS]] == [
        "brief"
    ] * contracts.MAX_SECTIONS
    assert [s["disposition"] for s in coverage[contracts.MAX_SECTIONS :]] == [
        "deferred"
    ] * (18 - contracts.MAX_SECTIONS)
    assert all(
        "容量" in s["reason"] for s in coverage[contracts.MAX_SECTIONS :]
    )


@pytest.mark.parametrize("kind", contracts.SECTION_KINDS)
def test_topic_semantics_survive_publication_independently_of_brief_or_deep(
    kind,
):
    for mode in ("brief", "deep"):
        value = publication.result(
            mode=mode, content=publication.story(kind=kind)
        )
        built = newsletter_workflow_publication.assemble(
            "run-1", publication.DAY, [publication.task()], [value]
        )
        assert built["draft"]["sections"][0]["kind"] == kind
        assert (
            built["draft"]["sections"][0]["heading"]
            == value["content"]["title"]
        )
        assert (
            built["draft"]["sections"][0]["paragraphs"]
            == value["content"]["paragraphs"]
        )


def test_twelve_briefs_keep_individual_titles_and_limitations():
    values = [
        publication.result(
            i,
            content=publication.story(
                i,
                kind=contracts.SECTION_KINDS[
                    (i - 1) % len(contracts.SECTION_KINDS)
                ],
            ),
        )
        for i in range(1, 13)
    ]
    built = newsletter_workflow_publication.assemble(
        "run-1",
        publication.DAY,
        [publication.task(i) for i in range(1, 13)],
        values,
    )
    assert len(built["draft"]["sections"]) == 12
    assert all(
        s["disposition"] == "brief" for s in built["coverage"]["stories"]
    )
    for section, value in zip(built["draft"]["sections"], values, strict=True):
        assert section == {
            "kind": value["content"]["kind"],
            "heading": value["content"]["title"],
            "paragraphs": value["content"]["paragraphs"],
            "limitations": value["content"]["limitations"],
        }


def test_no_approved_public_content_is_explicit_error_not_empty_success():
    for values in (
        [],
        [publication.result(content=False)],
        [publication.result(assessments=[])],
    ):
        with pytest.raises(
            newsletter_workflow_publication.PublicationError
        ) as caught:
            newsletter_workflow_publication.assemble(
                "run-1", publication.DAY, [publication.task()], values
            )
        assert caught.value.code == "no_publishable_content"
    with pytest.raises(
        newsletter_workflow_publication.PublicationError
    ) as caught:
        newsletter_workflow_publication.assemble(
            "run-1", publication.DAY, [], []
        )
    assert caught.value.code == "no_publishable_content"


def test_no_findings_plan_is_a_valid_honest_record_not_a_successful_empty_issue(
    repository,
):
    assert repository.save_plan("run-1", publication.DAY, []) == []
    assert repository.plan("run-1") == []
    assert repository.pending_history(NEXT_DAY) == []


def test_checkpoint_replay_detaches_data_and_keeps_versions(
    repository,
):
    t = publication.task()
    initial, final = (
        publication.result(content=False, signal=True),
        publication.result(),
    )
    repository.save_plan("run-1", publication.DAY, [t])
    saved = repository.save(
        "run-1", t, "brief", initial, issue_date=publication.DAY
    )
    saved["reason"] = "caller cannot mutate stored checkpoint"
    repository.save("run-1", t, "brief", final, issue_date=publication.DAY)
    repository.save("run-1", t, "brief", final, issue_date=publication.DAY)
    assert repository.results("run-1") == [initial, final]
    assert repository.results("other-run") == []
    with pytest.raises(newsletter_store.StoreError):
        repository.save(
            "run-1",
            publication.task(priority=2),
            "deep",
            publication.result(mode="deep"),
            issue_date=publication.DAY,
        )
    with pytest.raises(newsletter_store.StoreError):
        repository.save(
            "run-1",
            t,
            "deep",
            publication.result(mode="deep"),
            issue_date=NEXT_DAY,
        )


def test_checkpoint_versions_and_per_run_story_count_are_bounded(repository):
    for i in range(newsletter_workflow_publication.MAX_VERSIONS):
        repository.save(
            "run-1",
            publication.task(),
            "brief",
            publication.result(reason=f"checkpoint-{i}"),
            issue_date=publication.DAY,
        )
    with pytest.raises(
        newsletter_workflow_publication.PublicationError
    ) as caught:
        repository.save(
            "run-1",
            publication.task(),
            "brief",
            publication.result(reason="overflow"),
            issue_date=publication.DAY,
        )
    assert caught.value.code == "publication_capacity"
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        repository.save_plan(
            "run-2",
            publication.DAY,
            [publication.task(i) for i in range(1, 101)],
        )


def test_plan_replay_frozen_identity_and_unknown_task_refused(repository):
    plan = [publication.task(), publication.task(2)]
    assert repository.save_plan("run-1", publication.DAY, plan) == plan
    assert (
        repository.save_plan("run-1", publication.DAY, copy.deepcopy(plan))
        == plan
    )
    for date, tasks in (
        (NEXT_DAY, plan),
        (publication.DAY, [publication.task(2), publication.task()]),
        (publication.DAY, [publication.task()]),
    ):
        with pytest.raises(newsletter_store.StoreError):
            repository.save_plan("run-1", date, tasks)
    with pytest.raises(newsletter_store.StoreError):
        repository.save(
            "run-1",
            publication.task(3),
            "brief",
            publication.result(3),
            issue_date=publication.DAY,
        )
    assert repository.plan("run-1") == plan
    assert repository.plan("unknown") == []
    returned = repository.plan("run-1")
    returned[0]["question"] = "Not allowed to mutate the persisted task"
    assert repository.plan("run-1") == plan


def test_deep_prior_prefers_approved_brief_over_later_failure(
    repository,
):
    initial = publication.result(content=False, signal=True)
    brief = publication.result()
    failed = publication.result(content=False)
    repository.save(
        "run-1",
        publication.task(),
        "brief",
        initial,
        issue_date=publication.DAY,
    )
    assert repository.best_result("run-1", "story-1") == initial
    repository.save(
        "run-1", publication.task(), "brief", brief, issue_date=publication.DAY
    )
    repository.save(
        "run-1", publication.task(), "brief", failed, issue_date=publication.DAY
    )
    assert repository.best_result("run-1", "story-1") == brief
    assert repository.best_result("run-1", "story-1", "deep") is None
    assert repository.best_result("run-1", "unselected") is None
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        repository.best_result("run-1", "story-1", "unknown")


@pytest.mark.parametrize(
    "change",
    [
        {"id": "bad/id"},
        {"priority": True},
        {"priority": 0},
        {"candidate_ids": ["a", "a"]},
        {"candidate_ids": [{}]},
        {"question": ""},
        {"source_urls": ["http://127.0.0.1/private"]},
    ],
)
def test_invalid_plan_boundaries_have_finite_publication_errors(
    repository, change
):
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        repository.save_plan(
            "run-1", publication.DAY, [publication.task(**change)]
        )
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        newsletter_workflow_publication.assemble(
            "run-1", publication.DAY, [publication.task(**change)], []
        )


def test_frozen_ledger_reconstruction_ignores_late_deep_result(
    repository,
):
    tasks, values = (
        [publication.task(), publication.task(2)],
        [publication.result()],
    )
    repository.save_plan("run-1", publication.DAY, tasks)
    repository.save(
        "run-1", tasks[0], "brief", values[0], issue_date=publication.DAY
    )
    built = newsletter_workflow_publication.assemble(
        "run-1",
        publication.DAY,
        tasks,
        repository.results("run-1"),
        reason="deadline",
    )
    frozen = repository.record_publication(
        "run-1", publication.DAY, tasks, built
    )
    assert frozen == built == repository.get_publication("run-1")
    assert (
        repository.record_publication("run-1", publication.DAY, tasks, built)
        == built
    )
    repository.save(
        "run-1", tasks[0], "brief", values[0], issue_date=publication.DAY
    )
    with pytest.raises(newsletter_store.StoreError):
        repository.save(
            "run-1",
            tasks[0],
            "deep",
            publication.result(mode="deep"),
            issue_date=publication.DAY,
        )
    with pytest.raises(newsletter_store.StoreError):
        repository.save(
            "run-1",
            tasks[1],
            "brief",
            publication.result(2),
            issue_date=publication.DAY,
        )
    frozen["draft"]["title"] = "Mutated caller object"
    assert repository.get_publication("run-1")["draft"]["title"] == "每日简报"


def test_fake_pass_or_unrecorded_approved_text_cannot_be_frozen(repository):
    repository.save_plan("run-1", publication.DAY, [publication.task()])
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [publication.result()]
    )
    with pytest.raises(newsletter_workflow_publication.PublicationError):
        repository.record_publication(
            "run-1", publication.DAY, [publication.task()], built
        )
    repository.save(
        "run-1",
        publication.task(),
        "brief",
        publication.result(),
        issue_date=publication.DAY,
    )
    for key, replacement in (
        ("title", "Unreviewed headline"),
        ("limitations", "Unreviewed fact"),
    ):
        bad = copy.deepcopy(built)
        bad["draft"][key] = replacement
        with pytest.raises(
            newsletter_workflow_publication.PublicationError
        ) as caught:
            repository.record_publication(
                "run-1", publication.DAY, [publication.task()], bad
            )
        assert caught.value.code == "invalid_publication_snapshot"
    assert repository.get_publication("run-1") is None


def test_old_combined_layout_replays_after_layout_upgrade(
    repository, monkeypatch
):

    tasks, values = (
        [publication.task(), publication.task(2)],
        [publication.result(), publication.result(2)],
    )
    repository.save_plan("old-run", publication.DAY, tasks)
    for selected, value in zip(tasks, values, strict=True):
        repository.save(
            "old-run", selected, "brief", value, issue_date=publication.DAY
        )
    old = newsletter_workflow_publication.assemble(
        "old-run", publication.DAY, tasks, values
    )
    old["draft"]["sections"] = [
        {
            "kind": "world",
            "heading": "今日简讯",
            "paragraphs": [
                {
                    **value["content"]["paragraphs"][0],
                    "text": value["content"]["title"]
                    + "\n"
                    + value["content"]["paragraphs"][0]["text"],
                }
                for value in values
            ],
            "limitations": "\n".join(
                value["content"]["title"]
                + "："
                + value["content"]["limitations"]
                for value in values
            ),
        }
    ]
    contracts.validate_draft(old["draft"], old["packets"])
    # Synthetic disk snapshot represents the previous release's valid immutable
    # publication. No current API is allowed to newly certify this old layout.
    digest = contracts.content_hash(
        {"issue_date": publication.DAY, "tasks": tasks, "result": old}
    )
    with repository.store.transaction():
        repository.store.db.execute(
            "INSERT INTO publication_snapshots VALUES(?,?,?,?,?,?)",
            (
                "old-run",
                publication.DAY,
                contracts.canonical_json(tasks),
                contracts.canonical_json(old),
                digest,
                publication.DAY,
            ),
        )

    def forbidden(*args, **kwargs):
        raise AssertionError(
            "Existing publication must not be reassembled after an upgrade"
        )

    monkeypatch.setattr("newsletter.workflow.publication.assemble", forbidden)
    assert repository.get_publication("old-run") == old
    assert (
        repository.record_publication("old-run", publication.DAY, tasks, old)
        == old
    )
    assert (
        story_nodes.freeze_publication(
            repository, "old-run", publication.DAY, reason="restart"
        )
        == old
    )
    altered = copy.deepcopy(old)
    altered["draft"]["sections"][0]["heading"] = "不能借升级改动旧邮件"
    with pytest.raises(newsletter_store.StoreError):
        repository.record_publication(
            "old-run", publication.DAY, tasks, altered
        )


@pytest.mark.parametrize("feature_cap", [0, 1, 2])
def test_freeze_keeps_admission_order_at_capacity(repository, feature_cap):
    tasks = [publication.task(i) for i in range(1, 19)]
    repository.save_plan("run-1", publication.DAY, tasks)
    for selected in tasks:
        number = selected["priority"]
        repository.save(
            "run-1",
            selected,
            "brief",
            publication.result(number),
            issue_date=publication.DAY,
        )
        if number in (1, 2, 18):
            repository.save(
                "run-1",
                selected,
                "deep",
                publication.result(number, "deep"),
                issue_date=publication.DAY,
            )
    values = repository.results("run-1")
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, tasks, values, max_features=feature_cap
    )
    assert (
        sum(s["disposition"] == "deep" for s in built["coverage"]["stories"])
        == feature_cap
    )
    assert (
        repository.record_publication("run-1", publication.DAY, tasks, built)
        == built
    )


def test_failed_before_any_review_still_has_next_day_selected_topic_memory(
    repository,
):
    repository.save_plan(
        "run-1", publication.DAY, [publication.task(), publication.task(2)]
    )
    assert repository.pending_history(publication.DAY) == []
    pending = repository.pending_history(NEXT_DAY)
    assert [p["story_id"] for p in pending] == ["story-1", "story-2"]
    assert all(p["disposition"] == "deferred" for p in pending)
    assert (
        pending[0]["evidence_context"] == publication.task()["evidence_context"]
    )
    assert pending[0]["source_urls"] == [publication.URL]
    assert "不是证据" in pending[0]["reason"]


def test_published_deep_closes_old_followup_even_if_task_identifier_changes(
    repository,
):
    repository.save_plan("run-old", "2026-09-05", [publication.task()])
    renamed = publication.task(2, candidate_ids=["candidate-1"])
    approved = publication.result(2, "deep")
    repository.save_plan("run-new", publication.DAY, [renamed])
    repository.save(
        "run-new", renamed, "deep", approved, issue_date=publication.DAY
    )
    built = newsletter_workflow_publication.assemble(
        "run-new", publication.DAY, [renamed], [approved]
    )
    repository.record_publication("run-new", publication.DAY, [renamed], built)
    assert repository.pending_history(NEXT_DAY)[0]["disposition"] == "deferred"
    publication.delivery_receipt(repository, "run-new", built)
    assert repository.pending_history(NEXT_DAY) == []


def test_brief_watch_and_deferred_priorities_survive_next_day_history(
    repository,
):
    tasks = [
        publication.task(3),
        publication.task(1),
        publication.task(2),
        publication.task(4),
    ]
    values = [
        publication.result(),
        publication.result(2, content=False, signal=True),
        publication.result(3, "deep"),
    ]
    repository.save_plan("run-1", publication.DAY, tasks)
    for value in values:
        selected = next(t for t in tasks if t["id"] == value["story_id"])
        repository.save(
            "run-1", selected, value["mode"], value, issue_date=publication.DAY
        )
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, tasks, values
    )
    repository.record_publication("run-1", publication.DAY, tasks, built)
    publication.delivery_receipt(repository, "run-1", built)
    assert [p["disposition"] for p in repository.pending_history(NEXT_DAY)] == [
        "brief",
        "watch",
        "deferred",
    ]
    assert [
        p["priority"] for p in repository.pending_history(NEXT_DAY, limit=2)
    ] == [1, 2]


@pytest.mark.parametrize(
    "state",
    [
        "not_requested",
        "unknown",
        "submitting",
        "rejected",
        "simulated",
        "provider_accepted",
    ],
)
@pytest.mark.parametrize("verification", [False, True])
def test_deep_topic_memory_closes_only_after_a_confirmed_send_receipt(
    repository, state, verification
):
    if verification:
        original = newsletter_workflow_publication.assemble(
            "original",
            publication.DAY,
            [publication.task(99)],
            [publication.result(99)],
        )
        publication.delivery_receipt(repository, "original", original)
    value = publication.result(mode="deep")
    repository.save(
        "run-1", publication.task(), "deep", value, issue_date=publication.DAY
    )
    built = newsletter_workflow_publication.assemble(
        "run-1", publication.DAY, [publication.task()], [value]
    )
    repository.record_publication(
        "run-1", publication.DAY, [publication.task()], built
    )
    edition = publication.delivery_receipt(
        repository, "run-1", built, state, verification=verification
    )
    before = repository.store.db.execute(
        "SELECT COUNT(*) FROM sends"
    ).fetchone()[0]
    pending = repository.pending_history(NEXT_DAY)
    assert (
        repository.store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0]
        == before
    )
    if state in {"simulated", "provider_accepted"}:
        assert pending == []
    else:
        assert len(pending) == 1
        assert pending[0]["disposition"] == "deferred"
        assert "勿自动重发原稿" in pending[0]["reason"]
    if state in {"provider_accepted", "unknown"}:
        # Existing general edition history already includes explicit
        # verification
        # outcomes; it must not need a fake normal-send row to remember them.
        assert edition["id"] in {
            item["id"] for item in repository.store.recent_history()
        }
