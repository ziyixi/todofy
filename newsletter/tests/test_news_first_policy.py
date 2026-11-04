"""Deterministic news/research budgets, not a claim of perfect LLM judgement."""

import dataclasses
import json
import pathlib

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.store as newsletter_store
import newsletter.workflow.content as content
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as newsletter_workflow_engine
import newsletter.workflow.publication as newsletter_workflow_publication
import newsletter.workflow.schema as newsletter_workflow_schema
import newsletter.workflow.sources as sources
import newsletter.workflow.story_nodes as story_nodes
import tests.support.news_first_policy as news_first_policy
import tests.support.publication as publication
import tests.support.workflow_content as workflow_content


def config(**limits):
    return {
        "schema_version": 1,
        "revision": "fixture-config",
        "digest": "fixture-only",
        "editorial": {
            "max_public_items": 6,
            "max_research_items": 1,
            "max_deep": 1,
            "max_research_candidates": 10,
            **limits,
        },
        "files": {},
    }


def classifications(*candidates):
    return {
        c["id"]: {
            "kind": "news",
            "basis": (
                "Previously unavailable treatment is now approved for a "
                "defined population."
            ),
        }
        for c in candidates
    }


def topic(c, number=1, **changes):
    return workflow_content.task(
        id=f"topic-{number}",
        candidate_ids=[c["id"]],
        source_urls=[c["url"]],
        priority=number,
        editorial_kind="news",
        **changes,
    )


def selected(candidates, tasks, **limits):
    return content.parse_classified_plan(
        workflow_content.planned(*tasks),
        candidates,
        classifications(*candidates),
        8,
        content.editorial_limits(config(**limits)),
    )


def test_internal_classifications_do_not_expand_shared_proto_contract():
    c = news_first_policy.news()
    output = json.loads(workflow_content.discovered(c))
    output["candidates"][0].update(
        editorial_kind="news", change_basis="A new rule has entered force."
    )
    parsed = content.parse_discovery(
        json.dumps(output),
        {c["url"]},
        True,
        c["direction"],
        workflow_content.DAY,
        classified=True,
    )
    contracts.parse_message(parsed.candidates[0], editorial_pb2.Candidate)
    assert parsed.classifications[parsed.candidates[0]["id"]]["kind"] == "news"
    plan = selected([c], [topic(c)])
    contracts.parse_message(plan.research_tasks[0], editorial_pb2.ResearchTask)
    assert plan.task_classifications == {"topic-1": "news"}
    assert "editorial_kind" not in plan.research_tasks[0]
    assert (
        "editorial_kind"
        in newsletter_workflow_schema.discovery_schema(classified=True)[
            "properties"
        ]["candidates"]["items"]["properties"]
    )
    assert (
        "editorial_kind"
        in newsletter_workflow_schema.planning_schema(
            [c["id"]], [c["url"]], 6, classified=True
        )["properties"]["research_tasks"]["items"]["properties"]
    )


@pytest.mark.parametrize(
    "c",
    [
        news_first_policy.paper(),
        news_first_policy.news(doi="10.1234/test"),
        news_first_policy.news(publication_status="preprint"),
        news_first_policy.news(url="https://doi.org/10.1234/test", doi=""),
        news_first_policy.news(url="https://dx.doi.org/10.1234/test", doi=""),
    ],
)
def test_title_or_kind_change_cannot_turn_paper_into_news(
    c,
):
    c["title"] = "Game-changing industry news"
    assert (
        content.candidate_classification(c, classifications(c)[c["id"]])["kind"]
        == "research"
    )


def test_news_can_cite_a_background_paper_without_becoming_a_paper_topic():
    c = news_first_policy.news(
        evidence_urls=["https://arxiv.org/abs/2609.00001"]
    )
    assert (
        content.candidate_classification(c, classifications(c)[c["id"]])["kind"]
        == "news"
    )


