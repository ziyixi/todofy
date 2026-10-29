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
