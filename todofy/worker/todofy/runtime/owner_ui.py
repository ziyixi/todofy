"""The owner API todofy.ui.v1 (proto/todofy/ui/v1) inside TodofyCore.

The gateway serves TodofyUiService through the shared transcoder behind Access, CSRF and MAINTENANCE_MODE
(todofy/gateway/src/owner.ts) and calls the coordinator's ``owner_ui`` RPC method once per request with the rpc's
name, the decoded request as wire JSON and, for a list, the cursor from its page token. This module reads the
request again with the generated code, does the work and answers

    {"ok": <the response message as wire JSON text>, "next_cursor": <JSON text of the next page's cursor> | None}

or ``{"error": <ErrorInfo reason>, "detail": <a MailEvent as wire JSON text> | None, "retry_after": int | None}``,
never an exception (a Python exception reaches the gateway only as an opaque error, which it must read as the
object being unavailable). D1 and storage failures (JsException) are UNAVAILABLE, which the UI may repeat with the
same request_id; any other exception, including an answer the codec refuses to write, is a bug: INTERNAL, which no
client repeats by itself, with only the exception's type logged (docs/gateway-contract.md §3.5).

The ledger's readers (runtime/api.py, the coordinator, reminder.py, metrics.py, gtd.py, backup.py) build the
same dicts as the owner API before todofy.ui.v1; core/owner_ui.py maps them to the generated messages. Reads are
the same bounded, indexed D1 queries as before.
"""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pyodide.ffi import JsException
from ziyixi_proto.todofy.ui.v1 import mail_event_pb, reports_pb
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb
from ziyixi_proto.wire_json import wire_name

from todofy.core import owner_ui as ui
from todofy.core.api_errors import ApiError
from todofy.core.owner_ui import Reason, UiError
from todofy.core.report_schema import MAX_TOP_N
from todofy.runtime import api, backup, gtd, metrics, reminder, reports
from todofy.runtime.config import flag, report_default_top
from todofy.runtime.interop import now_s

MAX_OWNER_CHARS = 254
EVENTS_PAGE = (50, 100)
REMINDERS_PAGE = (50, 100)
METRIC_DAYS_PAGE = (metrics.DEFAULT_API_DAYS, metrics.MAX_API_DAYS)
GTD_DAYS_PAGE = (gtd.DEFAULT_API_DAYS, gtd.MAX_API_DAYS)
REVIEWS_PAGE = (gtd.HISTORY_WEEKS, gtd.HISTORY_WEEKS)
# The old owner API's codes as todofy.ui.v1 reasons (the reconcile and recompute paths are shared).
REASONS = {
    ApiError.NOT_FOUND: Reason.NOT_FOUND,
    ApiError.VERSION_CONFLICT: Reason.ETAG_MISMATCH,
    ApiError.ACTION_NOT_ALLOWED: Reason.ACTION_NOT_ALLOWED,
    ApiError.ACTION_REQUEST_CONFLICT: Reason.REQUEST_ID_REUSED,
    ApiError.RATE_LIMITED: Reason.RATE_LIMITED,
    ApiError.MAINTENANCE: Reason.MAINTENANCE,
    ApiError.INVALID_REQUEST: Reason.BAD_REQUEST,
}


@dataclass(frozen=True, slots=True)
class Call:
    """One owner API request as the gateway passes it."""

    env: Any
    coordinator: Any
    owner: str
    request: Any
    cursor: str | None


@dataclass(frozen=True, slots=True)
class Answer:
    """The response message and the next page's cursor (JSON text), if any."""

    message: Any
    next_cursor: str | None = None


Handler = Callable[[Call], Awaitable[Answer]]


async def _list_mail_events(call: Call) -> Answer:
    request: pb.ListMailEventsRequest = call.request
    size = ui.page_size(request.page_size, *EVENTS_PAGE)
    state = wire_name(request.state) if request.state else None
    if request.attention and state is not None:
        raise UiError(Reason.BAD_REQUEST)
    items, following = await api.event_page(
        call.env, attention=request.attention, state=state, after=ui.event_cursor(call.cursor), limit=size
    )
    cursor = None if following is None else {"at": following[0], "id": following[1]}
    return Answer(
        pb.ListMailEventsResponse(mail_events=tuple(ui.mail_event(item) for item in items)), ui.cursor_text(cursor)
    )


async def _detail(coordinator: Any, event_id: str) -> mail_event_pb.MailEvent:
    detail = await coordinator.event_detail(event_id)
    if detail is None:
        raise UiError(Reason.NOT_FOUND)
    return ui.mail_event(detail)


