"""The console's rules, each stated once (console_views.py)."""

import datetime

import pytest
import ziyixi_proto.newsletter.ui.v1.backup_status_pb as backup_pb
import ziyixi_proto.newsletter.ui.v1.edition_pb as edition_pb
import ziyixi_proto.newsletter.ui.v1.run_pb as run_pb
import ziyixi_proto.newsletter.ui.v1.source_catalog_pb as catalog_pb

import newsletter.console_views as views

KIND = run_pb.RunFailure_Kind
STATE = catalog_pb.ConfigState_State
REPLICA = backup_pb.Replica_State
GRAPH = [
    {"id": "feeds", "type": "api_feed", "on_error": "continue", "params": {}},
    {
        "id": "discovery",
        "type": "discovery",
        "on_error": "continue",
        "params": {"timeout_seconds": 240},
    },
    {
        "id": "selection",
        "type": "selection",
        "on_error": "stop",
        "params": {"timeout_seconds": 150},
    },
]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026-10-28T14:07:41.250000+00:00", "2026-10-28T14:07:41.250Z"),
        ("2026-10-28T14:07:41.999999+00:00", "2026-10-28T14:07:41.999Z"),
        ("2026-10-28T14:07:41.000400+00:00", "2026-10-28T14:07:41Z"),
        ("2026-10-28T07:07:41-07:00", "2026-10-28T14:07:41Z"),
        ("2026-10-28T14:07:41Z", "2026-10-28T14:07:41Z"),
        (1793196000.5, "2026-10-28T14:00:00.500Z"),
        (0, None),
        ("2026-10-28T14:07:41", None),
        ("", None),
        (None, None),
        (True, None),
    ],
)
def test_times_are_written_as_toisostring_writes_them(value, expected):
    assert views.timestamp(value) == expected


def _attempt(node, state, code, finished, item=""):
    return {
        "node_id": node,
        "item_id": item,
        "state": state,
        "error_code": code,
        "started_at": "2026-10-28T14:00:00+00:00",
        "finished_at": finished,
    }


def _failure(attempts, nodes=None, stop="", deadline=600):
    return views.run_failure(
        run_id="r",
        definition=GRAPH,
        nodes=nodes or {},
        attempts=attempts,
        calls=[],
        stop_reason=stop,
        started_at="2026-10-28T14:00:00+00:00",
        deadline_seconds=deadline,
    )


@pytest.mark.parametrize(
    ("code", "finished", "kind"),
    [
        ("timeout", "2026-10-28T14:02:50+00:00", KIND.NODE_BUDGET),
        # Cut off at or after the run's whole deadline (600 s here).
        ("interrupted", "2026-10-28T14:10:00+00:00", KIND.RUN_DEADLINE),
        ("interrupted", "2026-10-28T14:05:00+00:00", KIND.INTERRUPTED),
        ("rate_limit", "2026-10-28T14:01:00+00:00", KIND.MODEL_ERROR),
        ("invalid_output", "2026-10-28T14:01:00+00:00", KIND.MODEL_ERROR),
        ("no_findings", "2026-10-28T14:01:00+00:00", KIND.NO_FINDINGS),
        ("handler_failed", "2026-10-28T14:01:00+00:00", KIND.OTHER),
    ],
)
def test_what_stopped_a_run_in_plain_words(code, finished, kind):
    failure = _failure(
        [_attempt("selection", "failed", code, finished)],
        nodes={"selection": {"state": "failed"}},
    )
    assert failure is not None
    assert (failure.node_id, failure.kind) == ("selection", kind)
    assert failure.budget_seconds == 150


def test_the_earliest_stopping_failure_wins_over_passed_over_ones():
    failure = _failure(
        [
            _attempt(
                "discovery",
                "failed",
                "timeout",
                "2026-10-28T14:01:00+00:00",
                "01-ai-ml",
            ),
            _attempt("selection", "failed", "timeout", ""),
            _attempt("selection", "unknown", "", "2026-10-28T14:03:00+00:00"),
        ],
        nodes={
            "discovery": {"state": "succeeded", "degraded": True},
            "selection": {"state": "failed"},
        },
    )
    assert failure is not None
    assert (failure.node_id, failure.error_code) == ("selection", "")


