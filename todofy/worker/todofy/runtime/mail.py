"""Todofy's Mail entry, todofy.mail.v1 MailService (proto/todofy/mail/v1), inside TodofyCore.

The gateway's Mail entrypoint (gateway/src/mail.ts) serves the IDL with the shared transcoder to the Workers whose
binding grants it (Tasks, the Personal MCP) and calls the coordinator's ``mail`` RPC method once per request with the
rpc's name and the decoded request as wire JSON. This module reads the request again strictly, does the work in D1
and answers

    {"ok": <the response message as wire JSON text>}  or  {"error": <ErrorInfo reason>, "retry_after": int | None}

never an exception. Mail is content: a summaries row still awaiting a decision (summaries_pending). Todofy creates,
reads and changes no task. Tasks makes the task from a mail itself and then marks the mail converted here. Both
writes are compare-and-sets in D1 alone, so they need no request ID and no receipt: a repeated MarkMailConverted
for the same task answers the mail as it is, and DeleteMailSummaries counts a summary already gone as deleted. They
wait while MAINTENANCE_MODE is on or the weekly backup holds the ledger. Logs carry no mail content.
"""

import json
import re
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from pyodide.ffi import JsException
from ziyixi_proto.todofy.mail.v1 import mail_service_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from todofy.core import mailbox
from todofy.core.backoff import DAY
from todofy.core.carryover import MAX_CARRYOVER_DAYS
from todofy.core.render import NO_SUBJECT, rfc3339
from todofy.core.sql import mailbox as sql
from todofy.runtime import backup
from todofy.runtime.config import flag, source_id
from todofy.runtime.interop import now_s

DEFAULT_PAGE = 25
MAX_PAGE = 50
MAX_DELETE = 200
MAX_SUMMARY_BYTES = 64 << 10
MAX_CURSOR = 2**63 - 1
CURSOR = re.compile(r"0|[1-9][0-9]{0,18}")
COLLECTION = "mailItems/"
WRITES = frozenset({"MarkMailConverted", "DeleteMailSummaries"})
# Seconds a write waits: a backup holds the ledger for a minute or so, maintenance until the owner ends it.
RETRY_AFTER = {"UNAVAILABLE": 30, "MAINTENANCE": 300}


