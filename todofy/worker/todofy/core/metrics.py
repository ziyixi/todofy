"""Operating metrics: one Analytics Engine data point per pipeline step, and the daily counters.

Two sinks with different jobs (docs/dev-notes.md, "Metrics and ops queries"):

- Workers Analytics Engine gets one point per upstream step (and one per gateway
  request). Writes are cheap, but reading needs the SQL API and an account token,
  so these points are for the owner's ad-hoc queries, never for the UI.
- The D1 table ``daily_metrics`` holds a dozen keys per finished UTC day for the
  owner UI's 30-day trends. They are counted in the object and written once a day,
  which keeps D1 at a few dozen rows written per day.

Neither ever carries mail content, addresses, subjects or the owner's identity:
only step names, outcomes, error codes, model names and numbers.
"""

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from enum import StrEnum

from .vocab import EventState


class Step(StrEnum):
    """The pipeline steps that call an upstream; the index of their data points."""

    SUMMARY = "summary"
    TASK = "task"
    LOOKUP = "lookup"
    REMINDER = "reminder"
    REPORT = "report"
    BACKUP = "backup"
    # The summary call of a canary event (contracts/ops-v1): its own step, so the summary
    # latency stays real mail only; its Gemini calls and tokens still count against the day.
    CANARY = "canary"


GEMINI_STEPS = frozenset({Step.SUMMARY, Step.REPORT, Step.CANARY})
TODOIST_CREATE_STEPS = frozenset({Step.TASK, Step.REMINDER})

# Analytics Engine accepts at most 20 blobs, 20 doubles and one index of at most
# 96 bytes per point, and 250 points per invocation. A point here has 4 of each and
# the object writes at most one per step (a handful per alarm), so only the cut of
# overlong strings needs enforcing.
MAX_INDEX_BYTES = 96
MAX_BLOB_CHARS = 64
# daily_metrics.key CHECK (length(key) BETWEEN 1 AND 96).
MAX_KEY_CHARS = 96


class Key(StrEnum):
    """The fixed daily_metrics keys; Gemini tokens add one key per model."""

    MAILS_RECEIVED = "mails_received"
    MAILS_COMPLETED = "mails_completed"
    MAILS_FAILED = "mails_failed"
    LATENCY_P50 = "latency_p50_s"
    LATENCY_P90 = "latency_p90_s"
    GEMINI_CALLS = "gemini_calls"
    TODOIST_CREATES = "todoist_creates"
    TODOIST_LOOKUPS = "todoist_lookups"


GEMINI_TOKENS = "gemini_tokens:"
# The OpenAPI DailyMetricsDay counters, in the Key they are stored under.
COUNTERS = {
    "mails_received": Key.MAILS_RECEIVED,
    "mails_completed": Key.MAILS_COMPLETED,
    "mails_failed": Key.MAILS_FAILED,
    "gemini_calls": Key.GEMINI_CALLS,
    "todoist_creates": Key.TODOIST_CREATES,
    "todoist_lookups": Key.TODOIST_LOOKUPS,
}


def _cut(text: str, limit: int) -> str:
    return text.encode()[:limit].decode(errors="ignore")


def tokens_key(model: str) -> str:
    return _cut(GEMINI_TOKENS + model, MAX_KEY_CHARS)