def test_a_degraded_node_then_the_runs_own_code():
    degraded = _failure(
        [],
        nodes={
            "feeds": {
                "state": "succeeded",
                "degraded": True,
                "error_code": "partial_failure",
            }
        },
    )
    assert degraded is not None
    assert (degraded.node_id, degraded.kind) == ("feeds", KIND.OTHER)
    for stop, kind in (
        ("no_publishable_content", KIND.NOTHING_PUBLISHABLE),
        ("workflow_deadline", KIND.RUN_DEADLINE),
        ("workflow_storage", KIND.STORAGE),
        ("legacy_workflow_retired", KIND.OTHER),
    ):
        failure = _failure([], stop=stop)
        assert failure == run_pb.RunFailure(error_code=stop, kind=kind)
    assert _failure([]) is None


@pytest.mark.parametrize("code", ["invalid_output", "unavailable"])
def test_optional_deep_technical_failure_remains_visible_in_ready_run(code):
    definition = [
        {
            "id": "deep",
            "type": "story_deep",
            "on_error": "continue",
            "params": {"timeout_seconds": 420},
        }
    ]
    nodes = {
        "deep": {
            "state": "skipped",
            "degraded": True,
            "error_code": "partial_failure",
            "items": [{"id": "story-1", "state": "failed", "error_code": code}],
        }
    }
    attempts = [
        _attempt("deep", "failed", code, "2026-10-28T14:01:00Z", "story-1")
    ]
    failure = views.run_failure(
        run_id="r",
        definition=definition,
        nodes=nodes,
        attempts=attempts,
        calls=[],
        stop_reason="",
        started_at="2026-10-28T14:00:00Z",
        deadline_seconds=5400,
    )
    assert failure is not None
    assert (failure.node_id, failure.error_code) == ("deep", "partial_failure")
    node = views.run_nodes(definition, nodes, attempts)[0]
    assert node.state == run_pb.RunNode_State.SKIPPED
    assert node.degraded and node.failed_item_count == 1
    assert node.items[0].state == run_pb.RunNode_State.FAILED
    assert node.items[0].error_code == code


@pytest.mark.parametrize(
    ("entity", "versions", "outdated", "state"),
    [
        (None, [], False, REPLICA.NOT_STARTED),
        (
            {"create_state": "conflict", "error": "x"},
            ["unknown"],
            True,
            REPLICA.CONFLICT,
        ),
        (
            {"create_state": "ready", "error": "x", "page_id": "p"},
            ["unknown"],
            True,
            REPLICA.UNKNOWN,
        ),
        (
            {"create_state": "ready", "error": "x", "page_id": "p"},
            ["done"],
            True,
            REPLICA.RETRYING,
        ),
        (
            {"create_state": "ready", "page_id": "p"},
            ["pending"],
            True,
            REPLICA.OUTDATED,
        ),
        (
            {"create_state": "ready", "page_id": "p"},
            ["done", "appending"],
            False,
            REPLICA.SYNCING,
        ),
        ({"create_state": "new"}, [], False, REPLICA.SYNCING),
        (
            {"create_state": "ready", "page_id": "p"},
            ["done"],
            False,
            REPLICA.SYNCED,
        ),
    ],
)
def test_the_notion_copy_takes_the_first_state_that_applies(
    entity, versions, outdated, state
):
    assert (
        views.replica_state(
            enabled=True,
            entity=entity,
            version_states=versions,
            outdated=outdated,
        )
        == state
    )
    assert (
        views.replica_state(
            enabled=False,
            entity=entity,
            version_states=versions,
            outdated=outdated,
        )
        == REPLICA.DISABLED
    )


def test_backup_times_compare_as_times_not_text():
    # A whole second is written without ".000", so text would order
    # 07:00:00.500Z before 07:00:00Z.
    whole, later = "2026-10-29T07:00:00Z", "2026-10-29T07:00:00.500Z"
    records = [
        (
            backup_pb.Replica(state=REPLICA.SYNCING, last_progress_time=moment),
            moment,
        )
        for moment in (whole, later)
    ]
    counts = views.replica_counts(
        backup_pb.ReplicaCounts_Target.EDITIONS, records
    )
    assert counts.last_progress_time == later
    assert counts.oldest_pending_time == whole
    merged = views.merge_counts(
        [
            backup_pb.ReplicaCounts(
                last_progress_time=whole, oldest_pending_time=later
            ),
            backup_pb.ReplicaCounts(
                last_progress_time=later, oldest_pending_time=whole
            ),
        ]
    )
    assert (merged.last_progress_time, merged.oldest_pending_time) == (
        later,
        whole,
    )


