"""Replay receipts of the Mail writes, in TodofyCore's own SQLite (docs/planning-api.md, "Receipts").

ConvertMailItem records a receipt ``started`` with its frozen Tasks operation, waits until the object's storage
holds it, and only then sends it; DeleteMailSummaries records one with no operation. ``done`` drops the operations
and keeps the answer's IDs, never a title. A replay of a done request answers from those IDs, a started one resends
the same operations, whose request IDs (core/mailbox.command_id of the request ID) Tasks runs at most once and
answers again from its own receipt. So a lost receipt only turns a replay into a re-run that Tasks deduplicates:
receipts may live in the object's SQLite, which no backup holds.

A lookup reads only the receipts of the last MAX_AGE, and an older request ID starts over. Nothing deletes a
receipt (the owner's rule: no automatic time-based deletion), so one that never finished keeps its operations in the
object's SQLite. Planning is Tasks' now: the receipts of Todofy's planning writes (with their plan_etag) and their
operation journal (native_task_requests) stay in the object as they are, and nothing reads them.
"""

import json
from typing import Any, NamedTuple

from todofy.core.backoff import DAY
from todofy.runtime.interop import now_s

MAX_AGE = 30 * DAY

DO_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS plus_receipts (request_id TEXT PRIMARY KEY, method TEXT NOT NULL,"
    " request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('started', 'done')), commands TEXT,"
    " plan_etag TEXT, result TEXT CHECK (result IS NULL OR length(result) <= 4096), created_at INTEGER NOT NULL,"
    " finished_at INTEGER, CHECK ((state = 'done') = (finished_at IS NOT NULL)),"
    " CHECK (state = 'started' OR commands IS NULL))",
    # Nothing reads the unfinished receipts by this index any more.
    "DROP INDEX IF EXISTS plus_receipts_started",
)
FIND = "SELECT request_hash, state, commands, result FROM plus_receipts WHERE request_id = ? AND created_at >= ?"
# A started receipt keeps its commands; one older than MAX_AGE is replaced, as if it did not exist.
START = (
    "INSERT INTO plus_receipts (request_id, method, request_hash, state, commands, created_at)"
    " VALUES (?, ?, ?, 'started', ?, ?) ON CONFLICT (request_id) DO UPDATE SET method = excluded.method,"
    " request_hash = excluded.request_hash, state = 'started', commands = excluded.commands, plan_etag = NULL,"
    " result = NULL, created_at = excluded.created_at, finished_at = NULL WHERE plus_receipts.created_at < ?"
)
FINISH = (
    "UPDATE plus_receipts SET state = 'done', commands = NULL, result = ?, finished_at = ?"
    " WHERE request_id = ? AND state = 'started'"
)


class Receipt(NamedTuple):
    request_hash: str
    commands: list[dict[str, Any]] | None  # the frozen Tasks operations, until done
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
        return Receipt(str(row.request_hash), None, json.loads(row.result))
    return Receipt(str(row.request_hash), json.loads(row.commands), None)


async def start(core: Any, request_id: str, method: str, request_hash: str, commands: list[dict[str, Any]]) -> None:
    """Record ``commands`` before they are sent (a started receipt keeps the ones it has), and wait until the
    object's storage holds them: Cloudflare documents the output gate that holds back a fetch for put() and delete()
    only, not for an SQL write."""
    now = now_s()
    core.sql.exec(START, request_id, method, request_hash, _json(commands), now, now - MAX_AGE)
    await core.ctx.storage.sync()


def finish(store: Any, request_id: str, result: dict[str, Any]) -> None:
    """Done: the commands go, ``result`` (IDs only) stays."""
    store.exec(FINISH, _json(result), now_s(), request_id)