async def _get_mail_event(call: Call) -> Answer:
    return Answer(await _detail(call.coordinator, ui.event_id(call.request.name)))


async def _reconcile_mail_event(call: Call) -> Answer:
    request: pb.ReconcileMailEventRequest = call.request
    event_id = ui.event_id(request.name)
    action = wire_name(request.action)
    if action is None or not request.request_id:
        raise UiError(Reason.BAD_REQUEST)
    task_id = ui.reconcile_task_id(request.action, request.task_id)
    try:
        version = ui.etag_version(request.etag)
    except UiError as stale:
        stale.detail = await _detail(call.coordinator, event_id)
        raise
    refused = await call.coordinator.apply_reconcile(call.owner, event_id, action, version, request.request_id, task_id)
    if refused in (ApiError.VERSION_CONFLICT, ApiError.ACTION_NOT_ALLOWED):
        raise UiError(REASONS[refused], await _detail(call.coordinator, event_id))
    if refused is not None:
        raise UiError(REASONS[refused])
    return Answer(await _detail(call.coordinator, event_id))


async def _list_daily_reminders(call: Call) -> Answer:
    size = ui.page_size(call.request.page_size, *REMINDERS_PAGE)
    items, next_day = await reminder.page(call.env.DB, ui.text_cursor(call.cursor, "day", ui.DAY), size)
    return Answer(
        pb.ListDailyRemindersResponse(daily_reminders=tuple(ui.daily_reminder(item) for item in items)),
        ui.cursor_text(None if next_day is None else {"day": next_day}),
    )


def _check_singleton(name: str, expected: str) -> None:
    if name != expected:
        raise UiError(Reason.BAD_REQUEST)


async def _get_latest_reports(call: Call) -> Answer:
    _check_singleton(call.request.name, "latestReports")
    stored = await reports.latest(call.env.DB)
    summary = None if stored["summary"] is None else ui.summary_report(stored["summary"])
    recommendations = [ui.recommendation_report(document) for document in stored["recommendations"]]
    if (stored["summary"] is not None and summary is None) or None in recommendations:
        # A stored report the codec cannot read (none was ever written so): left out rather than failing the page.
        print('{"owner_ui": "report_unreadable"}')
    return Answer(
        reports_pb.LatestReports(
            name="latestReports",
            summary=summary,
            recommendations=tuple(report for report in recommendations if report is not None),
        )
    )


async def _recompute_report(call: Call) -> Answer:
    request: pb.RecomputeReportRequest = call.request
    _check_singleton(request.name, "latestReports")
    kind = ui.report_kind(request.kind)
    if not request.request_id or not 0 <= request.top_n <= MAX_TOP_N:
        raise UiError(Reason.BAD_REQUEST)
    if kind == reports.SUMMARY and request.top_n != 0:
        raise UiError(Reason.BAD_REQUEST)
    top_n = 0 if kind == reports.SUMMARY else request.top_n or report_default_top(call.env)
    status, result = await call.coordinator.recompute_outcome(call.owner, request.request_id, kind, top_n)
    if status != 200:
        retry_after = reports.report_error(status, result, now_s()).retry_after
        raise UiError(REASONS.get(result, Reason.UNAVAILABLE), retry_after=retry_after)
    if kind == reports.SUMMARY:
        response = pb.RecomputeReportResponse(summary=ui.summary_report(result))
    else:
        response = pb.RecomputeReportResponse(recommendation=ui.recommendation_report(result))
    return Answer(response)


async def _list_metric_days(call: Call) -> Answer:
    size = ui.page_size(call.request.page_size, *METRIC_DAYS_PAGE)
    days, before = await metrics.day_page(call.env.DB, size, ui.text_cursor(call.cursor, "day", ui.DAY), now_s())
    return Answer(
        pb.ListMetricDaysResponse(metric_days=tuple(ui.metric_day(day) for day in days)),
        ui.cursor_text(None if before is None else {"day": before}),
    )


async def _list_gtd_days(call: Call) -> Answer:
    size = ui.page_size(call.request.page_size, *GTD_DAYS_PAGE)
    days, before = await gtd.day_page(call.env.DB, size, ui.text_cursor(call.cursor, "day", ui.DAY), now_s())
    return Answer(
        pb.ListGtdDaysResponse(gtd_days=tuple(ui.gtd_day(day) for day in days)),
        ui.cursor_text(None if before is None else {"day": before}),
    )


