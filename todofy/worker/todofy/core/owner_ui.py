"""todofy.ui.v1 (proto/todofy/ui/v1) in todofy-core: the owner API's messages, built from the ledger's rows.

The gateway serves TodofyUiService through the shared transcoder and asks TodofyCore for each answer
(runtime/owner_ui.py). This module is the pure part: the request rules the IDL cannot state (page sizes, names,
cursors, a reconcile's task ID), the error reasons TodofyCore answers, and the mapping from the dicts the
ledger's readers build (runtime/api.py, the coordinator, metrics.py, backup.py) to the generated messages, which
``answer`` writes with the wire JSON codec. The codec checks every message before a byte leaves. The gateway reads
only a list's page (to add the page token) and sends every other answer to the browser byte for byte (PreEncoded,
gateway/test/pre-encoded.test.ts), so ``answer`` must keep writing the compact wire profile toWire writes: no other
separators, escaping or indentation.
"""

import json
import re
from collections.abc import Mapping
from datetime import date
from enum import IntEnum, StrEnum
from typing import Any

from ziyixi_proto.todofy.report.v1 import report_pb
from ziyixi_proto.todofy.ui.v1 import history_pb, mail_event_pb, reports_pb, status_pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire, wire_member, wire_name

from .contract import UUID
from .sql import ACTIVE_STATES

TASK_ID = re.compile(r"[0-9A-Za-z_-]{1,64}")
DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# Before any day the ledger keeps; a cursor older is BAD_REQUEST.
MIN_CURSOR_YEAR = 1970
# ListMailEvents' AIP-160 filter: one restriction, `state = <MailEvent.State name>` or `attention = true`.
EVENT_FILTER = re.compile(r"\s*(state|attention)\s*=\s*([A-Za-z_]{1,32})\s*")
MAX_FILTER_CHARS = 64
# An etag is the event's version (MailEvent.etag says opaque; only TodofyCore reads it back).
ETAG = re.compile(r"[1-9][0-9]{0,15}")
# Beyond any timestamp, yet still passed to D1 as a JS Number (larger ints become BigInt, which D1 rejects).
MAX_INTEGER = 2**52
# int32 fields: a value the ledger could hold beyond them (a token budget set too high) is written as the bound.
INT32_MAX = 2**31 - 1


class Reason(StrEnum):
    """The ErrorInfo reasons TodofyCore answers: common.errors.v1.CommonReason and todofy.ui.v1.ErrorReason names."""

    NOT_CONFIGURED = "NOT_CONFIGURED"
    BAD_REQUEST = "BAD_REQUEST"
    NOT_FOUND = "NOT_FOUND"
    UNAVAILABLE = "UNAVAILABLE"
    UNAUTHORIZED = "UNAUTHORIZED"
    ETAG_MISMATCH = "ETAG_MISMATCH"
    ACTION_NOT_ALLOWED = "ACTION_NOT_ALLOWED"
    RATE_LIMITED = "RATE_LIMITED"
    MAINTENANCE = "MAINTENANCE"
    # A bug in TodofyCore (an exception, or an answer the codec refuses to write): never repeated by a client.
    INTERNAL = "INTERNAL"


