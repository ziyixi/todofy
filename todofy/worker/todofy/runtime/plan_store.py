"""The planning store in D1 (migrations/0007_plan_store.sql): the only module that reads or writes plan_*.

Owner-authored planning facts and Todofy's own task identities; never task content. Nothing writes these tables
yet: this release adds the schema, its backup and the owner's check (docs/todoist-plus.md, "Planning store").
"""

from typing import Any

from todofy.core.sql import plan as sql


async def verify(db: Any) -> dict[str, int]:
    """VerifyPlanStoreResponse's counts: rows per table and the rows that break a rule, never row content."""
    row = await db.prepare(sql.VERIFY).first()
    return {name: int(row[name]) for name in sql.VERIFY_COUNTS}
