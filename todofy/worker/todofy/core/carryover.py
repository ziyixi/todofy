"""The morning brief's carryover (runtime/reports.py): older mail that still awaits a decision.

Pure stdlib, host-tested. The recommendation reads the 24 h window and, besides it, the mail of the days before
that is still pending in Mail (neither converted to a task, deleted, nor decided on the event page): the
``summaries_pending`` rows that arrived 1 to REPORT_CARRYOVER_DAYS days ago. Each is one ``[N 天前] summary`` line,
spread over the days it arrived and cut to a byte budget, built only of summaries Todofy already stores.
"""

from collections.abc import Mapping, Sequence
from typing import Any

DAY = 86_400

CARRYOVER_MAX_ROWS = 30
DEFAULT_CARRYOVER_DAYS = 14
MAX_CARRYOVER_DAYS = 14
# The pending mail read to pick from: a fortnight of a busy inbox, each row an ID and a time.
MAX_CANDIDATES = 2000
# Each carried summary is cut to this many UTF-8 bytes (the SQL reads at most CARRYOVER_READ_CHARS
# characters of it), and the carried block stops at CARRYOVER_MAX_BYTES: at most about 8K tokens more
# than the 24 h report, whatever the stored summaries' size (up to 64 KiB each).
CARRYOVER_READ_CHARS = 1024
CARRYOVER_LINE_BYTES = 1024
CARRYOVER_MAX_BYTES = 16 * 1024


def carried_days(now: int, created_at: int) -> int:
    """How many days ago a carried mail arrived (N >= 1: it is older than the 24 h window)."""
    return max((now - created_at) // DAY, 1)


def carried_line(summary: str, now: int, created_at: int) -> str:
    """A carried summary for the recommendation input: ``[N 天前] summary`` (N >= 1), the summary cut
    to CARRYOVER_LINE_BYTES on a UTF-8 boundary."""
    text = summary.encode()[:CARRYOVER_LINE_BYTES].decode(errors="ignore")
    return f"[{carried_days(now, created_at)} 天前] {text}"


def pick_carried(candidates: Sequence[Mapping[str, Any]], now: int, cap: int = CARRYOVER_MAX_ROWS) -> list[str]:
    """Which pending mail the brief carries: ``candidates`` are ``{event_id, created_at}`` rows (any order);
    returns at most ``cap`` event IDs, spread over the days they arrived.

    Round-robin over the "N 天前" days, oldest day first and the newest mail of a day first, so an
    ordinary day's 30+ pending mail cannot push out the mail pending for a week or more (the most
    forgotten ones, the reason for the carryover)."""
    by_day: dict[int, list[tuple[int, str]]] = {}
    for row in candidates:
        created_at = int(row["created_at"])
        by_day.setdefault(carried_days(now, created_at), []).append((created_at, str(row["event_id"])))
    queues = [sorted(by_day[day], reverse=True) for day in sorted(by_day, reverse=True)]
    picked: list[str] = []
    while len(picked) < cap and any(queues):
        for queue in queues:
            if queue and len(picked) < cap:
                picked.append(queue.pop(0)[1])
    return picked


def carried_lines(rows: Sequence[Mapping[str, Any]], order: Sequence[str], now: int) -> list[str]:
    """The carried input lines for the picked rows (``{event_id, summary, created_at}``): taken in
    ``order`` (pick_carried's priority) until CARRYOVER_MAX_BYTES, then newest first."""
    by_id = {str(row["event_id"]): row for row in rows}
    kept: list[tuple[int, str]] = []
    total = 0
    for event_id in order:
        row = by_id.get(event_id)
        if row is None:
            continue  # converted or deleted between the two reads
        line = carried_line(str(row["summary"]), now, int(row["created_at"]))
        size = len(line.encode()) + 1
        if total + size > CARRYOVER_MAX_BYTES:
            break
        total += size
        kept.append((int(row["created_at"]), line))
    return [line for _, line in sorted(kept, key=lambda item: item[0], reverse=True)]
