"""task-intent-v1 rules for Todofy (contracts/task-intent-v1): input checks, the canonical form, task
text, the per-task state machine and the results.

Pure stdlib, host-tested; runtime/intents.py runs it against D1 and Todoist. The messages and enums are
generated from proto/todofy/taskintent/v1/task_intent.proto (``ziyixi_proto``, stdlib only too; never
committed, ``uv sync`` builds it, proto/README.md). An input is read strictly with the wire JSON profile,
which refuses what the structure shows (unknown fields and enum names, null, wrong types, a missing
REQUIRED field); the contract's value rules the IDL cannot express (lengths, patterns, 1-30 distinct items)
are checked here. Every result is a generated ``TaskIntentResult`` written with ``to_wire``, built from
codes, counts, booleans, the caller's own identifiers and a timestamp, so it can never carry task text or
Todoist IDs (tests validate every result against contracts/task-intent-v1/task-intent-v1.schema.json).

The ledger (migrations/0005_task_intents.sql) stores an error code by its wire name ("" for none):
``code_name`` and ``code_of`` convert at the D1 boundary, and a name this build does not know reads as
``ErrorCode.UNSPECIFIED``, which a result writes as null (the default branch, never a guess).

Patterns use ``fullmatch``: ``$`` would accept a trailing newline, like the schema's ``$(?!\\n)``.
"""

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from enum import IntEnum, StrEnum
from typing import Any, NoReturn

from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire, wire_member, wire_name

from .backoff import DAY, HOUR, MINUTE, postpone_delay, retry_delay
from .classify import TaskResult
from .ops import InvalidInput, OpsError, timestamp
from .vocab import Code

# The generated enums of the contract: a result's state and error code, a message's source and mode.
State = pb.State
ErrorCode = pb.ErrorCode

VERSION = "task-intent-v1"
# No error code: null on the wire, "" in D1.
NO_CODE = ErrorCode.UNSPECIFIED


def _names(cls: type[IntEnum]) -> tuple[str, ...]:
    """The wire names of a generated enum, in value order (its zero value has none)."""
    return tuple(name for member in cls if (name := wire_name(member)) is not None)


# The task_intents.mode column's values.
MODES = _names(pb.Mode)
# The sources the contract knows (its Source enum); Todofy accepts those listed in TASK_INTENT_SOURCES.
SOURCES = _names(pb.Source)

# TASK_INTENT_LIMITS of task-intent-v1.ts.
ITEMS_MAX = 30
TASKS_MAX = 31
PARENT_TITLE_MAX = 200
ITEM_TITLE_MAX = 300
DESCRIPTION_MAX = 1000
URL_MAX = 500
INTENTS_PER_SOURCE_PER_DAY = 10
INTENT_MAX_BYTES = 65536
STATUS_MIN_INTERVAL = 3
RETRY_AFTER_MAX = DAY

# Automatic work per task and per alarm step (README "Todofy's side").
TASK_MAX_ATTEMPTS = 48
TASK_RETRY_WINDOW = 7 * DAY
LOOKUP_MAX_ATTEMPTS = 6
STEP_CREATES = 6
STEP_LOOKUPS = 1
# No new Todoist call starts once a step has run this long (each create has its own 45 s budget).
STEP_BUDGET = 60
# Retention (runtime/retention.py): a failed intent's text after 30 days, every row 400 days after
# its last change.
FAILED_PAYLOAD_DAYS = 30
ROW_DAYS = 400

# retry_after_seconds of a paused answer, per reason (the Todoist auth block reports its own end).
PAUSE_RETRY = {
    ErrorCode.MAINTENANCE: HOUR,
    ErrorCode.PROCESSING_PAUSED: HOUR,
    ErrorCode.TODOIST_PAUSED: HOUR,
    ErrorCode.BACKUP_ACTIVE: 2 * MINUTE,
}

INTENT_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}", re.ASCII)
BLOCK_TEXT = re.compile(r"[^\x00-\x09\x0b-\x1f\x7f]*")
TITLE = re.compile(r"[^\x00-\x1f\x7f\u2028\u2029]+")
HTTPS_URL = re.compile(r"https://([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(/[A-Za-z0-9._~/%-]{0,400})?", re.ASCII)
FOOTER_PREFIX = "Todofy intent: "


