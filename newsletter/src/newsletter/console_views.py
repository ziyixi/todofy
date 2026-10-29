"""Newsletter's records as newsletter.ui.v1 messages, for the owner console.

Pure: rows that console_read.py read from one snapshot of the database go in,
generated dataclasses come out, and the clock is a parameter. The rules that
keep every page consistent live here and only here
(contracts/newsletter-ui-v1/README.md "Rules that keep the console
consistent"): a node's budget is the one its run froze, what stopped a run,
the Notion copy's state, an edition's kind, Fleet's configuration state and
the model-usage totals. SQLite is the record; the Notion backup's state is the
replication journal's, never Notion's.
"""

from collections.abc import Iterable, Mapping, Sequence
import datetime
import re
import statistics
from typing import Any

import ziyixi_proto.newsletter.ui.v1.backup_status_pb as backup_pb
import ziyixi_proto.newsletter.ui.v1.edition_pb as edition_pb
import ziyixi_proto.newsletter.ui.v1.model_call_pb as model_call_pb
import ziyixi_proto.newsletter.ui.v1.overview_pb as overview_pb
import ziyixi_proto.newsletter.ui.v1.run_pb as run_pb
import ziyixi_proto.newsletter.ui.v1.source_catalog_pb as catalog_pb

import newsletter.workflow.researcher as researcher

Row = Mapping[str, Any]
INT32_MAX = 2**31 - 1
# Fleet's thresholds (fleet/worker/src/newsletter-config.ts).
CONFIG_STALE = datetime.timedelta(minutes=30)
CONFIG_FUTURE = datetime.timedelta(seconds=120)
RUN_STATES = {
    "queued": run_pb.Run_State.QUEUED,
    "collecting": run_pb.Run_State.RUNNING,
    "projecting": run_pb.Run_State.RUNNING,
    "editing": run_pb.Run_State.RUNNING,
    "ready": run_pb.Run_State.READY,
    "blocked": run_pb.Run_State.BLOCKED,
    "failed": run_pb.Run_State.FAILED,
}
NODE_STATES = {
    "pending": run_pb.RunNode_State.PENDING,
    "running": run_pb.RunNode_State.RUNNING,
    "succeeded": run_pb.RunNode_State.SUCCEEDED,
    "skipped": run_pb.RunNode_State.SKIPPED,
    "failed": run_pb.RunNode_State.FAILED,
    "unknown": run_pb.RunNode_State.UNKNOWN,
}
DELIVERY_STATES = {
    "not_requested": edition_pb.Delivery_State.NOT_REQUESTED,
    "submitting": edition_pb.Delivery_State.SUBMITTING,
    "simulated": edition_pb.Delivery_State.SIMULATED,
    "provider_accepted": edition_pb.Delivery_State.PROVIDER_ACCEPTED,
    "rejected": edition_pb.Delivery_State.REJECTED,
    "unknown": edition_pb.Delivery_State.UNKNOWN,
}
CALL_STATES = {
    "running": model_call_pb.ModelCall_State.RUNNING,
    "completed": model_call_pb.ModelCall_State.COMPLETED,
    "failed": model_call_pb.ModelCall_State.FAILED,
}
DIGEST_STATES = {
    "current": edition_pb.PersonalDigest_State.CURRENT,
    "empty": edition_pb.PersonalDigest_State.EMPTY,
    "unavailable": edition_pb.PersonalDigest_State.UNAVAILABLE,
    "disabled": edition_pb.PersonalDigest_State.DISABLED,
}
_KIND = run_pb.RunFailure_Kind
# An attempt's code, then the run's own stop code, in plain words.
_ATTEMPT_KINDS = {
    "timeout": _KIND.NODE_BUDGET,
    "authentication": _KIND.MODEL_ERROR,
    "rate_limit": _KIND.MODEL_ERROR,
    "unavailable": _KIND.MODEL_ERROR,
    "invalid_output": _KIND.MODEL_ERROR,
    "no_findings": _KIND.NO_FINDINGS,
}
_RUN_KINDS = {
    "no_publishable_content": _KIND.NOTHING_PUBLISHABLE,
    "workflow_deadline": _KIND.RUN_DEADLINE,
    "workflow_storage": _KIND.STORAGE,
}
_FEED_CODES = frozenset({"ok", *researcher.FAILURES})
_FEED_OUTCOME = re.compile(r"([a-z0-9][a-z0-9-]{0,63}):([a-z_]{1,32})\Z")
_ROUTER_REQUEST = re.compile(r"requests/[A-Za-z0-9-]{1,64}\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_REPLICA = backup_pb.Replica_State
_DEPENDENCY = run_pb.Dependency_State
_ENDED = frozenset({"ready", "blocked", "failed"})
MAX_ITEMS = 64
MAX_LABEL_CHARS = 200


def instant(value: object) -> datetime.datetime | None:
    """An aware ISO 8601 time or an epoch number as UTC; None otherwise."""
    if isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float)):
            # The journal writes 0 for "never".
            if value <= 0:
                return None
            return datetime.datetime.fromtimestamp(value, datetime.UTC)
        if not isinstance(value, str) or not value:
            return None
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, OverflowError, OSError):
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(datetime.UTC)


