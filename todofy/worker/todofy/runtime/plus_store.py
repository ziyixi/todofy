"""D1 storage for connection revocation, weekly membership and replay-safe actions."""

import json
from typing import Any

from todofy.core import plus
from todofy.core.sql import plus as sql
from todofy.runtime.interop import now_s


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
        if names["committed"] in labels or names["bets"] in labels:
            statements.append(
                db.prepare(sql.REMEMBER_WEEK).bind(
                    str(task["id"]), week, int(names["committed"] in labels), int(names["bets"] in labels)
                )
            )
    # Bounded pages and bounded D1 batches; only planning parents/explicit Bets are recorded.
    for offset in range(0, len(statements), 25):
        await db.batch(statements[offset : offset + 25])


async def start_action(db: Any, request_id: str, digest: str, commands: list[dict[str, Any]]) -> None:
    await run(db, sql.START_ACTION, request_id, digest, json.dumps(commands, separators=(",", ":")), now_s())