def code_name(code: ErrorCode) -> str:
    """How the ledger and the logs spell an error code: its wire name, "" for none."""
    return wire_name(code) or ""


def code_of(name: Any) -> ErrorCode:
    """A stored error code: "" and a name this build does not know read as ``ErrorCode.UNSPECIFIED``."""
    return wire_member(ErrorCode, name) or ErrorCode.UNSPECIFIED


class IntentState(StrEnum):
    """task_intents.state (migrations/0005_task_intents.sql); paused is never stored."""

    PENDING = "pending"
    CREATED = "created"
    FAILED = "failed"


class TaskState(StrEnum):
    """task_intent_tasks.state.

    pending: send the frozen request when due. sending: a call is in flight (found at the start of
    a step, it was interrupted and becomes unknown). unknown: the call may have created the task; a
    read-only footer lookup decides, and finding nothing fails the task. recheck: the same lookup
    after the proposer retried a failed intent; finding nothing then resends. created / failed: done.
    """

    PENDING = "pending"
    SENDING = "sending"
    UNKNOWN = "unknown"
    RECHECK = "recheck"
    CREATED = "created"
    FAILED = "failed"


def _invalid() -> NoReturn:
    raise InvalidInput(OpsError.INVALID_INPUT)


# ---- input -------------------------------------------------------------------------------


def loads(text: Any) -> Any:
    """Strict JSON of at most INTENT_MAX_BYTES (the gateway checks the same bound first)."""
    if not isinstance(text, str) or len(text) > INTENT_MAX_BYTES:
        _invalid()
    try:
        if len(text.encode()) > INTENT_MAX_BYTES:
            _invalid()
        return json.loads(text, parse_constant=lambda name: _invalid())
    except (ValueError, RecursionError, UnicodeEncodeError):
        _invalid()


def _read[M](cls: type[M], value: Any) -> M:
    """A strict wire read: the structure of the contract (closed objects, known enum names, types)."""
    try:
        return from_wire(cls, value, strict=True).message
    except WireJsonError:
        _invalid()


def _text(value: str, pattern: re.Pattern[str], low: int, high: int) -> str:
    if not low <= len(value) <= high or not pattern.fullmatch(value):
        _invalid()
    try:
        value.encode()  # a lone surrogate (JSON "\\ud800") cannot be stored or sent
    except UnicodeEncodeError:
        _invalid()
    return value


def _id(value: str) -> str:
    if not INTENT_ID.fullmatch(value):
        _invalid()
    return value


def _version(value: str) -> None:
    if value != VERSION:
        _invalid()


def _wire_text(message: Any) -> str:
    """A message's wire JSON, compact: the bytes the contract sends and Todofy hashes."""
    return json.dumps(to_wire(message), ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True, slots=True)
class Intent:
    """A TaskIntent that passed every rule of the schema; ``canonical`` is its frozen form (its wire JSON,
    compact: fields in schema order, absent optionals left out) and ``sha256`` that form's hash."""

    message: pb.TaskIntent
    canonical: str
    sha256: str

    @property
    def source(self) -> str:
        return wire_name(self.message.source) or ""

    @property
    def intent_id(self) -> str:
        return self.message.intent_id

    @property
    def mode(self) -> str:
        """The wire name, as task_intents.mode stores it."""
        return wire_name(self.message.mode) or ""

    @property
    def parent_title(self) -> str:
        return self._parent.title

    @property
    def parent_description(self) -> str | None:
        return self._parent.description

    @property
    def items(self) -> tuple[pb.TaskIntentItem, ...]:
        return self.message.items

    @property
    def _parent(self) -> pb.TaskIntentParent:
        parent = self.message.parent
        assert parent is not None, "a strict read never leaves a REQUIRED message unset"
        return parent

    @property
    def tasks_total(self) -> int:
        return len(self.items) + (1 if self.message.mode == pb.Mode.SUBTASKS else 0)

    @property
    def task_numbers(self) -> range:
        """n of every task: 0 is the parent (subtasks only), item i is n = i + 1 in both modes."""
        return range(0 if self.message.mode == pb.Mode.SUBTASKS else 1, len(self.items) + 1)