def timestamp(value: object) -> str | None:
    """The wire's canonical form of a time: UTC, milliseconds unless whole.

    TypeScript's toWire writes a Timestamp the same way (toISOString without
    ``.000``), so the bytes Newsletter writes are the bytes the console's
    Worker would write.
    """
    moment = instant(value)
    if moment is None:
        return None
    text = moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return text.replace(".000Z", "Z")


def seconds(start: object, end: object) -> float | None:
    """The seconds between two times, to the millisecond; None if unknown."""
    first, last = instant(start), instant(end)
    if first is None or last is None:
        return None
    return round(max(0.0, (last - first).total_seconds()), 3)


def int32(value: object) -> int:
    """A non-negative count within int32; anything else is 0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(min(max(value, 0), INT32_MAX))


def text(value: object, limit: int = 0) -> str:
    """A stored string, optionally cut to ``limit`` characters."""
    if not isinstance(value, str):
        return ""
    return value[:limit] if limit else value


def http_url(value: object) -> str:
    """An http or https URL as stored; empty for any other scheme."""
    url = text(value)
    return url if url.startswith(("https://", "http://")) else ""


def budget_seconds(definition: Sequence[Row], node_id: str) -> int:
    """The node's budget as its run froze it; 0 for a node without one."""
    for node in definition:
        if node.get("id") == node_id:
            params = node.get("params")
            value = params.get("timeout_seconds", 0) if params else 0
            return int32(value)
    return 0


def node_of(definition: Sequence[Row], kind: str) -> str:
    """The ID of the run's node of one type, empty when it has none."""
    return next(
        (str(node["id"]) for node in definition if node.get("type") == kind),
        "",
    )


# Runs and what stopped them.


def run_state(state: object) -> run_pb.Run_State:
    """A collection run's stored state in the API's words."""
    return RUN_STATES.get(str(state), run_pb.Run_State.UNSPECIFIED)


def run_trigger(
    *, request_key: str, issue_date: str, parent_run: str
) -> run_pb.Run_Trigger:
    """Scheduled is the issue date's daily key; replay has a parent."""
    if parent_run:
        return run_pb.Run_Trigger.REPLAY
    if request_key == "daily-" + issue_date:
        return run_pb.Run_Trigger.SCHEDULED
    return run_pb.Run_Trigger.MANUAL


def _attempt_kind(
    attempt: Row, started_at: object, deadline_seconds: int
) -> run_pb.RunFailure_Kind:
    code = str(attempt.get("error_code") or "")
    if code == "interrupted":
        elapsed = seconds(started_at, attempt.get("finished_at"))
        if (
            deadline_seconds
            and elapsed is not None
            and elapsed >= deadline_seconds
        ):
            return _KIND.RUN_DEADLINE
        return _KIND.INTERRUPTED
    return _ATTEMPT_KINDS.get(code, _KIND.OTHER)


def _stops(attempt: Row, definition: Sequence[Row], nodes: Row) -> bool:
    """Whether this attempt's failure stopped its node's run."""
    if attempt.get("state") not in {"failed", "unknown"}:
        return False
    node = nodes.get(str(attempt.get("node_id")))
    if isinstance(node, Mapping) and node.get("state"):
        # The aggregate node failed only when its failure could not be
        # passed over (no ``on_error: continue``, or an account-level code).
        return node["state"] in {"failed", "unknown"}
    spec = next(
        (n for n in definition if n.get("id") == attempt.get("node_id")), {}
    )
    return spec.get("on_error") != "continue"


def run_failure(
    *,
    run_id: str,
    definition: Sequence[Row],
    nodes: Row,
    attempts: Sequence[Row],
    calls: Sequence[Row],
    stop_reason: str,
    started_at: object,
    deadline_seconds: int,
) -> run_pb.RunFailure | None:
    """What stopped or degraded a run, absent when nothing did.

    The earliest finished failed or unknown attempt of a node whose failure
    stops the run, else the first degraded node in the graph's order, else
    the run's own stop code.
    """
    stopping = sorted(
        (a for a in attempts if _stops(a, definition, nodes)),
        key=lambda a: (
            a.get("finished_at") or "￿",
            a.get("started_at") or "",
        ),
    )
    if stopping:
        attempt = stopping[0]
        node_id = str(attempt["node_id"])
        item_id = str(attempt.get("item_id") or "")
        stage = node_id + (":" + item_id if item_id else "")
        in_flight = [
            call
            for call in calls
            if call.get("stage") == stage and call.get("status") != "completed"
        ]
        return run_pb.RunFailure(
            node_id=node_id,
            item_id=item_id,
            error_code=str(attempt.get("error_code") or ""),
            kind=_attempt_kind(attempt, started_at, deadline_seconds),
            elapsed_seconds=seconds(
                attempt.get("started_at"), attempt.get("finished_at")
            )
            or 0.0,
            budget_seconds=budget_seconds(definition, node_id),
            model_call=f"runs/{run_id}/modelCalls/{in_flight[-1]['id']}"
            if in_flight
            else "",
        )
    for spec in definition:
        node = nodes.get(str(spec.get("id")))
        if isinstance(node, Mapping) and node.get("degraded"):
            return run_pb.RunFailure(
                node_id=str(spec["id"]),
                error_code=str(node.get("error_code") or "partial_failure"),
                kind=_KIND.OTHER,
                budget_seconds=budget_seconds(definition, str(spec["id"])),
            )
    if stop_reason:
        return run_pb.RunFailure(
            error_code=stop_reason,
            kind=_RUN_KINDS.get(stop_reason, _KIND.OTHER),
        )
    return None


