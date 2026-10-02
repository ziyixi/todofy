"""Test discovery, planning and research with synthetic engine responses."""

import json
import pathlib
import re

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.instructions as instructions
import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.settings as settings
import newsletter.store as newsletter_store
import newsletter.workflow.content as content
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as newsletter_workflow_engine
import newsletter.workflow.nodes as newsletter_workflow_nodes
import newsletter.workflow.schema as newsletter_workflow_schema
import newsletter.workflow.sources as sources
import newsletter.workflow.story_nodes as story_nodes
import tests.support.workflow_content as workflow_content


def material(url=workflow_content.URL):
    return {
        "title": "Synthetic material",
        "body": "Synthetic findings with explicit limitations.",
        "sources": [
            {
                "id": "source-1",
                "title": "Original source",
                "url": url,
                "published_at": workflow_content.DAY,
                "access_scope": "abstract",
                "excerpt": "",
            }
        ],
        "tags": ["fixture"],
    }


def test_discovery_ids_are_local_stable_and_exact_open_url_is_preserved():
    c = workflow_content.candidate(url=workflow_content.URL + "#abstract")
    result = content.parse_discovery(
        workflow_content.discovered(c),
        {workflow_content.URL},
        True,
        c["direction"],
        workflow_content.DAY,
    )
    assert result.candidates[0]["id"] == sources.candidate_id(c)
    assert result.candidates[0]["url"] == workflow_content.URL + "#abstract"
    assert result.candidates[0]["provenance"] == "web_open"
    contracts.parse_message(result.candidates[0], editorial_pb2.Candidate)


@pytest.mark.parametrize(
    "value,opened,searched",
    [
        (
            workflow_content.candidate(
                url="https://arxiv.org/pdf/2609.00001v2"
            ),
            {workflow_content.URL},
            True,
        ),
        (workflow_content.candidate(), {workflow_content.URL}, False),
        (workflow_content.candidate(), set(), True),
        (
            workflow_content.candidate(access_scope="verified"),
            {workflow_content.URL},
            True,
        ),
        (
            workflow_content.candidate(published_at="2026-09-07"),
            {workflow_content.URL},
            True,
        ),
        (
            workflow_content.candidate(published_at="2026-09"),
            {workflow_content.URL},
            True,
        ),
        (
            workflow_content.candidate(doi="made-up DOI"),
            {workflow_content.URL},
            True,
        ),
        (
            workflow_content.candidate(url="http://127.0.0.1/private"),
            {"http://127.0.0.1/private"},
            True,
        ),
    ],
)
def test_discovery_rejects_bad_identity_dates_scopes_and_urls(
    value, opened, searched
):
    with pytest.raises((errors.EditorError, contracts.ContractError)):
        content.parse_discovery(
            workflow_content.discovered(value),
            opened,
            searched,
            "01-ai-ml",
            workflow_content.DAY,
        )


def test_unopened_feed_reuses_real_metadata_not_model_claims():
    seed = workflow_content.candidate(
        provenance="crossref_metadata",
        access_scope="metadata",
        summary="Only a title record",
    )
    output = workflow_content.candidate(
        access_scope="metadata", summary="Invented clinical results"
    )
    result = content.parse_discovery(
        workflow_content.discovered(output),
        set(),
        True,
        "02-science",
        workflow_content.DAY,
        seeds=[seed],
    )
    assert result.candidates[0]["summary"] == "Only a title record"
    assert result.candidates[0]["provenance"] == "crossref_metadata"
    with pytest.raises(errors.EditorError):
        content.parse_discovery(
            workflow_content.discovered(
                workflow_content.candidate(access_scope="full_text")
            ),
            set(),
            True,
            "02-science",
            workflow_content.DAY,
            seeds=[seed],
        )