def test_missing_classification_or_change_basis_is_not_assumed_to_be_news():
    c = news_first_policy.news()
    assert content.candidate_classification(c)["kind"] == "unknown"
    assert (
        content.candidate_classification(c, {"kind": "news", "basis": " "})[
            "kind"
        ]
        == "unknown"
    )
    output = json.loads(workflow_content.discovered(c))
    parsed = content.parse_discovery(
        json.dumps(output),
        {c["url"]},
        True,
        c["direction"],
        workflow_content.DAY,
        classified=True,
    )
    assert (
        parsed.classifications[parsed.candidates[0]["id"]]["kind"] == "unknown"
    )


def test_must_know_event_with_unreadable_bodies_stays_news_at_metadata_scope():
    # The world direction hands off a major event whose bodies would not load.
    # An open action counts even when the page fails, so the honest metadata
    # scope keeps it news; an unopened lead never becomes news.
    primary = "https://news.example.org/national-election-result"
    second = "https://wire.example.org/national-election-result"
    event = news_first_policy.news(
        url=primary,
        title="Synthetic national election flips the legislative majority",
        access_scope="metadata",
        evidence_urls=[primary, second],
        source_basis="Two synthetic outlets report it; no body was read.",
    )
    output = json.loads(workflow_content.discovered(event))
    output["candidates"][0].update(
        editorial_kind="news",
        change_basis="必知：two synthetic outlets report a new majority.",
    )
    seed = sources.metadata_candidate(
        event["title"],
        primary,
        "",
        workflow_content.DAY,
        "rss_metadata",
        direction="03-world",
        venue="Synthetic Outlet",
    )

    def parse_with(opened, seeds=(seed,)):
        return content.parse_discovery(
            json.dumps(output),
            opened,
            True,
            "03-world",
            workflow_content.DAY,
            seeds=seeds,
            classified=True,
        )

    parsed = parse_with({primary, second})
    (candidate,) = parsed.candidates
    assert candidate["provenance"] == "web_open"
    assert candidate["access_scope"] == "metadata"
    assert candidate["evidence_urls"] == [primary, second]
    classification = parsed.classifications[candidate["id"]]
    assert classification["kind"] == "news"
    assert classification["basis"].startswith("必知：")
    papers = [news_first_policy.paper(n) for n in range(1, 13)]
    retained, kinds = content.candidate_budget(
        papers + [candidate],
        parsed.classifications,
        maximum=30,
        research_maximum=10,
    )
    assert retained[0] == candidate
    assert kinds[candidate["id"]]["kind"] == "news"
    # Not opened: the same output falls back to the bare feed seed.
    unopened = parse_with(set())
    (lead,) = unopened.candidates
    assert lead["provenance"] == "rss_metadata"
    assert unopened.classifications[lead["id"]]["kind"] == "unknown"
    # Not opened and not a feed seed: the whole direction is rejected.
    with pytest.raises(errors.EditorError):
        parse_with(set(), seeds=())
    # One unopened evidence URL also rejects the whole direction, which is why
    # 03-world names other outlets in source_basis instead.
    with pytest.raises(errors.EditorError):
        parse_with({primary})


def test_unopened_headline_leads_must_not_join_a_must_know_news_task():
    # Feed leads reach selection as unknown candidates. Merging one into the
    # opened news task turns the task into research; two drop it entirely.
    event = news_first_policy.news(1)
    leads = [
        sources.metadata_candidate(
            f"Synthetic outlet {name} leads with the same election",
            f"https://{name}.example.org/election",
            "",
            workflow_content.DAY,
            "rss_metadata",
            direction="03-world",
            venue=f"Synthetic {name}",
        )
        for name in ("a", "b")
    ]
    paper = news_first_policy.paper(1)
    pool = [event, *leads, paper]
    kinds = {
        event["id"]: {"kind": "news", "basis": "必知：two outlets report it."}
    }

    def plan(*extra_leads):
        merged = topic(event)
        merged["candidate_ids"] += [lead["id"] for lead in extra_leads]
        result = content.parse_classified_plan(
            workflow_content.planned(merged, topic(paper, 2)),
            pool,
            kinds,
            6,
            content.editorial_limits(config()),
        )
        return (
            {
                t["id"]: result.task_classifications[t["id"]]
                for t in result.research_tasks
            },
            {o["task"]["id"]: o["reason"] for o in result.omitted_tasks},
        )

    assert plan() == ({"topic-1": "news", "topic-2": "research"}, {})
    assert plan(leads[0]) == (
        {"topic-1": "research"},
        {"topic-2": "research_quota"},
    )
    assert plan(*leads) == (
        {"topic-2": "research"},
        {"topic-1": "mixed_research_topics"},
    )


