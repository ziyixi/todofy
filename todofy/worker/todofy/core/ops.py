"""ops-v1 rules for Todofy (contracts/ops-v1, proto/ops/v1/ops.proto): inputs, guard and status signals.

Pure stdlib, host-tested. Every answer that leaves the app through the ``Ops`` entrypoint is a generated message
(``ziyixi_proto.ops.v1``) written with the wire codec, which checks the contract's value rules before a byte leaves:
names are codes, metrics and counters numbers, URLs plain https ones, so a status can never carry mail content.
Inputs are read strictly with the same rules (``from_wire``). What the IDL cannot say stays here: a guard's ``until``
within 36 hours. The answers are plain dicts (``to_wire``), the JSON the dashboard reads; tests pin their bytes
(tests/unit/test_ops_golden.py). Todofy implements no OpsDigestService since 2026-10-21: Home sends the daily
reminder itself.
"""

import json
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, NoReturn

from ziyixi_proto.ops.v1 import ops_pb as pb
from ziyixi_proto.wire_json import (
    WireJsonError,
    field_rules,
    format_matches,
    from_wire,
    to_wire,
    wire_member,
    wire_name,
)

VERSION = "ops-v1"
APP = "todofy"
CAPABILITIES = ("canary_consumer", "guard")

# OPS_LIMITS of contracts/ops-v1/ops-v1.ts: the rule relative to a clock, which the IDL cannot hold.
GUARD_MAX_AHEAD = 36 * 3600
# The largest input read (a guard input is a few hundred bytes).
MAX_INPUT_CHARS = 32 * 1024
# The contract's bounds, read where proto/ops/v1/ops.proto states them.
MAX_SIGNALS = field_rules(pb.OpsStatus, "signals").max_items
MAX_METRICS = field_rules(pb.Signal, "metrics").max_items


def _wire_enum(name: str, cls: Any, doc: str) -> Any:
    """A StrEnum of a generated enum's wire names (member INFO is "info"), for code that keeps wire JSON as dicts."""
    enum = StrEnum(name, [(member.name, wire_name(member)) for member in cls if member != 0])
    enum.__doc__ = doc
    return enum


# The message of the Error an Ops method rejects with (ops.v1.ErrorCode): invalid_input, busy, unavailable.
OpsError = _wire_enum(
    "OpsError", pb.ErrorCode, "The message of the Error an Ops method rejects with (ops.v1.ErrorCode)."
)


class InvalidInput(ValueError):
    """An input the contract's rules or a bound reject: the caller must not retry it unchanged."""


# A signal's severity by wire name (ops.v1.Severity): info, warning, critical.
Severity = _wire_enum("Severity", pb.Severity, "A signal's severity (ops.v1.Severity).")
SEVERITY_RANK = {Severity.CRITICAL: 0, Severity.WARNING: 1, Severity.INFO: 2}


class Job(StrEnum):
    """Background jobs a shed guard defers (IMPLEMENTATION.md §3.7), with their bounds."""

    WEEKLY_BACKUP = "weekly_backup"
    RETENTION = "retention"
    METRICS_ROLLUP = "metrics_rollup"


DEFERRED = (Job.WEEKLY_BACKUP, Job.RETENTION, Job.METRICS_ROLLUP)
# A deferred job still runs once its last run is this old, however long the guard is renewed.
JOB_BOUND = {Job.RETENTION: 72 * 3600, Job.METRICS_ROLLUP: 72 * 3600}
# status() reports backup_stale (critical) once the last complete backup is older than this.
BACKUP_STALE = 8 * 86400
# A held backup starts anyway once the last complete one is this old (or there is none): 12 h
# after its weekly slot and 12 h before backup_stale, so a renewed shed guard never makes its own
# weekly backup late enough to raise a critical signal (a job takes about a minute).
BACKUP_BOUND = 7 * 86400 + 12 * 3600
DUE_BACKLOG = 3600


def _invalid() -> NoReturn:
    raise InvalidInput(OpsError.INVALID_INPUT)


def is_code(value: Any) -> bool:
    """Whether ``value`` is an ops-v1 ``Code`` (the contract's format): a name this app writes without choosing it."""
    return isinstance(value, str) and format_matches(pb.FORMATS["Code"], value)