def test_discovery_cap_empty_note_and_shape_fail_closed():
    with pytest.raises(errors.EditorError):
        content.parse_discovery(
            workflow_content.discovered(*[workflow_content.candidate()] * 6),
            {workflow_content.URL},
            True,
            "01-ai-ml",
            workflow_content.DAY,
        )
    for raw in (
        '{"candidates":[],"note":""}',
        '{"candidates":[],"note":"x","extra":1}',
    ):
        with pytest.raises(errors.EditorError):
            content.parse_discovery(
                raw, set(), True, "01-ai-ml", workflow_content.DAY
            )
    assert (
        content.parse_discovery(
            workflow_content.discovered(),
            set(),
            True,
            "01-ai-ml",
            workflow_content.DAY,
        ).candidates
        == []
    )


def test_discovery_schema_exposes_parser_string_and_empty_value_boundaries():
    schema = newsletter_workflow_schema.discovery_schema()
    props = schema["properties"]["candidates"]["items"]["properties"]
    optional = {
        "doi",
        "version",
        "event_key",
        "published_at",
        *newsletter_workflow_schema.CANDIDATE_RESEARCH_FIELDS,
    }
    for name, field in props.items():
        if name == "evidence_urls":
            assert field == {
                "type": "array",
                "maxItems": 4,
                "items": {"type": "string", "minLength": 1, "maxLength": 1200},
            }
            continue
        assert field["minLength"] == (0 if name in optional else 1)
        assert field["maxLength"] == {
            "title": 500,
            "why_now": 1000,
            "published_at": 10,
        }.get(name, 1200)
    assert schema["properties"]["note"] == {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000,
    }


@pytest.mark.parametrize(
    "field,maximum",
    [
        ("title", 500),
        ("summary", 1200),
        ("why_now", 1000),
        ("version", 1200),
        ("event_key", 1200),
        *(
            (name, 1200)
            for name in newsletter_workflow_schema.CANDIDATE_RESEARCH_FIELDS
        ),
    ],
)
def test_discovery_schema_lengths_match_actual_parser(field, maximum):
    props = newsletter_workflow_schema.discovery_schema()["properties"][
        "candidates"
    ]["items"]["properties"]
    assert props[field]["maxLength"] == maximum
    result = content.parse_discovery(
        workflow_content.discovered(
            workflow_content.candidate(**{field: "x" * maximum})
        ),
        {workflow_content.URL},
        True,
        "01-ai-ml",
        workflow_content.DAY,
    )
    assert result.candidates[0][field] == "x" * maximum
    with pytest.raises(errors.EditorError):
        content.parse_discovery(
            workflow_content.discovered(
                workflow_content.candidate(**{field: "x" * (maximum + 1)})
            ),
            {workflow_content.URL},
            True,
            "01-ai-ml",
            workflow_content.DAY,
        )


@pytest.mark.parametrize(
    "value",
    ["2026-09", "20260906", "2026-9-06", "2026-09-06T00:00:00Z", "unknown"],
)
def test_discovery_schema_rejects_non_date_shapes(value):
    field = newsletter_workflow_schema.discovery_schema()["properties"][
        "candidates"
    ]["items"]["properties"]["published_at"]
    assert re.fullmatch(field["pattern"], value) is None
    with pytest.raises(contracts.ContractError):
        content.parse_discovery(
            workflow_content.discovered(
                workflow_content.candidate(published_at=value)
            ),
            {workflow_content.URL},
            True,
            "01-ai-ml",
            workflow_content.DAY,
        )


@pytest.mark.parametrize(
    "value,valid",
    [
        ("", True),
        (workflow_content.DAY, True),
        ("2026-02-30", False),
        ("2026-09-07", False),
    ],
)
def test_date_shape_is_not_a_substitute_for_calendar_and_issue_date_validation(
    value, valid
):
    field = newsletter_workflow_schema.discovery_schema()["properties"][
        "candidates"
    ]["items"]["properties"]["published_at"]
    assert re.fullmatch(field["pattern"], value) is not None
    if valid:
        result = content.parse_discovery(
            workflow_content.discovered(
                workflow_content.candidate(published_at=value)
            ),
            {workflow_content.URL},
            True,
            "01-ai-ml",
            workflow_content.DAY,
        )
        assert result.candidates[0]["published_at"] == value
    else:
        with pytest.raises((contracts.ContractError, errors.EditorError)):
            content.parse_discovery(
                workflow_content.discovered(
                    workflow_content.candidate(published_at=value)
                ),
                {workflow_content.URL},
                True,
                "01-ai-ml",
                workflow_content.DAY,
            )