class MailError(Exception):
    """An expected refusal: a common.errors.v1 reason or a todofy.mail.v1 ErrorReason name."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _id(value: str) -> str:
    try:
        return mailbox.check_id(value)
    except ValueError:
        raise MailError("BAD_REQUEST") from None


def _event_id(name: str) -> str:
    """mailItems/{id}."""
    if not name.startswith(COLLECTION):
        raise MailError("BAD_REQUEST")
    return _id(name.removeprefix(COLLECTION))


def _pending(row: Mapping[str, Any]) -> bool:
    return not row["imported"] and row["triaged_at"] is None


def _item(row: Mapping[str, Any], *, summary: bool = False) -> pb.MailItem:
    """A MailItem from a mailbox.ITEM or NATIVE_ITEMS row; ``summary`` adds the full text, cut to 64 KiB."""
    text = str(row["summary"]).encode()[:MAX_SUMMARY_BYTES].decode(errors="ignore") if summary else ""
    return pb.MailItem(
        name=COLLECTION + row["event_id"],
        id=row["event_id"],
        title=row["subject"] if row["subject"].strip() else NO_SUBJECT,
        brief=row["brief"] or mailbox.brief_of(row["head"] or ""),
        receive_time=rfc3339(datetime.fromtimestamp(int(row["received_at"]), UTC)),
        has_summary=bool(row["has_summary"]),
        etag=mailbox.item_etag(row),
        task_id=row["task_id"],
        summary=text,
        pending=_pending(row),
    )


async def _row(core: Any, event_id: str) -> dict[str, Any] | None:
    row = await core.env.DB.prepare(sql.ITEM.sql).bind(source_id(core.env), event_id).first()
    return None if row is None else dict(row)


# ---- reads ----------------------------------------------------------------------------------------------------


async def _list(core: Any, request: pb.ListMailItemsRequest) -> pb.ListMailItemsResponse:
    """A page of pending mail, newest first, by a keyset cursor: one read."""
    size = request.page_size or DEFAULT_PAGE
    if not 1 <= size <= MAX_PAGE:
        raise MailError("BAD_REQUEST")
    try:
        at, last = mailbox.page_cursor(request.page_token)
    except ValueError:
        raise MailError("BAD_REQUEST") from None
    page = await core.env.DB.prepare(sql.NATIVE_ITEMS.sql).bind(source_id(core.env), at, last, size + 1).all()
    rows = [dict(row) for row in page.results]
    return pb.ListMailItemsResponse(
        mail_items=tuple(_item(row) for row in rows[:size]),
        next_page_token=mailbox.next_page(rows[size - 1]) if len(rows) > size else "",
    )


async def _get(core: Any, request: pb.GetMailItemRequest) -> pb.MailItem:
    row = await _row(core, _event_id(request.name))
    if row is None:
        raise MailError("NOT_FOUND")
    return _item(row, summary=True)


async def _inbox(core: Any, request: pb.GetMailInboxRequest) -> pb.MailInbox:
    """How much mail is pending, and how much of it arrived 1 to 14 days ago: one batch of two counts."""
    if request.name != "mailInbox":
        raise MailError("BAD_REQUEST")
    db, now = core.env.DB, now_s()
    pending, carried = await db.batch(
        [
            db.prepare(sql.NATIVE_COUNT.sql),
            db.prepare(sql.PENDING_BETWEEN.sql).bind(now - MAX_CARRYOVER_DAYS * DAY, now - DAY),
        ]
    )
    return pb.MailInbox(
        name="mailInbox",
        pending_count=int(dict(pending.results[0])["n"]),
        carryover_count=int(dict(carried.results[0])["n"]),
    )


async def _poll(core: Any, request: pb.PollMailReadyRequest) -> pb.PollMailReadyResponse:
    """At most 50 ledger transitions after the cursor, and the pending mail among them; no content."""
    cursor, db = request.cursor, core.env.DB
    if request.baseline:
        if cursor:
            raise MailError("BAD_REQUEST")
        head = await db.prepare(sql.READY_HEAD.sql).first()
        return pb.PollMailReadyResponse(cursor=str(dict(head)["id"]))
    if not CURSOR.fullmatch(cursor) or int(cursor) > MAX_CURSOR:
        raise MailError("BAD_REQUEST")
    page = await db.prepare(sql.READY_PAGE.sql).bind(cursor).all()
    rows = [dict(row) for row in page.results]
    if not rows and int(cursor) > 0:
        head = await db.prepare(sql.READY_HEAD.sql).first()
        if int(cursor) > int(dict(head)["id"]):
            # A restored database is behind the reader: it starts again from a new baseline.
            raise MailError("CURSOR_RESET_REQUIRED")
    return pb.PollMailReadyResponse(
        cursor=str(rows[-1]["id"]) if rows else cursor,
        mail_items=tuple(
            pb.MailReadyItem(
                event_id=row["event_id"], ready_time=rfc3339(datetime.fromtimestamp(int(row["created_at"]), UTC))
            )
            for row in rows
            if row["event_id"] is not None
        ),
    )


# ---- writes ---------------------------------------------------------------------------------------------------


async def _mark_converted(core: Any, request: pb.MarkMailConvertedRequest) -> pb.MailItem:
    """Records the task Tasks made from a pending mail, by compare-and-set on the mail its etag names: one read, then
    one batch of the write and the read back. The same task again answers the mail as it is."""
    event_id, task_id = _event_id(request.name), _id(request.task_id)
    if not request.etag:
        raise MailError("BAD_REQUEST")
    row = await _row(core, event_id)
    if row is not None and _pending(row):
        if request.etag != mailbox.item_etag(row):
            raise MailError("ETAG_MISMATCH")
        db = core.env.DB
        marked, after = await db.batch(
            [
                db.prepare(sql.MARK_CONVERTED.sql).bind(task_id, now_s(), event_id, row["task_id"]),
                db.prepare(sql.ITEM.sql).bind(source_id(core.env), event_id),
            ]
        )
        row = dict(after.results[0]) if after.results else None
        if marked.meta.changes == 1 and row is not None:
            return _item(row)
        if row is not None and _pending(row):
            raise MailError("ETAG_MISMATCH")  # changed between the read and the write
    if row is None:
        raise MailError("NOT_FOUND")
    if row["triaged_at"] is not None and row["task_id"] == task_id:
        return _item(row)  # a repeat, or another caller marked it for the same task
    raise MailError("NOT_PENDING")


async def _delete(core: Any, request: pb.DeleteMailSummariesRequest) -> pb.DeleteMailSummariesResponse:
    """Deletes pending summaries and keeps the ledger's events, so no mail is summarised again: one batch."""
    ids = list(request.event_ids)
    if not 1 <= len(ids) <= MAX_DELETE or len(set(ids)) != len(ids):
        raise MailError("BAD_REQUEST")
    bound = json.dumps([_id(event_id) for event_id in ids])
    db = core.env.DB
    _, remaining = await db.batch(
        [db.prepare(sql.FORGET_EVENTS.sql).bind(bound), db.prepare(sql.EXISTING_EVENTS.sql).bind(bound)]
    )
    kept = {dict(row)["event_id"] for row in remaining.results}
    return pb.DeleteMailSummariesResponse(
        deleted_event_ids=tuple(event_id for event_id in ids if event_id not in kept),
        kept_event_ids=tuple(event_id for event_id in ids if event_id in kept),
    )