def _read(cls: type, value: Any) -> Any:
    """An input message read strictly with the contract's rules; anything else is invalid input."""
    try:
        return from_wire(cls, value, strict=True).message
    except WireJsonError:
        _invalid()


# ---- time ------------------------------------------------------------------------------


def parse_timestamp_ms(value: Any) -> int:
    """Epoch ms of an ops-v1 Timestamp (UTC, ``Z``, up to milliseconds)."""
    if not isinstance(value, str) or not format_matches(pb.FORMATS["Timestamp"], value):
        _invalid()
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _invalid()
    return round(moment.timestamp() * 1000)


def timestamp(seconds: int) -> str:
    """An ops-v1 Timestamp of Unix seconds (whole seconds, ``Z``, as Todofy's API writes them)."""
    t = datetime.fromtimestamp(seconds, UTC)
    return f"{t.year:04d}-{t.month:02d}-{t.day:02d}T{t.hour:02d}:{t.minute:02d}:{t.second:02d}Z"


def timestamp_ms(ms: int) -> str:
    """Like ``timestamp``, with milliseconds only when there are any (an input's own precision)."""
    seconds, rest = divmod(ms, 1000)
    whole = timestamp(seconds)
    return whole if rest == 0 else f"{whole[:-1]}.{rest:03d}Z"


def loads(text: Any) -> Any:
    """Strict JSON: no NaN/Infinity, no huge or unparsable input."""
    if not isinstance(text, str) or len(text) > MAX_INPUT_CHARS:
        _invalid()
    try:
        return json.loads(text, parse_constant=lambda name: _invalid())
    except (ValueError, RecursionError):
        _invalid()


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ---- inputs ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GuardInput:
    level: str  # normal | shed
    reason: str
    until_ms: int | None


def guard_input(value: Any, now_ms: int) -> GuardInput:
    """SetGuardInput (the contract's rules: shed has ``until``, normal has it null), then the clock: ``until`` in
    (now, now + 36 h]."""
    wanted = _read(pb.SetGuardInput, value)
    if wanted.level == pb.GuardLevel.NORMAL:
        return GuardInput("normal", wanted.reason, None)
    until = parse_timestamp_ms(wanted.until)
    if not now_ms < until <= now_ms + GUARD_MAX_AHEAD * 1000:
        _invalid()
    return GuardInput("shed", wanted.reason, until)


def event_id(value: Any) -> str:
    """The event ID of ``canaryResult(eventId)`` (its request's positional field), read with the contract's rules."""
    return _read(pb.CanaryResultRequest, {"event_id": value}).event_id


# ---- guard -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Guard:
    """The stored guard (epoch ms); None fields for a normal guard."""

    level: str
    reason: str | None
    until_ms: int | None
    set_ms: int | None

    def shed(self, now_ms: int) -> bool:
        return self.level == "shed" and self.until_ms is not None and now_ms < self.until_ms


NORMAL = Guard("normal", None, None, None)


def guard_state(guard: Guard, now_ms: int) -> dict[str, Any]:
    """GuardState: an expired or normal guard reads as normal with nulls."""
    return to_wire(guard_message(guard, now_ms))


def guard_message(guard: Guard, now_ms: int) -> pb.GuardState:
    """The effective guard as a message (shed only while now < until)."""
    if not guard.shed(now_ms):
        return pb.GuardState(level=pb.GuardLevel.NORMAL)
    assert guard.until_ms is not None and guard.set_ms is not None
    return pb.GuardState(
        level=pb.GuardLevel.SHED,
        reason=guard.reason,
        until=timestamp_ms(guard.until_ms),
        set_at=timestamp_ms(guard.set_ms),
        deferred=tuple(str(job) for job in DEFERRED),
    )


def defer_until(guard: Guard, now: int, last_run: int | None, bound: int) -> int | None:
    """When to reconsider a deferred job (Unix seconds), or None to run it now.

    Shed defers a job only while it ran within ``bound``; it then waits until the guard ends
    or the bound is reached, whichever comes first, so a guard renewed forever cannot starve it.
    """
    if not guard.shed(now * 1000) or last_run is None or now - last_run >= bound:
        return None
    assert guard.until_ms is not None
    return min(math.ceil(guard.until_ms / 1000), last_run + bound)


