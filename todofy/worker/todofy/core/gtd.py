"""GTD ledger rules (docs/gtd-features.md): snapshot rows, daily aggregates, the Sunday review.

Pure stdlib, host-tested. Todoist task text never gets past this module: ``snapshot_row`` keeps a
whitelist of metadata and folds ``content`` and ``description`` into a keyed hash, the completed-task
tally keeps counts only, and every text built here (the review body, the carryover lines) is made of
numbers, dates, codes and links, or of summaries Todofy already stores.
"""

import hmac
import json
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, timedelta
from enum import StrEnum
from typing import Any

from .ops import OpsDigest, metric_text

MINUTE = 60
HOUR = 60 * MINUTE
DAY = 24 * HOUR

# Todoist's page size maximum (GET /api/v1/tasks and the completed list): 10 pages cover 2,000 tasks.
PAGE_SIZE = 200
MAX_TASK_PAGES = 10
MAX_COMPLETED_PAGES = 5
# Todoist GETs one alarm invocation may make; a longer collection continues a second later.
CALLS_PER_ALARM = 5
# Rows a day's snapshot can hold (the page cap), and so the bound of every read of one day.
MAX_SNAPSHOT_ROWS = MAX_TASK_PAGES * PAGE_SIZE
COLLECT_RETRY = 10 * MINUTE
COLLECT_ATTEMPTS = 3
DEFAULT_COLLECT_UTC = "13:00"
COMPLETED_WINDOW = 7 * DAY

# Retention (runtime/retention.py).
SNAPSHOT_TASK_DAYS = 14
DAILY_DAYS = 120
REVIEW_DAYS = 400

# The morning brief's carryover (runtime/reports.py).
CARRYOVER_MAX_ROWS = 30
DEFAULT_CARRYOVER_DAYS = 14
MAX_CARRYOVER_DAYS = 14  # snapshot rows are kept 14 days; older mail would never match anyway
# A snapshot serves the brief while it is at most this old: the 13:30 precompute, the newsletter's
# on-demand call and an owner recompute later the same day all use the 13:00 snapshot.
SNAPSHOT_FRESH = 26 * HOUR

# ops-v1: gtd_snapshot_stale (review_overdue's threshold is core/ops.py REVIEW_OVERDUE_DAYS).
SNAPSHOT_STALE = 48 * HOUR

# The Sunday review: 17:00 UTC is 09:00 PST / 10:00 PDT.
REVIEW_WEEKDAY = 6  # datetime.weekday(): Sunday
REVIEW_HOUR = 17
REVIEW_RETRY = HOUR
REVIEW_MAX_ATTEMPTS = 5
REVIEW_SENDER = "todofy-review:"
MAX_REVIEW_BODY_BYTES = 8192

MAX_LABELS_BYTES = 2048
MAX_ID_CHARS = 64
DAY_TEXT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)


class SnapshotStatus(StrEnum):
    COLLECTING = "collecting"
    OK = "ok"
    PARTIAL = "partial"
    FAILED = "failed"


class GtdCode(StrEnum):
    """Codes of a failed snapshot or review (gtd_snapshots.error_code, gtd_reviews.last_error_code)."""

    TODOIST_UNAVAILABLE = "todoist_unavailable"
    TODOIST_AUTH_BLOCKED = "todoist_auth_blocked"
    TODOIST_RATE_LIMITED = "todoist_rate_limited"
    MALFORMED_PAGE = "malformed_page"
    PAGE_CAP = "page_cap"
    INTERRUPTED = "interrupted"
    REVIEW_CREATE_FAILED = "review_create_failed"
    REVIEW_RESULT_UNKNOWN = "review_result_unknown"
    INTERRUPTED_REVIEW_CALL = "interrupted_review_call"


class Scope(StrEnum):
    ALL = "all"
    INBOX = "inbox"


# ---- time ------------------------------------------------------------------------------------


