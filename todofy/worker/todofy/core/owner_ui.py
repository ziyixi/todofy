"""todofy.ui.v1 (proto/todofy/ui/v1) in todofy-core: the owner API's messages, built from the ledger's rows.

The gateway serves TodofyUiService through the shared transcoder and asks TodofyCore for each answer
(runtime/owner_ui.py). This module is the pure part: the request rules the IDL cannot state (page sizes, names,
cursors, a reconcile's task ID), the error reasons TodofyCore answers, and the mapping from the dicts the
ledger's readers build (runtime/api.py, the coordinator, reminder.py, metrics.py, gtd.py, backup.py) to the
generated messages, which ``answer`` writes with the wire JSON codec. The codec checks every message before a
byte leaves; the gateway reads the text leniently and writes it again for the browser.
"""

import json
import re
from collections.abc import Mapping
from enum import IntEnum, StrEnum
from typing import Any

from ziyixi_proto.todofy.report.v1 import report_pb
from ziyixi_proto.todofy.ui.v1 import history_pb, mail_event_pb, reports_pb, status_pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire, wire_member, wire_name

from .contract import UUID
from .sql import ACTIVE_STATES

# The ledger's IDs: a Mail Hero event (a UUID) or an imported Go cache row without one.
LEGACY_ID = re.compile(r"legacy:[0-9A-Za-z-]{1,128}")
TASK_ID = re.compile(r"[0-9A-Za-z_-]{1,64}")
DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
WEEK = re.compile(r"[0-9]{4}-W[0-9]{2}")
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
    """A message as compact wire JSON text (the codec refuses one that breaks a rule: a bug, never sent)."""
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
    """legacyTexts/{id}: an event's ID or an imported cache row's key; anything else is NOT_FOUND."""
    value = resource_id(name, "legacyTexts")
    if not (UUID.fullmatch(value) or LEGACY_ID.fullmatch(value)):
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
    """TASK_CREATED needs a Todoist task ID; every other action takes none."""
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


def text_cursor(text: str | None, key: str, pattern: re.Pattern[str]) -> str | None:
    """A cursor of one string matching ``pattern`` (a day or a week)."""
    value = _cursor_object(text)
    if value is None:
        return None
    item = value.get(key)
    if not isinstance(item, str) or not pattern.fullmatch(item):
        raise UiError(Reason.BAD_REQUEST)
    return item


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


def daily_reminder(row: Mapping[str, Any]) -> status_pb.DailyReminder:
    """A DailyReminder from a reminder dict (runtime/reminder.py)."""
    return status_pb.DailyReminder(
        name=f"dailyReminders/{row['day']}",
        state=_enum(status_pb.DailyReminder_State, row["state"]),
        task_id=row["task_id"] or "",
        attention_count=row["attention_count"],
        attempt_count=row["attempts"],
        error_code=_enum(status_pb.ReminderErrorCode, row["error_code"]),
        next_attempt_time=row["next_attempt_at"],
        create_time=row["created_at"],
        update_time=row["updated_at"],
        imported=row["imported"],
    )


def service_status(overview: Mapping[str, Any]) -> status_pb.ServiceStatus:
    """The ServiceStatus from the Overview dict (runtime/api.py overview_data)."""
    flags, counts, gemini, todoist, backup = (
        overview["flags"],
        overview["counts"],
        overview["gemini"],
        overview["todoist"],
        overview["backup"],
    )
    latest = overview["latest_reminder"]
    return status_pb.ServiceStatus(
        name="serviceStatus",
        build=overview["build"],
        read_time=overview["now"],
        switches=status_pb.Switches(
            maintenance_mode=flags["maintenance_mode"],
            processing_paused=flags["processing_paused"],
            force_pause_todoist=flags["force_pause_todoist"],
            reminder_enabled=flags["reminder_enabled"],
        ),
        active_counts=status_pb.ActiveCounts(**{f"{state}_count": counts[state] for state in ACTIVE_STATES}),
        attention_count=overview["attention_count"],
        received_last_day_count=overview["received_24h"],
        latest_reminder=None if latest is None else daily_reminder(latest),
        next_alarm_time=overview["next_alarm_at"],
        oldest_due_time=overview["oldest_due_at"],
        gemini=status_pb.GeminiBudget(
            day=gemini["day"],
            token_budget=_int32(gemini["token_budget"]),
            reserved_tokens=_int32(gemini["reserved_tokens"]),
            used_tokens=_int32(gemini["used_tokens"]),
            call_count=gemini["calls"],
            models=tuple(gemini["models"]),
        ),
        todoist=status_pb.TodoistBudget(
            block_expire_time=todoist["blocked_until"],
            window_seconds=todoist["window_seconds"],
            window_call_count=todoist["window_calls"],
            window_call_limit=todoist["window_limit"],
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


def _gtd_scope(scope: Mapping[str, Any] | None) -> history_pb.GtdScope | None:
    if scope is None:
        return None
    return history_pb.GtdScope(
        open_count=scope["open"],
        fresh_count=scope["age_0_7"],
        recent_count=scope["age_8_14"],
        stale_count=scope["age_15_30"],
        old_count=scope["age_31_plus"],
        oldest_age_days=scope["oldest_days"],
        overdue_count=scope["overdue"],
        undated_count=scope["undated"],
        created_last_week_count=scope["created_7d"],
        completed_last_week_count=scope["completed_7d"],
        completed_source=_enum(history_pb.GtdScope_CompletedSource, scope["completed_source"]),
        closed_last_day_count=scope["closed_1d"],
        open_mail_count=scope["mail_open"],
        complete=scope["complete"],
    )


def gtd_day(day: Mapping[str, Any]) -> history_pb.GtdDay:
    """A GtdDay from a GtdDay dict (core/gtd.py daily_api)."""
    return history_pb.GtdDay(
        name=f"gtdDays/{day['day']}",
        recorded=day["recorded"],
        all_projects=_gtd_scope(day["all"]),
        inbox=_gtd_scope(day["inbox"]),
    )


def gtd_review(review: Mapping[str, Any]) -> history_pb.GtdReview:
    """A GtdReview from a review dict (runtime/gtd.py review_page)."""
    return history_pb.GtdReview(
        name=f"gtdReviews/{review['week']}",
        state=_enum(history_pb.GtdReview_State, review["state"]),
        create_time=review["created_at"],
        complete_time=review["completed_at"],
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