def completed_run(finished: bool, next_at: int, now: int, continue_after: int) -> bool:
    """Whether a deferrable job's run restarts its bound: it finished without an error and did not
    schedule itself to continue within ``continue_after`` (one batch of a larger backlog). So the
    bound covers the whole job: once due, it keeps its normal cadence until it has caught up."""
    return finished and next_at > now + continue_after


# ---- canary result ---------------------------------------------------------------------


def canary_result(
    row: Mapping[str, Any] | None, *, maintenance: bool, processing_paused: bool, backup_active: bool
) -> dict[str, Any]:
    """CanaryResult of one ledger row (``state``, ``last_error_code``, ``updated_at``, ``canary_run_id``)."""
    state = pb.CanaryResult_State
    if row is None or row["canary_run_id"] is None:
        return to_wire(pb.CanaryResult(state=state.NOT_SEEN))
    status, code = row["state"], row["last_error_code"] or ""
    if status in ("pending", "summarizing"):
        waiting = None
        if maintenance:
            waiting = "maintenance"
        elif processing_paused:
            waiting = "processing_paused"
        elif backup_active:
            waiting = "backup_active"
        elif code:
            waiting = "retry_wait"
        return to_wire(pb.CanaryResult(state=state.PROCESSING, waiting_code=waiting))
    completed = timestamp(int(row["updated_at"]))
    if status == "complete":
        return to_wire(pb.CanaryResult(state=state.OK, completed_at=completed))
    if status == "ignored" and is_code(code):
        return to_wire(pb.CanaryResult(state=state.FAILED, completed_at=completed, error_code=code))
    # Only a release without canary handling moves a canary anywhere else.
    return to_wire(pb.CanaryResult(state=state.FAILED, completed_at=completed, error_code="canary_side_effect_blocked"))


# ---- status ----------------------------------------------------------------------------


def signal(code: str, severity: Severity, **metrics: int | float) -> pb.Signal:
    """One active condition, its metrics in the order given (the contract keeps it)."""
    return pb.Signal(code=code, severity=wire_member(pb.Severity, str(severity)), metrics=metrics)


def _rank(signal: pb.Signal) -> int:
    return SEVERITY_RANK[Severity(wire_name(signal.severity))]


def ordered(signals: Iterable[pb.Signal]) -> list[pb.Signal]:
    """Critical first, then by code; at most MAX_SIGNALS."""
    return sorted(signals, key=lambda s: (_rank(s), s.code))[:MAX_SIGNALS]


def health(signals: Sequence[pb.Signal], maintenance: bool) -> pb.Health:
    if maintenance:
        return pb.Health.DOWN
    return pb.Health.DEGRADED if any(s.severity != pb.Severity.INFO for s in signals) else pb.Health.OK