async def _list_gtd_reviews(call: Call) -> Answer:
    size = ui.page_size(call.request.page_size, *REVIEWS_PAGE)
    reviews, last = await gtd.review_page(call.env.DB, size, ui.text_cursor(call.cursor, "week", ui.WEEK), now_s())
    return Answer(
        pb.ListGtdReviewsResponse(gtd_reviews=tuple(ui.gtd_review(review) for review in reviews)),
        ui.cursor_text(None if last is None else {"week": last}),
    )


async def _get_legacy_text(call: Call) -> Answer:
    key = ui.legacy_key(call.request.name)
    text = await api.legacy_text_data(call.env, key)
    if text is None:
        raise UiError(Reason.NOT_FOUND)
    return Answer(ui.legacy_text(key, text))


async def _get_service_status(call: Call) -> Answer:
    _check_singleton(call.request.name, "serviceStatus")
    return Answer(ui.service_status(await api.overview_data(call.env, call.coordinator)))


# rpc name -> (request message, handler, whether it writes). GetIntegration is the gateway's own (its facts and
# TodofyCore's setup()).
METHODS: dict[str, tuple[type, Handler, bool]] = {
    "GetServiceStatus": (pb.GetServiceStatusRequest, _get_service_status, False),
    "ListMailEvents": (pb.ListMailEventsRequest, _list_mail_events, False),
    "GetMailEvent": (pb.GetMailEventRequest, _get_mail_event, False),
    "ReconcileMailEvent": (pb.ReconcileMailEventRequest, _reconcile_mail_event, True),
    "ListDailyReminders": (pb.ListDailyRemindersRequest, _list_daily_reminders, False),
    "GetLatestReports": (pb.GetLatestReportsRequest, _get_latest_reports, False),
    "RecomputeReport": (pb.RecomputeReportRequest, _recompute_report, True),
    "ListMetricDays": (pb.ListMetricDaysRequest, _list_metric_days, False),
    "ListGtdDays": (pb.ListGtdDaysRequest, _list_gtd_days, False),
    "ListGtdReviews": (pb.ListGtdReviewsRequest, _list_gtd_reviews, False),
    "GetLegacyText": (pb.GetLegacyTextRequest, _get_legacy_text, False),
}


def _refusal(error: UiError) -> dict[str, Any]:
    detail = None if error.detail is None else ui.answer(error.detail)
    return {"error": str(error.reason), "detail": detail, "retry_after": error.retry_after}


async def handle(
    env: Any, coordinator: Any, owner: str, method: str, request_json: str, cursor_json: str | None
) -> dict[str, Any]:
    """One todofy.ui.v1 rpc for the canonical owner the gateway verified with Access; never raises."""
    try:
        return await _answer(env, coordinator, owner, method, request_json, cursor_json)
    except Exception as exc:
        # A bug, never the owner's data: the rpc's name (only a known one) and the exception's type.
        rpc = method if method in METHODS else None
        print(json.dumps({"owner_ui": "internal", "rpc": rpc, "error": type(exc).__name__}))
        return {"error": str(Reason.INTERNAL), "detail": None, "retry_after": None}


async def _answer(
    env: Any, coordinator: Any, owner: str, method: str, request_json: str, cursor_json: str | None
) -> dict[str, Any]:
    try:
        if "@" not in owner or len(owner) > MAX_OWNER_CHARS:
            raise UiError(Reason.UNAUTHORIZED)
        entry = METHODS.get(method)
        if entry is None:
            raise UiError(Reason.NOT_FOUND)
        request_class, handler, writes = entry
        request = ui.read_request(request_class, request_json)
        if writes and flag(env, "MAINTENANCE_MODE"):
            # The gateway refuses writes in maintenance first; this keeps the single writer consistent on its own.
            raise UiError(Reason.MAINTENANCE)
        if writes and backup.holds_ledger(env, coordinator.sql, now_s()):
            # A backup job keeps the ledger still for a minute or so (at most its lease).
            raise UiError(Reason.UNAVAILABLE)
        result = await handler(Call(env, coordinator, owner, request, cursor_json))
        # Inside the try: an answer the codec refuses to write is a bug (INTERNAL), not a transport failure.
        return {"ok": ui.answer(result.message), "next_cursor": result.next_cursor}
    except UiError as error:
        return _refusal(error)
    except JsException:
        # D1 or object storage failed; the platform logs carry the details.
        return _refusal(UiError(Reason.UNAVAILABLE))
