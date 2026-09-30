"""ops-v1 rules for Todofy (contracts/ops-v1): input checks, guard, status signals, digest items.

Pure stdlib, host-tested. Everything that leaves the app through the ``Ops`` entrypoint is built
here from numbers, booleans, timestamps and closed codes only, so a status or receipt can never
carry mail content (tests validate every value against contracts/ops-v1/ops-v1.schema.json).
Patterns use ``fullmatch`` and ``[0-9]``: ``$`` would accept a trailing newline, ``\\d`` other
scripts' digits.
"""

import json
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, NoReturn

VERSION = "ops-v1"
APP = "todofy"
CAPABILITIES = ("canary_consumer", "guard", "ops_digest")

# OPS_LIMITS of contracts/ops-v1/ops-v1.ts.
GUARD_MAX_AHEAD = 36 * 3600
DIGEST_WINDOW = 36 * 3600
REPORT_FUTURE_SKEW = 300
REPORT_MAX_ITEMS = 20
REPORT_MAX_BYTES = 8192
MAX_SIGNALS = 16
MAX_METRICS = 12

CODE = re.compile(r"[a-z][a-z0-9_]{0,47}", re.ASCII)
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", re.ASCII)
EVENT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.ASCII)
TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z", re.ASCII)
SOURCE = re.compile(r"[a-z][a-z0-9-]{0,31}", re.ASCII)
HTTPS_URL = re.compile(r"https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?/[A-Za-z0-9._~/-]{0,200}", re.ASCII)
HOST = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?", re.ASCII)
MAX_URL_CHARS = 300


class OpsError(StrEnum):
    """The message of the Error an Ops method rejects with (OpsErrorCode)."""

    INVALID_INPUT = "invalid_input"
    BUSY = "busy"
    UNAVAILABLE = "unavailable"


class InvalidInput(ValueError):
    """An input the schema or a bound rejects: the caller must not retry it unchanged."""


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


SEVERITY_RANK = {Severity.CRITICAL: 0, Severity.WARNING: 1, Severity.INFO: 2}


class Job(StrEnum):
    """Background jobs a shed guard defers (IMPLEMENTATION.md §3.7), with their bounds."""

    WEEKLY_BACKUP = "weekly_backup"
    RETENTION = "retention"
    METRICS_ROLLUP = "metrics_rollup"
    # The GTD ledger's daily Todoist snapshot (docs/gtd-features.md): a few hundred D1 rows written.
    GTD_SNAPSHOT = "gtd_snapshot"


DEFERRED = (Job.WEEKLY_BACKUP, Job.RETENTION, Job.METRICS_ROLLUP, Job.GTD_SNAPSHOT)
# A deferred job still runs once its last run is this old, however long the guard is renewed.
JOB_BOUND = {Job.RETENTION: 72 * 3600, Job.METRICS_ROLLUP: 72 * 3600, Job.GTD_SNAPSHOT: 48 * 3600}
# status() reports backup_stale (critical) once the last complete backup is older than this.
BACKUP_STALE = 8 * 86400
# A held backup starts anyway once the last complete one is this old (or there is none): 12 h
# after its weekly slot and 12 h before backup_stale, so a renewed shed guard never makes its own
# weekly backup late enough to raise a critical signal (a job takes about a minute).
BACKUP_BOUND = 7 * 86400 + 12 * 3600
DUE_BACKLOG = 3600
# The GTD counters status() passes on (core/gtd.py status_counters), plus review_age_days.
GTD_COUNTERS = ("inbox_open", "inbox_oldest_days", "overdue", "carryover_open", "completed_7d")


def _invalid() -> NoReturn:
    raise InvalidInput(OpsError.INVALID_INPUT)


# ---- time ------------------------------------------------------------------------------


def parse_timestamp_ms(value: Any) -> int:
    """Epoch ms of an ops-v1 Timestamp (UTC, ``Z``, up to milliseconds)."""
    if not isinstance(value, str) or not TIMESTAMP.fullmatch(value):
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
    if not isinstance(text, str) or len(text) > 4 * REPORT_MAX_BYTES:
        _invalid()
    try:
        return json.loads(text, parse_constant=lambda name: _invalid())
    except (ValueError, RecursionError):
        _invalid()


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ---- inputs ----------------------------------------------------------------------------


def _code(value: Any) -> str:
    if not isinstance(value, str) or not CODE.fullmatch(value):
        _invalid()
    return value