def _item(item: pb.TaskIntentItem) -> None:
    _text(item.title, TITLE, 1, ITEM_TITLE_MAX)
    if item.url is not None:
        _text(item.url, HTTPS_URL, 0, URL_MAX)
    if item.description is not None:
        _text(item.description, BLOCK_TEXT, 0, DESCRIPTION_MAX)


def intent(value: Any) -> Intent:
    """A TaskIntent: the strict wire read, then every value rule of the schema (lengths, patterns, 1-30
    distinct items). Absent and empty descriptions stay different, as on the wire."""
    message = _read(pb.TaskIntent, value)
    _version(message.version)
    _id(message.intent_id)
    parent = message.parent
    if parent is None:  # REQUIRED: a strict read refuses a missing or null parent; kept for the type
        _invalid()
    _text(parent.title, TITLE, 1, PARENT_TITLE_MAX)
    if parent.description is not None:
        _text(parent.description, BLOCK_TEXT, 0, DESCRIPTION_MAX)
    if not 1 <= len(message.items) <= ITEMS_MAX or len(set(message.items)) != len(message.items):
        _invalid()
    for item in message.items:
        _item(item)
    text = _wire_text(message)
    return Intent(message, text, hashlib.sha256(text.encode()).hexdigest())


def ref(value: Any) -> tuple[str, str]:
    """A TaskIntentRef as (source, intent_id)."""
    message = _read(pb.TaskIntentRef, value)
    _version(message.version)
    return wire_name(message.source) or "", _id(message.intent_id)


def stored(payload_json: str) -> Intent:
    """The intent a ledger row froze (its canonical JSON); InvalidInput if it no longer reads."""
    return intent(loads(payload_json))


def url_host(url: str) -> str:
    match = HTTPS_URL.fullmatch(url)
    assert match is not None, "validated URLs only"
    return match.group(1)


def url_hosts(watch_host: str) -> Mapping[str, tuple[str, ...]]:
    """Exact source hosts; deployment identity is supplied by Todofy's caller."""
    return {"lab": ("arxiv.org",), "watch": (watch_host,)}


def urls_allowed(value: Intent, *, watch_host: str) -> bool:
    """Every item URL's host is on the source's allow-list (Todofy never fetches them)."""
    hosts = url_hosts(watch_host).get(value.source, ())
    return all(item.url is None or url_host(item.url) in hosts for item in value.items)


# ---- task text ---------------------------------------------------------------------------


def footer(source: str, intent_id: str, n: int) -> str:
    """The last line of every task's description, and the key of the read-only lookup."""
    return f"{FOOTER_PREFIX}{source}/{intent_id}#{n}"


def has_footer(description: str, text: str) -> bool:
    """Whether a task description ends with this footer line. Only the last line counts: every task
    Todofy creates ends with its own footer, so text the proposer supplied (which may quote another
    task's footer) can never make one task look like another."""
    lines = description.strip().splitlines()
    return bool(lines) and lines[-1].strip() == text


def task_text(value: Intent, n: int) -> tuple[str, str]:
    """(content, description) of task ``n``: deterministic, so every attempt sends the same bytes.

    content is the title as given; the description is the item's description, its URL, in
    separate mode a line naming the parent title, then the footer, as blocks.
    """
    if n == 0:
        if value.mode != "subtasks":
            raise ValueError("only subtasks mode has a parent task")
        blocks = [value.parent_description, footer(value.source, value.intent_id, 0)]
        return value.parent_title, "\n\n".join(block for block in blocks if block)
    item = value.items[n - 1]
    blocks = [item.description, item.url]
    if value.mode == "separate":
        blocks.append(f"— {value.parent_title}")
    blocks.append(footer(value.source, value.intent_id, n))
    return item.title, "\n\n".join(block for block in blocks if block)


# ---- the state machine -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Task:
    """One task_intent_tasks row (``error_code`` read with ``code_of``, stored with ``code_name``)."""

    n: int
    request_id: str
    state: str
    attempts: int
    next_attempt_at: int
    todoist_id: str | None
    error_code: ErrorCode
    started_at: int

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Task":
        return cls(
            int(row["n"]),
            str(row["request_id"]),
            str(row["state"]),
            int(row["attempts"]),
            int(row["next_attempt_at"]),
            None if row["todoist_id"] is None else str(row["todoist_id"]),
            code_of(row["error_code"]),
            int(row["started_at"]),
        )


