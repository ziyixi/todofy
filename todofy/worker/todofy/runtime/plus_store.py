"""D1 storage for connection revocation and weekly membership (receipts: runtime/plus_receipts.py)."""

from typing import Any

from todofy.core import plus
from todofy.core.sql import plus as sql


async def first(db: Any, statement: str, *args: Any) -> dict[str, Any] | None:
    result = await db.prepare(statement).bind(*args).first()
    return dict(result) if result is not None else None


async def rows(db: Any, statement: str, *args: Any) -> list[dict[str, Any]]:
    result = await db.prepare(statement).bind(*args).all()
    return [dict(row) for row in result.results]


async def run(db: Any, statement: str, *args: Any) -> None:
    await db.prepare(statement).bind(*args).run()


async def settings(db: Any) -> dict[str, Any] | None:
    return await first(db, sql.SETTINGS)


async def remember(
    db: Any, tasks: list[dict[str, Any]], week: str, mapping: list[dict[str, Any]] | None = None
) -> None:
    names = plus.role_labels(mapping)
    statements = []
    for task in tasks:
        labels = task.get("labels") or []
        # The retired Bets label is remembered while a setup still binds it, so Monday's reset removes it.
        committed, bet = names["committed"] in labels, names.get("bets") in labels
        if committed or bet:
            statements.append(db.prepare(sql.REMEMBER_WEEK).bind(str(task["id"]), week, int(committed), int(bet)))
    # Bounded pages and bounded D1 batches; only commitments and tasks still labelled Bets are recorded.
    for offset in range(0, len(statements), 25):
        await db.batch(statements[offset : offset + 25])