def run_nodes(
    definition: Sequence[Row],
    nodes: Row,
    attempts: Sequence[Row],
) -> list[run_pb.RunNode]:
    """The frozen graph's nodes in order, with their attempts and items."""
    by_node: dict[str, list[Row]] = {}
    for attempt in attempts:
        by_node.setdefault(str(attempt["node_id"]), []).append(attempt)
    remaining = MAX_ITEMS
    result = []
    for spec in definition:
        node_id = str(spec["id"])
        node = nodes.get(node_id)
        stored: Row = node if isinstance(node, Mapping) else {}
        own = by_node.get(node_id, [])
        starts = [a["started_at"] for a in own if a.get("started_at")]
        running = any(a.get("state") == "running" for a in own)
        ends = [a["finished_at"] for a in own if a.get("finished_at")]
        timed = {
            str(a.get("item_id") or ""): a for a in own if a.get("item_id")
        }
        items = []
        stored_items = stored.get("items") or []
        for item in stored_items[:remaining]:
            attempt = timed.get(str(item.get("id")), {})
            value = item.get("value")
            label = item.get("id")
            if isinstance(value, Mapping):
                label = value.get("question") or value.get("id") or label
            items.append(
                run_pb.RunNodeItem(
                    item_id=text(item.get("id")),
                    label=text(label, MAX_LABEL_CHARS),
                    state=NODE_STATES.get(
                        str(item.get("state")),
                        run_pb.RunNode_State.UNSPECIFIED,
                    ),
                    error_code=text(item.get("error_code")),
                    start_time=timestamp(attempt.get("started_at")),
                    end_time=timestamp(attempt.get("finished_at")),
                )
            )
        remaining -= len(items)
        result.append(
            run_pb.RunNode(
                node_id=node_id,
                type=text(spec.get("type")),
                needs=tuple(str(need) for need in spec.get("needs") or ()),
                continue_on_error=spec.get("on_error") == "continue",
                state=NODE_STATES.get(
                    str(stored.get("state") or "pending"),
                    run_pb.RunNode_State.UNSPECIFIED,
                ),
                error_code=text(stored.get("error_code")),
                degraded=bool(stored.get("degraded")),
                budget_seconds=budget_seconds(definition, node_id),
                start_time=timestamp(min(starts)) if starts else None,
                end_time=timestamp(max(ends)) if ends and not running else None,
                item_count=int32(len(stored_items)),
                failed_item_count=int32(
                    sum(
                        item.get("state") in {"failed", "unknown"}
                        for item in stored_items
                    )
                ),
                items=tuple(items),
            )
        )
    return result


# Feeds.


def feed_outcomes(
    issue_date: str, diagnostics: object, sources: object
) -> list[run_pb.SourceOutcome]:
    """Each fetched source's outcome in the registry's order.

    Runs since per-source counts were recorded carry them (``sources``);
    older runs have only the ``<id>:<code>`` diagnostics, so their counts
    stay absent rather than zero.
    """
    if isinstance(sources, list) and sources:
        return [
            run_pb.SourceOutcome(
                source_id=text(item.get("id")),
                issue_date=issue_date,
                code=text(item.get("code")),
                entry_count=int32(item.get("entries")),
                accepted_count=int32(item.get("accepted")),
                seed_count=int32(item.get("seeds")),
            )
            for item in sources
            if isinstance(item, Mapping)
        ]
    result = []
    for entry in diagnostics if isinstance(diagnostics, list) else []:
        match = (
            _FEED_OUTCOME.fullmatch(entry) if isinstance(entry, str) else None
        )
        if match and match[2] in _FEED_CODES:
            result.append(
                run_pb.SourceOutcome(
                    source_id=match[1], issue_date=issue_date, code=match[2]
                )
            )
    return result


def feed_summary(
    outcomes: Sequence[run_pb.SourceOutcome],
) -> run_pb.FeedSummary:
    """What the feeds node fetched, with its failed sources."""
    failures = tuple(o for o in outcomes if o.code != "ok")
    counted = bool(outcomes) and all(o.seed_count is not None for o in outcomes)
    return run_pb.FeedSummary(
        source_count=len(outcomes),
        ok_count=len(outcomes) - len(failures),
        failed_count=len(failures),
        seed_count=sum(int(o.seed_count or 0) for o in outcomes)
        if counted
        else None,
        failures=failures,
    )


