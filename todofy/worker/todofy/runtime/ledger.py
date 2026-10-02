"""The mail_events ledger in D1. Only the coordinator Durable Object calls these.

Every state change is one compare-and-set on (state, version) batched with its
event_transitions row, and with the summaries row or owner action that belongs
to it, so either all of them commit or none do.
"""

from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any

from todofy.core.backoff import SUMMARY_CRASH_LIMIT
from todofy.core.sql import ledger as sql
from todofy.core.vocab import TERMINAL_STATES, Code, EventState

WORKER = "worker"
OWNER = "owner"
# STATE_CAS binding order after state, updated_at and the payload flag; the
# error code is bound separately because every transition sets it.
_MUTABLE = (
    "summary",
    "summary_model",
    "todo_body",
    "todoist_request_id",
    "task_id",
    "attempt_count",
    "crashes",
    "next_attempt_at",
)


@dataclass(frozen=True, slots=True)
class EventRow:
    """One mail_events row; times in Unix seconds."""

    source_id: str
    event_id: str
    state: EventState
    version: int
    payload: str | None
    summary: str
    summary_model: str
    todo_body: str
    todoist_request_id: str
    task_id: str
    attempt_count: int
    crashes: int
    next_attempt_at: int
    last_error_code: str
    imported: bool
    created_at: int
    updated_at: int
    # Set for a canary event (contracts/ops-v1): processed, never sent to Todoist.
    canary_run_id: str | None = None

    @property
    def canary(self) -> bool:
        return self.canary_run_id is not None

    @classmethod
    def from_d1(cls, row: Any) -> "EventRow":
        return cls(
            source_id=row["source_id"],
            event_id=row["event_id"],
            state=EventState(row["state"]),
            version=int(row["version"]),
            payload=row["payload"],
            summary=row["summary"],
            summary_model=row["summary_model"],
            todo_body=row["todo_body"],
            todoist_request_id=row["todoist_request_id"],
            task_id=row["task_id"],
            attempt_count=int(row["attempt_count"]),
            crashes=int(row["crashes"]),
            next_attempt_at=int(row["next_attempt_at"]),
            last_error_code=row["last_error_code"],
            imported=bool(row["imported"]),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
            canary_run_id=row["canary_run_id"],
        )


class Stored(StrEnum):
    NEW = "new"
    DUPLICATE = "duplicate"
    CONFLICT = "conflict"


class Claim(StrEnum):
    NEW = "new"
    REPLAY = "replay"
    CONFLICT = "conflict"


@dataclass(frozen=True, slots=True)
class ActionClaim:
    claim: Claim
    result_ref: str | None = None
    http_status: int | None = None


@dataclass(frozen=True, slots=True)
class OwnerAction:
    """An owner action recorded in the same batch as the transition it caused."""

    owner: str
    action_request_id: str
    kind: str
    request_hash: str


@dataclass(frozen=True, slots=True)
class CompletedSummary:
    """The report-cache row written when an event completes."""

    subject: str
    summary: str
    model: str
    task_id: str


async def ingest(
    db: Any, source_id: str, event_id: str, payload: str, payload_hash: str, now: int, canary_run_id: str | None = None
) -> Stored:
    results = await db.batch(
        [
            db.prepare(sql.INGEST.sql).bind(source_id, event_id, payload_hash, payload, now, now, now, canary_run_id),
            db.prepare(sql.ARRIVAL.sql).bind(now, source_id, event_id),
            db.prepare(sql.INGEST_HASH.sql).bind(source_id, event_id),
        ]
    )
    if results[0].meta.changes == 1:
        return Stored.NEW
    stored = results[2].results[0]["payload_hash"]
    return Stored.DUPLICATE if stored == payload_hash else Stored.CONFLICT


async def get(db: Any, source_id: str, event_id: str) -> EventRow | None:
    row = await db.prepare(sql.EVENT.sql).bind(source_id, event_id).first()
    return EventRow.from_d1(row) if row else None


async def next_due(db: Any, now: int, *, todoist: bool = True) -> EventRow | None:
    """The oldest due pending/summarized/todo_created row; no summarized rows without Todoist."""
    query = sql.NEXT_DUE if todoist else sql.NEXT_DUE_WITHOUT_TODOIST
    row = await db.prepare(query.sql).bind(now).first()
    return EventRow.from_d1(row) if row else None


async def next_lookup(db: Any, now: int) -> EventRow | None:
    row = await db.prepare(sql.LOOKUP_DUE.sql).bind(now).first()
    return EventRow.from_d1(row) if row else None


async def next_wake_at(db: Any, *, todoist: bool = True) -> int | None:
    """Earliest scheduled ledger work (lookups only when Todoist may be called)."""
    due = sql.NEXT_WAKE if todoist else sql.NEXT_WAKE_WITHOUT_TODOIST
    statements = [db.prepare(due.sql)]
    if todoist:
        statements.append(db.prepare(sql.NEXT_LOOKUP.sql))
    results = await db.batch(statements)
    times = [result.results[0]["at"] for result in results]
    return min((int(at) for at in times if at is not None), default=None)


async def owner_confirmed_resend(db: Any, event_id: str) -> bool:
    """Whether the owner's task_not_created is the latest word on this todo_unknown row.

    That is the only owner transition that leaves a row in todo_unknown; any
    later worker transition (a lookup result) supersedes it.
    """
    row = await db.prepare(sql.LATEST_TRANSITION.sql).bind(event_id).first()
    return bool(row) and row["actor"] == OWNER and row["to_state"] == EventState.TODO_UNKNOWN