@pytest.mark.parametrize(
    ("fixture", "correction", "key", "kind"),
    [
        (True, True, "daily-2026-10-27", edition_pb.Edition_Kind.TEST),
        (False, True, "daily-2026-10-27", edition_pb.Edition_Kind.CORRECTION),
        (False, False, "manual-1", edition_pb.Edition_Kind.TEST),
        (False, False, "daily-2026-10-26", edition_pb.Edition_Kind.TEST),
        (False, False, "daily-2026-10-27", edition_pb.Edition_Kind.DAILY),
    ],
)
def test_edition_kinds_take_the_first_rule(fixture, correction, key, kind):
    assert (
        views.edition_kind(
            is_fixture=fixture,
            correction=correction,
            runs_recorded=True,
            request_key=key,
            issue_date="2026-10-27",
        )
        == kind
    )


NOW = datetime.datetime(2026, 10, 3, tzinfo=datetime.UTC)
FIVE_MINUTES = (NOW - datetime.timedelta(minutes=5)).timestamp()
CONFIG = {
    "active_revision": "1" * 40,
    "active_digest": "a" * 64,
    "wanted_revision": "1" * 40,
    "wanted_digest": "a" * 64,
    "wanted_commit": "2" * 40,
    "pinned_digest": None,
    "error": None,
    "last_attempt": FIVE_MINUTES,
    "last_success": FIVE_MINUTES,
}


@pytest.mark.parametrize(
    ("change", "state"),
    [
        ({}, STATE.CURRENT),
        (
            {"active_revision": "packaged", "wanted_revision": "packaged"},
            STATE.CURRENT,
        ),
        ({"active_revision": "3" * 40}, STATE.PENDING),
        ({"active_digest": "b" * 64}, STATE.PENDING),
        ({"error": "CONFIG_GITHUB_NETWORK_ERROR"}, STATE.FAILED),
        # 30 minutes and one second ago, then exactly 30 minutes ago.
        ({"last_attempt": NOW.timestamp() - 1801}, STATE.STALE),
        ({"last_attempt": NOW.timestamp() - 1800}, STATE.CURRENT),
        ({"last_attempt": NOW.timestamp() + 121}, STATE.UNOBSERVED),
        ({"pinned_digest": "a" * 64, "wanted_digest": "b" * 64}, STATE.PINNED),
        ({"pinned_digest": "b" * 64}, STATE.PENDING),
        ({"wanted_digest": None}, STATE.UNOBSERVED),
        ({"last_attempt": None}, STATE.UNOBSERVED),
        ({"active_digest": None}, STATE.UNOBSERVED),
    ],
)
def test_the_configuration_state_is_fleets(change, state):
    """The cases of fleet/worker/test/newsletter-config.test.ts."""
    observed = views.config_state({**CONFIG, **change}, "o/r", NOW)
    assert observed.state == state


def test_an_unread_configuration_is_failed_and_none_is_unobserved():
    unread = dict.fromkeys(CONFIG) | {"error": "CONFIG_STATUS_UNAVAILABLE"}
    assert views.config_state(unread, "", NOW).state == STATE.FAILED
    assert views.config_state(None, "", NOW) == catalog_pb.ConfigState(
        state=STATE.UNOBSERVED
    )
    linked = views.config_state(CONFIG, "owner/config", NOW)
    assert linked.revision_url == (
        "https://github.com/owner/config/commit/" + "1" * 40
    )
    packaged = {**CONFIG, "active_revision": "packaged"}
    assert views.config_state(packaged, "owner/config", NOW).revision_url == ""


def test_older_feed_runs_have_codes_without_counts():
    outcomes = views.feed_outcomes(
        "2026-10-20",
        [
            "a-feed:ok",
            "a-feed:truncated",
            "b-feed:http_error",
            "b-feed:undated:3",
            "artifact:trimmed:2",
            "registry:absent",
        ],
        None,
    )
    assert [(o.source_id, o.code) for o in outcomes] == [
        ("a-feed", "ok"),
        ("b-feed", "http_error"),
    ]
    summary = views.feed_summary(outcomes)
    assert summary.seed_count is None
    assert summary.failed_count == 1