def test_dedup_matches_doi_alias_arxiv_versions_tracking_urls_and_events():
    assert sources.identity_keys(
        workflow_content.candidate()
    ) & sources.identity_keys(
        workflow_content.candidate(url="https://arxiv.org/pdf/2609.00001v1")
    )
    doi = workflow_content.candidate(
        url="https://doi.org/10.1234/ABC", doi="10.1234/abc"
    )
    publisher = workflow_content.candidate(
        url="https://example.org/article", doi="https://doi.org/10.1234/ABC"
    )
    assert len(sources.deduplicate_candidates([doi, publisher])) == 1
    original = workflow_content.candidate(
        url="https://example.org/story?article=1&utm_source=feed",
        title="First title",
    )
    alias = workflow_content.candidate(
        url="https://example.org/story?article=1#section", title="Another title"
    )
    assert len(sources.deduplicate_candidates([original, alias])) == 1
    same_event = workflow_content.candidate(
        url="https://example.net/other",
        title="Different title",
        event_key="storm:2026-09-06",
    )
    original["event_key"] = "storm:2026-09-06"
    assert len(sources.deduplicate_candidates([original, same_event])) == 1


def test_dedup_retains_meaningful_query_parameters():
    first = workflow_content.candidate(
        url="https://example.org/story?id=1", title="first"
    )
    second = workflow_content.candidate(
        url="https://example.org/story?id=2", title="second"
    )
    assert len(sources.deduplicate_candidates([first, second])) == 2


def test_history_keeps_explained_upgrades_not_repeats_or_downgrades():
    c = workflow_content.candidate()
    assert sources.deduplicate_candidates([c], [c]) == []
    old = workflow_content.candidate(version="v1")
    assert sources.deduplicate_candidates([c], [old]) == [c]
    assert sources.deduplicate_candidates([old], [c]) == []
    assert (
        sources.deduplicate_candidates(
            [workflow_content.candidate(why_now="New")], [old]
        )
        == []
    )
    assert sources.deduplicate_candidates([c], [{"title": c["title"]}]) == []


@pytest.mark.parametrize(
    "changes",
    [
        {"candidate_ids": ["invented"]},
        {"candidate_ids": []},
        {"candidate_ids": ["candidate-1"] * 2},
        {"source_urls": ["https://example.org/unprovided"]},
        {"priority": True},
        {"priority": "1"},
        {"priority": 13},
        {"question": ""},
        {"evidence_context": ""},
        {"id": "../bad"},
    ],
)
def test_plan_only_selects_known_unique_identifiers_and_bounded_tasks(changes):
    with pytest.raises((errors.EditorError, contracts.ContractError)):
        content.parse_plan(
            workflow_content.planned(workflow_content.task(**changes)),
            {"candidate-1"},
            {workflow_content.URL},
            12,
        )


def test_duplicate_tasks_and_duplicate_selected_candidate_rejected():
    with pytest.raises(errors.EditorError):
        content.parse_plan(
            workflow_content.planned(
                workflow_content.task(),
                workflow_content.task(id="other", priority=2),
            ),
            {"candidate-1"},
            {workflow_content.URL},
            8,
        )


def test_gap_plan_can_have_no_candidate_but_has_context_and_only_given_urls():
    result = content.parse_plan(
        workflow_content.planned(workflow_content.task(candidate_ids=[])),
        set(),
        {workflow_content.URL},
        3,
        gaps=True,
    )
    assert result.research_tasks[0]["evidence_context"]
    assert (
        contracts.to_dict(
            contracts.parse_message(
                result.research_tasks[0], editorial_pb2.ResearchTask
            )
        )["priority"]
        == 1
    )


