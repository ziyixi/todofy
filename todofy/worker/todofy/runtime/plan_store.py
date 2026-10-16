"""The planning store in D1 (migrations/0007_plan_store.sql): the only module that reads or writes plan_*.

Owner-authored planning facts and Todofy's own task identities; never task content. Dependencies
(docs/todoist-plus.md, "Dependencies"), the weekly Bets (plan_notes of kind 'bets') and the Mailbox's categories
(plan_categories of scheme 'mail', with the Todoist adapter's binding in plan_settings 'todoist.mail') are the facts
it keeps so far; the other tables wait for later steps (docs/todoist-plus.md, "Planning store"). Callers name tasks
by the task store's own IDs, with its provider (core/plan.py PROVIDERS).
"""

import json
from collections.abc import Iterable
from typing import Any

from todofy.core import plan
from todofy.core.gtd import rfc3339
from todofy.core.mailbox import Category, MailSettings
from todofy.core.sql import plan as sql

# The Todoist adapter's binding of the Mailbox:
#   {"categories": [{"id": <plan_categories.id>, "label_id": "<Todoist label ID>", "label": "<its name when saved>"}],
#    "destination": "<Todoist project ID>"}
# The destination is what an extension before planning protocol 6 chose; filed mail goes to the Inbox since then.
MAIL_KEY = "todoist.mail"


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


def bets_statement(db: Any, week: str) -> Any:
    """The Bets a plan of the account week starting on ``week`` shows (core/plan.bet_weeks), for its D1 batch."""
    return db.prepare(sql.BETS.sql).bind(*plan.bet_weeks(week))


def bet_statement(db: Any, week: str, area: str) -> Any:
    """One week's Bet of one area, for a batch."""
    return db.prepare(sql.BET.sql).bind(week, area)


def weekly_bet(row: dict[str, Any]) -> dict[str, Any]:
    """A plan_notes 'bets' row as a WeeklyBet (wire JSON): its rev is the etag, its body the text."""
    return {
        "week_start": row["period"],
        "area": row["area"],
        "text": row["body"],
        "etag": str(int(row["rev"])),
        "update_time": rfc3339(int(row["updated_at"])),
    }


def weekly_bets(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """The WeeklyBets of a BETS answer, by week, Work before Personal."""
    ordered = sorted(rows, key=lambda row: (row["period"], plan.BET_AREAS.index(row["area"])))
    return [weekly_bet(row) for row in ordered]


async def save_bet(db: Any, week: str, area: str, text: str, rev: int, now: int) -> dict[str, Any] | None:
    """Writes a Bet read at ``rev`` (0 when it had no row) and answers it as saved, or None when its row has another
    rev by now: someone else saved it in between."""
    row = await db.prepare(sql.SAVE_BET.sql).bind(week, area, text, now, rev).first()
    return None if row is None else weekly_bet(dict(row))


def mail_settings_statements(db: Any) -> list[Any]:
    """The two reads of the Mailbox's settings, for a caller's batch (mail_settings_of reads their answers)."""
    return [db.prepare(sql.MAIL_CATEGORIES.sql), db.prepare(sql.SETTING.sql).bind(MAIL_KEY)]


async def mail_settings(db: Any) -> MailSettings:
    """The Mailbox's categories and destination, one batch."""
    return mail_settings_of(*await db.batch(mail_settings_statements(db)))


def mail_settings_of(rows: Any, document: Any) -> MailSettings:
    """The active category rows with their label binding, from the answers to mail_settings_statements."""
    saved = next((json.loads(dict(row)["value"]) for row in document.results), {"categories": [], "destination": ""})
    labels = {int(entry["id"]): entry for entry in saved["categories"]}
    categories = []
    for row in (dict(item) for item in rows.results):
        # A category is saved with its binding in one batch; a row without one is ignored.
        if (bound := labels.get(int(row["id"]))) is not None:
            categories.append(Category(int(row["id"]), bound["label_id"], bound["label"], int(row["priority"])))
    return MailSettings(tuple(categories), saved["destination"])


async def next_category_id(db: Any) -> int:
    row = await db.prepare(sql.NEXT_CATEGORY_ID.sql).first()
    return int(row["id"])


async def save_mail_settings(
    db: Any, current: MailSettings, saved: MailSettings, archived: list[int], now: int
) -> None:
    """Replaces the Mailbox's settings in one batch: the archived categories go first (so a name they free can be
    taken again), the kept ones take their new names and places, the new ones are added, and the binding follows."""
    kept = {category.id for category in current.categories}
    statements = [db.prepare(sql.ARCHIVE_CATEGORY.sql).bind(now, now, category_id) for category_id in archived]
    for position, category in enumerate(saved.categories):
        if category.id in kept:
            statement = db.prepare(sql.KEEP_CATEGORY.sql).bind(category.name, position, now, category.id)
        else:
            statement = db.prepare(sql.ADD_CATEGORY.sql).bind(
                category.id, category.name, category.priority, position, now, now
            )
        statements.append(statement)
    binding = {
        "categories": [
            {"id": category.id, "label_id": category.label_id, "label": category.label} for category in saved.categories
        ],
        "destination": saved.destination,
    }
    value = json.dumps(binding, ensure_ascii=False, separators=(",", ":"))
    statements.append(db.prepare(sql.SAVE_SETTING.sql).bind(MAIL_KEY, value, now))
    await db.batch(statements)