async def recover_interrupted(db: Any, now: int, *, lookup_at: int) -> None:
    """Settle rows a previous run left mid-call (it was evicted or timed out).

    An interrupted summary is simply repeated, up to the crash limit; an
    interrupted Todoist call may have created the task, so it is never resent.
    A canary ends ``ignored`` where real mail would need the owner.
    """
    rows = (await db.prepare(sql.INTERRUPTED.sql).all()).results
    for row in map(EventRow.from_d1, rows):
        if row.canary and row.state == EventState.TODO_SENDING:
            # Only a release without canary handling sends a canary to Todoist; never look it up.
            await transition(
                db,
                row,
                EventState.IGNORED,
                actor=WORKER,
                now=now,
                code=Code.CANARY_SIDE_EFFECT_BLOCKED,
                next_attempt_at=0,
            )
        elif row.state == EventState.SUMMARIZING:
            crashes = row.crashes + 1
            if crashes >= SUMMARY_CRASH_LIMIT:
                await transition(
                    db,
                    row,
                    EventState.IGNORED if row.canary else EventState.FAILED_SUMMARY,
                    actor=WORKER,
                    now=now,
                    code=Code.PROCESSING_INTERRUPTED_LIMIT,
                    crashes=crashes,
                    next_attempt_at=0,
                )
            else:
                await transition(
                    db, row, EventState.PENDING, actor=WORKER, now=now, crashes=crashes, next_attempt_at=now
                )
        else:
            await transition(
                db,
                row,
                EventState.TODO_UNKNOWN,
                actor=WORKER,
                now=now,
                code=Code.INTERRUPTED_TODO_CALL,
                attempt_count=0,
                next_attempt_at=lookup_at,
            )


async def transition(
    db: Any,
    row: EventRow,
    to: EventState,
    *,
    actor: str,
    now: int,
    code: str = "",
    completed: CompletedSummary | None = None,
    action: OwnerAction | None = None,
    **columns: Any,
) -> EventRow | None:
    """Move ``row`` to ``to`` and return it as stored; None when it changed since it was read.

    ``columns`` sets mutable columns by name; the rest keep their value. A
    terminal state drops the mail body and everything derived from it.
    """
    if completed and action:
        # Each dependent insert is guarded by the row count of the statement just before it.
        raise TypeError("a transition records a completed summary or an owner action, not both")
    terminal = to in TERMINAL_STATES
    if terminal:
        columns = {"summary": "", "todo_body": "", **columns}
    unknown = columns.keys() - set(_MUTABLE)
    if unknown:
        raise TypeError(f"not a mutable column: {sorted(unknown)}")
    values = [columns.get(name) for name in _MUTABLE]
    version = row.version + 1
    key = (row.source_id, row.event_id)
    statements = [
        db.prepare(sql.STATE_CAS.sql).bind(to, now, int(terminal), *values, code, *key, row.state, row.version),
        db.prepare(sql.TRANSITION.sql).bind(now, row.state, to, code, actor, *key, version),
    ]
    if completed and completed.summary:
        statements.append(
            db.prepare(sql.COMPLETE_SUMMARY.sql).bind(
                now, completed.subject, completed.summary, completed.model, completed.task_id, *key, version
            )
        )
    if action:
        statements.append(
            db.prepare(sql.ACTION_WITH_TRANSITION.sql).bind(
                action.owner, action.action_request_id, action.kind, action.request_hash, now, *key, version
            )
        )
    results = await db.batch(statements)
    if results[0].meta.changes != 1:
        return None
    return replace(
        row,
        **columns,
        state=to,
        version=version,
        updated_at=now,
        last_error_code=code,
        payload=None if terminal else row.payload,
    )


async def find_action(db: Any, owner: str, action_request_id: str, request_hash: str) -> ActionClaim:
    row = await db.prepare(sql.OWNER_ACTION.sql).bind(owner, action_request_id).first()
    return _claim(row, request_hash)


async def claim_action(
    db: Any, owner: str, action_request_id: str, kind: str, request_hash: str, now: int
) -> ActionClaim:
    """Record an action before running it; a replay or reuse returns what is stored."""
    results = await db.batch(
        [
            db.prepare(sql.ACTION_CLAIM.sql).bind(owner, action_request_id, kind, request_hash, now),
            db.prepare(sql.OWNER_ACTION.sql).bind(owner, action_request_id),
        ]
    )
    if results[0].meta.changes == 1:
        return ActionClaim(Claim.NEW)
    return _claim(results[1].results[0], request_hash)


async def finish_action(db: Any, owner: str, action_request_id: str, result_ref: str | None, http_status: int) -> None:
    await db.prepare(sql.ACTION_FINISH.sql).bind(result_ref, http_status, owner, action_request_id).run()


async def release_action(db: Any, owner: str, action_request_id: str) -> None:
    """Forget a claimed action whose run failed, so that the same ID runs it again."""
    await db.prepare(sql.ACTION_RELEASE.sql).bind(owner, action_request_id).run()


async def take_over_action(
    db: Any, owner: str, action_request_id: str, request_hash: str, now: int, stale_before: int
) -> bool:
    """Claim again an action whose run never finished before ``stale_before`` (or that stored a failure); False
    while another run may still hold it."""
    result = await (
        db.prepare(sql.ACTION_TAKEOVER.sql).bind(now, owner, action_request_id, request_hash, stale_before).run()
    )
    return result.meta.changes == 1


def _claim(row: Any, request_hash: str) -> ActionClaim:
    if not row:
        return ActionClaim(Claim.NEW)
    if row["request_hash"] != request_hash:
        return ActionClaim(Claim.CONFLICT)
    status = row["http_status"]
    return ActionClaim(Claim.REPLAY, row["result_ref"], None if status is None else int(status))