def test_usage_totals_count_failures_partials_and_cost():
    records = [
        {
            "status": "completed",
            "partial": False,
            "usage": {
                "input_tokens": 10,
                "cached_input_tokens": 4,
                "output_tokens": 2,
            },
            "estimated_cost_microusd": 5,
        },
        {"status": "failed", "partial": True, "usage": None},
    ]
    totals = views.usage_totals(records)
    assert (totals.call_count, totals.failed_count, totals.partial_count) == (
        2,
        1,
        1,
    )
    assert totals.estimated_cost_microusd == 5.0
    assert not totals.complete
    assert not views.usage_totals([]).complete
    assert views.usage_totals(records[:1]).complete


# A run's funnel, consensus leads and reference check.

LEAD = run_pb.ConsensusLead_Stage
STAGE = run_pb.ReferenceEvent_Stage


def funnel(**changes):
    value = {
        "directions": [{"id": "03-world", "state": "succeeded"}],
        "seeds": None,
        "notes": {},
        "headlines": [],
        "reference": {},
        "discovered": {},
        "pool": [],
        "classifications": {},
        "dropped": None,
        "tasks": [],
        "stories": [],
        "threads": None,
        "excerpts": {},
    }
    value.update(changes)
    return views.Funnel(**value)


def candidate(key, title="", **more):
    return {
        "id": key,
        "direction": "03-world",
        "title": title or key,
        "url": f"https://example.org/{key}",
        **more,
    }


def test_a_run_from_before_the_funnel_says_what_it_did_not_record():
    found = {"candidates": [candidate("a", access_scope="full_text")]}
    (row,) = views.direction_funnel(
        funnel(discovered={"03-world": found}), "discovery", [], []
    )
    assert (row.seed_count, row.opened_count, row.dropped_count) == (
        None,
        None,
        None,
    )
    assert (row.handed_count, row.full_text_count, row.news_count) == (1, 1, 0)
    assert views.consensus_leads(funnel()) == []
    assert views.reference_check(funnel()) is None


def test_a_direction_counts_each_stage_and_its_own_calls():
    pool = [
        candidate("a"),
        candidate("b"),
        {**candidate("c"), "direction": "x"},
    ]
    row = views.direction_funnel(
        funnel(
            seeds=[candidate("s"), {"id": "t", "direction": "x"}],
            discovered={
                "03-world": {
                    "candidates": [candidate("a", access_scope="metadata")],
                    "classifications": {"a": {"kind": "unknown"}},
                    "observed": {"opened": [], "opened_count": 0},
                }
            },
            pool=pool,
            dropped=[
                {"id": "d", "direction": "03-world", "reason": "pool_cap"},
                {"id": "e", "direction": "03-world", "reason": "history"},
                {"id": "f", "direction": "x", "reason": "history"},
            ],
            tasks=[{"candidate_ids": ["a", "b"]}, {"candidate_ids": ["c"]}],
            stories=[{"candidate_ids": ["a"], "disposition": "deferred"}],
        ),
        "discovery",
        [
            {
                "node_id": "discovery",
                "item_id": "03-world",
                "started_at": "2026-10-28T14:00:00+00:00",
                "finished_at": "2026-10-28T14:01:30.5+00:00",
            }
        ],
        [
            {"stage": "discovery:03-world", "status": "failed"},
            {"stage": "discovery:x", "status": "completed"},
        ],
    )[0]
    assert (row.seed_count, row.opened_count) == (1, 0)
    assert (row.unknown_count, row.metadata_count, row.pooled_count) == (
        1,
        1,
        2,
    )
    assert row.dropped_count == 2
    assert [(d.reason, d.count) for d in row.drops] == [
        ("history", 1),
        ("pool_cap", 1),
    ]
    # One task cites two of its candidates; its only story was deferred.
    assert (row.selected_count, row.published_count) == (1, 0)
    assert row.elapsed_seconds == 90.5
    assert (row.usage.call_count, row.usage.failed_count) == (1, 1)