async def test_discover_passes_public_history_watchlist_never_private_fields(
    tmp_path,
):
    engine = workflow_content.Engine(
        (
            workflow_content.discovered(workflow_content.candidate()),
            {workflow_content.URL},
            True,
        )
    )
    service = content.ContentPreparation(engine)
    instruction = instructions.Instruction(
        "01-ai-ml", "Find substantial public research", "a" * 64
    )
    await service.discover(
        instruction,
        workflow_content.DAY,
        tmp_path.resolve() / "discover",
        history=[{"title": "Old paper", "personal_digest": "private marker"}],
        watchlist=[
            {
                "question": "Watch future replication",
                "password": "secret marker",
            }
        ],
    )
    prompt = json.dumps(engine.calls[0][0])
    assert "private marker" not in prompt and "secret marker" not in prompt
    assert "Watch future replication" in prompt
    assert "不得读本地文件" in engine.calls[0][2]


async def test_shortlist_accepts_12_cap_empty_candidates_never_invoke_model(
    tmp_path,
):
    engine = workflow_content.Engine(
        (workflow_content.planned(workflow_content.task()), set(), False)
    )
    service = content.ContentPreparation(engine)
    assert (
        await service.shortlist(
            [], workflow_content.DAY, tmp_path.resolve() / "empty"
        )
    ).research_tasks == []
    assert not engine.calls
    selected = await service.shortlist(
        [workflow_content.candidate()],
        workflow_content.DAY,
        tmp_path.resolve() / "select",
        max_tasks=12,
    )
    assert selected.research_tasks[0]["id"] == "research-1"
    assert engine.calls[0][1]["properties"]["research_tasks"]["maxItems"] == 12
    assert engine.calls[0][0]["reader_profile"] == ""


def test_promoted_selection_keeps_evaluated_text_and_public_safety_boundary():
    directory = pathlib.Path(__file__).resolve().parents[1]
    evaluated = (directory / "tests/fixtures/editorial/selection.md").read_text(
        encoding="utf-8"
    )
    assert evaluated.strip() in content._SELECTION
    assert content._SELECTION.startswith(content._SAFETY)
    assert "不得读本地文件、密钥、个人事件、登录信息" in content._SELECTION
    assert "不search/open，不新增ID或URL" in content._SELECTION
    assert "question只提出一个核心问题和一两项决定性核查" in content._SELECTION
    assert "不承诺执行列表之外的研究" in content._SELECTION
    assert "reader_profile仅表达本次冻结的显式读者偏好" in content._SELECTION


@pytest.mark.parametrize(
    "production,evaluated",
    [
        ("04-economy.md", "discovery-economy.md"),
        ("06-technology.md", "discovery-technology.md"),
    ],
)
def test_current_discovery_instructions_match_versioned_evaluation_inputs(
    production, evaluated
):
    directory = pathlib.Path(__file__).resolve().parents[1]
    actual = directory / "src/newsletter/instructions/discovery" / production
    expected = directory / "tests/fixtures/editorial" / evaluated
    assert actual.read_text(encoding="utf-8") == expected.read_text(
        encoding="utf-8"
    )


async def test_empty_discovery_still_requires_real_search(
    tmp_path,
):
    engine = workflow_content.Engine(
        (workflow_content.discovered(), set(), False),
        (workflow_content.discovered(), set(), True),
    )
    service = content.ContentPreparation(engine)
    instruction = instructions.Instruction(
        "04-economy", "Find public finance research", "a" * 64
    )
    seed = workflow_content.candidate(
        provenance="crossref_metadata", access_scope="metadata"
    )
    with pytest.raises(errors.EditorError) as error:
        await service.discover(
            instruction,
            workflow_content.DAY,
            tmp_path.resolve() / "bad",
            seeds=[seed],
        )
    assert error.value.code == "invalid_output"
    result = await service.discover(
        instruction,
        workflow_content.DAY,
        tmp_path.resolve() / "good",
        seeds=[seed],
    )
    assert result.candidates == []
    assert engine.calls[0][2] == content._DISCOVERY
    assert content._DISCOVERY.startswith(content._SAFETY)
    assert "必须实际调用hosted web search" in content._DISCOVERY
    assert "已有metadata线索或最后没有合格候选" in content._DISCOVERY
    assert "不能伪造搜索或打开记录" in content._DISCOVERY


