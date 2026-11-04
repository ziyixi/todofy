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
    (event,) = check(linked, seeds=[lead], dropped=dropped).events
    assert (event.stage, event.match, event.drop_reason) == (
        STAGE.NOT_HANDED,
        "Norland votes",
        "research_cap",
    )
    handed = {"03-world": {"candidates": [lead]}}
    (event,) = check(
        linked, seeds=[lead], dropped=dropped, discovered=handed
    ).events
    assert (event.stage, event.drop_reason) == (STAGE.DROPPED, "research_cap")
    (event,) = check(REFERENDUM).events
    assert (event.stage, event.match) == (STAGE.CUT, "Norland votes")
    weak = candidate("weak", "Norland voters approve a referendum")
    (event,) = check({**REFERENDUM, "feeds": 0}, pool=[weak]).events
    assert (event.stage, event.match) == (STAGE.UNCERTAIN, weak["title"])
    (event,) = check({**REFERENDUM, "feeds": 0}).events
    assert (event.stage, event.match) == (STAGE.UNSEEN, "")