# Model calls and their totals.


def _usage(record: Row) -> Row:
    usage = record.get("usage")
    return usage if isinstance(usage, Mapping) else {}


def reported_models(record: Row) -> list[str]:
    """The distinct models the Router reported, first reported first."""
    models: list[str] = []
    requests = record.get("requests") or []
    names = [r.get("model") for r in requests if isinstance(r, Mapping)]
    for name in [*names, *(record.get("contributing_models") or [])]:
        if isinstance(name, str) and name and name not in models:
            models.append(name)
    return models[:4]


def model_call(
    run_id: str, record: Row, updated_at: str
) -> model_call_pb.ModelCall:
    """One invocation as recorded; keys older records lack stay unset."""
    node_id, _, item_id = text(record.get("stage")).partition(":")
    usage = _usage(record)
    cost = record.get("estimated_cost_microusd")
    requests = record.get("requests") or []
    return model_call_pb.ModelCall(
        name=f"runs/{run_id}/modelCalls/{record['id']}",
        node_id=node_id,
        item_id=item_id,
        purpose=text(record.get("purpose")),
        requested_model=text(record.get("model")),
        reported_models=tuple(reported_models(record)),
        state=CALL_STATES.get(
            str(record.get("status")), model_call_pb.ModelCall_State.UNSPECIFIED
        ),
        failure_code=text(record.get("failure"))
        if record.get("status") == "failed"
        else "",
        partial=bool(record.get("partial")),
        turn_count=int32(record.get("turns_started")),
        completed_turn_count=int32(record.get("turns_completed")),
        input_tokens=int32(usage.get("input_tokens")),
        cached_input_tokens=int32(usage.get("cached_input_tokens")),
        output_tokens=int32(usage.get("output_tokens")),
        estimated_cost_microusd=int32(cost)
        if type(cost) is int and cost >= 0
        else None,
        billing_kind=text(record.get("billing_kind")),
        start_time=timestamp(record.get("started_at")),
        end_time=timestamp(record.get("finished_at")),
        update_time=timestamp(updated_at),
        conversation=text(record.get("thread_id")),
        router_requests=tuple(
            name
            for name in (
                r.get("name") for r in requests if isinstance(r, Mapping)
            )
            if isinstance(name, str) and _ROUTER_REQUEST.fullmatch(name)
        )[:4],
    )


def usage_totals(records: Iterable[Row]) -> model_call_pb.UsageTotals:
    """Calls, failures and token sums of some model calls.

    ``complete`` only when there are calls and every call's usage was
    observed (no partial call, none missing).
    """
    calls = failed = partial = 0
    tokens = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
    cost: int | None = None
    complete = True
    for record in records:
        calls += 1
        failed += record.get("status") == "failed"
        partial += bool(record.get("partial"))
        usage = _usage(record)
        complete &= bool(usage) and not record.get("partial")
        for key in tokens:
            tokens[key] += int32(usage.get(key))
        value = record.get("estimated_cost_microusd")
        if type(value) is int and value >= 0:
            cost = (cost or 0) + value
    return model_call_pb.UsageTotals(
        call_count=calls,
        failed_count=failed,
        partial_count=partial,
        input_tokens=float(tokens["input_tokens"]),
        cached_input_tokens=float(tokens["cached_input_tokens"]),
        output_tokens=float(tokens["output_tokens"]),
        estimated_cost_microusd=float(cost) if cost is not None else None,
        complete=bool(calls) and complete,
    )


def frozen_usage(summary: object) -> model_call_pb.UsageTotals | None:
    """The usage summary frozen into an edition (its email footer's numbers)."""
    if not isinstance(summary, Mapping):
        return None
    usage = _usage(summary)
    return model_call_pb.UsageTotals(
        call_count=int32(summary.get("invocations")),
        input_tokens=float(int32(usage.get("input_tokens"))),
        cached_input_tokens=float(int32(usage.get("cached_input_tokens"))),
        output_tokens=float(int32(usage.get("output_tokens"))),
        complete=not summary.get("partial", True),
    )


def call_seconds(record: Row) -> float | None:
    """A finished call's duration; None for calls recorded without times."""
    return seconds(record.get("started_at"), record.get("finished_at"))


def usage_days(
    calls: Sequence[tuple[str, Row]],
) -> list[model_call_pb.ModelUsageDay]:
    """Per issue date and model (the first reported, else the requested)."""
    groups: dict[tuple[str, str], list[Row]] = {}
    for issue_date, record in calls:
        models = reported_models(record)
        model = models[0] if models else text(record.get("model"))
        groups.setdefault((issue_date, model), []).append(record)
    return [
        model_call_pb.ModelUsageDay(
            issue_date=day, model=model, usage=usage_totals(records)
        )
        for (day, model), records in sorted(groups.items())
    ]