@pytest.mark.parametrize(
    "profile",
    [None, {}, ["preferences"], "x" * 100_001],
    ids=["null", "object", "list", "long"],
)
async def test_shortlist_rejects_invalid_reader_profile_before_model(
    tmp_path, profile
):
    engine = workflow_content.Engine()
    with pytest.raises(errors.EditorError) as error:
        await content.ContentPreparation(engine).shortlist(
            [workflow_content.candidate()],
            workflow_content.DAY,
            tmp_path.resolve() / "bad",
            reader_profile=profile,
        )
    assert error.value.code == "invalid_input"
    assert not engine.calls


@pytest.mark.parametrize(
    "node_class,recipe",
    [
        (newsletter_workflow_nodes.EditorialNodes, "legacy-daily.yaml"),
        (story_nodes.StoryNodes, "daily.yaml"),
    ],
)
async def test_selection_uses_only_reader_profile_from_frozen_run_policy(
    tmp_path, node_class, recipe
):
    directory = pathlib.Path(__file__).resolve().parents[1]
    definition = newsletter_workflow_definition.load_definition(
        directory / "src/newsletter/workflows" / recipe
    )
    ids = {node.type: node.id for node in definition.nodes}
    engine = workflow_content.Engine(
        (workflow_content.planned(workflow_content.task()), set(), False)
    )
    store = newsletter_store.Store(tmp_path / "selection.sqlite3", "mock")
    profile = (
        "Frozen explicit preference: understand AI/ML/CS and "
        "financial mechanisms.\n"
    )
    try:
        nodes = node_class(store, definition, engine, tmp_path.resolve())
        ctx = newsletter_workflow_engine.NodeContext(
            run_id="synthetic-selection",
            node_id=ids["selection"],
            item_id="",
            params={"max_tasks": 8},
            inputs={
                ids["deduplicate"]: {
                    "candidates": [workflow_content.candidate()]
                },
                ids["history"]: {
                    "candidates": [],
                    "watchlist": [],
                    "editions": [],
                },
            },
            run_inputs={
                "issue_date": workflow_content.DAY,
                "policy": {
                    "reader-profile.md": profile,
                    "editorial.md": "Unrelated editorial policy marker",
                    "private_extra": "Secret configuration marker",
                },
                "personal_digest": "Private event marker",
            },
        )
        selected = await nodes.execute(
            "selection", ctx, tmp_path.resolve() / "select"
        )
        assert selected["research_tasks"][0]["id"] == "research-1"
        assert len(engine.calls) == 1
        prompt = engine.calls[0][0]
        assert prompt["reader_profile"] == profile
        assert "policy" not in prompt
        assert "Unrelated editorial policy marker" not in json.dumps(prompt)
        assert "Secret configuration marker" not in json.dumps(prompt)
        assert "Private event marker" not in json.dumps(prompt)
        assert engine.calls[0][2] == content._SELECTION
    finally:
        store.close()


async def test_old_candidates_still_need_fresh_research_provenance(
    tmp_path,
):
    output = json.dumps(
        {
            "state": "collected",
            "note": "Read actual abstract",
            "packets": [material()],
        }
    )
    engine = workflow_content.Engine(
        (output, set(), True), (output, {workflow_content.URL}, True)
    )
    service = content.ContentPreparation(engine)
    with pytest.raises(errors.EditorError):
        await service.research(
            workflow_content.task(),
            [workflow_content.candidate()],
            workflow_content.DAY,
            tmp_path.resolve() / "bad",
        )
    result = await service.research(
        workflow_content.task(),
        [workflow_content.candidate()],
        workflow_content.DAY,
        tmp_path.resolve() / "good",
    )
    assert result.packets[0]["sources"][0]["url"] == workflow_content.URL


