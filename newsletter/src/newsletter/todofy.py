"""Fetch private, opt-in Todofy digests, never public research packets.

Todofy's authenticated /api/recommendation and /api/summary GET endpoints run
its own LLM against the last 24 hours of persisted event summaries. They are
read-only with respect to tasks, but NOT free database reads. Neither exposes
raw event records, individual timestamps, nor Todoist completion state. Fetch
one endpoint only; retain complete selected explanations and never auto-retry.
Recommendation fetches up to ten candidates for conservative local selection;
the configured top count limits displayed items, never forces the list to fill.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import datetime
import json
import math
import re
from typing import cast, Protocol
import urllib.parse as parse
import zoneinfo

import httpx

import newsletter.contracts as contracts
import newsletter.personal as personal
import newsletter.types as types

_MAX_RESPONSE_BYTES = 128 * 1024
_MAX_SUMMARY_CHARS = 12_000
_LIMITATIONS = (
    "来自 Todofy 最近 24 小时入库事件的上游模型概述；"
    "不是 Todoist 的当前任务清单，"
    "也不代表事项已经完成。上游未提供逐条事件时间或原文核验链接。"
)
_MESSAGES = {
    "todofy_disabled": "尚未启用 Todofy；此处保留你的事件概述位置。",
    "todofy_unavailable": "暂时无法读取 Todofy，本期不能据此判断是否有新事件。",
    "todofy_auth_failed": "Todofy 认证未通过，本期没有取得事件概述。",
    "todofy_timeout": "Todofy 响应超时，本期没有取得事件概述。",
    "todofy_invalid_response": (
        "Todofy 返回了无法安全使用的数据，本期没有取得事件概述。"
    ),
    "todofy_historical_unavailable": (
        "Todofy 当前接口只提供抓取时刻之前的 24 小时概述，不能用于历史日期。"
    ),
}


class TodofyAdapter(Protocol):
    """Read a private digest without supplying public editorial evidence."""

    async def fetch(self, issue_date: str) -> types.Payload:
        """Fetch a digest or return an explicit unavailable state."""
        ...


def _date(value: str) -> datetime.date:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}", value
    ):
        raise ValueError("Invalid Todofy issue date")
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise ValueError("Invalid Todofy issue date") from None


def _base(
    state: types.DigestState, fetched_at: str = "", *, fixture: bool = False
) -> types.Payload:
    return {
        "state": state,
        "title": "你的事件概述",
        "summary": "",
        "items": [],
        "time_window_hours": 24,
        "fetched_at": fetched_at,
        "source_label": "Todofy · 最近入库事件",
        "limitations": _LIMITATIONS,
        "is_fixture": fixture,
        "error_code": "",
    }


def unavailable_digest(
    code: str = "todofy_unavailable", fetched_at: str = ""
) -> types.Payload:
    """Build safe failure data without raw exceptions or response bodies."""
    if code not in _MESSAGES:
        code = "todofy_unavailable"
    result = _base(
        "disabled" if code == "todofy_disabled" else "unavailable", fetched_at
    )
    result.update(error_code=code, summary=_MESSAGES[code])
    return result


class DisabledTodofy:
    """Represent an explicitly disabled private-digest integration."""

    async def fetch(self, issue_date: str) -> types.Payload:
        """Return date-validated data without contacting Todofy."""
        _date(issue_date)
        return unavailable_digest("todofy_disabled")


class FakeTodofy:
    """Supply fictional, offline examples deterministic for an issue date."""

    async def fetch(self, issue_date: str) -> types.Payload:
        """Return date-validated data without contacting Todofy."""
        _date(issue_date)
        result = _base("current", f"{issue_date}T12:00:00+00:00", fixture=True)
        result.update(
            summary=(
                "3 条演示事件：先回应研究讨论邀请，再检查简报预览；"
                "服务维护通知只需知悉。这些不是真实账户记录。"
            ),
            task_count=3,
            items=[
                {
                    "rank": 1,
                    "title": "需回应 · 研究讨论时间待确认",
                    "detail": (
                        "演示会议邀请提供了两个候选时段，但尚未确认你的空闲时间。"
                        "可先对照日历回复合适时段；这不表示会议已经排定。"
                    ),
                },
                {
                    "rank": 2,
                    "title": "待处理 · 简报预览需要验收",
                    "detail": (
                        "演示项目通知提到移动端排版和中文图表已经可以预览。"
                        "下一步是检查阅读体验与事件信息是否完整，暂不触发正式邮件。"
                    ),
                },
                {
                    "rank": 3,
                    "title": "仅知悉 · 例行服务维护通知",
                    "detail": (
                        "演示通知说明夜间可能有短时不可用；没有给出需要你执行的操作。"
                        "若不影响计划中的任务，可以保留为背景信息。"
                    ),
                },
            ],
            limitations=(
                "演示数据，用于检查个人栏目样式；"
                "未连接 Todofy、Todoist 或任何模型。"
            ),
        )
        return result


def validate_todofy_configuration(
    base_url: str, username: str, password: str
) -> str:
    """Validate an operator-owned HTTPS origin and Basic Auth credentials."""
    try:
        parsed = parse.urlsplit(base_url)
        port = parsed.port
        if (
            not isinstance(base_url, str)
            or len(base_url) > 2048
            or any(char.isspace() or ord(char) < 32 for char in base_url)
            or parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or port not in {None, 443}
            or "\\" in base_url
            or any(char in parsed.netloc for char in "%@")
        ):
            raise ValueError
        # This is operator configuration, not an SSRF-prone content URL. HTTPS
        # Private hosts are allowed; proxy environment settings and redirects
        # remain disabled so credentials cannot be forwarded to another origin.
        parsed.hostname.encode("idna")
        for secret in (username, password):
            if (
                not isinstance(secret, str)
                or not secret
                or len(secret) > 1024
                or any(ord(char) < 32 or ord(char) == 127 for char in secret)
            ):
                raise ValueError
        if ":" in username:
            raise ValueError
    except (ValueError, TypeError, AttributeError, UnicodeError):
        raise ValueError("Invalid Todofy HTTPS origin or credentials") from None
    return base_url.rstrip("/")


def _unique_object(pairs: list[tuple[str, object]]) -> types.Payload:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _invalid_constant(_: str) -> None:
    raise ValueError


def _decode(data: bytes, fetched_at: str, mode: str, top: int) -> types.Payload:
    body = json.loads(
        data, object_pairs_hook=_unique_object, parse_constant=_invalid_constant
    )
    if not isinstance(body, dict):
        raise ValueError
    if mode == "recommendation":
        return _decode_recommendation(body, fetched_at, top)
    count, window, summary = (
        body.get("task_count"),
        body.get("time_window_hours"),
        body.get("summary"),
    )
    if (
        type(count) is not int
        or not 0 <= count <= 1_000_000
        or type(window) is not int
        or window != 24
        or not isinstance(summary, str)
        or len(summary) > _MAX_SUMMARY_CHARS
        or any(
            (ord(char) < 32 and char not in "\n\t\r") or ord(char) == 127
            for char in summary
        )
        or (count > 0 and not summary.strip())
    ):
        raise ValueError
    result = _base("current" if count else "empty", fetched_at)
    result.update(
        task_count=count,
        # Do not show upstream's obsolete "check your service" error-like text
        # when task_count explicitly proves a successful empty result.
        summary=summary.strip()
        if count
        else "最近 24 小时没有新的入库事件；这不代表没有未完成任务。",
        source_label="Todofy · 近 24 小时事件综合概述",
    )
    return result


def _carryover(body: types.Payload) -> tuple[str, str]:
    """Name the window, including older mail tasks Todofy says are still open.

    Their reasons then usually start with "（N 天前）".
    """
    carried = body.get("carryover_count", 0)
    if type(carried) is not int or not 0 <= carried <= 1_000_000:
        raise ValueError
    if not carried:
        return "近 24 小时", ""
    return f"近 24 小时及 {carried} 条仍未完成的旧任务", (
        f" 另带入 {carried} 条此前入库、Todofy 取数时在 Todoist 中"
        "仍未完成的邮件任务，其说明通常以“（N 天前）”开头；"
        "之后是否已完成请以 Todoist 为准。"
    )


def _decode_recommendation(
    body: types.Payload, fetched_at: str, top: int
) -> types.Payload:
    tasks, count = body.get("tasks"), body.get("task_count")
    if not isinstance(tasks, list) or len(tasks) > personal.CANDIDATE_LIMIT:
        raise ValueError
    if "task_count" in body and (
        type(count) is not int or not 0 <= count <= 1_000_000
    ):
        raise ValueError
    if count == 0 and tasks:
        raise ValueError
    window, carried_note = _carryover(body)
    items: list[types.PersonalItem] = []
    ranks = set()
    for index, task in enumerate(tasks, 1):
        if not isinstance(task, dict):
            raise ValueError
        rank = task.get("rank", 0)
        if type(rank) is not int or rank < 0 or rank > 100:
            raise ValueError
        rank = rank or index
        if rank in ranks:
            raise ValueError
        ranks.add(rank)
        title, detail = task.get("title"), task.get("reason")
        for text, limit in ((title, 500), (detail, 4000)):
            if (
                not isinstance(text, str)
                or not text.strip()
                or len(text) > limit
                or any(
                    (ord(c) < 32 and c not in "\n\r\t") or ord(c) == 127
                    for c in text
                )
            ):
                raise ValueError
        # The loop above validates both values before normalizing them.
        items.append(
            {
                "rank": rank,
                "title": cast(str, title).strip(),
                "detail": cast(str, detail).strip(),
            }
        )
    selection = personal.select_personal_items(items, top)
    result = _base("current" if items or count else "empty", fetched_at)
    summary = (
        f"从 Todofy 的 {selection.candidates} 条候选中保留 "
        f"{len(selection.items)} 条，"
        "按风险与行动线索保守排序，保留具体说明；不为凑数补齐。"
        if items
        else "Todofy 本次没有返回重点事件；这不代表没有未完成任务。"
    )
    if selection.routine_omitted or selection.duplicates_omitted:
        summary += (
            f" 已略去 {selection.routine_omitted} 条明确例行通知、"
            f"{selection.duplicates_omitted} 条完全重复候选；"
            "这不表示账单已支付。"
        )
    if selection.limit_omitted:
        summary += f" 另有 {selection.limit_omitted} 条候选超过展示上限。"
    if selection.risk_limit_omitted:
        summary += (
            f" 其中 {selection.risk_limit_omitted} 条含风险提示，"
            "请到 Todofy 核对。"
        )
    result.update(
        items=selection.items,
        summary=summary,
        source_label=f"Todofy · {window}候选本地精选（最多 {top} 条）",
        limitations=(
            _LIMITATIONS
            + carried_note
            + " 本栏目为上游候选的本地保守筛选，并非全部事件。"
            "没有原始账单或真实 autopay 状态，不推断所有账户自动还款；"
            "例行账单可查看通知不会被改写成还款指令。未知事项保留，"
            "但无法恢复上游遗漏的异常或保证没有重要遗漏。"
        ),
    )
    if count is not None:
        result["task_count"] = count
    else:
        result["limitations"] += " 上游未提供本次查询的入库事件总数。"
    return result


class Todofy:
    """Read a private HTTPS digest once, without automatic retries."""

    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        *,
        mode: str = "recommendation",
        top: int = 5,
        time_zone: str = "America/Los_Angeles",
        timeout: float = 45,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime.datetime] | None = None,
    ):
        origin = validate_todofy_configuration(base_url, username, password)
        if (
            mode not in {"recommendation", "summary"}
            or type(top) is not int
            or not 1 <= top <= 10
        ):
            raise ValueError("Invalid Todofy endpoint mode or top count")
        if (
            not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 < timeout <= 60
        ):
            raise ValueError("Invalid Todofy timeout")
        self._url = origin + (
            f"/api/recommendation?top={personal.CANDIDATE_LIMIT}"
            if mode == "recommendation"
            else "/api/summary"
        )
        self._mode, self._top = mode, top
        self._auth = httpx.BasicAuth(username, password)
        self._zone = zoneinfo.ZoneInfo(time_zone)
        self._timeout = timeout
        self._transport = transport
        self._clock = clock or (lambda: datetime.datetime.now(datetime.UTC))

    async def fetch(self, issue_date: str) -> types.Payload:
        """Fetch today's bounded digest or return a finite unavailable state."""
        requested = _date(issue_date)
        instant = self._clock()
        if instant.tzinfo is None:
            raise ValueError("Todofy clock must have a timezone")
        fetched_at = instant.astimezone(datetime.UTC).isoformat()
        if requested != instant.astimezone(self._zone).date():
            return unavailable_digest(
                "todofy_historical_unavailable", fetched_at
            )
        try:
            async with asyncio.timeout(self._timeout):
                async with httpx.AsyncClient(
                    auth=self._auth,
                    transport=self._transport,
                    timeout=self._timeout,
                    follow_redirects=False,
                    trust_env=False,
                    headers={"Accept": "application/json"},
                ) as client:
                    async with client.stream("GET", self._url) as response:
                        if response.status_code in {401, 403}:
                            return unavailable_digest(
                                "todofy_auth_failed", fetched_at
                            )
                        if response.status_code != 200:
                            return unavailable_digest(
                                "todofy_unavailable", fetched_at
                            )
                        if (
                            response.headers.get("content-type", "")
                            .split(";", 1)[0]
                            .strip()
                            != "application/json"
                        ):
                            return unavailable_digest(
                                "todofy_invalid_response", fetched_at
                            )
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(content) + len(chunk) > _MAX_RESPONSE_BYTES:
                                return unavailable_digest(
                                    "todofy_invalid_response", fetched_at
                                )
                            content.extend(chunk)
            result = _decode(bytes(content), fetched_at, self._mode, self._top)
            contracts.validate_personal_digest(result)
            return result
        except (httpx.TimeoutException, TimeoutError):
            return unavailable_digest("todofy_timeout", fetched_at)
        except httpx.HTTPError:
            return unavailable_digest("todofy_unavailable", fetched_at)
        except (ValueError, UnicodeError, RecursionError):
            return unavailable_digest("todofy_invalid_response", fetched_at)