def usage_nodes(
    calls: Sequence[tuple[str, Row]],
    definition: Sequence[Row],
) -> list[model_call_pb.ModelUsageNode]:
    """Per node and purpose, in the newest run's graph order."""
    groups: dict[tuple[str, str], list[Row]] = {}
    for _, record in calls:
        node_id = text(record.get("stage")).partition(":")[0]
        groups.setdefault((node_id, text(record.get("purpose"))), []).append(
            record
        )
    order = {str(node.get("id")): i for i, node in enumerate(definition)}
    result = []
    for (node_id, purpose), records in sorted(
        groups.items(),
        key=lambda item: (
            order.get(item[0][0], len(order)),
            item[0][0],
            item[0][1],
        ),
    ):
        durations = [d for d in map(call_seconds, records) if d is not None]
        result.append(
            model_call_pb.ModelUsageNode(
                node_id=node_id,
                purpose=purpose,
                usage=usage_totals(records),
                timed_call_count=len(durations),
                median_seconds=round(statistics.median(durations), 3)
                if durations
                else None,
                max_seconds=max(durations) if durations else None,
                budget_seconds=budget_seconds(definition, node_id),
            )
        )
    return result


# Editions, their delivery and their Notion copy.


def edition_kind(
    *,
    is_fixture: bool,
    correction: bool,
    runs_recorded: bool,
    request_key: str,
    issue_date: str,
) -> edition_pb.Edition_Kind:
    """Which kind of issue, by the first rule that applies.

    As the Notion backup's type column (notion_intake.py, with
    NotionJournal.is_verification and is_daily_run): a fixture is a test, a
    correction is a correction, an edition of any run but the issue date's
    scheduled one is a test, the rest are daily.
    """
    if is_fixture:
        return edition_pb.Edition_Kind.TEST
    if correction:
        return edition_pb.Edition_Kind.CORRECTION
    if runs_recorded and request_key != "daily-" + issue_date:
        return edition_pb.Edition_Kind.TEST
    return edition_pb.Edition_Kind.DAILY


def delivery(
    *, state: object, updated_at: object, error_code: object, corrections: int
) -> edition_pb.Delivery:
    """The delivery outcome; its time and code only once one was requested."""
    requested = state != "not_requested"
    return edition_pb.Delivery(
        state=DELIVERY_STATES.get(
            str(state), edition_pb.Delivery_State.UNSPECIFIED
        ),
        update_time=timestamp(updated_at) if requested else None,
        error_code=text(error_code) if requested else "",
        verification_count=int32(corrections),
    )


def replica_state(
    *,
    enabled: bool,
    entity: Row | None,
    version_states: Iterable[str],
    outdated: bool,
) -> backup_pb.Replica_State:
    """The Notion copy's state.

    When several apply the first wins: CONFLICT, UNKNOWN, RETRYING, OUTDATED,
    SYNCING, SYNCED.
    """
    if not enabled:
        return _REPLICA.DISABLED
    if entity is None:
        return _REPLICA.NOT_STARTED
    states = set(version_states)
    if entity.get("create_state") == "conflict":
        return _REPLICA.CONFLICT
    if entity.get("create_state") == "unknown" or "unknown" in states:
        return _REPLICA.UNKNOWN
    if entity.get("error"):
        return _REPLICA.RETRYING
    if outdated:
        return _REPLICA.OUTDATED
    if (
        not entity.get("page_id")
        or entity.get("create_state") != "ready"
        or not states
        or states != {"done"}
    ):
        return _REPLICA.SYNCING
    return _REPLICA.SYNCED


def notion_url(page_id: object) -> str:
    """The page's https address in Notion, empty until the page exists."""
    compact = text(page_id).replace("-", "")
    return (
        "https://www.notion.so/" + compact
        if re.fullmatch(r"[0-9a-f]{32}", compact)
        else ""
    )


def replica(
    *,
    enabled: bool,
    entity: Row | None,
    version_states: Iterable[str],
    outdated: bool,
) -> backup_pb.Replica:
    """One record's copy in Notion, as the journal knows it."""
    state = replica_state(
        enabled=enabled,
        entity=entity,
        version_states=version_states,
        outdated=outdated,
    )
    if entity is None:
        return backup_pb.Replica(state=state)
    return backup_pb.Replica(
        state=state,
        error_code=text(entity.get("error")),
        attempt_count=int32(entity.get("attempts")),
        next_retry_time=timestamp(entity.get("retry_at"))
        if state == _REPLICA.RETRYING
        else None,
        last_progress_time=timestamp(entity.get("progress_at")),
        notion_url=notion_url(entity.get("page_id")),
    )


def _moment(value: str) -> datetime.datetime:
    # Canonical texts drop ".000", so their lengths differ: compare as times.
    return instant(value) or datetime.datetime.min.replace(tzinfo=datetime.UTC)


def _latest(times: Sequence[str]) -> str | None:
    return max(times, key=_moment) if times else None


