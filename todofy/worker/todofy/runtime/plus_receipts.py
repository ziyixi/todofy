"""Replay receipts of the Plus writes that change the task store, in TodofyCore's own SQLite (docs/planning-api.md,
"Receipts").

SetTaskPlan, SetTaskLead, CompleteTask, AppendTaskSteps, ReorderTasks, ConvertMailItem and each planning update of
the Monday reset record a receipt ``started`` with their frozen Tasks operations, wait until the object's storage
holds it, and only then send them. ``done`` drops the operations and keeps the answer's IDs, never a title;
CompleteTask's also keeps the FlowDay settlement it froze, at ``$.focus``, and ReorderTasks' keeps nothing
(runtime/plus_order.py). A replay of a done request answers from those IDs, a started one resends the same
operations, whose request IDs (uuid5 of the request ID) Tasks runs at most once (runtime/native_plus.py). So a lost
receipt only turns a replay into a re-run that Tasks deduplicates: receipts may live in the object's SQLite, which no
backup holds. A planning write's started receipt also keeps the plan etag it was chosen under: once that has
changed, its retry answers ETAG_MISMATCH.

A lookup reads only the receipts of the last MAX_AGE, and an older request ID starts over. Nothing deletes a
receipt (the owner's rule: no automatic time-based deletion), so one that never finished keeps its operations,
step titles included, in the object's SQLite.
"""

import json
from typing import Any, NamedTuple

from todofy.core.backoff import DAY
from todofy.runtime import native_plus
from todofy.runtime.interop import now_s

MAX_AGE = 30 * DAY

DO_SCHEMA = (
    native_plus.SCHEMA,
    "CREATE TABLE IF NOT EXISTS plus_receipts (request_id TEXT PRIMARY KEY, method TEXT NOT NULL,"
    " request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('started', 'done')), commands TEXT,"
    " plan_etag TEXT, result TEXT CHECK (result IS NULL OR length(result) <= 4096), created_at INTEGER NOT NULL,"
    " finished_at INTEGER, CHECK ((state = 'done') = (finished_at IS NOT NULL)),"
    " CHECK (state = 'started' OR commands IS NULL))",
    # Nothing reads the unfinished receipts by this index any more.
    "DROP INDEX IF EXISTS plus_receipts_started",
)
FIND = (
    "SELECT request_hash, state, commands, plan_etag, result FROM plus_receipts"
    " WHERE request_id = ? AND created_at >= ?"
)
# A started receipt keeps its commands; one older than MAX_AGE is replaced, as if it did not exist.
START = (
    "INSERT INTO plus_receipts (request_id, method, request_hash, state, commands, plan_etag, created_at)"
    " VALUES (?, ?, ?, 'started', ?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET method = excluded.method,"
    " request_hash = excluded.request_hash, state = 'started', commands = excluded.commands,"
    " plan_etag = excluded.plan_etag, result = NULL, created_at = excluded.created_at, finished_at = NULL"
    " WHERE plus_receipts.created_at < ?"
)
FINISH = (
    "UPDATE plus_receipts SET state = 'done', commands = NULL, result = ?, finished_at = ?"
    " WHERE request_id = ? AND state = 'started'"
)
FOCUS = (
    "SELECT result ->> '$.focus' AS focus FROM plus_receipts"
    " WHERE request_id = ? AND method = 'CompleteTask' AND state = 'done' AND created_at >= ?"
)
# Compare-and-set: the first settlement frozen wins, and only the one whose timer etag FlowDay refused (409)
# is replaced (gateway/src/plus.ts settleCompleted).
SETTLE = (
    "UPDATE plus_receipts SET result = json_set(result, '$.focus', json(?))"
    " WHERE request_id = ? AND method = 'CompleteTask' AND state = 'done'"
    " AND ((? IS NULL AND result ->> '$.focus' IS NULL) OR result ->> '$.focus.etag' = ?)"
)


class Receipt(NamedTuple):
    request_hash: str
    commands: list[dict[str, Any]] | None  # the frozen Tasks operations, until done
    plan_etag: str | None  # a planning write's: the plan etag its operations were chosen under
    result: dict[str, Any] | None  # once done: the answer's IDs


def _json(value: dict[str, Any] | list[dict[str, Any]]) -> str:
    return json.dumps(value, separators=(",", ":"))


async def find(core: Any, request_id: str) -> Receipt | None:
    """The object's receipt for ``request_id`` of the last MAX_AGE."""
    rows = core.sql.exec(FIND, request_id, now_s() - MAX_AGE).toArray()
    if not rows:
        return None
    row = rows[0]
    if row.state == "done":
        return Receipt(str(row.request_hash), None, None, json.loads(row.result))
    etag = None if row.plan_etag is None else str(row.plan_etag)
    return Receipt(str(row.request_hash), json.loads(row.commands), etag, None)


async def start(
    core: Any,
    request_id: str,
    method: str,
    request_hash: str,
    commands: list[dict[str, Any]],
    plan_etag: str | None = None,
) -> None:
    """Record ``commands`` before they are sent (a started receipt keeps the ones it has, with its
    ``plan_etag``), and wait until the object's storage holds them: Cloudflare documents the output gate that
    holds back a fetch for put() and delete() only, not for an SQL write."""
    now = now_s()
    core.sql.exec(START, request_id, method, request_hash, _json(commands), plan_etag, now, now - MAX_AGE)
    await core.ctx.storage.sync()


def finish(store: Any, request_id: str, result: dict[str, Any]) -> None:
    """Done: the commands go, ``result`` (IDs only) stays."""
    store.exec(FINISH, _json(result), now_s(), request_id)


async def settle(core: Any, request_id: str, value: str | None, replace_etag: str | None) -> str | None:
    """The FlowDay settlement CompleteTask ``request_id`` freezes, or None when it has no done receipt.

    ``value`` freezes a settlement when none is frozen, or replaces the frozen one whose etag is
    ``replace_etag``; otherwise the frozen one is answered unchanged.
    """
    rows = core.sql.exec(FOCUS, request_id, now_s() - MAX_AGE).toArray()
    if not rows:
        return None
    frozen = rows[0].focus
    if value is None:
        return frozen
    if core.sql.exec(SETTLE, value, request_id, replace_etag, replace_etag).rowsWritten == 0:
        return frozen
    # The gateway sends what this answers to FlowDay.
    await core.ctx.storage.sync()
    return value
