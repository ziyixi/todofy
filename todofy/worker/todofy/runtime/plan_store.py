"""The planning store in D1 (migrations/0007_plan_store.sql): the only module that reads or writes plan_*.

Owner-authored planning facts and Todofy's own task identities; never task content. Dependencies are the first
facts written here (docs/todoist-plus.md, "Dependencies"); the other tables stay idle until their features move
over. Callers name tasks by the task store's own IDs, with its provider (core/plan.py PROVIDERS).
"""

import json
from typing import Any

from todofy.core import plan
from todofy.core.sql import plan as sql


async def verify(db: Any) -> dict[str, int]:
    """VerifyPlanStoreResponse's counts: rows per table and the rows that break a rule, never row content."""
    row = await db.prepare(sql.VERIFY).first()
    return {name: int(row[name]) for name in sql.VERIFY_COUNTS}


def dependency_rows(result: Any) -> list[dict[str, Any]]:
    """TaskDependency messages from the result of sql.EDGES or sql.TASK_EDGES."""
    return [
        {
            "task_id": str(row["task_id"]),
            "prerequisite_id": str(row["prerequisite_id"]),
            "baseline_completed_count": int(row["baseline_count"]),
            "done": bool(row["done"]),
        }
        for row in (dict(item) for item in result.results)
    ]


def edges(db: Any) -> Any:
    """Every dependency, as a statement for a caller's batch; dependency_rows reads its result."""
    return db.prepare(sql.EDGES)


async def dependencies(db: Any) -> list[dict[str, Any]]:
    return dependency_rows(await db.prepare(sql.EDGES).all())


async def add_dependency(
    db: Any,
    provider: str,
    task_id: str,
    prerequisite_id: str,
    baseline: int,
    now: int,
    replaced: tuple[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Adds that ``task_id`` waits for ``prerequisite_id`` (both just confirmed active), or starts a done dependency
    between them over from ``baseline``, and answers what it waits for. One batch, so a task identity is never left
    without its edge, and a done dependency that gives way (``replaced``, core/plan.py check_dependency) goes in
    the same write."""
    statements = []
    if replaced:
        statements.append(db.prepare(sql.REMOVE_EDGE.sql).bind(provider, replaced[0], provider, replaced[1]))
    *_, edges_after = await db.batch(
        [
            *statements,
            db.prepare(sql.ADD_TASKS.sql).bind(provider, now, json.dumps([task_id, prerequisite_id])),
            db.prepare(sql.ADD_EDGE.sql).bind(baseline, now, provider, task_id, provider, prerequisite_id),
            db.prepare(sql.TASK_EDGES.sql).bind(provider, task_id),
        ]
    )
    return dependency_rows(edges_after)


async def remove_dependency(db: Any, provider: str, task_id: str, prerequisite_id: str) -> list[dict[str, Any]]:
    _, edges_after = await db.batch(
        [
            db.prepare(sql.REMOVE_EDGE.sql).bind(provider, task_id, provider, prerequisite_id),
            db.prepare(sql.TASK_EDGES.sql).bind(provider, task_id),
        ]
    )
    return dependency_rows(edges_after)


async def dependency_roles(db: Any, provider: str, task_ids: list[str]) -> list[dict[str, Any]]:
    """Of ``task_ids``, those with a dependency: whether each waits, is waited for, and how it closed if known."""
    result = await db.prepare(sql.DEPENDENCY_ROLES.sql).bind(provider, json.dumps(task_ids)).all()
    rows = [dict(row) for row in result.results]
    return [
        {
            "id": str(row["external_id"]),
            "closed_as": row["closed_as"],
            "waits": bool(row["waits"]),
            "awaited": bool(row["awaited"]),
        }
        for row in rows
        if row["waits"] or row["awaited"]
    ]


async def close_tasks(db: Any, provider: str, task_ids: list[str], closed_as: str, now: int) -> None:
    await db.prepare(sql.CLOSE_TASKS.sql).bind(now, closed_as, provider, json.dumps(task_ids)).run()


async def settle(
    db: Any,
    provider: str,
    now: int,
    *,
    gone: list[str],
    completed: list[str],
    deleted: list[str],
    released: list[str],
    reopened: list[str],
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Settles what the task store says about tasks, in one batch: what ``gone`` tasks waited for is removed,
    ``completed`` prerequisites are recorded so, ``deleted`` ones are recorded so with every dependency on them
    removed, and the dependencies on ``released`` ones, whose closing the store does not say, are removed with
    nothing recorded. ``reopened`` tasks, recorded closed but listed again, are open again. Answers every
    dependency after it, and the tasks that waited for a deleted and for a released one."""
    statements = []
    told: dict[str, int] = {}  # which result lists the waiters of the deleted, and of the released, tasks
    if deleted:
        ids = json.dumps(deleted)
        told["deleted"] = len(statements)
        statements += [
            db.prepare(sql.WAITERS.sql).bind(provider, ids),
            db.prepare(sql.CLOSE_TASKS.sql).bind(now, plan.DELETED, provider, ids),
            db.prepare(sql.FORGET_PREREQUISITES.sql).bind(provider, ids),
        ]
    if released:
        ids = json.dumps(released)
        told["released"] = len(statements)
        statements += [
            db.prepare(sql.WAITERS.sql).bind(provider, ids),
            db.prepare(sql.FORGET_PREREQUISITES.sql).bind(provider, ids),
        ]
    if completed:
        statements.append(db.prepare(sql.CLOSE_TASKS.sql).bind(now, plan.COMPLETED, provider, json.dumps(completed)))
    if reopened:
        statements.append(db.prepare(sql.ADD_TASKS.sql).bind(provider, now, json.dumps(reopened)))
    if gone:
        statements.append(db.prepare(sql.FORGET_WAITS.sql).bind(provider, json.dumps(gone)))
    results = await db.batch([*statements, db.prepare(sql.EDGES)])

    def waiters(kind: str) -> list[str]:
        rows = results[told[kind]].results if kind in told else []
        return list(dict.fromkeys(str(dict(row)["external_id"]) for row in rows))

    return dependency_rows(results[-1]), waiters("deleted"), waiters("released")