def replica_counts(
    target: backup_pb.ReplicaCounts_Target,
    records: Sequence[tuple[backup_pb.Replica, object]],
) -> backup_pb.ReplicaCounts:
    """Counts of one target from each record's copy and since-when time."""
    count = dict.fromkeys(_REPLICA, 0)
    for copy, _ in records:
        count[copy.state] += 1
    progress = [
        c.last_progress_time for c, _ in records if c.last_progress_time
    ]
    pending = [
        instant(since)
        for copy, since in records
        if copy.state != _REPLICA.SYNCED
    ]
    known = [moment for moment in pending if moment is not None]
    return backup_pb.ReplicaCounts(
        target=target,
        synced_count=count[_REPLICA.SYNCED],
        syncing_count=count[_REPLICA.SYNCING] + count[_REPLICA.NOT_STARTED],
        outdated_count=count[_REPLICA.OUTDATED],
        retrying_count=count[_REPLICA.RETRYING],
        unknown_count=count[_REPLICA.UNKNOWN],
        conflict_count=count[_REPLICA.CONFLICT],
        last_progress_time=_latest(progress),
        oldest_pending_time=timestamp(min(known).isoformat())
        if known
        else None,
    )


def merge_counts(
    targets: Sequence[backup_pb.ReplicaCounts],
) -> backup_pb.ReplicaCounts:
    """Every target together (the overview's backup line)."""
    progress = [t.last_progress_time for t in targets if t.last_progress_time]
    pending = [t.oldest_pending_time for t in targets if t.oldest_pending_time]
    return backup_pb.ReplicaCounts(
        synced_count=sum(t.synced_count for t in targets),
        syncing_count=sum(t.syncing_count for t in targets),
        outdated_count=sum(t.outdated_count for t in targets),
        retrying_count=sum(t.retrying_count for t in targets),
        unknown_count=sum(t.unknown_count for t in targets),
        conflict_count=sum(t.conflict_count for t in targets),
        last_progress_time=_latest(progress),
        oldest_pending_time=min(pending, key=_moment) if pending else None,
    )


def personal_digest(
    value: object, *, backup_included: bool
) -> edition_pb.PersonalDigest | None:
    """The private Todofy section (only the owner sees it)."""
    if not isinstance(value, Mapping):
        return None
    count = value.get("task_count")
    return edition_pb.PersonalDigest(
        state=DIGEST_STATES.get(
            str(value.get("state")), edition_pb.PersonalDigest_State.UNSPECIFIED
        ),
        title=text(value.get("title")),
        summary=text(value.get("summary")),
        items=tuple(
            edition_pb.PersonalItem(
                rank=int32(item.get("rank")),
                title=text(item.get("title")),
                detail=text(item.get("detail")),
            )
            for item in value.get("items") or []
            if isinstance(item, Mapping)
        ),
        task_count=int32(count) if type(count) is int else None,
        fetch_time=timestamp(value.get("fetched_at")),
        error_code=text(value.get("error_code")),
        backup_included=backup_included,
    )


def story_outcomes(
    coverage: object, plan: object, results: Mapping[str, str]
) -> list[edition_pb.StoryOutcome]:
    """What a run decided for each story it considered.

    The frozen publication's coverage, or the selected plan when nothing was
    published.
    """
    stories = coverage if isinstance(coverage, list) else []
    if stories:
        return [
            edition_pb.StoryOutcome(
                story_id=text(story.get("story_id")),
                title=text(story.get("title")),
                disposition=text(story.get("disposition")),
                reason=text(story.get("reason")),
                result=results.get(text(story.get("story_id")), ""),
            )
            for story in stories
            if isinstance(story, Mapping)
        ]
    tasks = plan if isinstance(plan, list) else []
    return [
        edition_pb.StoryOutcome(
            story_id=text(task.get("id")),
            title=text(task.get("question"), 300),
            result=results.get(text(task.get("id")), ""),
        )
        for task in tasks
        if isinstance(task, Mapping)
    ]