def test_authored_world_rules_mark_must_know_events_for_selection():
    root = pathlib.Path(__file__).resolve().parents[1]
    world, packaged, discovery, selection = (
        path.read_text(encoding="utf-8")
        for path in (
            root / "content-config/discovery/03-world.md",
            root / "src/newsletter/instructions/discovery/03-world.md",
            root / "content-config/prompts/discovery.md",
            root / "content-config/prompts/selection.md",
        )
    )
    assert world == packaged
    # The markers are the only contract between the stages.
    assert "change_basis以“必知：”开头" in world
    assert "basis以“必知：”开头" in selection
    assert f"basis以“{content.CONSENSUS_BASIS}”开头" in selection
    # Selection judges a headline consensus against the world definition.
    definition = world[world.index("必知事件指：") : world.index("这类事件")]
    assert definition.endswith("冲击。") and definition in selection
    assert "家数多不等于必知" in selection
    for required in ("independent_sources", "alternate_urls"):
        assert required in world
    assert "alternate_urls" in discovery
    for required in (
        "含美国",
        "metadata_seeds",
        "又一处援助点或避难所遇袭",
        "最多再试两个替代来源",
        "access_scope写metadata",
        "evidence_urls都只列本轮调用过open的地址",
    ):
        assert required in world
    assert "不能悄悄删掉" in discovery
    for required in (
        "最多两项",
        "只读到metadata的必知事件不排在这些位置",
        "引用两条以上会整题丢弃",
        "会不会意外",
    ):
        assert required in selection


def test_large_research_pool_cannot_crowd_actual_news_out_of_candidate_budget():
    papers, events = (
        [news_first_policy.paper(n) for n in range(1, 31)],
        [news_first_policy.news(n) for n in range(1, 21)],
    )
    retained, kinds = content.candidate_budget(
        papers + events,
        classifications(*events),
        maximum=30,
        research_maximum=10,
    )
    assert retained == events + papers[:10]
    assert sum(c["kind"] != "news" for c in kinds.values()) == 10


def test_news_short_edition_does_not_fill_its_empty_slots_with_weak_papers():
    candidates = [
        news_first_policy.paper(1),
        news_first_policy.paper(2),
        news_first_policy.news(1),
        news_first_policy.news(2),
    ]
    result = selected(
        candidates, [topic(c, n) for n, c in enumerate(candidates, 1)]
    )
    assert [t["candidate_ids"] for t in result.research_tasks] == [
        ["paper-1"],
        ["news-1"],
        ["news-2"],
    ]
    assert result.omitted_tasks[0]["reason"] == "research_quota"
    assert result.omitted_tasks[0]["task"]["candidate_ids"] == ["paper-2"]
    assert (
        len(result.research_tasks) == 3
    )  # No second approval gate and no filler.


def test_mixed_task_cannot_hide_multiple_papers_in_one_news_slot():
    a, b, event = (
        news_first_policy.paper(1),
        news_first_policy.paper(2),
        news_first_policy.news(),
    )
    mixed = topic(a)
    mixed["candidate_ids"] = [a["id"], b["id"]]
    mixed["source_urls"] = [a["url"], b["url"]]
    result = selected([a, b, event], [mixed, topic(event, 2)])
    assert [t["id"] for t in result.research_tasks] == ["topic-2"]
    assert result.omitted_tasks[0]["reason"] == "mixed_research_topics"