def interrupted(task: Task, lookup_at: int) -> Task:
    """A task a step left in ``sending`` (evicted mid-call): the call may have created it."""
    return replace(task, state=TaskState.UNKNOWN, attempts=0, next_attempt_at=lookup_at, error_code=NO_CODE)


def after_create(
    task: Task,
    result: TaskResult,
    code: str | None,
    retry_after: float,
    todoist_id: str,
    now: int,
    *,
    backoff_base: float,
    lookup_at: int,
    blocked_until: int,
) -> tuple[Task, bool]:
    """The task after one create call (classify.final_task_verdict), and whether the step stops.

    A call that may have created the task is never resent from here: it goes to the lookup.
    """
    match result:
        case TaskResult.CREATED:
            done = replace(
                task,
                state=TaskState.CREATED,
                next_attempt_at=0,
                todoist_id=todoist_id,
                error_code=NO_CODE,
            )
            return replace(done, attempts=task.attempts + 1), False
        case TaskResult.UNKNOWN:
            return interrupted(task, lookup_at), False
        case TaskResult.BLOCKED:
            # 401/403: the existing 6 h Todoist block holds every Todoist call, this one included.
            return replace(task, state=TaskState.PENDING, next_attempt_at=blocked_until, error_code=NO_CODE), True
    if code == Code.TODOIST_REJECTED:
        return failed(task, ErrorCode.TODOIST_REJECTED), False
    attempts = task.attempts + 1
    if attempts >= TASK_MAX_ATTEMPTS or now - task.started_at >= TASK_RETRY_WINDOW:
        # Nothing was created (only provably-unsent failures come here): the proposer may retry.
        return replace(failed(task, ErrorCode.TODOIST_REJECTED), attempts=attempts), True
    wait = ErrorCode.RATE_LIMITED if code == Code.TODOIST_RATE_LIMITED else ErrorCode.RETRY_WAIT
    delay = math.ceil(postpone_delay(task.attempts, retry_after, backoff_base))
    return replace(
        task, state=TaskState.PENDING, attempts=attempts, next_attempt_at=now + max(delay, 1), error_code=wait
    ), True


def after_lookup(task: Task, found: Sequence[str] | None, now: int, *, backoff_base: float) -> Task:
    """The task after a read-only footer lookup (``found``: IDs of active tasks carrying its footer,
    None when the scan failed or did not finish). Any match means the task exists; with several
    (duplicates made elsewhere) the first is kept and nothing more is created."""
    if found:
        return replace(
            task,
            state=TaskState.CREATED,
            attempts=0,
            next_attempt_at=0,
            todoist_id=found[0],
            error_code=NO_CODE,
        )
    if found is not None:
        if task.state == TaskState.RECHECK:
            # The proposer asked again and Todoist has no such task: resend the frozen request.
            return replace(task, state=TaskState.PENDING, attempts=0, next_attempt_at=now, error_code=NO_CODE)
        return failed(task, ErrorCode.TODOIST_RESULT_UNKNOWN)
    attempts = task.attempts + 1
    if attempts >= LOOKUP_MAX_ATTEMPTS:
        return replace(failed(task, ErrorCode.TODOIST_RESULT_UNKNOWN), attempts=attempts)
    delay = math.ceil(retry_delay(task.attempts, backoff_base))
    return replace(task, attempts=attempts, next_attempt_at=now + max(delay, 1))


def failed(task: Task, code: ErrorCode) -> Task:
    return replace(task, state=TaskState.FAILED, next_attempt_at=0, error_code=code)


def requeued(task: Task, now: int) -> Task:
    """What the proposer's retry of a failed intent does to one task (REQUEUE_TASKS in SQL)."""
    if task.state not in (TaskState.FAILED, TaskState.PENDING):
        return task
    unknown = task.state == TaskState.FAILED and task.error_code == ErrorCode.TODOIST_RESULT_UNKNOWN
    return replace(
        task,
        state=TaskState.RECHECK if unknown else TaskState.PENDING,
        attempts=0,
        next_attempt_at=now,
        error_code=NO_CODE,
        started_at=now,
    )