def edition_body(context: Row | None, draft: Row) -> dict[str, Any]:
    """The structured body and its numbered references.

    Or the draft's text without numbers when the email's numbering cannot be
    rebuilt. ``context`` is rendering.edition_context's result: the email's own
    first-appearance numbering, so ``[n]`` here is ``[n]`` in the email.
    """
    if context is None:
        sections = [
            edition_pb.EditionSection(
                kind=text(section.get("kind")),
                heading=text(section.get("heading")),
                paragraphs=tuple(
                    edition_pb.EditionParagraph(text=text(p.get("text")))
                    for p in section.get("paragraphs") or []
                ),
                limitations=text(section.get("limitations")),
            )
            for section in draft.get("sections") or []
        ]
        return {"sections": tuple(sections)}
    scopes = {}
    for packet in context["packets"]:
        for source in packet["content"].get("sources", []):
            scopes[f"{packet['id']}/{source['id']}"] = source["access_scope"]

    def numbers(references: Iterable[Row]) -> tuple[int, ...]:
        return tuple(int(ref["number"]) for ref in references)

    body: dict[str, Any] = {
        "sections": tuple(
            edition_pb.EditionSection(
                kind=section["kind"],
                heading=section["heading"],
                paragraphs=tuple(
                    edition_pb.EditionParagraph(
                        text=p["text"],
                        reference_numbers=numbers(p["references"]),
                    )
                    for p in section["paragraphs"]
                ),
                limitations="\n".join(section["limitations"]),
            )
            for section in context["sections"]
        ),
        "references": tuple(
            edition_pb.EditionReference(
                number=int(ref["number"]),
                title=text(ref["title"]),
                url=http_url(ref["url"]),
                access_scope=text(scopes.get(ref["citation"])),
                publication_date=text(ref.get("published_at")),
            )
            for ref in context["references"]
        ),
    }
    chart = context.get("chart")
    if chart:
        body["chart"] = edition_pb.EditionChart(
            kind=text(chart.get("kind")),
            question=text(chart.get("question")),
            metric=text(chart.get("metric")),
            unit=text(chart.get("unit")),
            period=text(chart.get("period")),
            caption=text(chart.get("caption")),
            alt_text=text(chart.get("alt_text")),
            limitations="\n".join(chart.get("limitations") or []),
            points=tuple(
                edition_pb.EditionChartPoint(
                    label=text(row["label"]),
                    decimal_value=text(row.get("value")),
                    missing_reason=text(row.get("missing_reason")),
                    reference_numbers=numbers(row["references"]),
                )
                for row in chart["rows"]
            ),
        )
    reading = context.get("reading")
    if reading:
        body["recommended_reading"] = edition_pb.EditionReading(
            reference_number=int(reading["reference"]["number"]),
            reason=text(reading["reason"]),
            supporting_reference_numbers=numbers(
                reading["supporting_references"]
            ),
        )
    return body


# The service, its configuration and its external interfaces.


def drain_state(state: object) -> overview_pb.ServiceState_DrainState:
    """The deployment gate in the API's words (drain.py's states)."""
    return {
        "active": overview_pb.ServiceState_DrainState.ACTIVE,
        "resumed": overview_pb.ServiceState_DrainState.ACTIVE,
        "draining": overview_pb.ServiceState_DrainState.DRAINING,
        "frozen": overview_pb.ServiceState_DrainState.FROZEN,
    }.get(str(state), overview_pb.ServiceState_DrainState.UNSPECIFIED)


def _config_time(value: object) -> datetime.datetime | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return instant(value)


def config_state(
    observed: Row | None, repository: str, now: datetime.datetime
) -> catalog_pb.ConfigState:
    """The configuration as monitoring_api.config_status reads it.

    With the state Fleet derives from the same observation (configState).
    """
    if observed is None:
        return catalog_pb.ConfigState(
            state=catalog_pb.ConfigState_State.UNOBSERVED
        )
    attempt = _config_time(observed.get("last_attempt"))
    success = _config_time(observed.get("last_success"))
    active = text(observed.get("active_revision"))
    digest = text(observed.get("active_digest"))
    wanted = text(observed.get("wanted_revision"))
    wanted_digest = text(observed.get("wanted_digest"))
    pinned = text(observed.get("pinned_digest"))
    error = text(observed.get("error"))
    state = catalog_pb.ConfigState_State
    if error:
        current = state.FAILED
    elif attempt is None or attempt > now + CONFIG_FUTURE:
        current = state.UNOBSERVED
    elif now - attempt > CONFIG_STALE:
        current = state.STALE
    elif not active or not digest:
        current = state.UNOBSERVED
    elif pinned:
        current = state.PINNED if digest == pinned else state.PENDING
    elif not wanted or not wanted_digest:
        current = state.UNOBSERVED
    elif active == wanted and digest == wanted_digest:
        current = state.CURRENT
    else:
        current = state.PENDING
    return catalog_pb.ConfigState(
        active_revision=active,
        active_digest=digest,
        pinned=bool(pinned),
        wanted_revision=wanted,
        last_sync_attempt_time=timestamp(attempt.isoformat())
        if attempt
        else None,
        last_sync_success_time=timestamp(success.isoformat())
        if success
        else None,
        sync_error_code=error,
        revision_url=f"https://github.com/{repository}/commit/{active}"
        if repository and _COMMIT.fullmatch(active)
        else "",
        state=current,
        wanted_digest=wanted_digest,
        wanted_commit=text(observed.get("wanted_commit")),
        pinned_digest=pinned,
    )


def _dependency(
    kind: run_pb.Dependency_Kind,
    *,
    calls: int,
    failed: int,
    unknown: int = 0,
    last: object = None,
    error_code: str = "",
    disabled: bool = False,
) -> run_pb.Dependency:
    if disabled:
        state = _DEPENDENCY.DISABLED
    elif unknown:
        state = _DEPENDENCY.UNKNOWN
    elif failed and failed >= calls:
        state = _DEPENDENCY.FAILED
    elif failed:
        state = _DEPENDENCY.ATTENTION
    else:
        state = _DEPENDENCY.OK
    return run_pb.Dependency(
        kind=kind,
        state=state,
        call_count=int32(calls),
        failed_count=int32(failed),
        last_call_time=timestamp(last),
        error_code=error_code,
    )