def test_reference_only_paper_cannot_evade_task_subject_budget():
    a, b, event = (
        news_first_policy.paper(1),
        news_first_policy.paper(2),
        news_first_policy.news(),
    )
    mixed = topic(event)
    mixed["source_urls"] = [a["url"], b["url"]]
    result = selected([a, b, event], [mixed])
    assert not result.research_tasks
    assert result.omitted_tasks[0]["reason"] == "mixed_research_topics"


def test_unknown_candidates_cannot_bundle_past_research_quota():
    a, b, known = (
        news_first_policy.news(1),
        news_first_policy.news(2),
        news_first_policy.news(3),
    )
    mixed = topic(a)
    mixed["candidate_ids"] = [a["id"], b["id"]]
    mixed["source_urls"] = [a["url"], b["url"]]
    result = content.parse_classified_plan(
        workflow_content.planned(mixed, topic(known, 2)),
        [a, b, known],
        classifications(known),
        6,
        content.editorial_limits(config()),
    )
    assert [task["id"] for task in result.research_tasks] == ["topic-2"]
    assert result.omitted_tasks[0]["reason"] == "mixed_research_topics"
    assert result.omitted_tasks[0]["editorial_kind"] == "research"


def test_public_and_research_caps_are_configuration_not_fixed_constants():
    candidates = [
        news_first_policy.paper(1),
        news_first_policy.paper(2),
        news_first_policy.news(1),
        news_first_policy.news(2),
    ]
    tasks = [topic(c, n) for n, c in enumerate(candidates, 1)]
    result = selected(
        candidates, tasks, max_public_items=3, max_research_items=2
    )
    assert (
        len(result.research_tasks) == 3
        and result.omitted_tasks[0]["reason"] == "public_item_quota"
    )
    result = selected(candidates, tasks, max_research_items=0)
    assert [t["candidate_ids"] for t in result.research_tasks] == [
        ["news-1"],
        ["news-2"],
    ]


async def test_configured_prompts_and_budgets_reach_only_new_run_models(
    tmp_path,
):
    c = news_first_policy.news()
    cfg = config(max_public_items=3, max_research_candidates=0)
    cfg["files"] = {
        "prompts/selection.md": (
            "Frozen editorial marker; real-world changes first."
        )
    }
    engine = workflow_content.Engine(
        (workflow_content.planned(topic(c)), set(), False)
    )
    result = await content.ContentPreparation(engine).shortlist(
        [news_first_policy.paper(), c],
        workflow_content.DAY,
        tmp_path.resolve() / "new",
        content_config=cfg,
        classifications=classifications(c),
    )
    assert result.research_tasks[0]["candidate_ids"] == [c["id"]]
    prompt, schema, instructions, _ = engine.calls[0]
    assert prompt["candidates_untrusted"] == [c]
    assert (
        prompt["max_tasks"] == 3
        and schema["properties"]["research_tasks"]["maxItems"] == 3
    )
    assert (
        instructions.startswith(content._SAFETY)
        and "Frozen editorial marker" in instructions
    )
    assert "只比较给定候选" in instructions
    assert cfg["files"]["prompts/selection.md"] in instructions


async def test_configured_discovery_policy_and_classifications_reach_the_run(
    tmp_path,
):
    c = news_first_policy.news()
    cfg = config()
    cfg["files"] = {
        "prompts/discovery.md": (
            "Frozen discovery marker: transport access and real deployment."
        )
    }
    output = json.loads(workflow_content.discovered(c))
    output["candidates"][0].update(
        editorial_kind="news",
        change_basis="A new transport route is now operating.",
    )
    engine = workflow_content.Engine((json.dumps(output), {c["url"]}, True))
    result = await content.ContentPreparation(engine).discover(
        newsletter_collection_instructions.Instruction(
            "03-world", "Frozen direction", "fixture"
        ),
        workflow_content.DAY,
        tmp_path.resolve() / "discover",
        content_config=cfg,
    )
    assert result.classifications[result.candidates[0]["id"]]["kind"] == "news"
    assert engine.calls[0][2].startswith(content._SAFETY)
    assert "Frozen discovery marker" in engine.calls[0][2]
    assert (
        "evidence_urls" in engine.calls[0][2]
        and "不得读本地文件" in engine.calls[0][2]
    )


