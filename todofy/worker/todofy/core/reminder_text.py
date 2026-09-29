"""The owner's daily attention reminder task (mail_inbox_worker.go:547-690 @ 6c46ed4).

Title, header and rows keep the Go bytes; the handling instructions now point
at the owner UI instead of the retired BasicAuth API. The text lists only IDs,
states, codes and arrival times, never subjects, addresses or mail text.

The ops section (contracts/ops-v1 digest) lists the dashboard's latest warning and
critical items: sources, codes, severities, timestamps and numbers, plus links. A
day without ops items keeps exactly the text above.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from .ops import OpsDigest, metric_text
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


ONCE_A_DAY = "此提醒每个 UTC 日最多创建一次。"


def reminder_title(attention_count: int, ops_count: int = 0) -> str:
    if ops_count == 0:
        return f"{TITLE_PREFIX} Mail Hero：{attention_count} 封邮件需要处理"
    if attention_count == 0:
        return f"{TITLE_PREFIX} 运维：{ops_count} 项需要关注"
    return f"{TITLE_PREFIX} Mail Hero：{attention_count} 封邮件需要处理；运维 {ops_count} 项"


def reminder_body(
    attention_count: int,
    day: str,
    rows: Sequence[AttentionRow],
    public_host: str,
    ops: OpsDigest | None = None,
) -> str:
    """``rows`` are the oldest attention rows first; at most LIST_LIMIT are listed.

    With ``ops`` items the ops section follows the attention list (or stands alone when no
    event needs attention); without them the text is exactly the attention reminder."""
    lines: list[str] = []
    if attention_count > 0 or not ops or not ops.items:
        listed = rows[:LIST_LIMIT]
        lines.append(f"Todofy 的 Mail Hero 收件箱有 {attention_count} 个事件需要处理（UTC {day}）：\n\n")
        for row in listed:
            received = rfc3339(datetime.fromtimestamp(row.created_at, UTC))
            lines.append(f"- {row.event_id} · {row.state} · {row.error_code or '-'} · 收到 {received}\n")
        if (more := attention_count - len(listed)) > 0:
            lines.append(f"- … 另有 {more} 条\n")
    if ops and ops.items:
        section = _ops_section(ops)
        lines.append(section if lines else section.removeprefix("\n"))
        if attention_count == 0:
            lines.append(f"\n{ONCE_A_DAY}")
            return "".join(lines)
    lines.append(_instructions(public_host))
    return "".join(lines)


def _stamp(seconds: int) -> str:
    return rfc3339(datetime.fromtimestamp(seconds, UTC))


def _ops_section(ops: OpsDigest) -> str:
    lines = [f"\n运维（仪表盘报告，生成于 {_stamp(ops.generated_at)}）：\n"]
    for item in ops.items[:LIST_LIMIT]:
        line = f"- {item.severity} · {item.source} · {item.code} · 自 {_stamp(item.since)}"
        if item.metrics:
            line += " · " + ", ".join(f"{name}={metric_text(value)}" for name, value in item.metrics)
        lines.append(line + "\n")
    if ops.dashboard_url:
        lines.append(f"查看仪表盘：{ops.dashboard_url}\n")
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
        f"{ONCE_A_DAY}"
    )
