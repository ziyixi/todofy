"""Map one upstream HTTP attempt to what the state machine does next (v2 plan §5.3).

The rule that shapes every table here: a call that may have reached the
upstream is never repeated blindly. Only failures that provably did not
create anything are retried later; the rest become "unknown" for the owner.
"""

from dataclasses import dataclass
from enum import StrEnum

from .vocab import Code, EventState, ReminderState


class Failure(StrEnum):
    NOT_SENT = "not_sent"  # the request provably never left, e.g. connect refused
    TIMEOUT = "timeout"  # our deadline fired; the upstream may still act on it
    LOST = "lost"  # the connection broke after sending


@dataclass(frozen=True, slots=True)
class HttpOutcome:
    """Either an HTTP ``status`` or a transport ``failure``."""

    status: int | None = None
    failure: Failure | None = None
    retry_after: float = 0.0

    def __post_init__(self) -> None:
        if (self.status is None) == (self.failure is None):
            raise ValueError("an outcome has exactly one of status and failure")

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300


_GATEWAY = frozenset({502, 503, 504})


@dataclass(frozen=True, slots=True)
class GeminiVerdict:
    ok: bool
    code: Code | None = None
    next_model: bool = False  # this failure is specific to the model, try the next one
    retry_after: float = 0.0


def classify_gemini(outcome: HttpOutcome, text: str | None) -> GeminiVerdict:
    """``text`` is the first candidate's text of a 2xx response, if any.

    With every model tried, the last verdict's code is the step's code.
    """
    if outcome.ok:
        if text and text.strip():
            return GeminiVerdict(ok=True)
        return GeminiVerdict(ok=False, code=Code.SUMMARY_FAILED, next_model=True)
    status = outcome.status
    if status == 429:
        return GeminiVerdict(ok=False, code=Code.LLM_QUOTA, next_model=True, retry_after=outcome.retry_after)
    if status is None or status >= 500:
        return GeminiVerdict(ok=False, code=Code.SUMMARY_FAILED, next_model=True)
    # 404 is usually a retired model name; 400/401/403 fail the same on every model.
    return GeminiVerdict(ok=False, code=Code.LLM_REQUEST_REJECTED, next_model=status == 404)


class TaskResult(StrEnum):
    CREATED = "created"  # -> complete
    RETRY_LATER = "retry_later"  # stay summarized, durable backoff
    BLOCKED = "blocked"  # stay summarized, pause the whole Todoist stage
    UNKNOWN = "unknown"  # -> todo_unknown, never resent automatically


@dataclass(frozen=True, slots=True)
class TaskVerdict:
    result: TaskResult
    code: Code | None = None
    retry_inline: bool = False  # worth another in-call attempt with the same frozen request
    retry_after: float = 0.0

    @property
    def state(self) -> EventState:
        return {
            TaskResult.CREATED: EventState.COMPLETE,
            TaskResult.UNKNOWN: EventState.TODO_UNKNOWN,
        }.get(self.result, EventState.SUMMARIZED)


def classify_task_create(outcome: HttpOutcome, task_id: str) -> TaskVerdict:
    """``task_id`` is the ``id`` of a 2xx response body, or ``""``.

    When in-call attempts run out, the last verdict applies as is.
    """
    if outcome.ok:
        if task_id:
            return TaskVerdict(TaskResult.CREATED)
        return TaskVerdict(TaskResult.UNKNOWN, Code.TODO_RESULT_UNKNOWN)
    match outcome.failure:
        case Failure.NOT_SENT:
            return TaskVerdict(TaskResult.RETRY_LATER, Code.TODOIST_UNAVAILABLE)
        case Failure.TIMEOUT:
            return TaskVerdict(TaskResult.UNKNOWN, Code.TODO_RESULT_UNKNOWN, retry_inline=True)
        case Failure.LOST:
            return TaskVerdict(TaskResult.UNKNOWN, Code.TODO_RESULT_UNKNOWN)
    status = outcome.status or 0
    if status == 429:
        return TaskVerdict(
            TaskResult.RETRY_LATER, Code.TODOIST_RATE_LIMITED, retry_inline=True, retry_after=outcome.retry_after
        )
    if status in _GATEWAY:
        return TaskVerdict(TaskResult.RETRY_LATER, Code.TODOIST_UNAVAILABLE, retry_inline=True)
    if status >= 500:
        return TaskVerdict(TaskResult.UNKNOWN, Code.TODO_RESULT_UNKNOWN)
    if status in (401, 403):
        return TaskVerdict(TaskResult.BLOCKED, Code.TODOIST_AUTH_BLOCKED)
    return TaskVerdict(TaskResult.RETRY_LATER, Code.TODOIST_REJECTED)


@dataclass(frozen=True, slots=True)
class ReminderVerdict:
    state: ReminderState
    code: Code | None = None
    retry_inline: bool = False
    retry_after: float = 0.0


def classify_reminder(outcome: HttpOutcome, task_id: str) -> ReminderVerdict:
    """Only failures that cannot have created a task are ``failed`` (retried hourly);
    anything that may have created one is ``unknown`` and not resent that day."""
    task = classify_task_create(outcome, task_id)
    if task.result is TaskResult.CREATED:
        return ReminderVerdict(ReminderState.CREATED)
    if task.result is TaskResult.UNKNOWN:
        return ReminderVerdict(ReminderState.UNKNOWN, Code.REMINDER_RESULT_UNKNOWN, task.retry_inline)
    return ReminderVerdict(ReminderState.FAILED, Code.REMINDER_CREATE_FAILED, task.retry_inline, task.retry_after)


def classify_lookup(matches: int | None) -> tuple[EventState, Code | None]:
    """Result of the read-only footer lookup for a ``todo_unknown`` row.

    ``matches`` counts active tasks carrying the footer; None if the lookup failed.
    """
    match matches:
        case None:
            return EventState.TODO_UNKNOWN, Code.LOOKUP_FAILED
        case 0:
            return EventState.TODO_UNKNOWN, Code.LOOKUP_NOT_FOUND
        case 1:
            return EventState.TODO_CREATED, None
        case _:
            return EventState.TODO_UNKNOWN, Code.LOOKUP_AMBIGUOUS
