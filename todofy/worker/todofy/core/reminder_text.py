"""The owner's daily attention reminder task (mail_inbox_worker.go:547-690 @ 6c46ed4).

Title, header and rows keep the Go bytes; the handling instructions now point
at the owner UI instead of the retired BasicAuth API. The text lists only IDs,
states, codes and arrival times, never subjects, addresses or mail text.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from .render import rfc3339

TITLE_PREFIX = "[Todofy System]"
SENDER = "todofy"
LIST_LIMIT = 20


@dataclass(frozen=True, slots=True)
class AttentionRow:
    event_id: str
    state: str
    error_code: str
    created_at: int


def reminder_title(attention_count: int) -> str:
    return f"{TITLE_PREFIX} Mail Hero：{attention_count} 封邮件需要处理"


def reminder_body(attention_count: int, day: str, rows: Sequence[AttentionRow], public_host: str) -> str:
    """``rows`` are the oldest attention rows first; at most LIST_LIMIT are listed."""
    listed = rows[:LIST_LIMIT]
    lines = [f"Todofy 的 Mail Hero 收件箱有 {attention_count} 个事件需要处理（UTC {day}）：\n\n"]
    for row in listed:
        received = rfc3339(datetime.fromtimestamp(row.created_at, UTC))
        lines.append(f"- {row.event_id} · {row.state} · {row.error_code or '-'} · 收到 {received}\n")
    if (more := attention_count - len(listed)) > 0:
        lines.append(f"- … 另有 {more} 条\n")
    lines.append(_instructions(public_host))
    return "".join(lines)


def _instructions(public_host: str) -> str:
    return (
        "\n处理方法：\n"
        f"1. 打开 https://{public_host}/attention（经 Cloudflare Access 登录）查看全部待处理事件。\n"
        "2. 进入事件详情，按情况选择对账动作：\n"
        "   - 已创建任务（task_created）：Todoist 已有含 `Mail Hero event: <event_id>` 的任务，填入它的任务 ID；\n"
        "   - 确认未创建（task_not_created）：已确认 Todoist 没有该任务，会用冻结的正文重新创建，可能重复建任务；\n"
        "   - 重新摘要（retry_summary）：重新摘要 failed_summary 事件（mail_needs_review 除外）；\n"
        "   - 放弃（dismiss）：放弃 failed_summary 或 todo_unknown 事件，不会检查 Todoist。\n"
        "3. 超过 6 小时仍在处理中的事件多半仍在自动重试，可先查看错误码。\n\n"
        "此提醒每个 UTC 日最多创建一次。"
    )