def test_a_direction_counts_its_pooled_candidates_on_a_thread():
    pool = [
        candidate("a"),
        candidate("b"),
        {**candidate("c"), "direction": "x"},
    ]
    thread = {"thread_key": "thread-0123456789ab", "times_14d": 2}
    (row,) = views.direction_funnel(
        funnel(pool=pool, threads={"a": thread, "c": thread, "gone": thread}),
        "discovery",
        [],
        [],
    )
    assert row.thread_count == 1
    (row,) = views.direction_funnel(
        funnel(pool=pool, threads={}), "discovery", [], []
    )
    assert row.thread_count == 0
    # A pool from before threads did not record them.
    (row,) = views.direction_funnel(funnel(pool=pool), "discovery", [], [])
    assert row.thread_count is None


def test_consensus_leads_go_as_far_as_their_stories():
    basis = {"kind": "news", "basis": "头条共识：BBC、NPR、DW共3家"}
    pool = [candidate(f"c{n}", f"Lead {n}") for n in range(5)]
    leads = views.consensus_leads(
        funnel(
            pool=pool,
            classifications={
                **{f"c{n}": basis for n in range(4)},
                "c4": {"kind": "news", "basis": "Opened news"},
            },
            notes={"c0": {"signals": {"independent_sources": 4}}},
            tasks=[
                {"candidate_ids": ["c1"]},
                {"candidate_ids": ["c2"]},
                {"candidate_ids": [], "source_urls": [pool[3]["url"]]},
            ],
            stories=[
                {"candidate_ids": ["c2"], "disposition": "deferred"},
                {"candidate_ids": ["c3"], "disposition": "deferred"},
                {"candidate_ids": ["c3"], "disposition": "watch"},
            ],
        )
    )
    assert [(lead.title, lead.stage, lead.disposition) for lead in leads] == [
        ("Lead 0", LEAD.POOLED, ""),
        ("Lead 1", LEAD.SELECTED, ""),
        ("Lead 2", LEAD.DEFERRED, "deferred"),
        ("Lead 3", LEAD.PUBLISHED, "watch"),
    ]
    assert [lead.outlet_count for lead in leads] == [4, 0, 0, 0]


def test_a_consensus_lead_counts_the_excerpts_the_pool_carried():
    basis = {"kind": "news", "basis": "头条共识：BBC、NPR、DW共3家"}
    pool = [candidate("c0", "Lead 0"), candidate("c1", "Lead 1")]
    leads = views.consensus_leads(
        funnel(
            pool=pool,
            classifications={"c0": basis, "c1": basis},
            excerpts={"c0": 3, "other": 2},
        )
    )
    assert [lead.excerpt_count for lead in leads] == [3, 0]


def test_a_consensus_lead_counts_a_candidate_at_another_outlets_report():
    basis = {"kind": "news", "basis": "头条共识：BBC、NPR、DW共3家"}
    lead = candidate("lead", "Norland votes")
    opened = candidate("opened", "合成：诺兰公投", url="https://b.example/x")
    run = {
        "pool": [lead, opened],
        "classifications": {"lead": basis},
        "notes": {"lead": {"alternate_urls": ["https://b.example/x"]}},
        "tasks": [{"candidate_ids": ["opened"]}],
    }
    (found,) = views.consensus_leads(
        funnel(
            **run,
            stories=[{"candidate_ids": ["opened"], "disposition": "brief"}],
        )
    )
    assert (found.title, found.stage, found.disposition) == (
        "Norland votes",
        LEAD.PUBLISHED,
        "brief",
    )
    (found,) = views.consensus_leads(funnel(**run))
    assert found.stage == LEAD.SELECTED
    (found,) = views.consensus_leads(funnel(**{**run, "notes": {}}))
    assert found.stage == LEAD.POOLED


REFERENDUM = {
    "category": "Politics and elections",
    "text": "Norland's electoral commission confirms that voters approved "
    "the referendum on the constitution.",
    "urls": ["https://news.example.org/referendum", "javascript:alert(1)"],
    "entities": ["Norland", "Electoral Commission Norland"],
    "feeds": 2,
    "feed_title": "Norland votes",
    "seeds": [],
}


def check(*items, **changes):
    reference = {
        "source": "current-events",
        "date": "2026-10-27",
        "url": "https://en.wikipedia.org/wiki/Portal:Current_events/x",
        "code": "ok",
        "items": list(items),
    }
    return views.reference_check(funnel(reference=reference, **changes))