async def test_valid_larger_configured_pool_has_same_core_runtime_limits(
    tmp_path,
):
    frozen = content_config.packaged_snapshot()
    files = dict(frozen["files"])
    files["workflow.yaml"] = files["workflow.yaml"].replace(
        "max_candidates: 30", "max_candidates: 60"
    )
    files["editorial.yaml"] = files["editorial.yaml"].replace(
        "max_research_candidates: 10", "max_research_candidates: 50"
    )
    cfg = content_config.build_snapshot(files, "c" * 40)
    assert content.editorial_limits(cfg).max_research_candidates == 50
    candidates = [
        news_first_policy.paper(number) for number in range(1, 46)
    ] + [news_first_policy.news(number) for number in range(1, 6)]
    engine = workflow_content.Engine(
        (workflow_content.planned(topic(candidates[-1])), set(), False)
    )
    result = await content.ContentPreparation(engine).shortlist(
        candidates,
        workflow_content.DAY,
        tmp_path.resolve() / "large-pool",
        content_config=cfg,
        classifications=classifications(*candidates[-5:]),
    )
    assert len(engine.calls[0][0]["candidates_untrusted"]) == 50
    assert len(result.research_tasks) == 1


def test_malformed_internal_task_identifier_is_a_finite_output_error():
    c = news_first_policy.news()
    malformed = topic(c)
    malformed["id"] = []
    with pytest.raises(errors.EditorError) as error:
        selected([c], [malformed])
    assert error.value.code == "invalid_output"


async def test_legacy_jobs_keep_exact_envelopes_and_instructions(
    tmp_path,
):
    c = news_first_policy.paper()
    t = topic(c)
    t.pop("editorial_kind")
    engine = workflow_content.Engine(
        (workflow_content.planned(t), set(), False),
        (workflow_content.discovered(c), {c["url"]}, True),
    )
    service = content.ContentPreparation(engine)
    selection = await service.shortlist(
        [c], workflow_content.DAY, tmp_path.resolve() / "legacy-selection"
    )
    discovery = await service.discover(
        newsletter_collection_instructions.Instruction(
            "01-ai-ml", "Frozen old instruction", "digest"
        ),
        workflow_content.DAY,
        tmp_path.resolve() / "legacy-discovery",
    )
    assert set(dataclasses.asdict(selection)) == {"research_tasks", "note"}
    # ``observed`` only records the call's opens for the console.
    assert set(dataclasses.asdict(discovery)) == {
        "candidates",
        "note",
        "observed",
    }
    assert (
        engine.calls[0][2] == content._SELECTION
        and engine.calls[1][2] == content._DISCOVERY
    )
    assert (
        "editorial_kind"
        not in engine.calls[0][1]["properties"]["research_tasks"]["items"][
            "properties"
        ]
    )


async def test_story_plan_uses_frozen_depth_and_old_runs_keep_original_depth(
    tmp_path,
):
    directory = pathlib.Path(__file__).resolve().parents[1]
    definition = newsletter_workflow_definition.load_definition(
        directory / "src/newsletter/workflows/daily.yaml"
    )
    ids = {node.type: node.id for node in definition.nodes}
    store = newsletter_store.Store(tmp_path / "plan.sqlite3", "mock")
    try:
        nodes = story_nodes.StoryNodes(
            store, definition, workflow_content.Engine(), tmp_path
        )
        tasks = [publication.task(n) for n in range(1, 5)]
        for run_id, frozen, expected in [
            ("new", config(), 1),
            ("no-depth", config(max_deep=0), 0),
            ("old", None, 4),
        ]:
            ctx = newsletter_workflow_engine.NodeContext(
                run_id=run_id,
                node_id=ids["story_plan"],
                item_id="",
                params={"max_deep": 4},
                inputs={ids["selection"]: {"research_tasks": tasks}},
                run_inputs={
                    "issue_date": workflow_content.DAY,
                    **({"content_config": frozen} if frozen else {}),
                },
            )
            result = await nodes.execute("story_plan", ctx, tmp_path)
            assert (
                result["brief_tasks"] == tasks
                and result["deep_tasks"] == tasks[:expected]
            )
    finally:
        store.close()