async def test_gap_research_accepts_empty_candidates_with_explicit_question(
    tmp_path,
):
    output = json.dumps(
        {
            "state": "no_findings",
            "note": "Could not verify the claim",
            "packets": [],
        }
    )
    engine = workflow_content.Engine((output, set(), True))
    result = await content.ContentPreparation(engine).research(
        workflow_content.task(candidate_ids=[]),
        [],
        workflow_content.DAY,
        tmp_path.resolve() / "gap-research",
    )
    assert not result.packets


async def test_plan_gaps_uses_public_draft_and_strips_packet_record_extras(
    tmp_path,
):
    packet = {"id": "packet-1", "content": material()}
    draft = {
        "subject": "Test",
        "title": "Test",
        "sections": [
            {
                "kind": "feature",
                "heading": "Research",
                "paragraphs": [
                    {
                        "text": "A claim worth checking",
                        "citations": ["packet-1/source-1"],
                    }
                ],
            }
        ],
    }
    engine = workflow_content.Engine(
        (
            workflow_content.planned(workflow_content.task(candidate_ids=[])),
            set(),
            False,
        )
    )
    result = await content.ContentPreparation(engine).plan_gaps(
        draft, [packet], workflow_content.DAY, tmp_path.resolve() / "gap-plan"
    )
    assert result.research_tasks[0]["candidate_ids"] == []
    assert engine.calls[0][1]["properties"]["research_tasks"]["maxItems"] == 3
    assert "唯一一轮共享预算" in engine.calls[0][2]


async def test_extra_private_fields_on_candidates_are_rejected_before_model(
    tmp_path,
):
    engine = workflow_content.Engine()
    c = workflow_content.candidate(personal_digest="private marker")
    with pytest.raises(contracts.ContractError):
        await content.ContentPreparation(engine).shortlist(
            [c], workflow_content.DAY, tmp_path.resolve() / "bad"
        )
    assert not engine.calls


def test_schema_agrees_with_shared_proto_directions_eight_separate_files():
    assert set(newsletter_workflow_schema.CANDIDATE_FIELDS) == set(
        editorial_pb2.Candidate.DESCRIPTOR.fields_by_name
    ) - {
        "id",
        "direction",
        "provenance",
    }
    assert set(newsletter_workflow_schema.TASK_FIELDS) == set(
        editorial_pb2.ResearchTask.DESCRIPTOR.fields_by_name
    )
    assert (
        newsletter_workflow_schema.discovery_schema()["properties"][
            "candidates"
        ]["maxItems"]
        == 5
    )
    assert (
        newsletter_workflow_schema.planning_schema([], [], 3, gaps=True)[
            "properties"
        ]["research_tasks"]["items"]["properties"]["candidate_ids"]["maxItems"]
        == 0
    )
    directory = (
        pathlib.Path(__file__).resolve().parents[1]
        / "src/newsletter/instructions/discovery"
    )
    directions = instructions.load_instructions(directory)
    assert [d.id for d in directions] == [
        "01-ai-ml",
        "02-science",
        "03-world",
        "04-economy",
        "05-health",
        "06-technology",
        "07-search-ads-recs",
        "08-llm-architectures",
    ]
    assert all("最多5" in d.text for d in directions)
    assert len(instructions.load_instructions(directory.parent)) == 3


@pytest.mark.parametrize(
    "identifier", ["07-search-ads-recs", "08-llm-architectures"]
)
def test_specialized_discovery_instructions_keep_source_and_dedup_boundaries(
    identifier,
):
    directory = (
        pathlib.Path(__file__).resolve().parents[1]
        / "src/newsletter/instructions/discovery"
    )
    directions = {
        item.id: item for item in instructions.load_instructions(directory)
    }
    text = directions[identifier].text
    for required in (
        "最多5",
        "不凑数",
        "近两周",
        "六周",
        "首发日期",
        "未知留空",
        "history",
        "metadata_seeds",
        "DOI",
        "arXiv",
        "event_key",
        "01-ai-ml",
        "search",
        "open",
        *newsletter_workflow_schema.CANDIDATE_RESEARCH_FIELDS,
        "evidence_urls",
    ):
        assert required in text
    assert directions[identifier].digest == contracts.content_hash(text)
    # Prompt/packaging contracts only, not a claim about live retrieval quality.