def _number(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        _invalid()
    if isinstance(value, float) and not math.isfinite(value):
        _invalid()
    return value


def _metrics(value: Any) -> dict[str, int | float]:
    if not isinstance(value, dict) or len(value) > MAX_METRICS:
        _invalid()
    return {_code(name): _number(number) for name, number in value.items()}


def _exact_keys(value: Any, required: set[str], optional: frozenset[str] = frozenset()) -> dict[str, Any]:
    if not isinstance(value, dict) or not required <= value.keys() <= required | optional:
        _invalid()
    return value


@dataclass(frozen=True, slots=True)
class GuardInput:
    level: str  # normal | shed
    reason: str
    until_ms: int | None


def guard_input(value: Any, now_ms: int) -> GuardInput:
    """SetGuardInput: shed needs ``until`` in (now, now + 36 h]; normal needs ``until`` null."""
    doc = _exact_keys(value, {"level", "reason", "until"})
    reason = _code(doc["reason"])
    match doc["level"]:
        case "normal":
            if doc["until"] is not None:
                _invalid()
            return GuardInput("normal", reason, None)
        case "shed":
            until = parse_timestamp_ms(doc["until"])
            if not now_ms < until <= now_ms + GUARD_MAX_AHEAD * 1000:
                _invalid()
            return GuardInput("shed", reason, until)
    _invalid()


def event_id(value: Any) -> str:
    if not isinstance(value, str) or not EVENT_ID.fullmatch(value):
        _invalid()
    return value


def run_id(value: Any) -> bool:
    return isinstance(value, str) and RUN_ID.fullmatch(value) is not None


@dataclass(frozen=True, slots=True)
class Report:
    """A validated OpsReport; ``doc`` is its compact JSON as stored."""

    generated_ms: int
    items: tuple[dict[str, Any], ...]
    dashboard_url: str | None
    doc: str


def _url(value: Any) -> str:
    if not isinstance(value, str) or len(value) > MAX_URL_CHARS or not HTTPS_URL.fullmatch(value):
        _invalid()
    return value


def _item(value: Any) -> dict[str, Any]:
    doc = _exact_keys(value, {"source", "code", "severity", "since", "metrics"})
    if not isinstance(doc["source"], str) or not SOURCE.fullmatch(doc["source"]):
        _invalid()
    if doc["severity"] not in set(Severity):
        _invalid()
    parse_timestamp_ms(doc["since"])
    return {
        "source": doc["source"],
        "code": _code(doc["code"]),
        "severity": doc["severity"],
        "since": doc["since"],
        "metrics": _metrics(doc["metrics"]),
    }


def report(value: Any, now: int) -> Report:
    """OpsReport: at most 20 items and 8 KiB of compact JSON, generated at most 5 minutes ahead."""
    doc = _exact_keys(value, {"generated_at", "items"}, frozenset({"dashboard_url"}))
    generated = parse_timestamp_ms(doc["generated_at"])
    if generated > (now + REPORT_FUTURE_SKEW) * 1000:
        _invalid()
    if not isinstance(doc["items"], list) or len(doc["items"]) > REPORT_MAX_ITEMS:
        _invalid()
    items = tuple(_item(item) for item in doc["items"])
    url = _url(doc["dashboard_url"]) if "dashboard_url" in doc else None
    stored: dict[str, Any] = {"generated_at": doc["generated_at"], "items": list(items)}
    if url is not None:
        stored["dashboard_url"] = url
    text = compact(stored)
    if len(text.encode()) > REPORT_MAX_BYTES:
        _invalid()
    return Report(generated, items, url, text)


def stored_report(doc: str) -> Report | None:
    """A report as stored by ``report``; None if it no longer reads (then it is ignored)."""
    try:
        value = json.loads(doc)
        return report(value, (parse_timestamp_ms(value["generated_at"]) // 1000) + REPORT_FUTURE_SKEW)
    except (InvalidInput, ValueError, TypeError, KeyError):
        return None


def receipt(stored: bool, kept: Report) -> dict[str, Any]:
    """OpsReportReceipt describing ``kept``, the report stored after the call."""
    return {"stored": stored, "generated_at": timestamp_ms(kept.generated_ms), "item_count": len(kept.items)}


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
    if not guard.shed(now_ms):
        return {"level": "normal", "reason": None, "until": None, "set_at": None, "deferred": []}
    assert guard.until_ms is not None and guard.set_ms is not None
    return {
        "level": "shed",
        "reason": guard.reason,
        "until": timestamp_ms(guard.until_ms),
        "set_at": timestamp_ms(guard.set_ms),
        "deferred": [str(job) for job in DEFERRED],
    }


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
    if row is None or row["canary_run_id"] is None:
        return {"state": "not_seen"}
    state, code = row["state"], row["last_error_code"] or ""
    if state in ("pending", "summarizing"):
        result: dict[str, Any] = {"state": "processing"}
        if maintenance:
            result["waiting_code"] = "maintenance"
        elif processing_paused:
            result["waiting_code"] = "processing_paused"
        elif backup_active:
            result["waiting_code"] = "backup_active"
        elif code:
            result["waiting_code"] = "retry_wait"
        return result
    completed = timestamp(int(row["updated_at"]))
    if state == "complete":
        return {"state": "ok", "completed_at": completed}
    if state == "ignored" and CODE.fullmatch(code):
        return {"state": "failed", "completed_at": completed, "error_code": code}
    # Only a release without canary handling moves a canary anywhere else.
    return {"state": "failed", "completed_at": completed, "error_code": "canary_side_effect_blocked"}


# ---- status ----------------------------------------------------------------------------


def signal(code: str, severity: Severity, **metrics: int | float) -> dict[str, Any]:
    return {"code": code, "severity": str(severity), "metrics": metrics}


def ordered(signals: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Critical first, then by code; at most MAX_SIGNALS."""
    return sorted(signals, key=lambda s: (SEVERITY_RANK[Severity(s["severity"])], s["code"]))[:MAX_SIGNALS]


def health(signals: Sequence[dict[str, Any]], maintenance: bool) -> str:
    if maintenance:
        return "down"
    return "degraded" if any(s["severity"] != Severity.INFO for s in signals) else "ok"


def percent(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole > 0 else 100.0


def ui_url(public_host: str) -> str | None:
    host = public_host.strip().lower()
    return f"https://{host}/" if HOST.fullmatch(host) and not host.startswith(".") else None


@dataclass(frozen=True, slots=True)
class Facts:
    """What status() reads: D1 counts, the object's budgets, backup state and guard."""

    now: int
    maintenance: bool
    processing_paused: bool
    force_pause_todoist: bool
    reminder_enabled: bool
    active_events: int
    attention_events: int
    received_24h: int
    oldest_due_at: int | None
    reminder_state: str | None  # today's mail_reminders row, if any
    reminder_attempts: int
    reminder_retries_left: bool
    gemini_used: int
    gemini_reserved: int
    gemini_budget: int
    gemini_calls: int
    todoist_blocked_until: int
    todoist_window_calls: int
    todoist_window_limit: int
    backup_bound: bool  # the BACKUPS binding exists
    backup_active: bool
    backup_status: str  # never | ok | failed | running | disabled
    last_backup_at: int | None
    guard: Guard
    public_host: str
    # The GTD ledger (docs/gtd-features.md §8), from the object's storage: the latest complete
    # aggregate's counters, how long the snapshot has been stale (None: it is not), and the days since
    # the last review (None: no review yet) while the weekly review is enabled and the daily snapshot
    # runs (core/gtd.py review_watched: only its completed list sees a review done).
    gtd_counters: Mapping[str, int] = field(default_factory=dict)
    gtd_stale_seconds: int | None = None
    review_enabled: bool = False
    review_age_days: int | None = None
    # task-intent-v1: intents still being created, and intents failed within 7 days.
    intents_pending: int = 0
    intents_failed_7d: int = 0


# review_overdue: the weekly review has not been done for this many days.
REVIEW_OVERDUE_DAYS = 10


def status(facts: Facts) -> dict[str, Any]:
    """OpsStatus from ``facts``; only numbers, booleans, codes and timestamps."""
    now = facts.now
    signals: list[dict[str, Any]] = []
    if facts.maintenance:
        signals.append(signal("maintenance_mode", Severity.CRITICAL))
    if facts.processing_paused:
        signals.append(signal("processing_paused", Severity.WARNING))
    if facts.force_pause_todoist:
        signals.append(signal("todoist_paused", Severity.WARNING))
    if not facts.reminder_enabled:
        signals.append(signal("reminder_disabled", Severity.INFO))
    if facts.attention_events > 0:
        signals.append(signal("attention", Severity.WARNING, count=facts.attention_events))
    oldest_age = max(now - facts.oldest_due_at, 0) if facts.oldest_due_at is not None else 0
    if oldest_age >= DUE_BACKLOG:
        signals.append(signal("due_backlog", Severity.WARNING, oldest_age_seconds=oldest_age))
    if facts.todoist_blocked_until > now:
        signals.append(signal("todoist_blocked", Severity.CRITICAL, seconds_left=facts.todoist_blocked_until - now))
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
    if facts.reminder_state == "unknown" or (facts.reminder_state == "failed" and not facts.reminder_retries_left):
        signals.append(signal("reminder_failed", Severity.WARNING, attempts=facts.reminder_attempts))
    if facts.guard.shed(now * 1000):
        assert facts.guard.until_ms is not None
        signals.append(signal("guard_shed", Severity.INFO, seconds_left=max(facts.guard.until_ms // 1000 - now, 0)))
    if facts.gtd_stale_seconds is not None:
        signals.append(signal("gtd_snapshot_stale", Severity.WARNING, age_hours=facts.gtd_stale_seconds // 3600))
    # Info on purpose: a skipped personal review never makes the tile degraded or enters the digest;
    # the Sunday task itself is the nudge.
    if facts.review_enabled and facts.review_age_days is not None and facts.review_age_days > REVIEW_OVERDUE_DAYS:
        signals.append(signal("review_overdue", Severity.INFO, days=facts.review_age_days))
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
        "todoist_window_calls": facts.todoist_window_calls,
        "todoist_window_limit": facts.todoist_window_limit,
        "intents_pending": facts.intents_pending,
        "intents_failed_7d": facts.intents_failed_7d,
    }
    if backup_age is not None:
        counters["backup_age_seconds"] = backup_age
    counters |= {name: int(value) for name, value in facts.gtd_counters.items() if name in GTD_COUNTERS}
    if facts.review_age_days is not None:
        counters["review_age_days"] = facts.review_age_days
    return {
        "version": VERSION,
        "app": APP,
        "generated_at": timestamp(now),
        "health": health(signals, facts.maintenance),
        "modes": modes(facts, facts.backup_active),
        "guard": guard_state(facts.guard, now * 1000),
        "signals": signals,
        "counters": counters,
        "last_backup_at": None if facts.last_backup_at is None else timestamp(facts.last_backup_at),
        "ui_url": ui_url(facts.public_host),
        "capabilities": list(CAPABILITIES),
    }


def modes(facts: Any, backup_active: bool | None) -> dict[str, bool]:
    """The switches; ``backup_active`` None when it could not be read (left out)."""
    result = {
        "maintenance": facts.maintenance,
        "processing_paused": facts.processing_paused,
        "force_pause_todoist": facts.force_pause_todoist,
        "reminder_enabled": facts.reminder_enabled,
    }
    if backup_active is not None:
        result["backup_active"] = backup_active
    return result


@dataclass(frozen=True, slots=True)
class Switches:
    maintenance: bool
    processing_paused: bool
    force_pause_todoist: bool
    reminder_enabled: bool


def unavailable_status(now: int, switches: Switches, guard: Guard, public_host: str) -> dict[str, Any]:
    """The status when the snapshot could not be read: down, one signal, no counters."""
    return {
        "version": VERSION,
        "app": APP,
        "generated_at": timestamp(now),
        "health": "down",
        "modes": modes(switches, None),
        "guard": guard_state(guard, now * 1000),
        "signals": [signal("status_unavailable", Severity.CRITICAL)],
        "counters": {},
        "last_backup_at": None,
        "ui_url": ui_url(public_host),
        "capabilities": list(CAPABILITIES),
    }


# ---- digest ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DigestItem:
    source: str
    code: str
    severity: str
    since: int  # Unix seconds
    metrics: tuple[tuple[str, int | float], ...]  # sorted by name


@dataclass(frozen=True, slots=True)
class OpsDigest:
    """The ops section of a reminder: the report's warning and critical items."""

    generated_at: int  # Unix seconds
    items: tuple[DigestItem, ...]
    dashboard_url: str | None


def digest(stored: Report | None, now: int) -> OpsDigest | None:
    """The stored report's warning/critical items while it is at most 36 h old, critical first,
    then by source, code and since; None when there is nothing to list."""
    if stored is None or now * 1000 - stored.generated_ms > DIGEST_WINDOW * 1000:
        return None
    items = [
        DigestItem(
            item["source"],
            item["code"],
            item["severity"],
            parse_timestamp_ms(item["since"]) // 1000,
            tuple(sorted(item["metrics"].items())),
        )
        for item in stored.items
        if item["severity"] in (Severity.WARNING, Severity.CRITICAL)
    ]
    if not items:
        return None
    items.sort(key=lambda i: (SEVERITY_RANK[Severity(i.severity)], i.source, i.code, i.since))
    return OpsDigest(stored.generated_ms // 1000, tuple(items[:REPORT_MAX_ITEMS]), stored.dashboard_url)


def metric_text(value: int | float) -> str:
    """An integral value as an integer, anything else with up to three decimals."""
    if isinstance(value, int) or float(value).is_integer():
        return str(int(value))
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text
