"""Replay receipts of the Plus writes that change Todoist, in TodofyCore's own SQLite (docs/todoist-plus.md,
"Receipts").

SetTaskPlan, SetTaskLead, CompleteTask, AppendTaskSteps and each label update of the Monday reset record a
receipt ``started`` with their frozen Sync commands, wait until the object's storage holds it, and only then
send them. ``done`` drops the commands and keeps the answer's IDs, never a title; CompleteTask's also keeps the
FlowDay settlement it froze, at ``$.focus``, and ReorderTasks' keeps nothing (runtime/plus_order.py). A replay
of a done request answers from those IDs, a started one resends the same commands, whose UUIDs (uuid5 of the
request ID) Todoist runs at most once. So a lost receipt only turns a replay into a re-run that Todoist
deduplicates: receipts may live in the object's SQLite, which no backup holds. A label write's started receipt
also keeps the plan etag its labels were chosen under: once the binding has changed, its retry answers
ETAG_MISMATCH instead of attaching a label by a stale name.

A lookup reads only the receipts of the last MAX_AGE, and an older request ID starts over. Nothing deletes a
receipt (the owner's rule: no automatic time-based deletion), so one that never finished keeps its commands,
step titles included, in the object's SQLite. ``writing`` names the tasks such an unfinished write of the last
MAX_AGE changes, which DeleteMailItems keeps (runtime/plus_mail.py).

D1 plus_actions holds the receipts of the releases before this one. They are read, never written: a request
ID of the last MAX_AGE that the object has no receipt for finds its D1 receipt.
"""

import json
from typing import Any, NamedTuple

from todofy.core.backoff import DAY
from todofy.core.sql import plus as sql
from todofy.runtime import native_plus
from todofy.runtime import plus_store as store
from todofy.runtime.interop import now_s

MAX_AGE = 30 * DAY

DO_SCHEMA = (
    native_plus.SCHEMA,
    "CREATE TABLE IF NOT EXISTS plus_receipts (request_id TEXT PRIMARY KEY, method TEXT NOT NULL,"
    " request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('started', 'done')), commands TEXT,"
    " plan_etag TEXT, result TEXT CHECK (result IS NULL OR length(result) <= 4096), created_at INTEGER NOT NULL,"
    " finished_at INTEGER, CHECK ((state = 'done') = (finished_at IS NOT NULL)),"
    " CHECK (state = 'started' OR commands IS NULL))",
    # The unfinished writes, for WRITING: few, since a write finishes or is retried within a visit.
    "CREATE INDEX IF NOT EXISTS plus_receipts_started ON plus_receipts (created_at) WHERE state = 'started'",
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
# Of the tasks bound (a JSON array), those a started receipt of the last MAX_AGE changes: an item_update,
# item_move or item_close names its task, an item_add (a step) its parent. A started deletion changes nothing a
# later deletion must keep, so it is not counted.
_WRITING_TASK = (
    "coalesce(nullif(c.value ->> '$.body.task.parent_id',''),substr(c.value ->> '$.body.task.name',7),"
    "substr(c.value ->> '$.body.name',7),c.value ->> '$.args.parent_id',c.value ->> '$.args.id')"
)
WRITING = (
    f"SELECT DISTINCT {_WRITING_TASK} AS task_id"
    " FROM plus_receipts AS r, json_each(r.commands) AS c"
    " WHERE r.state = 'started' AND r.created_at >= ? AND r.method <> 'DeleteMailItems'"
    f" AND {_WRITING_TASK} IN (SELECT value FROM json_each(?))"
)
# A CompleteTask receipt from D1, done there, with the settlement the release before froze (if any).
IMPORT = (
    "INSERT INTO plus_receipts (request_id, method, request_hash, state, result, created_at, finished_at)"
    " VALUES (?, 'CompleteTask', ?, 'done', ?, ?, ?) ON CONFLICT (request_id) DO NOTHING"
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
    commands: list[dict[str, Any]] | None  # the frozen Sync commands, until done
    plan_etag: str | None  # a label write's: the plan etag its commands' labels were chosen under
    result: dict[str, Any] | None  # once done: the answer's IDs, or a D1 receipt's whole stored answer
    legacy: bool  # a D1 plus_actions receipt of the release before


def _json(value: dict[str, Any] | list[dict[str, Any]]) -> str:
    return json.dumps(value, separators=(",", ":"))


async def find(core: Any, request_id: str) -> Receipt | None:
    """The object's receipt for ``request_id``, else the D1 one, of the last MAX_AGE."""
    since = now_s() - MAX_AGE
    rows = core.sql.exec(FIND, request_id, since).toArray()
    if rows:
        row = rows[0]
        if row.state == "done":
            return Receipt(str(row.request_hash), None, None, json.loads(row.result), legacy=False)
        etag = None if row.plan_etag is None else str(row.plan_etag)
        return Receipt(str(row.request_hash), json.loads(row.commands), etag, None, legacy=False)
    previous = await store.first(core.env.DB, sql.LEGACY_ACTION, request_id, since)
    if previous is None:
        return None
    response = previous["response"]
    return Receipt(
        previous["request_hash"],
        json.loads(previous["commands"]),
        None,  # the release before kept no etag: its started label write resends as it did there
        None if response is None else json.loads(response),
        legacy=True,
    )


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


def writing(store: Any, task_ids: list[str]) -> set[str]:
    """Which of ``task_ids`` an unfinished Plus write (a started receipt of the last MAX_AGE) changes: its labels,
    step, move or completion may not be in Todoist yet."""
    rows = store.exec(WRITING, now_s() - MAX_AGE, json.dumps(task_ids)).toArray()
    return {str(row.task_id) for row in rows}


def finish(store: Any, request_id: str, result: dict[str, Any]) -> None:
    """Done: the commands go, ``result`` (IDs only) stays."""
    store.exec(FINISH, _json(result), now_s(), request_id)


async def settle(core: Any, request_id: str, value: str | None, replace_etag: str | None) -> str | None:
    """The FlowDay settlement CompleteTask ``request_id`` freezes, or None when it has no done receipt.

    ``value`` freezes a settlement when none is frozen, or replaces the frozen one whose etag is
    ``replace_etag``; otherwise the frozen one is answered unchanged. A CompleteTask finished by the release
    before is first copied from D1, with the settlement it froze there.
    """
    now = now_s()
    rows = core.sql.exec(FOCUS, request_id, now - MAX_AGE).toArray()
    if not rows and await _copy_completion(core, request_id, now):
        rows = core.sql.exec(FOCUS, request_id, now - MAX_AGE).toArray()
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


async def _copy_completion(core: Any, request_id: str, now: int) -> bool:
    """Copy a done CompleteTask receipt and its frozen settlement from D1 plus_actions, if there is one."""
    rows = await store.rows(core.env.DB, sql.LEGACY_COMPLETION, request_id, "focus:" + request_id, now - MAX_AGE)
    found = {row["request_id"]: row for row in rows}
    completed = found.get(request_id)
    answer = json.loads(completed["response"]) if completed and completed["response"] is not None else None
    # Only CompleteTask answered with its task ID alone.
    if not isinstance(answer, dict) or set(answer) != {"task_id"}:
        return False
    result: dict[str, Any] = {"task_id": answer["task_id"]}
    if (focus := found.get("focus:" + request_id)) is not None:
        result["focus"] = json.loads(focus["commands"])
    core.sql.exec(IMPORT, request_id, completed["request_hash"], _json(result), int(completed["created_at"]), now)
    return True