def test_eight_directions_keep_selection_and_timeout_budgets():
    root = pathlib.Path(__file__).resolve().parents[1]
    definition = newsletter_workflow_definition.load_definition(
        root / "src/newsletter/workflows/daily.yaml"
    )
    roles = {node.type: node for node in definition.nodes}
    assert roles["discovery"].map.max_items == 8
    assert roles["discovery"].params == {"timeout_seconds": 150}
    assert roles["api_feed"].params == {"timeout_seconds": 45}
    assert roles["deduplicate"].params == {"max_candidates": 30}
    assert roles["selection"].params == {"max_tasks": 8, "timeout_seconds": 150}
    assert roles["story_plan"].params == {"max_deep": 4}
    assert roles["story_brief"].params == {"timeout_seconds": 300}
    assert roles["story_deep"].params == {"timeout_seconds": 420}
    assert (
        len([node for node in definition.nodes if node.type == "selection"])
        == 1
    )
    assert settings.Settings().workflow_timeout_seconds == 5400


def test_cross_direction_paper_is_one_candidate():
    records = [
        content.parse_discovery(
            workflow_content.discovered(workflow_content.candidate()),
            {workflow_content.URL},
            True,
            direction,
            workflow_content.DAY,
        ).candidates[0]
        for direction in (
            "01-ai-ml",
            "07-search-ads-recs",
            "08-llm-architectures",
        )
    ]
    assert len({record["id"] for record in records}) == 1
    assert len(sources.deduplicate_candidates(records)) == 1


def test_legacy_candidate_view_and_discovery_do_not_rewrite_old_hashes():
    old = workflow_content.candidate()
    old["id"] = sources.candidate_id(old)
    digest = contracts.content_hash(old)
    assert not set(newsletter_workflow_schema.CANDIDATE_RESEARCH_FIELDS) & set(
        old
    )
    assert content._candidate_view(old) == old
    assert contracts.content_hash(old) == digest
    raw = json.dumps(
        {
            "candidates": [
                {
                    key: old[key]
                    for key in (
                        newsletter_workflow_schema.CANDIDATE_LEGACY_FIELDS
                    )
                }
            ],
            "note": "Legacy public discovery checkpoint",
        }
    )
    parsed = content.parse_discovery(
        raw, {workflow_content.URL}, True, "01-ai-ml", workflow_content.DAY
    ).candidates[0]
    assert parsed == old and contracts.content_hash(parsed) == digest


def test_research_provenance_fields_preserve_opened_evidence_and_unknowns():
    evidence = "https://openreview.net/forum?id=synthetic"
    value = workflow_content.candidate(
        authors="Synthetic Researcher",
        # The abstract does not establish the author's affiliation.
        affiliations="",
        venue="Synthetic workshop",
        publication_status="Accepted workshop paper; source record only",
        contribution=(
            "Tests an earlier error-bound assumption against a matched "
            "baseline."
        ),
        source_basis=(
            "A specific workshop entry records the author and decision."
        ),
        evidence_urls=[evidence, workflow_content.URL],
    )
    parsed = content.parse_discovery(
        workflow_content.discovered(value),
        {workflow_content.URL, evidence},
        True,
        "01-ai-ml",
        workflow_content.DAY,
    )
    for key in (
        *newsletter_workflow_schema.CANDIDATE_RESEARCH_FIELDS,
        "evidence_urls",
    ):
        assert parsed.candidates[0][key] == value[key]
    assert parsed.candidates[0]["id"] == sources.candidate_id(
        workflow_content.candidate()
    )
    # A source-schema field is not a domain/author prestige allowlist.
    unlisted = workflow_content.candidate(
        authors="A new team",
        affiliations="Independent researchers",
        evidence_urls=["https://new-team.example.org/paper"],
    )
    assert content.parse_discovery(
        workflow_content.discovered(unlisted),
        {workflow_content.URL, *unlisted["evidence_urls"]},
        True,
        "01-ai-ml",
        workflow_content.DAY,
    ).candidates


