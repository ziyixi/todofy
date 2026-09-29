"""Single source of the ledger vocabulary: states, error codes and owner actions.

Codes marked ``legacy`` were written only by the retired Go service; the Worker
never produces them, but imported ledger rows still carry them.
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
    description: str
    legacy: bool = False


EVENT_ERROR_CODES: dict[Code, CodeInfo] = {
    Code.MAIL_NEEDS_REVIEW: CodeInfo(
        "Mail Hero 标记该邮件需要人工检查（或 HTML 被省略且没有正文）；不会调用 Gemini，也不会建任务"
    ),
    Code.SUMMARY_FAILED: CodeInfo("Gemini 暂时不可用（5xx、超时、网络错误或空输出），会按退避自动重试最多 7 天"),
    Code.LLM_QUOTA: CodeInfo("Gemini 返回限流（429），会按 Retry-After 与退避自动重试"),
    Code.LLM_BUDGET_EXHAUSTED: CodeInfo("当日 Gemini token 预算已用完，推迟到预算恢复后继续，不会丢弃"),
    Code.LLM_REQUEST_REJECTED: CodeInfo(
        "Gemini 拒绝了请求（400/401/403/404 等），多半是密钥或模型配置问题；重试 12 次后停止"
    ),
    Code.PROCESSING_INTERRUPTED_LIMIT: CodeInfo("摘要连续 3 次在运行中被中断，已停止自动重试"),
    Code.TODOIST_REJECTED: CodeInfo("Todoist 拒绝创建任务（400/404 等），会按退避自动重试"),
    Code.TODOIST_AUTH_BLOCKED: CodeInfo("Todoist 认证失败（401/403），建任务阶段暂停 6 小时；请检查 TODOIST_API_KEY"),
    Code.TODOIST_RATE_LIMITED: CodeInfo("Todoist 限流（429），会按 Retry-After 与退避自动重试"),
    Code.TODOIST_UNAVAILABLE: CodeInfo("Todoist 暂时不可用（502/503/504 或连接失败），会按退避自动重试"),
    Code.TODO_RESULT_UNKNOWN: CodeInfo(
        "Todoist 建任务的结果不明（500、超时、断连或响应没有任务 ID），任务可能已创建；不会自动重发"
    ),
    Code.INTERRUPTED_TODO_CALL: CodeInfo("调用 Todoist 时运行被中断，任务可能已创建；不会自动重发"),
    Code.LOOKUP_NOT_FOUND: CodeInfo("在默认项目的未完成任务里没有找到带本事件页脚的任务"),
    Code.LOOKUP_FAILED: CodeInfo("只读查找 Todoist 任务失败，稍后会再查"),
    Code.LOOKUP_AMBIGUOUS: CodeInfo("找到多个带本事件页脚的任务，需要人工确认"),
    Code.DISMISSED_BY_OWNER: CodeInfo("owner 已放弃此事件，账本仍保留去重记录"),
    Code.INVALID_SAVED_EVENT: CodeInfo("（旧版）已保存的事件无法解析", legacy=True),
    Code.LLM_CLIENT_UNAVAILABLE: CodeInfo("（旧版）无法连接旧 LLM 服务", legacy=True),
    Code.SUMMARY_RENDER_FAILED: CodeInfo("（旧版）渲染任务描述失败", legacy=True),
    Code.TODO_CLIENT_UNAVAILABLE: CodeInfo("（旧版）无法连接旧 todo 服务，任务未创建", legacy=True),
    Code.DATABASE_CLIENT_UNAVAILABLE: CodeInfo("（旧版）无法连接旧数据库服务", legacy=True),
    Code.CACHE_WRITE_FAILED: CodeInfo("（旧版）写入旧摘要缓存失败", legacy=True),
    Code.CHECKPOINT_FAILED: CodeInfo("（旧版）Todoist 调用后写入账本失败，任务可能已创建", legacy=True),
}

REMINDER_ERROR_CODES: dict[Code, CodeInfo] = {
    Code.REMINDER_CREATE_FAILED: CodeInfo("提醒任务未能创建（请求没有发出或被 Todoist 拒绝），每小时重试，最多 5 次"),
    Code.REMINDER_RESULT_UNKNOWN: CodeInfo("提醒任务的结果不明，可能已创建；当天不再重发"),
    Code.INTERRUPTED_REMINDER_CALL: CodeInfo("创建提醒时运行被中断，可能已创建；当天不再重发"),
    Code.EMPTY_TASK_ID: CodeInfo("（旧版）旧 todo 服务返回了空任务 ID", legacy=True),
    Code.TODO_CLIENT_UNAVAILABLE: CodeInfo("（旧版）无法连接旧 todo 服务，提醒未创建", legacy=True),
}

TERMINAL_STATES = frozenset({EventState.COMPLETE, EventState.IGNORED})
# These need the owner at once; any other non-terminal row only once it is
# older than ATTENTION_AGE_SECONDS, i.e. it has outlived the automatic retries.
ALWAYS_ATTENTION_STATES = frozenset({EventState.FAILED_SUMMARY, EventState.TODO_UNKNOWN})
ATTENTION_AGE_SECONDS = 6 * 3600


def current_codes(table: dict[Code, CodeInfo]) -> frozenset[Code]:
    """Codes the Worker itself can write, i.e. every non-legacy code of a table."""
    return frozenset(code for code, info in table.items() if not info.legacy)


def allowed_actions(state: str, error_code: str) -> tuple[Reconcile, ...]:
    """Owner reconcile actions valid for a row, in display order."""
    actions: list[Reconcile] = []
    if state == EventState.TODO_UNKNOWN:
        actions += [Reconcile.TASK_CREATED, Reconcile.TASK_NOT_CREATED]
    # A review-flagged body cannot become summarisable by retrying.
    if state == EventState.FAILED_SUMMARY and error_code != Code.MAIL_NEEDS_REVIEW:
        actions.append(Reconcile.RETRY_SUMMARY)
    if state in ALWAYS_ATTENTION_STATES:
        actions.append(Reconcile.DISMISS)
    return tuple(actions)