Handler = Callable[[Any, Any], Awaitable[Any]]
# rpc name -> (request message, handler).
METHODS: dict[str, tuple[type, Handler]] = {
    "ListMailItems": (pb.ListMailItemsRequest, _list),
    "GetMailItem": (pb.GetMailItemRequest, _get),
    "MarkMailConverted": (pb.MarkMailConvertedRequest, _mark_converted),
    "DeleteMailSummaries": (pb.DeleteMailSummariesRequest, _delete),
    "GetMailInbox": (pb.GetMailInboxRequest, _inbox),
    "PollMailReady": (pb.PollMailReadyRequest, _poll),
}


async def handle(core: Any, method: str, text: str) -> dict[str, Any]:
    """One MailService rpc; never raises."""
    try:
        entry = METHODS.get(method)
        if entry is None:
            raise MailError("NOT_FOUND")
        request_type, handler = entry
        try:
            request = from_wire(request_type, json.loads(text), strict=True).message
        except (ValueError, WireJsonError):
            raise MailError("BAD_REQUEST") from None
        if method in WRITES:
            if flag(core.env, "MAINTENANCE_MODE"):
                raise MailError("MAINTENANCE")
            if backup.holds_ledger(core.env, core.sql, now_s()):
                raise MailError("UNAVAILABLE")
        response = await handler(core, request)
        return {"ok": json.dumps(to_wire(response), ensure_ascii=False, separators=(",", ":"))}
    except MailError as error:
        reason = error.reason
    except JsException:
        # D1 or object storage failed; the platform logs carry the details.
        reason = "UNAVAILABLE"
    except Exception as error:
        # A bug, never mail content: the rpc's name (only a known one) and the exception's type.
        rpc = method if method in METHODS else None
        print(json.dumps({"mail": "internal", "rpc": rpc, "error": type(error).__name__}))
        reason = "INTERNAL"
    return {"error": reason, "retry_after": RETRY_AFTER.get(reason)}