def test_an_unreadable_reference_lists_nothing():
    reference = {
        "source": "current-events",
        "url": "javascript:alert(1)",
        "code": "parse_error",
        "items": [REFERENDUM],
    }
    result = views.reference_check(funnel(reference=reference))
    assert result.state == run_pb.ReferenceCheck_State.UNAVAILABLE
    assert (result.error_code, result.url, result.events) == (
        "parse_error",
        "",
        (),
    )


def test_a_reference_event_takes_its_furthest_strong_match():
    words = candidate(
        "words",
        "Norland voters approve constitution in referendum, electoral "
        "commission says",
    )
    cited = candidate(
        "cited",
        "合成：诺兰公投",
        evidence_urls=["https://news.example.org/referendum"],
    )
    (event,) = check(
        REFERENDUM,
        pool=[words, cited],
        tasks=[{"candidate_ids": ["cited"]}],
        stories=[{"candidate_ids": ["cited"], "disposition": "brief"}],
    ).events
    assert (event.stage, event.match) == (STAGE.PUBLISHED, "合成：诺兰公投")
    assert event.source_urls == ("https://news.example.org/referendum",)
    (event,) = check(REFERENDUM, pool=[words]).events
    assert (event.stage, event.match) == (STAGE.POOLED, words["title"])


def test_a_reference_event_left_before_the_pool_names_where():
    lead = candidate("lead", "Norland votes")
    dropped = [
        {"id": "lead", "direction": "03-world", "reason": "research_cap"}
    ]
    linked = {**REFERENDUM, "seeds": ["lead"]}
    # The pool left the routed lead out: that is where it stopped.
    (event,) = check(linked, seeds=[lead], dropped=dropped).events
    assert (event.stage, event.match, event.drop_reason) == (
        STAGE.DROPPED,
        "Norland votes",
        "research_cap",
    )
    handed = {"03-world": {"candidates": [lead]}}
    (event,) = check(
        linked, seeds=[lead], dropped=dropped, discovered=handed
    ).events
    assert (event.stage, event.drop_reason) == (STAGE.DROPPED, "research_cap")
    (event,) = check(REFERENDUM, dropped=[]).events
    assert (event.stage, event.match) == (STAGE.CUT, "Norland votes")
    weak = candidate("weak", "Norland voters approve a referendum")
    (event,) = check({**REFERENDUM, "feeds": 0}, pool=[weak]).events
    assert (event.stage, event.match) == (STAGE.UNCERTAIN, weak["title"])
    (event,) = check({**REFERENDUM, "feeds": 0}, dropped=[]).events
    assert (event.stage, event.match) == (STAGE.UNSEEN, "")


def test_before_the_pool_a_reference_event_is_pending():
    # The run is still discovering: no pool, no drops yet.
    lead = candidate("lead", "Norland votes")
    linked = {**REFERENDUM, "seeds": ["lead"]}
    handed = {"03-world": {"candidates": [lead]}}
    for item in (linked, REFERENDUM, {**REFERENDUM, "feeds": 0}):
        (event,) = check(item, seeds=[lead], discovered=handed).events
        assert (event.stage, event.drop_reason) == (STAGE.PENDING, "")
    (event,) = check({**REFERENDUM, "feeds": 0}).events
    assert (event.stage, event.match) == (STAGE.PENDING, "")


def test_an_event_an_earlier_run_had_is_not_unseen():
    earlier = {
        **REFERENDUM,
        "feeds": 0,
        "feed_title": "",
        "previous": "Norland approves its constitution",
    }
    for changes in ({"dropped": []}, {}):
        (event,) = check(earlier, **changes).events
        assert (event.stage, event.match) == (
            STAGE.PREVIOUS,
            "Norland approves its constitution",
        )
    # A report this run carried further still wins.
    words = candidate(
        "words",
        "Norland voters approve constitution in referendum, electoral "
        "commission says",
    )
    (event,) = check(earlier, pool=[words]).events
    assert event.stage == STAGE.POOLED


