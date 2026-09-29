"""Daily cleanup of expired rows (v2 plan §5.3), one bounded batch per table per call.

Kept: non-imported summaries and daily reports 90 days, owner actions 180 days,
auth-failure counters 30 days; imported legacy mail text until its
``expires_at`` and, when LEGACY_TEXT_RETENTION_DAYS is above 0, for that many
days (0 keeps it). ``mail_events`` is never deleted: it is the webhook dedupe
ledger.
"""

import json
from datetime import UTC, datetime
from typing import Any

from todofy.core.backoff import DAY
from todofy.core.sql import retention as sql
from todofy.runtime.config import integer
from todofy.runtime.reports import failure_hour

SUMMARY_DAYS = 90
REPORT_DAYS = 90
OWNER_ACTION_DAYS = 180
AUTH_FAILURE_DAYS = 30
BATCH = 100


async def tick(db: Any, env: Any, now: int) -> bool:
    """One sweep of at most six bounded deletes; True if a table still has expired rows."""
    statements = [
        db.prepare(sql.EXPIRE_SUMMARIES.sql).bind(now - SUMMARY_DAYS * DAY, BATCH),
        db.prepare(sql.EXPIRE_REPORTS.sql).bind(_day(now - REPORT_DAYS * DAY), BATCH),
        db.prepare(sql.EXPIRE_OWNER_ACTIONS.sql).bind(now - OWNER_ACTION_DAYS * DAY, BATCH),
        db.prepare(sql.EXPIRE_AUTH_FAILURES.sql).bind(failure_hour(now - AUTH_FAILURE_DAYS * DAY), BATCH),
        db.prepare(sql.EXPIRE_LEGACY_TEXT.sql).bind(now, BATCH),
    ]
    if legacy_days := integer(env, "LEGACY_TEXT_RETENTION_DAYS", 0):
        statements.append(db.prepare(sql.EXPIRE_LEGACY_TEXT_OLD.sql).bind(now - legacy_days * DAY, BATCH))
    deleted = [result.meta.changes for result in await db.batch(statements)]
    print(json.dumps({"retention_deleted": deleted}))
    return any(count >= BATCH for count in deleted)


def _day(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%d")
