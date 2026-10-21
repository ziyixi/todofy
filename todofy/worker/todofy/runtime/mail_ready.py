"""Bounded Mail readiness polling over the existing append-only transition ledger."""

import json
import re
from typing import Any

from pyodide.ffi import JsException
from ziyixi_proto.todofy.ui.v1 import mail_ready_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from todofy.core.gtd import rfc3339
from todofy.core.sql import mailbox as sql

MAX_CURSOR = 2**63 - 1


async def handle(core: Any, text: str) -> dict[str, Any]:
    """A typed read of at most 50 transitions. Completion and its summary are committed in one D1 batch."""
    try:
        request = from_wire(pb.PollMailReadyRequest, json.loads(text), strict=True).message
        cursor = request.cursor
        if (request.baseline and cursor) or (
            not request.baseline and (not re.fullmatch(r"0|[1-9][0-9]{0,18}", cursor) or int(cursor) > MAX_CURSOR)
        ):
            raise ValueError("invalid cursor")
    except (WireJsonError, ValueError):
        return {"error": "BAD_REQUEST", "detail": None, "retry_after": None}

    try:
        if request.baseline:
            row = await core.env.DB.prepare(sql.READY_HEAD.sql).first()
            response = {"cursor": str(dict(row)["id"]), "mail_items": []}
        else:
            page = await core.env.DB.prepare(sql.READY_PAGE.sql).bind(cursor).all()
            rows = [dict(row) for row in page.results]
            if not rows and int(cursor) > 0:
                head = await core.env.DB.prepare(sql.READY_HEAD.sql).first()
                if int(cursor) > int(dict(head)["id"]):
                    return {"error": "CURSOR_RESET_REQUIRED", "detail": None, "retry_after": None}
            response = {
                "cursor": str(rows[-1]["id"]) if rows else cursor,
                "mail_items": [
                    {"event_id": row["event_id"], "ready_time": rfc3339(int(row["created_at"]))}
                    for row in rows
                    if row["event_id"] is not None
                ],
            }
        message = from_wire(pb.PollMailReadyResponse, response, strict=True).message
        return {"ok": json.dumps(to_wire(message), separators=(",", ":")), "next_cursor": None}
    except JsException:
        reason = "UNAVAILABLE"
    except Exception as error:
        print(json.dumps({"mail_ready": "failed", "error_type": type(error).__name__}))
        reason = "INTERNAL"
    return {"error": reason, "detail": None, "retry_after": 30 if reason == "UNAVAILABLE" else None}