async def test_deduplicate_node_applies_budget_before_remembering_candidates(
    tmp_path,
):
    directory = pathlib.Path(__file__).resolve().parents[1]
    definition = newsletter_workflow_definition.load_definition(
        directory / "src/newsletter/workflows/daily.yaml"
    )
    ids = {node.type: node.id for node in definition.nodes}
    store = newsletter_store.Store(tmp_path / "pool.sqlite3", "mock")
    try:
        nodes = story_nodes.StoryNodes(
            store, definition, workflow_content.Engine(), tmp_path
        )
        papers, events = (
            [news_first_policy.paper(n) for n in range(1, 36)],
            [news_first_policy.news(n) for n in range(1, 6)],
        )
        ctx = newsletter_workflow_engine.NodeContext(
            run_id="pool",
            node_id=ids["deduplicate"],
            item_id="",
            params={"max_candidates": 30},
            inputs={
                ids["history"]: {
                    "candidates": [],
                    "editions": [],
                    "watchlist": [],
                },
                ids["discovery"]: [
                    {
                        "candidates": papers + events,
                        "classifications": classifications(*events),
                    }
                ],
            },
            run_inputs={
                "issue_date": workflow_content.DAY,
                "content_config": config(),
            },
        )
        result = await nodes.execute("deduplicate", ctx, tmp_path)
        assert [c["id"] for c in result["candidates"]] == [
            c["id"] for c in events + papers[:10]
        ]
        assert len(result["classifications"]) == 15
        assert "classifications" not in result["candidates"][0]
        for c in result["candidates"]:
            contracts.parse_message(c, editorial_pb2.Candidate)
    finally:
        store.close()


def test_deep_receipt_roundtrips_without_changing_frozen_issue(
    tmp_path,
):
    store = newsletter_store.Store(tmp_path / "publication.sqlite3", "mock")
    try:
        repository = newsletter_workflow_publication.PublicationRepository(
            store
        )
        tasks = [publication.task(n) for n in (1, 2)]
        repository.save_plan("run", workflow_content.DAY, tasks)
        for number, task_ in enumerate(tasks, 1):
            for mode in ("brief", "deep"):
                repository.save(
                    "run",
                    task_,
                    mode,
                    publication.result(number, mode=mode),
                    issue_date=workflow_content.DAY,
                )
        frozen = story_nodes.freeze_publication(
            repository,
            "run",
            workflow_content.DAY,
            reason="completed",
            max_features=1,
        )
        assert [s["disposition"] for s in frozen["coverage"]["stories"]] == [
            "deep",
            "brief",
        ]
        assert (
            story_nodes.freeze_publication(
                repository,
                "run",
                workflow_content.DAY,
                reason="restart",
                max_features=0,
            )
            == frozen
        )
    finally:
        store.close()


def test_default_rules_prioritize_change_without_filler():
    for text in (
        content.DEFAULT_DISCOVERY_POLICY,
        content.DEFAULT_SELECTION_POLICY,
    ):
        assert "论文" in text and "现实" in text
    assert (
        "强公共事件和产业变化应挤掉弱增量论文"
        in content.DEFAULT_SELECTION_POLICY
    )
    assert "新闻不足就短刊" in content.DEFAULT_SELECTION_POLICY
    assert (
        "早期" in content.DEFAULT_SELECTION_POLICY
        and "不硬限大机构" in content.DEFAULT_SELECTION_POLICY
    )