@dataclass(frozen=True, slots=True)
class StepPoint:
    """One upstream step: what it was, how it ended and what it cost."""

    step: Step
    outcome: str  # ok / failed, a TaskResult, or the ledger state a lookup left
    code: str = ""  # core.vocab.Code or "" on success
    model: str = ""  # the Gemini model that answered (or was tried last)
    upstream_ms: int = 0  # wall time of the upstream call(s), retries included
    tokens_in: int = 0
    tokens_out: int = 0
    attempts: int = 0  # requests sent: models tried or POSTs; 0 when not counted (lookup pages)

    def data_point(self) -> dict[str, list[str] | list[float]]:
        """The ``writeDataPoint`` argument: index = step; blobs = step, outcome, code, model;
        doubles = upstream ms, tokens in, tokens out, attempts."""
        return {
            "indexes": [_cut(self.step, MAX_INDEX_BYTES)],
            "blobs": [_cut(value, MAX_BLOB_CHARS) for value in (self.step, self.outcome, self.code, self.model)],
            "doubles": [float(self.upstream_ms), float(self.tokens_in), float(self.tokens_out), float(self.attempts)],
        }

    def counters(self) -> dict[str, int]:
        """What this step adds to the day's counters (zero entries left out)."""
        if self.step in GEMINI_STEPS:
            counts = {Key.GEMINI_CALLS.value: self.attempts}
            if self.model:
                counts[tokens_key(self.model)] = self.tokens_in + self.tokens_out
        elif self.step in TODOIST_CREATE_STEPS:
            counts = {Key.TODOIST_CREATES.value: self.attempts}
        elif self.step == Step.LOOKUP:
            counts = {Key.TODOIST_LOOKUPS.value: 1}
        else:
            counts = {}
        return {key: value for key, value in counts.items() if value > 0}


def transition_keys(from_state: str | None, to_state: str) -> list[Key]:
    """The mail counters one event_transitions row adds to its day."""
    keys = [Key.MAILS_RECEIVED] if from_state is None else []
    if to_state == EventState.COMPLETE:
        keys.append(Key.MAILS_COMPLETED)
    elif to_state == EventState.FAILED_SUMMARY:
        keys.append(Key.MAILS_FAILED)
    return keys


def percentile(ordered: list[int], fraction: float) -> int:
    """Nearest-rank percentile of a non-empty ascending list."""
    return ordered[max(math.ceil(fraction * len(ordered)), 1) - 1]


def day_values(counts: Mapping[str, int], latencies: list[int]) -> dict[str, int]:
    """One finished day as stored: mails_received always (it marks the day as recorded),
    every other counter only when non-zero, and the latency percentiles when any mail
    completed. ``latencies`` are seconds from arrival to completion."""
    values = {key: value for key, value in counts.items() if value > 0}
    values[Key.MAILS_RECEIVED] = counts.get(Key.MAILS_RECEIVED, 0)
    if latencies:
        ordered = sorted(latencies)
        values[Key.LATENCY_P50] = percentile(ordered, 0.5)
        values[Key.LATENCY_P90] = percentile(ordered, 0.9)
    return values


def day_of(timestamp: int) -> str:
    """The UTC day (YYYY-MM-DD) of Unix seconds."""
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d")


def day_start(day: str) -> int:
    """Unix seconds of the UTC midnight that starts ``day``."""
    return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp())


def shift(day: str, days: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


def days_from(first: str, last: str) -> list[str]:
    """Every day from ``first`` to ``last`` inclusive (empty when first > last)."""
    count = (date.fromisoformat(last) - date.fromisoformat(first)).days + 1
    return [shift(first, offset) for offset in range(max(count, 0))]


def daily_series(rows: Iterable[tuple[str, str, int]], first: str, count: int) -> list[dict]:
    """``count`` OpenAPI DailyMetricsDay objects from ``first`` on, oldest first, from
    (day, key, value) rows; a day without rows is ``recorded: false`` with zeros."""
    stored: dict[str, dict[str, int]] = {}
    for day, key, value in rows:
        stored.setdefault(day, {})[key] = int(value)
    series = []
    for day in days_from(first, shift(first, count - 1)):
        values = stored.get(day, {})
        series.append(
            {
                "day": day,
                "recorded": bool(values),
                **{name: values.get(key, 0) for name, key in COUNTERS.items()},
                "latency_p50_seconds": values.get(Key.LATENCY_P50),
                "latency_p90_seconds": values.get(Key.LATENCY_P90),
                "gemini_tokens": {
                    key.removeprefix(GEMINI_TOKENS): value
                    for key, value in sorted(values.items())
                    if key.startswith(GEMINI_TOKENS)
                },
            }
        )
    return series