def percent(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole > 0 else 100.0


def ui_url(public_host: str) -> str | None:
    """The owner UI's URL, ``https://<host>/``, when the host is a plain name (no path) and the URL keeps the
    contract's ``HttpsUrl`` format (the IDL's, the one definition); else None."""
    host = public_host.strip().lower()
    url = f"https://{host}/"
    return url if "/" not in host and format_matches(pb.FORMATS["HttpsUrl"], url) else None


@dataclass(frozen=True, slots=True)
class Facts:
    """What status() reads: D1 counts, the object's budgets, backup state and guard."""

    now: int
    maintenance: bool
    processing_paused: bool
    active_events: int
    attention_events: int
    received_24h: int
    oldest_due_at: int | None
    # Mail still awaiting a decision that arrived 1 to 14 days ago: the morning brief's carryover pool.
    carryover_open: int
    gemini_used: int
    gemini_reserved: int
    gemini_budget: int
    gemini_calls: int
    backup_bound: bool  # the BACKUPS binding exists
    backup_active: bool
    backup_status: str  # never | ok | failed | running | disabled
    last_backup_at: int | None
    guard: Guard
    public_host: str


def status(facts: Facts) -> dict[str, Any]:
    """OpsStatus from ``facts``; only numbers, booleans, codes and timestamps (the codec checks every rule)."""
    now = facts.now
    signals: list[pb.Signal] = []
    if facts.maintenance:
        signals.append(signal("maintenance_mode", Severity.CRITICAL))
    if facts.processing_paused:
        signals.append(signal("processing_paused", Severity.WARNING))
    if facts.attention_events > 0:
        signals.append(signal("attention", Severity.WARNING, count=facts.attention_events))
    oldest_age = max(now - facts.oldest_due_at, 0) if facts.oldest_due_at is not None else 0
    if oldest_age >= DUE_BACKLOG:
        signals.append(signal("due_backlog", Severity.WARNING, oldest_age_seconds=oldest_age))
    spent = facts.gemini_used + facts.gemini_reserved
    share = percent(spent, facts.gemini_budget)
    if share >= 80:
        signals.append(
            signal(
                "gemini_budget_95" if share >= 95 else "gemini_budget_80",
                Severity.CRITICAL if share >= 95 else Severity.WARNING,
                percent=share,
                used_tokens=facts.gemini_used,
                reserved_tokens=facts.gemini_reserved,
                budget_tokens=facts.gemini_budget,
            )
        )
    backup_age = None if facts.last_backup_at is None else max(now - facts.last_backup_at, 0)
    if not facts.backup_bound:
        signals.append(signal("backup_disabled", Severity.INFO))
    else:
        if backup_age is None:
            signals.append(signal("backup_stale", Severity.CRITICAL, has_backup=0))
        elif backup_age > BACKUP_STALE:
            signals.append(signal("backup_stale", Severity.CRITICAL, age_seconds=backup_age, has_backup=1))
        if facts.backup_status == "failed":
            signals.append(signal("backup_failed", Severity.WARNING))
        if facts.backup_active:
            signals.append(signal("backup_active", Severity.INFO))
    if facts.guard.shed(now * 1000):
        assert facts.guard.until_ms is not None
        signals.append(signal("guard_shed", Severity.INFO, seconds_left=max(facts.guard.until_ms // 1000 - now, 0)))
    signals = ordered(signals)
    counters = {
        "active_events": facts.active_events,
        "attention_events": facts.attention_events,
        "received_24h": facts.received_24h,
        "oldest_due_age_seconds": oldest_age,
        "gemini_used_tokens": facts.gemini_used,
        "gemini_reserved_tokens": facts.gemini_reserved,
        "gemini_token_budget": facts.gemini_budget,
        "gemini_calls": facts.gemini_calls,
        "carryover_open": facts.carryover_open,
    }
    if backup_age is not None:
        counters["backup_age_seconds"] = backup_age
    return to_wire(
        pb.OpsStatus(
            version=VERSION,
            app=APP,
            generated_at=timestamp(now),
            health=health(signals, facts.maintenance),
            modes=modes(facts, facts.backup_active),
            guard=guard_message(facts.guard, now * 1000),
            signals=tuple(signals),
            counters=counters,
            last_backup_at=None if facts.last_backup_at is None else timestamp(facts.last_backup_at),
            ui_url=ui_url(facts.public_host),
            capabilities=CAPABILITIES,
        )
    )


def modes(facts: Any, backup_active: bool | None) -> dict[str, bool]:
    """The switches; ``backup_active`` None when it could not be read (left out)."""
    result = {"maintenance": facts.maintenance, "processing_paused": facts.processing_paused}
    if backup_active is not None:
        result["backup_active"] = backup_active
    return result


@dataclass(frozen=True, slots=True)
class Switches:
    maintenance: bool
    processing_paused: bool


def unavailable_status(now: int, switches: Switches, guard: Guard, public_host: str) -> dict[str, Any]:
    """The status when the snapshot could not be read: down, one signal, no counters."""
    return to_wire(
        pb.OpsStatus(
            version=VERSION,
            app=APP,
            generated_at=timestamp(now),
            health=pb.Health.DOWN,
            modes=modes(switches, None),
            guard=guard_message(guard, now * 1000),
            signals=(signal("status_unavailable", Severity.CRITICAL),),
            ui_url=ui_url(public_host),
            capabilities=CAPABILITIES,
        )
    )