def day_of(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d")


def shift(day: str, days: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


def rfc3339(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_offset(value: str, default: str = DEFAULT_COLLECT_UTC) -> int | None:
    """Seconds after UTC midnight of ``HH:MM``; None for ``off``; the default for anything unparsable."""
    if value == "off":
        return None
    hours, _, minutes = value.partition(":")
    if not (hours.isdigit() and minutes.isdigit() and len(minutes) == 2 and int(hours) < 24 and int(minutes) < 60):
        return utc_offset(default, default)
    return int(hours) * HOUR + int(minutes) * MINUTE


def next_collect(now: int, offset: int) -> int:
    """Today's collection time if it is still ahead, else tomorrow's."""
    due = now - now % DAY + offset
    return due if now < due else due + DAY


def iso_week(timestamp: int) -> str:
    """The ISO week (``2026-W40``) of a Unix time, in UTC."""
    year, week, _ = datetime.fromtimestamp(timestamp, UTC).isocalendar()
    return f"{year:04d}-W{week:02d}"


def week_shift(week: str, weeks: int) -> str:
    year, number = int(week[:4]), int(week[6:])
    monday = date.fromisocalendar(year, number, 1) + timedelta(weeks=weeks)
    iso = monday.isocalendar()
    return f"{iso.year:04d}-W{iso.week:02d}"


def review_window(now: int) -> tuple[int, int] | None:
    """(start, end) of the review window ``now`` is in: Sunday 17:00 UTC to the end of that ISO week
    (Monday 00:00 UTC); None outside it."""
    moment = datetime.fromtimestamp(now, UTC)
    if moment.weekday() != REVIEW_WEEKDAY or moment.hour < REVIEW_HOUR:
        return None
    start = moment.replace(hour=REVIEW_HOUR, minute=0, second=0, microsecond=0)
    return int(start.timestamp()), int((start.replace(hour=0) + timedelta(days=1)).timestamp())


def next_review(now: int) -> int:
    """The first Sunday 17:00 UTC strictly after ``now``."""
    moment = datetime.fromtimestamp(now, UTC).replace(hour=REVIEW_HOUR, minute=0, second=0, microsecond=0)
    at = moment + timedelta(days=(REVIEW_WEEKDAY - moment.weekday()) % 7)
    if at.timestamp() <= now:
        at += timedelta(days=7)
    return int(at.timestamp())


def parse_instant(value: Any) -> int | None:
    """Unix seconds of an RFC 3339 time with a zone (``Z`` or an offset); None otherwise."""
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00") if value.endswith("Z") else value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    return math.floor(moment.timestamp())


class Malformed(ValueError):
    """A task whose metadata cannot be read; it is counted as skipped, never stored."""


def _date(value: Any) -> str:
    if not isinstance(value, str) or not DAY_TEXT.fullmatch(value):
        raise Malformed("date")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise Malformed("date") from None
    return value


def parse_due(due: Any) -> tuple[str | None, int | None, bool]:
    """(due_date, due_at, recurring) of a Todoist ``due`` object.

    ``date`` is ``YYYY-MM-DD`` (all day), ``YYYY-MM-DDTHH:MM:SS`` (floating: the owner's local time,
    kept as its date only) or with ``Z`` (a fixed time: also ``due_at``); a ``datetime`` field, as the
    older REST API sent, is read the same way."""
    if due is None:
        return None, None, False
    if not isinstance(due, dict):
        raise Malformed("due")
    recurring = due.get("is_recurring") is True
    text = due.get("datetime") or due.get("date")
    if not isinstance(text, str) or len(text) < 10:
        raise Malformed("due")
    due_date = _date(text[:10])
    if len(text) == 10:
        return due_date, None, recurring
    at = parse_instant(text)
    if at is None:
        # Floating time: no zone, so only its date is known here.
        try:
            datetime.fromisoformat(text)
        except ValueError:
            raise Malformed("due") from None
        return due_date, None, recurring
    return day_of(at), at, recurring


def _optional_id(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_ID_CHARS:
        raise Malformed("id")
    return value


def _labels(value: Any) -> str:
    """Label names as a JSON array of at most MAX_LABELS_BYTES (names past the limit are dropped)."""
    names = [name for name in value if isinstance(name, str)] if isinstance(value, list) else []
    while True:
        text = json.dumps(names, ensure_ascii=False, separators=(",", ":"))
        if len(text) <= MAX_LABELS_BYTES and len(text.encode()) <= MAX_LABELS_BYTES:
            return text
        names.pop()


def content_hmac(key: bytes, content: Any, description: Any) -> str:
    """A keyed hash of the task text: the text itself is never kept. A plain SHA-256 of a short
    title could be reversed with a dictionary; the key never leaves the Durable Object."""
    text = (content if isinstance(content, str) else "") + "\0" + (description if isinstance(description, str) else "")
    return hmac.new(key, text.encode(), "sha256").hexdigest()


# The snapshot row: exactly these keys, in the order of the D1 columns after ``day``.
ROW_KEYS = (
    "task_id",
    "project_id",
    "parent_id",
    "labels",
    "priority",
    "due_date",
    "due_at",
    "due_recurring",
    "deadline_date",
    "added_at",
    "checked",
    "content_hmac",
)


def snapshot_row(task: Mapping[str, Any], key: bytes) -> dict[str, Any]:
    """The whitelisted metadata of one active task; raises Malformed for one that cannot be read."""
    task_id = task.get("id")
    if not isinstance(task_id, str) or not 1 <= len(task_id) <= MAX_ID_CHARS:
        raise Malformed("id")
    project_id = task.get("project_id")
    if not isinstance(project_id, str) or len(project_id) > MAX_ID_CHARS:
        raise Malformed("project")
    priority = task.get("priority", 1)
    if isinstance(priority, bool) or not isinstance(priority, int) or not 1 <= priority <= 4:
        raise Malformed("priority")
    due_date, due_at, recurring = parse_due(task.get("due"))
    deadline = task.get("deadline")
    deadline_date = _date(deadline.get("date")) if isinstance(deadline, dict) and deadline.get("date") else None
    added = task.get("added_at")
    added_at = parse_instant(added) if added is not None else None
    row = {
        "task_id": task_id,
        "project_id": project_id,
        "parent_id": _optional_id(task.get("parent_id")),
        "labels": _labels(task.get("labels")),
        "priority": priority,
        "due_date": due_date,
        "due_at": due_at,
        "due_recurring": int(recurring),
        "deadline_date": deadline_date,
        "added_at": added_at,
        "checked": int(task.get("checked") is True),
        "content_hmac": content_hmac(key, task.get("content"), task.get("description")),
    }
    assert tuple(row) == ROW_KEYS
    return row


def snapshot_rows(tasks: Iterable[Mapping[str, Any]], key: bytes) -> tuple[list[dict[str, Any]], int]:
    """(rows, skipped) of one page; a task id repeated within the page is kept once."""
    rows: dict[str, dict[str, Any]] = {}
    skipped = 0
    for task in tasks:
        try:
            row = snapshot_row(task, key)
        except Malformed:
            skipped += 1
            continue
        rows[row["task_id"]] = row
    return list(rows.values()), skipped


def parse_completed_page(body: bytes) -> tuple[list[dict[str, Any]], str]:
    """Items and next cursor (``""`` on the last page) of ``GET /api/v1/tasks/completed/by_completion_date``.

    Its envelope is ``{"items", "next_cursor"}`` with ``next_cursor`` omitted (or null) on the last page;
    raises ValueError for anything else."""
    page = json.loads(body)
    if not isinstance(page, dict) or not isinstance(page.get("items"), list):
        raise ValueError("unexpected completed page")
    cursor = page.get("next_cursor") or ""
    if not isinstance(cursor, str) or not all(isinstance(item, dict) for item in page["items"]):
        raise ValueError("unexpected completed page")
    return page["items"], cursor


@dataclass(frozen=True, slots=True)
class CompletedTally:
    """Counts of the 7-day completed window (never task text), per scope, kept between alarms."""

    total: int = 0
    inbox: int = 0
    added_recent_total: int = 0  # completed tasks that were also added within the window
    added_recent_inbox: int = 0
    # Review tasks seen completed: task id -> completed_at (Unix seconds).
    reviews: dict[str, int] = field(default_factory=dict)

    def dumps(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)

    @classmethod
    def loads(cls, text: str | None) -> "CompletedTally | None":
        if not text:
            return None
        try:
            value = json.loads(text)
            return cls(
                int(value["total"]),
                int(value["inbox"]),
                int(value["added_recent_total"]),
                int(value["added_recent_inbox"]),
                {str(k): int(v) for k, v in value["reviews"].items()},
            )
        except (ValueError, TypeError, KeyError, AttributeError):
            return None


def tally_completed(
    tally: CompletedTally, items: Iterable[Mapping[str, Any]], *, since: int, inbox: str, review_ids: Iterable[str]
) -> CompletedTally:
    """Add one page of completed items to ``tally``. ``review_ids`` are open review tasks to watch for."""
    watched = set(review_ids)
    total, in_inbox, recent, recent_inbox = tally.total, tally.inbox, tally.added_recent_total, tally.added_recent_inbox
    reviews = dict(tally.reviews)
    for item in items:
        task_id = item.get("id") if isinstance(item.get("id"), str) else item.get("task_id")
        is_inbox = bool(inbox) and item.get("project_id") == inbox
        total += 1
        in_inbox += is_inbox
        added = parse_instant(item.get("added_at"))
        if added is not None and added >= since:
            recent += 1
            recent_inbox += is_inbox
        if isinstance(task_id, str) and task_id in watched:
            completed = parse_instant(item.get("completed_at"))
            if completed is not None:
                reviews[task_id] = completed
    return CompletedTally(total, in_inbox, recent, recent_inbox, reviews)


# ---- aggregates ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Daily:
    """One gtd_daily row (without day, scope and computed_at)."""

    open: int
    age_0_7: int
    age_8_14: int
    age_15_30: int
    age_31_plus: int
    oldest_days: int
    overdue: int
    undated: int
    created_7d: int | None
    completed_7d: int | None
    completed_source: str  # api | none
    closed_1d: int | None
    mail_open: int | None
    complete: bool


def age_days(now: int, added_at: int | None) -> int | None:
    return None if added_at is None else max((now - added_at) // DAY, 0)


def is_overdue(row: Mapping[str, Any], now: int, today: str) -> bool:
    """A fixed-time due before now, or a date-only (or floating) due before the snapshot's UTC date.

    13:00 UTC is the same calendar day everywhere in the Americas, so the UTC date stands in for the
    owner's own without a time-zone setting."""
    if row.get("due_at") is not None:
        return int(row["due_at"]) < now
    due = row.get("due_date")
    return due is not None and due < today


def aggregate(
    rows: Sequence[Mapping[str, Any]],
    *,
    now: int,
    scope_project: str | None,
    completed: CompletedTally | None,
    complete: bool,
    closed_1d: int | None = None,
    mail_open: int | None = None,
) -> Daily:
    """One scope's aggregate of a day's snapshot rows: all rows when ``scope_project`` is None, else
    the rows of that project (the inbox)."""
    today = day_of(now)
    scoped = [row for row in rows if scope_project is None or row.get("project_id") == scope_project]
    buckets = [0, 0, 0, 0]
    oldest = overdue = undated = recent = 0
    for row in scoped:
        age = age_days(now, row.get("added_at"))
        if age is not None:
            buckets[0 if age <= 7 else 1 if age <= 14 else 2 if age <= 30 else 3] += 1
            oldest = max(oldest, age)
            if now - int(row["added_at"]) < COMPLETED_WINDOW:
                recent += 1
        overdue += is_overdue(row, now, today)
        undated += row.get("due_date") is None
    if completed is None:
        done, created, source = None, None, "none"
    elif scope_project is None:
        done, created, source = completed.total, recent + completed.added_recent_total, "api"
    else:
        done, created, source = completed.inbox, recent + completed.added_recent_inbox, "api"
    return Daily(
        open=len(scoped),
        age_0_7=buckets[0],
        age_8_14=buckets[1],
        age_15_30=buckets[2],
        age_31_plus=buckets[3],
        oldest_days=oldest,
        overdue=overdue,
        undated=undated,
        created_7d=created,
        completed_7d=done,
        completed_source=source,
        closed_1d=closed_1d if scope_project is None else None,
        mail_open=mail_open if scope_project is None else None,
        complete=complete,
    )


# ---- ops-v1 facts --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GtdFacts:
    """What the ops status reads from the object's storage (no D1): the latest complete aggregate's
    counters, the snapshot and review times, and the switches that decide the two signals."""

    collect_enabled: bool  # GTD_COLLECT_UTC is not off and nothing pauses Todoist
    review_enabled: bool
    last_ok_at: int | None = None
    first_attempt_at: int | None = None
    counters: Mapping[str, int] = field(default_factory=dict)
    last_review_at: int | None = None
    first_review_at: int | None = None


def status_counters(daily_all: Daily | None, daily_inbox: Daily | None) -> dict[str, int]:
    """The ops counters of a complete aggregate; unknown ones are left out."""
    counters: dict[str, int] = {}
    if daily_all is None or not daily_all.complete:
        return counters
    if daily_inbox is not None:
        counters["inbox_open"] = daily_inbox.open
        counters["inbox_oldest_days"] = daily_inbox.oldest_days
    counters["overdue"] = daily_all.overdue
    if daily_all.mail_open is not None:
        counters["carryover_open"] = daily_all.mail_open
    if daily_all.completed_7d is not None:
        counters["completed_7d"] = daily_all.completed_7d
    return counters


def review_age_days(facts: GtdFacts, now: int) -> int | None:
    """Days since the last completed review, or since the first review task when none was completed."""
    since = facts.last_review_at if facts.last_review_at is not None else facts.first_review_at
    return None if since is None else max((now - since) // DAY, 0)


def snapshot_age(facts: GtdFacts, now: int) -> int | None:
    """Seconds the snapshot has been stale for the signal, or None when it is not stale (or collection
    is off): the last ok snapshot is older than SNAPSHOT_STALE, or there has been none SNAPSHOT_STALE
    after the first attempt this object remembers."""
    if not facts.collect_enabled:
        return None
    since = facts.last_ok_at if facts.last_ok_at is not None else facts.first_attempt_at
    if since is None or now - since <= SNAPSHOT_STALE:
        return None
    return now - since


# ---- the morning brief's carryover -----------------------------------------------------------


def carried_line(summary: str, now: int, created_at: int) -> str:
    """A carried summary for the recommendation input: ``[N 天前] summary`` (N >= 1)."""
    return f"[{max((now - created_at) // DAY, 1)} 天前] {summary}"


# ---- the Sunday review ---------------------------------------------------------------------


def review_title(week: str) -> str:
    return f"每周回顾 {week}"


@dataclass(frozen=True, slots=True)
class ReviewFacts:
    """Everything the review body shows: numbers, dates, codes and links only."""

    week: str
    snapshot_day: str | None  # the day of the aggregate shown, None when there is none
    all: Daily | None
    inbox: Daily | None
    all_week_ago: Daily | None
    inbox_week_ago: Daily | None
    attention_events: int | None
    ops: OpsDigest | None
    last_review_at: int | None
    public_host: str
    dashboard_url: str | None


def _trend(now: int, before: int | None) -> str:
    if before is None:
        return ""
    delta = now - before
    return f"（上周 {before}，{'+' if delta > 0 else ''}{delta}）" if delta else f"（上周 {before}，持平）"


def _stamp(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%d %H:%M UTC")


def review_body(facts: ReviewFacts, now: int) -> str:
    """The review task's description: counts, trends and links, never a task title."""
    lines: list[str] = []
    if facts.all is None or facts.snapshot_day is None:
        lines.append("快照：本周没有可用的 Todoist 快照（只含计数，稍后可在 Todofy 查看）。")
    else:
        partial = "" if facts.all.complete else "；任务过多，快照不完整"
        lines.append(f"快照 {facts.snapshot_day}（Todoist 元数据，只含计数{partial}）")
        inbox = facts.inbox
        if inbox is not None:
            before = None if facts.inbox_week_ago is None else facts.inbox_week_ago.open
            lines.append(
                f"收件箱：开放 {inbox.open}{_trend(inbox.open, before)}；最老 {inbox.oldest_days} 天；"
                f"0–7 天 {inbox.age_0_7} · 8–14 天 {inbox.age_8_14} · 15–30 天 {inbox.age_15_30}"
                f" · >30 天 {inbox.age_31_plus}"
            )
        every = facts.all
        before = None if facts.all_week_ago is None else facts.all_week_ago.open
        lines.append(
            f"全部项目：开放 {every.open}{_trend(every.open, before)} · 逾期 {every.overdue} · 无日期 {every.undated}"
        )
        created = "不可用" if every.created_7d is None else str(every.created_7d)
        completed = "不可用" if every.completed_7d is None else str(every.completed_7d)
        lines.append(f"近 7 天：新建 {created} · 完成 {completed}")
        if every.mail_open is not None:
            lines.append(f"邮件任务：14 天内仍开着 {every.mail_open}")
    todofy = "不可用" if facts.attention_events is None else str(facts.attention_events)
    ops_text = "无"
    if facts.ops is not None and facts.ops.items:
        parts = []
        for item in facts.ops.items[:8]:
            text = f"{item.source} {item.code}"
            if item.metrics:
                text += " " + ",".join(f"{name}={metric_text(value)}" for name, value in item.metrics)
            parts.append(text)
        ops_text = f"（仪表盘报告 {_stamp(facts.ops.generated_at)}）" + "；".join(parts)
    lines.append(f"Todofy：需处理事件 {todofy}；运维：{ops_text}")
    if facts.last_review_at is None:
        lines.append("上次回顾：尚无完成记录")
    else:
        ago = max((now - facts.last_review_at) // DAY, 0)
        lines.append(f"上次回顾：{day_of(facts.last_review_at)} 完成（{ago} 天前）")
    lines.append("步骤：清空收件箱 → 看逾期与无日期 → 看项目与等待 → 想想下周")
    links = []
    if facts.dashboard_url:
        links.append(f"面板：{facts.dashboard_url}")
    if facts.public_host:
        links.append(f"Todofy GTD：https://{facts.public_host}/gtd")
    if links:
        lines.append("   ".join(links))
    body = "\n".join(lines) + "\n"
    return body.encode()[:MAX_REVIEW_BODY_BYTES].decode(errors="ignore")


def daily_from_row(row: Mapping[str, Any]) -> Daily:
    """A gtd_daily row read back from D1."""

    def optional(name: str) -> int | None:
        return None if row.get(name) is None else int(row[name])

    return Daily(
        open=int(row["open"]),
        age_0_7=int(row["age_0_7"]),
        age_8_14=int(row["age_8_14"]),
        age_15_30=int(row["age_15_30"]),
        age_31_plus=int(row["age_31_plus"]),
        oldest_days=int(row["oldest_days"]),
        overdue=int(row["overdue"]),
        undated=int(row["undated"]),
        created_7d=optional("created_7d"),
        completed_7d=optional("completed_7d"),
        completed_source=str(row["completed_source"]),
        closed_1d=optional("closed_1d"),
        mail_open=optional("mail_open"),
        complete=bool(row["complete"]),
    )


def pick_days(rows: Iterable[Mapping[str, Any]], today: str) -> dict[str, Any]:
    """From gtd_daily rows of the last two weeks: the newest complete-or-not day up to ``today`` and
    the rows of the same scope 7 days before it (for the review's trends)."""
    by_day: dict[str, dict[str, Daily]] = {}
    for row in rows:
        if row["day"] <= today:
            by_day.setdefault(str(row["day"]), {})[str(row["scope"])] = daily_from_row(row)
    days = sorted((day for day, scopes in by_day.items() if Scope.ALL in scopes), reverse=True)
    if not days:
        return {"day": None, "all": None, "inbox": None, "all_week_ago": None, "inbox_week_ago": None}
    latest = days[0]
    earlier = by_day.get(shift(latest, -7), {})
    return {
        "day": latest,
        "all": by_day[latest].get(Scope.ALL),
        "inbox": by_day[latest].get(Scope.INBOX),
        "all_week_ago": earlier.get(Scope.ALL),
        "inbox_week_ago": earlier.get(Scope.INBOX),
    }


def daily_api(rows: Iterable[Mapping[str, Any]], first: str, count: int) -> list[dict[str, Any]]:
    """The owner API's GtdDay list: ``count`` days from ``first``, oldest first; a day without rows has
    ``recorded: false`` and null scopes."""
    stored: dict[str, dict[str, Daily]] = {}
    for row in rows:
        stored.setdefault(str(row["day"]), {})[str(row["scope"])] = daily_from_row(row)
    series = []
    for offset in range(count):
        day = shift(first, offset)
        scopes = stored.get(day, {})
        series.append(
            {
                "day": day,
                "recorded": Scope.ALL in scopes,
                "all": None if Scope.ALL not in scopes else _api_daily(scopes[Scope.ALL]),
                "inbox": None if Scope.INBOX not in scopes else _api_daily(scopes[Scope.INBOX]),
            }
        )
    return series


def _api_daily(daily: Daily) -> dict[str, Any]:
    value = asdict(daily)
    value["complete"] = bool(value["complete"])
    return value