class UiError(Exception):
    """An expected refusal: its reason, a detail message (the current MailEvent of a stale reconcile) and the
    seconds of a Retry-After."""

    def __init__(self, reason: Reason, detail: Any = None, retry_after: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail
        self.retry_after = retry_after


def answer(message: Any) -> str:
    """A message as compact wire JSON text (the codec refuses one that breaks a rule: a bug, never sent).

    The gateway passes most answers through unread, so these bytes are what the browser receives.
    """
    return json.dumps(to_wire(message), ensure_ascii=False, separators=(",", ":"))


def read_request(cls: type, text: str) -> Any:
    """A request the gateway's transcoder already decoded, read again strictly: anything else is BAD_REQUEST."""
    try:
        return from_wire(cls, json.loads(text), strict=True).message
    except (ValueError, WireJsonError):
        raise UiError(Reason.BAD_REQUEST) from None


def page_size(value: int, default: int, maximum: int) -> int:
    """AIP-158: 0 is the default, a larger value than the maximum is read as the maximum, a negative one refused."""
    if value < 0:
        raise UiError(Reason.BAD_REQUEST)
    return default if value == 0 else min(value, maximum)


def resource_id(name: str, collection: str) -> str:
    """The ID of ``<collection>/<id>`` (the transcoder matched the pattern, so only the prefix is checked)."""
    prefix = f"{collection}/"
    if not name.startswith(prefix) or "/" in name[len(prefix) :]:
        raise UiError(Reason.BAD_REQUEST)
    return name[len(prefix) :]


def event_id(name: str) -> str:
    """mailEvents/{id}: a name that cannot be an event's is NOT_FOUND, as no event can have it."""
    value = resource_id(name, "mailEvents")
    if not UUID.fullmatch(value):
        raise UiError(Reason.NOT_FOUND)
    return value


def legacy_key(name: str) -> str:
    """legacyTexts/{id}: an event's ID (MailEvent.legacy_text); anything else is NOT_FOUND. An imported cache row
    with no event (key ``legacy:...``) stays in D1 only: its colon is outside AIP-122's IDs and no page links it."""
    value = resource_id(name, "legacyTexts")
    if not UUID.fullmatch(value):
        raise UiError(Reason.NOT_FOUND)
    return value


def etag_version(etag: str) -> int:
    """The version an etag names. A malformed etag names no version the event has: ETAG_MISMATCH (the caller adds
    the current event)."""
    if not ETAG.fullmatch(etag) or int(etag) > MAX_INTEGER:
        raise UiError(Reason.ETAG_MISMATCH)
    return int(etag)


def event_filter(text: str) -> tuple[str | None, bool]:
    """ListMailEvents' filter as (the state's wire name or None, attention); anything but one restriction is
    BAD_REQUEST. Names are upper case as in the IDL (`state = TODO_UNKNOWN`); UNSPECIFIED names no state."""
    if not text.strip():
        return None, False
    match = EVENT_FILTER.fullmatch(text) if len(text) <= MAX_FILTER_CHARS else None
    if match is None:
        raise UiError(Reason.BAD_REQUEST)
    field, value = match.groups()
    if field == "attention":
        if value != "true":
            raise UiError(Reason.BAD_REQUEST)
        return None, True
    member = mail_event_pb.MailEvent_State.__members__.get(value) if value.isupper() else None
    name = None if member is None else wire_name(member)
    if name is None:
        raise UiError(Reason.BAD_REQUEST)
    return name, False


def reconcile_task_id(action: mail_event_pb.ReconcileAction, task_id: str) -> str | None:
    """TASK_CREATED needs a Tasks task ID; every other action takes none."""
    if action == mail_event_pb.ReconcileAction.TASK_CREATED:
        if not TASK_ID.fullmatch(task_id):
            raise UiError(Reason.BAD_REQUEST)
        return task_id
    if task_id:
        raise UiError(Reason.BAD_REQUEST)
    return None


# ---- cursors: the JSON values the gateway keeps inside its AIP-158 page tokens (proto/ts/page-token.ts) ----------


def _cursor_object(text: str | None) -> Mapping[str, Any] | None:
    if text is None:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        raise UiError(Reason.BAD_REQUEST) from None
    if not isinstance(value, dict):
        raise UiError(Reason.BAD_REQUEST)
    return value


def event_cursor(text: str | None) -> tuple[int, str] | None:
    """The (created_at, event_id) of the row a page of events continues after."""
    value = _cursor_object(text)
    if value is None:
        return None
    at, last = value.get("at"), value.get("id")
    if isinstance(at, bool) or not isinstance(at, int) or not 0 <= at <= MAX_INTEGER:
        raise UiError(Reason.BAD_REQUEST)
    if not isinstance(last, str) or not UUID.fullmatch(last):
        raise UiError(Reason.BAD_REQUEST)
    return at, last


def _real(day: str) -> bool:
    """Whether a day of the right shape exists on the calendar (2026-02-30 does not), from 1970 on (a page goes
    back a day from its cursor, which 0001-01-01 could not)."""
    if int(day[:4]) < MIN_CURSOR_YEAR:
        return False
    try:
        date.fromisoformat(day)
    except ValueError:
        return False
    return True


def day_cursor(text: str | None) -> str | None:
    """A cursor ``{"day": YYYY-MM-DD}`` that names a real day. A page token is untrusted input
    (proto/ts/page-token.ts): anything else is BAD_REQUEST, never a later exception."""
    value = _cursor_object(text)
    if value is None:
        return None
    day = value.get("day")
    if not isinstance(day, str) or not DAY.fullmatch(day) or not _real(day):
        raise UiError(Reason.BAD_REQUEST)
    return day


def cursor_text(value: Any) -> str | None:
    """The JSON text of a next page's cursor, or None on the last page."""
    return None if value is None else json.dumps(value, separators=(",", ":"))


# ---- messages ------------------------------------------------------------------------------------------------------


def _enum[E: IntEnum](cls: type[E], name: Any) -> E:
    """An enum member from its wire name; a name the IDL lacks (or none) is UNSPECIFIED."""
    return wire_member(cls, name) or cls(0)


def _int32(value: Any) -> int:
    return min(int(value), INT32_MAX)


def list_view(view: mail_event_pb.MailEventView) -> None:
    """ListMailEvents answers BASIC only (FULL would read every event's detail): FULL is BAD_REQUEST."""
    if view == mail_event_pb.MailEventView.FULL:
        raise UiError(Reason.BAD_REQUEST)


def full_view(view: mail_event_pb.MailEventView) -> bool:
    """GetMailEvent's view: FULL unless BASIC is asked for (AIP-157)."""
    return view != mail_event_pb.MailEventView.BASIC


def mail_event(row: Mapping[str, Any], *, full: bool = True) -> mail_event_pb.MailEvent:
    """A MailEvent from a whole EventDetail dict (TodofyCore.event_detail) in the FULL view, or in the BASIC view
    (``full=False``) from it or from an EventSummary dict (runtime/api.py event_summary): the list fields only."""
    fields: dict[str, Any] = {
        "name": f"mailEvents/{row['event_id']}",
        "state": _enum(mail_event_pb.MailEvent_State, row["state"]),
        "error_code": _enum(mail_event_pb.EventErrorCode, row["error_code"]),
        "attempt_count": row["attempt_count"],
        "task_id": row["task_id"] or "",
        "receive_time": row["received_at"],
        "update_time": row["updated_at"],
        "next_attempt_time": row["next_attempt_at"],
        "attention": row["attention"],
        "imported": row["imported"],
    }
    if full:
        fields |= {
            "version": _int32(row["version"]),
            "etag": str(row["version"]),
            "crash_count": row["crashes"],
            "subject": row["subject"] or "",
            "sender": row["from"] or "",
            "summary": row["summary"] or "",
            "summary_model": row["summary_model"] or "",
            "todo_body": row["todo_body"] or "",
            "todoist_request_id": row["todoist_request_id"] or "",
            "allowed_actions": tuple(_enum(mail_event_pb.ReconcileAction, a) for a in row["allowed_actions"]),
            "transitions": tuple(
                mail_event_pb.Transition(
                    transition_time=step["at"],
                    prior_state=_enum(mail_event_pb.MailEvent_State, step["from_state"]),
                    state=_enum(mail_event_pb.MailEvent_State, step["to_state"]),
                    error_code=_enum(mail_event_pb.EventErrorCode, step["error_code"]),
                    actor=_enum(mail_event_pb.Transition_Actor, step["actor"]),
                )
                for step in row["transitions"]
            ),
            "legacy_text": f"legacyTexts/{row['event_id']}" if row["has_legacy_text"] else "",
            "canary": bool(row.get("canary", False)),
        }
    return mail_event_pb.MailEvent(**fields)


def service_status(overview: Mapping[str, Any]) -> status_pb.ServiceStatus:
    """The ServiceStatus from the Overview dict (runtime/api.py overview_data)."""
    flags, counts, gemini, backup = overview["flags"], overview["counts"], overview["gemini"], overview["backup"]
    # latest_reminder stays unset and the two retired switches false (status.proto): Home sends the reminder.
    return status_pb.ServiceStatus(
        name="serviceStatus",
        build=overview["build"],
        read_time=overview["now"],
        switches=status_pb.Switches(
            maintenance_mode=flags["maintenance_mode"], processing_paused=flags["processing_paused"]
        ),
        active_counts=status_pb.ActiveCounts(**{f"{state}_count": counts[state] for state in ACTIVE_STATES}),
        attention_count=overview["attention_count"],
        received_last_day_count=overview["received_24h"],
        next_alarm_time=overview["next_alarm_at"],
        oldest_due_time=overview["oldest_due_at"],
        gemini=status_pb.GeminiBudget(
            day=gemini["day"],
            token_budget=_int32(gemini["token_budget"]),
            reserved_tokens=_int32(gemini["reserved_tokens"]),
            used_tokens=_int32(gemini["used_tokens"]),
            call_count=gemini["calls"],
            models=tuple(gemini["models"]),
            email_models=tuple(gemini.get("email_models", ())),
        ),
        backup=status_pb.BackupStatus(
            state=_enum(status_pb.BackupStatus_State, backup["status"]),
            last_backup_time=backup["last_backup_at"],
            last_backup_key=backup["last_backup_key"] or "",
            last_backup_size_bytes=_int32(backup["last_backup_bytes"]),
            last_backup_row_count=_int32(backup["last_backup_rows"]),
            last_failure_time=backup["last_failure_at"],
            last_error_code=_enum(status_pb.BackupStatus_ErrorCode, backup["last_error_code"]),
            next_backup_time=backup["next_backup_at"],
        ),
    )


def metric_day(day: Mapping[str, Any]) -> history_pb.MetricDay:
    """A MetricDay from a DailyMetricsDay dict (core/metrics.py daily_series)."""
    return history_pb.MetricDay(
        name=f"metricDays/{day['day']}",
        recorded=day["recorded"],
        received_count=day["mails_received"],
        completed_count=day["mails_completed"],
        failed_count=day["mails_failed"],
        latency_p50_seconds=day["latency_p50_seconds"],
        latency_p90_seconds=day["latency_p90_seconds"],
        gemini_call_count=day["gemini_calls"],
        gemini_tokens={model: _int32(tokens) for model, tokens in day["gemini_tokens"].items()},
        todoist_create_count=day["todoist_creates"],
        todoist_lookup_count=day["todoist_lookups"],
    )


def legacy_text(key: str, text: Mapping[str, Any]) -> mail_event_pb.LegacyText:
    """A LegacyText from a LegacyText dict (runtime/api.py legacy_text_data)."""
    return mail_event_pb.LegacyText(
        name=f"legacyTexts/{key}",
        create_time=text["created_at"],
        expire_time=text["expires_at"],
        text=text["text"],
    )


def summary_report(document: Any) -> report_pb.SummaryReport | None:
    """A stored summary-v1 report, read like any consumer reads one (leniently); None when it does not read."""
    try:
        return from_wire(report_pb.SummaryReport, document).message
    except WireJsonError:
        return None


def recommendation_report(document: Any) -> report_pb.RecommendationReport | None:
    """A stored recommendation-v1 report, read leniently; None when it does not read."""
    try:
        return from_wire(report_pb.RecommendationReport, document).message
    except WireJsonError:
        return None


def report_kind(kind: reports_pb.ReportKind) -> str:
    """The reports' kind name (reports.SUMMARY, reports.RECOMMENDATION) of a RecomputeReport request."""
    name = wire_name(kind)
    if name is None:
        raise UiError(Reason.BAD_REQUEST)
    return name