def _feeds_dependency(
    run: Row | None,
    feeds: Sequence[run_pb.SourceOutcome],
    diagnostics: Sequence[object],
) -> run_pb.Dependency:
    kind = run_pb.Dependency_Kind.FEEDS
    last = run.get("feeds_finished_at") if run else None
    if "registry:absent" in diagnostics:
        return _dependency(kind, calls=0, failed=0, disabled=True)
    if "registry:invalid" in diagnostics:
        return _dependency(
            kind, calls=1, failed=1, last=last, error_code="registry_invalid"
        )
    failures = [o.code for o in feeds if o.code != "ok"]
    return _dependency(
        kind,
        calls=len(feeds),
        failed=len(failures),
        last=last,
        error_code=failures[0] if failures else "",
    )


def _calls_dependency(
    run: Row | None, calls: Sequence[tuple[str, Row]]
) -> run_pb.Dependency:
    records = [record for _, record in calls]
    failed = [r for r in records if r.get("status") == "failed"]
    # A call still running in an ended run was cut off: its outcome is
    # unknown.
    ended = run is not None and run.get("state") in _ENDED
    times = [
        moment
        for r in records
        if (moment := instant(r.get("finished_at") or r.get("update_time")))
    ]
    return _dependency(
        run_pb.Dependency_Kind.MODEL_ROUTER,
        calls=len(records),
        failed=len(failed),
        unknown=sum(ended and r.get("status") == "running" for r in records),
        last=max(times).isoformat() if times else None,
        error_code=text(failed[-1].get("failure")) if failed else "",
    )


def _todofy_dependency(edition: Row | None, enabled: bool) -> run_pb.Dependency:
    kind = run_pb.Dependency_Kind.TODOFY
    digest = edition.get("personal_digest") if edition else None
    if not isinstance(digest, Mapping):
        return _dependency(kind, calls=0, failed=0, disabled=not enabled)
    if digest.get("state") == "disabled":
        return _dependency(kind, calls=0, failed=0, disabled=True)
    unavailable = digest.get("state") == "unavailable"
    return _dependency(
        kind,
        calls=1,
        failed=int(unavailable),
        last=digest.get("fetched_at"),
        error_code=text(digest.get("error_code")) if unavailable else "",
    )


def _mail_dependency(edition: Row | None) -> run_pb.Dependency:
    kind = run_pb.Dependency_Kind.MAIL
    sent = edition.get("delivery_state") if edition else None
    if edition is None or sent in {None, "not_requested"}:
        return _dependency(kind, calls=0, failed=0)
    if sent == "submitting":
        return run_pb.Dependency(
            kind=kind,
            state=_DEPENDENCY.ATTENTION,
            call_count=1,
            last_call_time=timestamp(edition.get("updated_at")),
        )
    return _dependency(
        kind,
        calls=1,
        failed=int(sent == "rejected"),
        unknown=int(sent == "unknown"),
        last=edition.get("updated_at"),
        error_code=text(edition.get("error_code"))
        if sent in {"rejected", "unknown"}
        else "",
    )


def _backup_dependency(
    backup: backup_pb.ReplicaCounts | None, error_code: str
) -> run_pb.Dependency:
    kind = run_pb.Dependency_Kind.NOTION_BACKUP
    if backup is None:
        return _dependency(kind, calls=0, failed=0, disabled=True)
    attention = backup.retrying_count + backup.conflict_count
    if backup.unknown_count:
        state = _DEPENDENCY.UNKNOWN
    elif attention:
        state = _DEPENDENCY.ATTENTION
    else:
        state = _DEPENDENCY.OK
    return run_pb.Dependency(
        kind=kind,
        state=state,
        call_count=int32(
            backup.synced_count
            + backup.syncing_count
            + backup.outdated_count
            + attention
            + backup.unknown_count
        ),
        failed_count=int32(attention + backup.unknown_count),
        last_call_time=backup.last_progress_time,
        error_code=error_code,
    )


def dependencies(
    *,
    run: Row | None,
    feeds: Sequence[run_pb.SourceOutcome],
    feed_diagnostics: object,
    calls: Sequence[tuple[str, Row]],
    edition: Row | None,
    todofy_enabled: bool,
    backup: backup_pb.ReplicaCounts | None,
    backup_error: str,
) -> list[run_pb.Dependency]:
    """The five external interfaces, in ``Dependency.Kind`` order.

    A run's feeds, model calls, Todofy fetch and mail, then the Notion backup:
    an asynchronous copy of the record, so its state is the journal's, and
    ``backup`` is None when it is off. An interface the run did not call has
    no calls; one that is turned off is DISABLED.
    """
    diagnostics = feed_diagnostics if isinstance(feed_diagnostics, list) else []
    return [
        _feeds_dependency(run, feeds, diagnostics),
        _calls_dependency(run, calls),
        _todofy_dependency(edition, todofy_enabled),
        _mail_dependency(edition),
        _backup_dependency(backup, backup_error),
    ]