def test_a_published_discovery_candidate_in_chinese_is_not_left_pooled():
    # Discovery handed off a Chinese title at an address without a slug;
    # the English feed lead it opened sat in the pool uncited.
    lead = candidate(
        "lead",
        "Norland voters approve new constitution in referendum, electoral "
        "commission says",
    )
    published = candidate(
        "published",
        "诺兰选民在公投中通过新宪法",
        url="https://news.example.org/articles/c4g7x2y9",
        event_key="norland-constitution-referendum-approved",
    )
    run = {
        "seeds": [lead],
        "pool": [published, lead],
        "dropped": [],
        "tasks": [{"candidate_ids": ["published"]}],
        "stories": [{"candidate_ids": ["published"], "disposition": "brief"}],
    }
    linked = {**REFERENDUM, "seeds": ["lead"], "feed_urls": [lead["url"]]}
    # Its address is one of the strong feed matches' (a group alternate).
    (event,) = check(
        {**linked, "feed_urls": [lead["url"], published["url"]]}, **run
    ).events
    assert (event.stage, event.match) == (STAGE.PUBLISHED, published["title"])
    # It is not: its English event key is only a weak match, which got
    # further than the lead, so it may be there.
    (event,) = check(linked, **run).events
    assert (event.stage, event.match) == (STAGE.UNCERTAIN, published["title"])


def test_scalar_and_url_helpers_clamp_and_reject_unsafe_inputs():
    assert views.instant(True) is None
    assert views.instant(0) is None
    assert views.instant(-10) is None
    assert views.instant("2026-10-28T14:07:41") is None
    assert views.instant("not-a-date") is None
    assert views.instant(1793196000) == datetime.datetime(
        2026, 10, 28, 14, 0, tzinfo=datetime.UTC
    )
    assert views.int32(True) == 0
    assert views.int32("12") == 0
    assert views.int32(-99) == 0
    assert views.int32(views.INT32_MAX + 500) == views.INT32_MAX
    assert views.int32(42.8) == 42
    assert views.http_url("https://example.org/a") == "https://example.org/a"
    assert views.http_url("http://example.org/b") == "http://example.org/b"
    assert views.http_url("javascript:alert(1)") == ""
    assert views.http_url("ftp://example.org/file") == ""
    assert views.http_url(None) == ""
    uid = "01234567-89ab-cdef-0123-456789abcdef"
    assert views.notion_url(uid) == (
        "https://www.notion.so/0123456789abcdef0123456789abcdef"
    )
    assert views.notion_url("not-a-uuid") == ""
    assert views.notion_url(None) == ""
    assert (
        views.call_seconds(
            {
                "started_at": "2026-10-28T14:05:00Z",
                "finished_at": "2026-10-28T14:04:00Z",
            }
        )
        == 0.0
    )
    assert views.call_seconds({"started_at": "2026-10-28T14:05:00Z"}) is None


def test_funnel_fates_and_headline_summaries():
    pool = [candidate("c1"), candidate("c2")]
    active = funnel(
        pool=pool,
        tasks=[{"candidate_ids": ["c1"], "source_urls": [pool[1]["url"]]}],
        stories=[
            {"candidate_ids": ["c1"], "disposition": "deferred"},
            {"candidate_ids": ["c1"], "disposition": "deep"},
            {"candidate_ids": ["c2"], "disposition": "deferred"},
        ],
    )
    selected, disposition = active.fates()
    assert selected == {"c1", "c2"}
    assert disposition == {"c1": "deep", "c2": "deferred"}
    summaries = views.headline_summaries(
        [
            {
                "direction": "03-world",
                "feeds": 4,
                "feeds_ok": 3,
                "entries": 20,
                "groups": 8,
                "consensus_groups": 2,
                "max_outlets": 5,
                "top": [
                    {"title": f"Group {i}", "outlets": 5 - i} for i in range(4)
                ],
            }
        ]
    )
    assert len(summaries) == 1
    assert summaries[0].direction == "03-world"
    assert summaries[0].consensus_group_count == 2
    assert len(summaries[0].top_groups) == 3
    assert summaries[0].top_groups[0].title == "Group 0"


