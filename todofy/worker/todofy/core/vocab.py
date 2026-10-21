"""Single source of the ledger vocabulary: states, error codes and owner actions.

Codes marked ``legacy`` were written by a retired writer, the Go service, the
release that still wrote Todoist (``todoist_auth_blocked``) or the releases that
still wrote tasks (until 2026-10-21: the task create, lookup and reminder codes),
and older ledger rows still carry them. The Worker produces none of them for its own events; it writes
``invalid_saved_event`` only for an imported row that is still due but has no
stored payload the contract accepts.

Since 2026-10-21 Todofy writes no task: the states summarized, todo_sending,
todo_unknown and todo_created, the task codes and the reconcile actions
task_created and task_not_created are kept as stored vocabulary only (older rows,
transitions and owner actions hold them); nothing moves a row there any more.
"""

from dataclasses import dataclass
from enum import StrEnum


class EventState(StrEnum):
    PENDING = "pending"
    SUMMARIZING = "summarizing"
    SUMMARIZED = "summarized"
    TODO_SENDING = "todo_sending"
    TODO_UNKNOWN = "todo_unknown"
    TODO_CREATED = "todo_created"
    COMPLETE = "complete"
    IGNORED = "ignored"
    FAILED_SUMMARY = "failed_summary"


class ReminderState(StrEnum):
    SENDING = "sending"
    CREATED = "created"
    UNKNOWN = "unknown"
    FAILED = "failed"


class Reconcile(StrEnum):
    # Legacy: the answers to a task create whose outcome was lost, offered until 2026-10-21.
    TASK_CREATED = "task_created"
    TASK_NOT_CREATED = "task_not_created"
    RETRY_SUMMARY = "retry_summary"
    DISMISS = "dismiss"


class Code(StrEnum):
    MAIL_NEEDS_REVIEW = "mail_needs_review"
    SUMMARY_FAILED = "summary_failed"
    LLM_QUOTA = "llm_quota"
    LLM_BUDGET_EXHAUSTED = "llm_budget_exhausted"
    LLM_REQUEST_REJECTED = "llm_request_rejected"
    PROCESSING_INTERRUPTED_LIMIT = "processing_interrupted_limit"
    TODOIST_REJECTED = "todoist_rejected"
    TODOIST_AUTH_BLOCKED = "todoist_auth_blocked"
    TODOIST_RATE_LIMITED = "todoist_rate_limited"
    TODOIST_UNAVAILABLE = "todoist_unavailable"
    TODO_RESULT_UNKNOWN = "todo_result_unknown"
    INTERRUPTED_TODO_CALL = "interrupted_todo_call"
    LOOKUP_NOT_FOUND = "lookup_not_found"
    LOOKUP_FAILED = "lookup_failed"
    LOOKUP_AMBIGUOUS = "lookup_ambiguous"
    DISMISSED_BY_OWNER = "dismissed_by_owner"
    # A canary event (contracts/ops-v1) reached a step that would have written a task; it ended there.
    CANARY_SIDE_EFFECT_BLOCKED = "canary_side_effect_blocked"
    REMINDER_CREATE_FAILED = "reminder_create_failed"
    REMINDER_RESULT_UNKNOWN = "reminder_result_unknown"
    INTERRUPTED_REMINDER_CALL = "interrupted_reminder_call"
    # Written only by the Go service.
    INVALID_SAVED_EVENT = "invalid_saved_event"
    LLM_CLIENT_UNAVAILABLE = "llm_client_unavailable"
    SUMMARY_RENDER_FAILED = "summary_render_failed"
    TODO_CLIENT_UNAVAILABLE = "todo_client_unavailable"
    DATABASE_CLIENT_UNAVAILABLE = "database_client_unavailable"
    CACHE_WRITE_FAILED = "cache_write_failed"
    CHECKPOINT_FAILED = "checkpoint_failed"
    EMPTY_TASK_ID = "empty_task_id"


@dataclass(frozen=True, slots=True)
class CodeInfo:
    """What the ledger needs to know about a code. The owner-facing Chinese text lives only
    in web/src/lib/labels.ts, so there is one copy to keep in step with the behaviour."""

    legacy: bool = False  # only a retired writer wrote it


