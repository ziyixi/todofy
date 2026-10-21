"""Daily cleanup of expired rows (v2 plan §5.3), one bounded batch per table per call.

Kept: daily reports 90 days, owner actions 180 days,
auth-failure counters 30 days; imported legacy mail text until its
``expires_at`` and, when LEGACY_TEXT_RETENTION_DAYS is above 0, for that many
days (0 keeps it). ``mail_events`` is never deleted: it is the webhook dedupe
ledger. Nor are ``summaries`` (since 2026-10, the owner's rule): a summary is
Mail's content and goes only when the owner deletes it. The GTD ledger's daily
aggregates and weekly reviews stay as they are until Tasks has copied them and a
later migration drops them.
"""

import json
from datetime import UTC, datetime
from typing import Any

from todofy.core.backoff import DAY
from todofy.core.sql import retention as sql
from todofy.runtime.config import integer
from todofy.runtime.reports import failure_hour

REPORT_DAYS = 90
OWNER_ACTION_DAYS = 180
AUTH_FAILURE_DAYS = 30
BATCH = 100


async def tick(db: Any, env: Any, now: int) -> bool:
    """One sweep of at most five bounded writes; True if a table still has expired rows."""
    batches = [
        (sql.EXPIRE_REPORTS, _day(now - REPORT_DAYS * DAY), BATCH),
        (sql.EXPIRE_OWNER_ACTIONS, now - OWNER_ACTION_DAYS * DAY, BATCH),
        (sql.EXPIRE_AUTH_FAILURES, failure_hour(now - AUTH_FAILURE_DAYS * DAY), BATCH),
        (sql.EXPIRE_LEGACY_TEXT, now, BATCH),
    ]
    if legacy_days := integer(env, "LEGACY_TEXT_RETENTION_DAYS", 0):
        batches.append((sql.EXPIRE_LEGACY_TEXT_OLD, now - legacy_days * DAY, BATCH))
    results = await db.batch([db.prepare(query.sql).bind(cutoff, size) for query, cutoff, size in batches])
    deleted = [result.meta.changes for result in results]
    print(json.dumps({"retention_deleted": deleted}))
    return any(count >= size for count, (_, _, size) in zip(deleted, batches, strict=True))


def _day(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d")