def test_frozen_usage_and_usage_groupings():
    assert views.frozen_usage(None) is None
    frozen = views.frozen_usage(
        {
            "invocations": 3,
            "partial": False,
            "usage": {
                "input_tokens": 100,
                "cached_input_tokens": 40,
                "output_tokens": 25,
            },
        }
    )
    assert frozen is not None
    assert (frozen.call_count, frozen.input_tokens, frozen.complete) == (
        3,
        100.0,
        True,
    )
    calls = [
        (
            "2026-10-28",
            {
                "stage": "selection",
                "purpose": "selection",
                "model": "req-model",
                "contributing_models": ["rep-model"],
                "status": "completed",
                "partial": False,
                "started_at": "2026-10-28T14:00:00Z",
                "finished_at": "2026-10-28T14:00:10Z",
                "usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 0,
                    "output_tokens": 5,
                },
            },
        ),
        (
            "2026-10-28",
            {
                "stage": "discovery:01-ai",
                "purpose": "discovery",
                "model": "req-model",
                "status": "completed",
                "partial": False,
                "started_at": "2026-10-28T14:00:00Z",
                "finished_at": "2026-10-28T14:00:30Z",
                "usage": {
                    "input_tokens": 20,
                    "cached_input_tokens": 5,
                    "output_tokens": 8,
                },
            },
        ),
    ]
    days = views.usage_days(calls)
    assert [(d.issue_date, d.model, d.usage.call_count) for d in days] == [
        ("2026-10-28", "rep-model", 1),
        ("2026-10-28", "req-model", 1),
    ]
    nodes = views.usage_nodes(calls, GRAPH)
    assert [(n.node_id, n.purpose, n.budget_seconds) for n in nodes] == [
        ("discovery", "discovery", 240),
        ("selection", "selection", 150),
    ]
    assert nodes[0].median_seconds == 30.0
    assert nodes[1].max_seconds == 10.0


def test_replica_story_outcomes_and_edition_body():
    empty_rep = views.replica(
        enabled=True, entity=None, version_states=[], outdated=False
    )
    assert empty_rep.state == REPLICA.NOT_STARTED
    retrying_rep = views.replica(
        enabled=True,
        entity={
            "create_state": "ready",
            "error": "notion_rate_limited",
            "attempts": 2,
            "retry_at": "2026-10-28T15:00:00Z",
            "progress_at": "2026-10-28T14:30:00Z",
            "page_id": "01234567-89ab-cdef-0123-456789abcdef",
        },
        version_states=["done"],
        outdated=False,
    )
    assert retrying_rep.state == REPLICA.RETRYING
    assert retrying_rep.next_retry_time == "2026-10-28T15:00:00Z"
    assert retrying_rep.notion_url.endswith("0123456789abcdef")

    from_coverage = views.story_outcomes(
        [
            {
                "story_id": "s1",
                "title": "Story 1",
                "disposition": "deep",
                "reason": "lead",
            }
        ],
        [{"id": "s1", "question": "Plan Q"}],
        {"s1": "approved"},
    )
    assert len(from_coverage) == 1 and from_coverage[0].disposition == "deep"
    from_plan = views.story_outcomes(
        [], [{"id": "s1", "question": "Plan Q"}], {"s1": "failed"}
    )
    assert len(from_plan) == 1 and from_plan[0].title == "Plan Q"

    fallback = views.edition_body(
        None,
        {
            "sections": [
                {
                    "kind": "feature",
                    "heading": "H",
                    "paragraphs": [{"text": "Body text"}],
                    "limitations": "Lim",
                }
            ]
        },
    )
    assert fallback["sections"][0].paragraphs[0].text == "Body text"

    rich = views.edition_body(
        {
            "packets": [
                {
                    "id": "p1",
                    "content": {
                        "sources": [{"id": "s1", "access_scope": "full_text"}]
                    },
                }
            ],
            "sections": [
                {
                    "kind": "feature",
                    "heading": "H",
                    "paragraphs": [
                        {"text": "Cited", "references": [{"number": 1}]}
                    ],
                    "limitations": ["L1"],
                }
            ],
            "references": [
                {
                    "number": 1,
                    "title": "Ref 1",
                    "url": "https://example.org/1",
                    "citation": "p1/s1",
                    "published_at": "2026-10-28",
                }
            ],
            "chart": {
                "kind": "bar",
                "question": "Q",
                "metric": "M",
                "unit": "U",
                "period": "P",
                "caption": "C",
                "alt_text": "A",
                "limitations": ["CL"],
                "rows": [
                    {
                        "label": "R1",
                        "value": "10",
                        "missing_reason": "",
                        "references": [{"number": 1}],
                    }
                ],
            },
            "reading": {
                "reference": {"number": 1},
                "reason": "Read this",
                "supporting_references": [{"number": 1}],
            },
        },
        {},
    )
    assert rich["references"][0].access_scope == "full_text"
    assert rich["chart"].points[0].reference_numbers == (1,)
    assert rich["recommended_reading"].reference_number == 1
