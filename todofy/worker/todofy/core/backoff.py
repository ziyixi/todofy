"""Retry timing: durable row backoff, in-call Todoist retries, Retry-After and time budgets.

Durable backoff and the summary give-up rule come from mail_inbox_worker.go:75-105;
the in-call Todoist policy from todo/internal/todoist/client.go and utils/retry.go
(@ 6c46ed4); the budgets from the v2 plan §5.3-§5.4. All values are seconds.
"""

import re
from datetime import UTC, datetime

from .vocab import Code

MINUTE = 60
HOUR = 60 * MINUTE
DAY = 24 * HOUR

BACKOFF_BASE = MINUTE
BACKOFF_MAX_EXPONENT = 8  # caps the delay at 256 minutes
SUMMARY_GIVE_UP_ATTEMPTS = 12
SUMMARY_RETRY_WINDOW = 7 * DAY
MAX_RETRY_AFTER = DAY
SUMMARY_CRASH_LIMIT = 3
WATCHDOG = 2 * MINUTE

REMINDER_CHECK_INTERVAL = 10 * MINUTE
REMINDER_RETRY_DELAY = HOUR
REMINDER_MAX_ATTEMPTS = 5
TODOIST_AUTH_BLOCK = 6 * HOUR

GEMINI_MODEL_TIMEOUT = 60
GEMINI_STEP_BUDGET = 90
TODOIST_ATTEMPT_TIMEOUT = 14
TODOIST_MAX_ATTEMPTS = 3
TODOIST_STEP_BUDGET = 45
TODOIST_INLINE_BASE = 0.25
TODOIST_INLINE_MAX = 2.0
LOOKUP_PAGE_TIMEOUT = 20
LOOKUP_MAX_PAGES = 10
REPORT_ON_DEMAND_BUDGET = 40

# Outages and quota heal with time, so they get the week-long window; a
# rejected request is retried only up to the attempt floor.
_TRANSIENT_SUMMARY_CODES = frozenset({Code.SUMMARY_FAILED, Code.LLM_QUOTA})
_HTTP_DATE_FORMATS = ("%a, %d %b %Y %H:%M:%S GMT", "%A, %d-%b-%y %H:%M:%S GMT", "%a %b %d %H:%M:%S %Y")
_SECONDS = re.compile(r"[+-]?[0-9]+")


def retry_delay(attempts: int, base: float = BACKOFF_BASE) -> float:
    """Delay after a row's ``attempts`` earlier failures: base·2^n, n capped at 8."""
    return base * 2 ** min(max(attempts, 0), BACKOFF_MAX_EXPONENT)


def postpone_delay(attempts: int, retry_after: float = 0.0, base: float = BACKOFF_BASE) -> float:
    """Durable delay that also honours an upstream Retry-After, bounded to a day."""
    return max(retry_delay(attempts, base), min(retry_after, MAX_RETRY_AFTER))


def summary_gives_up(attempts: int, code: str, age: float) -> bool:
    """Whether a failed summary step moves the row to ``failed_summary``.

    ``attempts`` counts earlier failures (before this one) and ``age`` is the
    time since the event arrived.
    """
    if code == Code.LLM_BUDGET_EXHAUSTED or attempts < SUMMARY_GIVE_UP_ATTEMPTS:
        return False
    return code not in _TRANSIENT_SUMMARY_CODES or age >= SUMMARY_RETRY_WINDOW


def inline_delay(attempt: int, retry_after: float = 0.0) -> float:
    """Pause before in-call Todoist attempt ``attempt + 1`` (``attempt`` is 1-based)."""
    delay = retry_after if retry_after > 0 else TODOIST_INLINE_BASE * 2 ** (attempt - 1)
    return min(delay, TODOIST_INLINE_MAX)


def parse_retry_after(value: str | None, now: datetime) -> float:
    """Seconds from a Retry-After header (delta-seconds or HTTP-date); 0 if absent or past."""
    value = (value or "").strip()
    if _SECONDS.fullmatch(value):
        return float(max(int(value), 0))
    for layout in _HTTP_DATE_FORMATS:
        try:
            moment = datetime.strptime(value, layout).replace(tzinfo=UTC)
        except ValueError:
            continue
        return max((moment - now).total_seconds(), 0.0)
    return 0.0