def _parent_gate(mode: str, tasks: Sequence[Task]) -> Task | None:
    """The parent task every other task waits for (subtasks mode), or None."""
    return tasks[0] if mode == "subtasks" and tasks and tasks[0].n == 0 else None


def next_action(
    mode: str, tasks: Sequence[Task], now: int, *, lookups_left: int, creates_left: int, acted: set[int]
) -> tuple[str, int] | None:
    """("lookup" | "create", n) for the next unit of work in this step, or None.

    Lookups first (an unknown parent must be settled before any child is sent), then creates in
    order; in subtasks mode no child is sent before its parent exists, and none once it failed.
    """
    parent = _parent_gate(mode, tasks)
    if parent is not None and parent.state == TaskState.FAILED:
        return None
    if lookups_left > 0:
        for task in tasks:
            if task.state in (TaskState.UNKNOWN, TaskState.RECHECK) and 0 < task.next_attempt_at <= now:
                return "lookup", task.n
    if creates_left > 0:
        for task in tasks:
            gated = parent is not None and task.n > 0 and parent.state != TaskState.CREATED
            if task.state == TaskState.PENDING and task.next_attempt_at <= now and task.n not in acted and not gated:
                return "create", task.n
    return None


@dataclass(frozen=True, slots=True)
class Summary:
    """What task_intents stores after a step."""

    state: IntentState
    tasks_created: int
    error_code: ErrorCode
    next_attempt_at: int


def summarize(mode: str, tasks: Sequence[Task]) -> Summary:
    """The intent's state from its tasks: created when all exist; failed when no task can make
    progress any more (every unfinished task failed, or the parent failed); else pending, due when
    its earliest actionable task is."""
    created = sum(task.state == TaskState.CREATED for task in tasks)
    if created == len(tasks):
        return Summary(IntentState.CREATED, created, NO_CODE, 0)
    parent = _parent_gate(mode, tasks)
    live = [task for task in tasks if task.state not in (TaskState.CREATED, TaskState.FAILED)]
    if parent is not None and parent.state != TaskState.CREATED:
        live = [] if parent.state == TaskState.FAILED else [parent]
    if not live:
        first = next(task for task in tasks if task.state == TaskState.FAILED)
        return Summary(IntentState.FAILED, created, first.error_code or ErrorCode.TODOIST_REJECTED, 0)
    codes = {task.error_code for task in live}
    code = next((c for c in (ErrorCode.RATE_LIMITED, ErrorCode.RETRY_WAIT) if c in codes), NO_CODE)
    return Summary(IntentState.PENDING, created, code, min(task.next_attempt_at for task in live))


# ---- results -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class IntentRow:
    """One task_intents row (payload_json is not needed for results)."""

    source: str
    intent_id: str
    payload_sha256: str
    mode: str
    tasks_total: int
    tasks_created: int
    state: str
    error_code: ErrorCode
    next_attempt_at: int
    created_at: int
    updated_at: int

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "IntentRow":
        return cls(
            str(row["source"]),
            str(row["intent_id"]),
            str(row["payload_sha256"]),
            str(row["mode"]),
            int(row["tasks_total"]),
            int(row["tasks_created"]),
            str(row["state"]),
            code_of(row["error_code"]),
            int(row["next_attempt_at"]),
            int(row["created_at"]),
            int(row["updated_at"]),
        )


def _seconds(value: float | None) -> int | None:
    return None if value is None else max(1, min(RETRY_AFTER_MAX, math.ceil(value)))


def result(
    source: str,
    intent_id: str,
    state: State,
    *,
    recorded: bool,
    updated_at: int,
    total: int = 0,
    created: int = 0,
    code: ErrorCode = NO_CODE,
    retry_after: float | None = None,
) -> dict[str, Any]:
    """A TaskIntentResult in wire JSON (numbers, codes and the caller's own identifiers only).

    ``source`` is a wire name Todofy read or stored; ``ErrorCode.UNSPECIFIED`` is written as null.
    """
    message = pb.TaskIntentResult(
        version=VERSION,
        source=wire_member(pb.Source, source) or pb.Source.UNSPECIFIED,
        intent_id=intent_id,
        state=state,
        recorded=recorded,
        tasks_total=total,
        tasks_created=created,
        error_code=code,
        retry_after_seconds=_seconds(retry_after),
        updated_at=timestamp(updated_at),
    )
    return to_wire(message)