@pytest.mark.parametrize(
    "urls,opened",
    [
        (["https://openreview.net/forum?id=synthetic"], {workflow_content.URL}),
        ([workflow_content.URL, workflow_content.URL], {workflow_content.URL}),
        ([workflow_content.URL] * 5, {workflow_content.URL}),
        ("https://openreview.net/", {workflow_content.URL}),
        ([None], {workflow_content.URL}),
        (
            ["http://127.0.0.1/source"],
            {workflow_content.URL, "http://127.0.0.1/source"},
        ),
        (["https://openreview.net/" + "a" * 1200], {workflow_content.URL}),
    ],
)
def test_discovery_rejects_unsafe_unopened_or_unbounded_evidence(urls, opened):
    with pytest.raises((errors.EditorError, contracts.ContractError)):
        content.parse_discovery(
            workflow_content.discovered(
                workflow_content.candidate(evidence_urls=urls)
            ),
            opened,
            True,
            "01-ai-ml",
            workflow_content.DAY,
        )


def test_unopened_seed_cannot_gain_reputation_or_proof_urls():
    seed = workflow_content.candidate(
        url="https://doi.org/10.1234/synthetic",
        access_scope="metadata",
        provenance="crossref_metadata",
    )
    seed["id"] = sources.candidate_id(seed)
    model = workflow_content.candidate(
        **{
            **seed,
            "authors": "Invented famous author",
            "affiliations": "Invented prestigious lab",
            "venue": "Invented main conference",
            "publication_status": "Invented acceptance",
            "contribution": "Invented breakthrough",
            "source_basis": "Invented endorsement",
            "evidence_urls": ["https://example.org/unopened"],
        }
    )
    found = content.parse_discovery(
        workflow_content.discovered(model),
        set(),
        True,
        "02-science",
        workflow_content.DAY,
        seeds=[seed],
    )
    assert found.candidates == [{**seed, "direction": "02-science"}]
    assert "Invented" not in json.dumps(found.candidates)
    assert "evidence_urls" not in found.candidates[0]


async def test_shortlist_keeps_source_fields_without_extra_search(
    tmp_path,
):
    supplied = workflow_content.candidate(
        authors="Synthetic author",
        affiliations="Synthetic institution",
        venue="Synthetic journal",
        publication_status="Published according to the supplied entry",
        contribution=(
            "A matched-budget comparison changes the earlier claimed advantage."
        ),
        source_basis=(
            "Original journal entry, not a ranking or reputation claim."
        ),
        evidence_urls=[workflow_content.URL],
    )
    engine = workflow_content.Engine(
        (workflow_content.planned(workflow_content.task()), set(), False)
    )
    await content.ContentPreparation(engine).shortlist(
        [supplied], workflow_content.DAY, tmp_path.resolve() / "sources"
    )
    assert len(engine.calls) == 1
    assert engine.calls[0][0]["candidates_untrusted"] == [supplied]
    assert "不search/open" in engine.calls[0][2]
    assert "这个问题为什么重要" in engine.calls[0][2]
    assert "这篇工作实际增加了什么" in engine.calls[0][2]
    assert "声誉只是发现线索，不是硬白名单" in engine.calls[0][2]
    assert "未知" in engine.calls[0][2]
    # This verifies prompt routing and boundaries, not whether a model ranks
    # well.


def test_public_context_is_bounded_and_allowlisted():
    assert content.public_context(
        [{"title": "Public", "token": "secret", "personal_digest": {}}]
    ) == [{"title": "Public"}]
    with pytest.raises(errors.EditorError):
        content.public_context([{}] * 101)