EVENT_ERROR_CODES: dict[Code, CodeInfo] = {
    Code.MAIL_NEEDS_REVIEW: CodeInfo(),
    Code.SUMMARY_FAILED: CodeInfo(),
    Code.LLM_QUOTA: CodeInfo(),
    Code.LLM_BUDGET_EXHAUSTED: CodeInfo(),
    Code.LLM_REQUEST_REJECTED: CodeInfo(),
    Code.PROCESSING_INTERRUPTED_LIMIT: CodeInfo(),
    Code.TODOIST_REJECTED: CodeInfo(legacy=True),
    Code.TODOIST_AUTH_BLOCKED: CodeInfo(legacy=True),
    Code.TODOIST_RATE_LIMITED: CodeInfo(legacy=True),
    Code.TODOIST_UNAVAILABLE: CodeInfo(legacy=True),
    Code.TODO_RESULT_UNKNOWN: CodeInfo(legacy=True),
    Code.INTERRUPTED_TODO_CALL: CodeInfo(legacy=True),
    Code.LOOKUP_NOT_FOUND: CodeInfo(legacy=True),
    Code.LOOKUP_FAILED: CodeInfo(legacy=True),
    Code.LOOKUP_AMBIGUOUS: CodeInfo(legacy=True),
    Code.DISMISSED_BY_OWNER: CodeInfo(),
    Code.CANARY_SIDE_EFFECT_BLOCKED: CodeInfo(legacy=True),
    Code.INVALID_SAVED_EVENT: CodeInfo(legacy=True),
    Code.LLM_CLIENT_UNAVAILABLE: CodeInfo(legacy=True),
    Code.SUMMARY_RENDER_FAILED: CodeInfo(legacy=True),
    Code.TODO_CLIENT_UNAVAILABLE: CodeInfo(legacy=True),
    Code.DATABASE_CLIENT_UNAVAILABLE: CodeInfo(legacy=True),
    Code.CACHE_WRITE_FAILED: CodeInfo(legacy=True),
    Code.CHECKPOINT_FAILED: CodeInfo(legacy=True),
}

# mail_reminders' codes: every one legacy since Home sends the daily reminder (2026-10-21).
REMINDER_ERROR_CODES: dict[Code, CodeInfo] = {
    Code.REMINDER_CREATE_FAILED: CodeInfo(legacy=True),
    Code.REMINDER_RESULT_UNKNOWN: CodeInfo(legacy=True),
    Code.INTERRUPTED_REMINDER_CALL: CodeInfo(legacy=True),
    Code.EMPTY_TASK_ID: CodeInfo(legacy=True),
    Code.TODO_CLIENT_UNAVAILABLE: CodeInfo(legacy=True),
}

TERMINAL_STATES = frozenset({EventState.COMPLETE, EventState.IGNORED})
# These need the owner at once; any other non-terminal row only once it is
# older than ATTENTION_AGE_SECONDS, i.e. it has outlived the automatic retries.
ALWAYS_ATTENTION_STATES = frozenset({EventState.FAILED_SUMMARY, EventState.TODO_UNKNOWN})
ATTENTION_AGE_SECONDS = 6 * 3600


def current_codes(table: dict[Code, CodeInfo]) -> frozenset[Code]:
    """Codes the Worker itself can write, i.e. every non-legacy code of a table."""
    return frozenset(code for code, info in table.items() if not info.legacy)


def allowed_actions(state: str, error_code: str, *, canary: bool = False) -> tuple[Reconcile, ...]:
    """Owner reconcile actions valid for a row, in display order: retry a failed summary, or dismiss a row that needs
    the owner.

    A canary event (contracts/ops-v1) has none: it ends by itself."""
    if canary:
        return ()
    actions: list[Reconcile] = []
    # A review-flagged body cannot become summarisable by retrying.
    if state == EventState.FAILED_SUMMARY and error_code != Code.MAIL_NEEDS_REVIEW:
        actions.append(Reconcile.RETRY_SUMMARY)
    if state in ALWAYS_ATTENTION_STATES:
        actions.append(Reconcile.DISMISS)
    return tuple(actions)