# Why intents are held, and when to ask again.
Pause = tuple[ErrorCode, int]


def pause(
    *, maintenance: bool, processing_paused: bool, force_pause: bool, blocked_until: int, backup_active: bool, now: int
) -> Pause | None:
    """Why Todofy holds intents now, first reason first, with when to ask again; None when it does not."""
    if maintenance:
        return ErrorCode.MAINTENANCE, PAUSE_RETRY[ErrorCode.MAINTENANCE]
    if processing_paused:
        return ErrorCode.PROCESSING_PAUSED, PAUSE_RETRY[ErrorCode.PROCESSING_PAUSED]
    if force_pause:
        return ErrorCode.TODOIST_PAUSED, PAUSE_RETRY[ErrorCode.TODOIST_PAUSED]
    if blocked_until > now:
        return ErrorCode.TODOIST_BLOCKED, blocked_until - now
    if backup_active:
        return ErrorCode.BACKUP_ACTIVE, PAUSE_RETRY[ErrorCode.BACKUP_ACTIVE]
    return None


def describe(row: IntentRow, held: Pause | None, now: int, *, proposing: bool) -> dict[str, Any]:
    """The result for a recorded intent (a replayed proposal, or taskIntentStatus)."""
    common = {"recorded": True, "updated_at": row.updated_at, "total": row.tasks_total, "created": row.tasks_created}
    if row.state == IntentState.CREATED:
        state = State.DUPLICATE if proposing else State.CREATED
        return result(row.source, row.intent_id, state, **common)
    if row.state == IntentState.FAILED:
        if proposing and held is not None:
            # The proposer's retry while a pause holds: nothing is re-queued (no write under a pause), so the
            # answer is the pause, not the old failure. taskIntentStatus keeps answering failed; a proposal
            # after the pause re-queues the unfinished tasks.
            return result(row.source, row.intent_id, State.PAUSED, code=held[0], retry_after=held[1], **common)
        return result(row.source, row.intent_id, State.FAILED, code=row.error_code, **common)
    if held is not None:
        return result(row.source, row.intent_id, State.PAUSED, code=held[0], retry_after=held[1], **common)
    wait = max(row.next_attempt_at - now, STATUS_MIN_INTERVAL)
    return result(row.source, row.intent_id, State.PENDING, code=row.error_code, retry_after=wait, **common)


def conflict(row: IntentRow) -> dict[str, Any]:
    """Another content already holds this intent_id: the stored intent's counts, nothing changed."""
    return result(
        row.source,
        row.intent_id,
        State.REJECTED,
        recorded=True,
        updated_at=row.updated_at,
        total=row.tasks_total,
        created=row.tasks_created,
        code=ErrorCode.INTENT_CONFLICT,
    )


def rejected_new(source: str, intent_id: str, code: ErrorCode, now: int, retry_after: float | None = None) -> dict:
    """Refused before anything was recorded or sent (daily limit, URL, source)."""
    return result(source, intent_id, State.REJECTED, recorded=False, updated_at=now, code=code, retry_after=retry_after)


def paused_new(source: str, intent_id: str, held: Pause, now: int) -> dict[str, Any]:
    """A pause holds and nothing was recorded: the proposer may propose again later."""
    return result(source, intent_id, State.PAUSED, recorded=False, updated_at=now, code=held[0], retry_after=held[1])


def recorded_new(value: Intent, now: int) -> dict[str, Any]:
    """The answer to a proposal just recorded: pending, the alarm creates the tasks."""
    return result(
        value.source,
        value.intent_id,
        State.PENDING,
        recorded=True,
        updated_at=now,
        total=value.tasks_total,
        retry_after=STATUS_MIN_INTERVAL,
    )


def not_found(source: str, intent_id: str, now: int) -> dict[str, Any]:
    return result(source, intent_id, State.NOT_FOUND, recorded=False, updated_at=now)


def day_start(now: int) -> int:
    return now - now % DAY


def until_tomorrow(now: int) -> int:
    """Seconds until the next UTC midnight, when a source's daily limit starts over."""
    return day_start(now) + DAY - now
