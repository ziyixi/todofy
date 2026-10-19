"""Native rollover changes only Core-owned current planning state, with bounded SQLite work."""

import asyncio
import json
import types
import uuid

import pytest

from tests.unit.plus_support import D1, Statement, Storage, stubbed_pyodide
from todofy.core import plus
from todofy.core.sql import native_plan as native_sql

OLD_WEEK, WEEK = "2026-10-12", "2026-10-19"


@pytest.fixture
def rollover(monkeypatch):
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import plus_api, plus_receipts, plus_week

        database, storage = D1(), Storage([])
        for statement in plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=database),
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
            plus_lock=asyncio.Lock(),
            task_writes_wait=lambda _now: None,
        )

        def seed(task_id, week=OLD_WEEK, stage="committed", provider="tasks"):
            identity = database.db.execute(
                "INSERT INTO plan_tasks(provider,external_id,created_at) VALUES(?,?,1)", (provider, task_id)
            ).lastrowid
            database.db.execute(
                "INSERT INTO plan_task_state(task_id,stage,area,lead_days,waiting,active,rev,request_id,updated_at)"
                " VALUES(?,?,'work',21,1,1,1,'synthetic-before-rollover',1)",
                (identity, stage),
            )
            database.db.execute("INSERT INTO plus_weeks VALUES(?,?,1,0)", (task_id, week))
            database.db.commit()
            return identity

        yield types.SimpleNamespace(
            core=core, database=database, seed=seed, week=plus_week, receipts=plus_receipts, api=plus_api
        )


def receipt_state(core, request_id):
    [row] = core.sql.exec("SELECT state FROM plus_receipts WHERE request_id=?", request_id).toArray()
    return row.state


def test_native_rollover_preserves_new_week_choices_other_fields_and_provider_state(rollover):
    value = rollover
    ended = value.seed("synthetic-hidden-or-deleted")
    kept = value.seed("synthetic-kept", week=WEEK)
    weekly = value.seed("synthetic-weekly", stage="weekly")
    other = value.seed("synthetic-other-provider", provider="todoist")
    value.database.statements.clear()
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is True
    assert len(value.database.statements) == 4
    rows = {
        row["task_id"]: dict(row)
        for row in value.database.db.execute(
            "SELECT task_id,stage,area,lead_days,waiting,active,rev FROM plan_task_state"
        )
    }
    assert rows[ended] == {
        "task_id": ended,
        "stage": "weekly",
        "area": "work",
        "lead_days": 21,
        "waiting": 1,
        "active": 1,
        "rev": 2,
    }
    assert rows[kept]["stage"] == rows[other]["stage"] == "committed"
    assert rows[kept]["rev"] == rows[other]["rev"] == rows[weekly]["rev"] == 1
    assert value.database.weeks() == {"synthetic-kept": (WEEK, 1, 0)}
    assert not value.core.sql.exec("SELECT request_id FROM plus_receipts").toArray()


def test_native_rollover_finishes_only_matching_started_receipts_after_commit(rollover, monkeypatch):
    value = rollover
    identity = value.seed("synthetic-receipt")
    value.seed("synthetic-unrelated-receipt")
    record = {"task_id": "synthetic-receipt", "week_start": OLD_WEEK, "committed": 1, "bet": 0}
    request_id = f"week:{OLD_WEEK}:synthetic-receipt"
    commands = [{"method": "", "body": {"name": "tasks/synthetic-receipt"}}]
    asyncio.run(value.receipts.start(value.core, request_id, "WeekReset", plus.fingerprint(record), commands))
    unrelated_id = f"week:{OLD_WEEK}:synthetic-unrelated-receipt"
    asyncio.run(
        value.receipts.start(
            value.core,
            unrelated_id,
            "WeekReset",
            "different-request-hash",
            [{"method": "", "body": {"name": "tasks/synthetic-unrelated-receipt"}}],
        )
    )
    batch = value.database.batch

    async def failing_batch(statements):
        raise OSError("synthetic transaction refused")

    monkeypatch.setattr(value.database, "batch", failing_batch)
    with pytest.raises(OSError):
        asyncio.run(value.week.reset_ended(value.core, WEEK))
    assert receipt_state(value.core, request_id) == "started"
    assert value.database.db.execute("SELECT rev FROM plan_task_state WHERE task_id=?", (identity,)).fetchone()[0] == 1
    monkeypatch.setattr(value.database, "batch", batch)
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is True
    rows = {
        row.request_id: row.state for row in value.core.sql.exec("SELECT request_id,state FROM plus_receipts").toArray()
    }
    assert rows == {request_id: "done", unrelated_id: "started"}
    assert receipt_state(value.core, request_id) == "done"


def test_native_rollover_has_a_hundred_membership_bound_and_replays_without_revision_changes(rollover):
    value = rollover
    for index in range(101):
        value.seed(f"synthetic-bounded-{index:03d}")
    value.database.statements.clear()
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is False
    assert len(value.database.statements) == 4 and len(value.database.weeks()) == 1
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is True
    assert not value.database.weeks()
    before = value.database.db.execute("SELECT * FROM plan_task_state").fetchall()
    assert all(row["rev"] == 2 for row in before)
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is True
    assert value.database.db.execute("SELECT * FROM plan_task_state").fetchall() == before


@pytest.mark.parametrize("boundary", ["finish", "sync", "cleanup"])
def test_native_rollover_replays_an_interruption_after_d1_commit(rollover, monkeypatch, boundary):
    value = rollover
    value.seed("synthetic-interrupted-receipt")
    request_id = f"week:{OLD_WEEK}:synthetic-interrupted-receipt"
    record = {"task_id": "synthetic-interrupted-receipt", "week_start": OLD_WEEK, "committed": 1, "bet": 0}
    commands = [
        {
            "method": "",
            "body": {"name": "tasks/synthetic-interrupted-receipt", "request_id": plus.command_id(request_id)},
            "planning": {"state": {"stage": "weekly"}, "expected_rev": 1},
        }
    ]
    asyncio.run(value.receipts.start(value.core, request_id, "WeekReset", plus.fingerprint(record), commands))
    finish = value.receipts.finish
    storage = value.core.ctx.storage
    sync, all_rows = storage.sync, Statement.all
    order = []

    def interrupted_finish(*args):
        order.append("finish")
        if boundary == "finish":
            raise OSError("synthetic interruption before receipt finish")
        finish(*args)

    async def interrupted_sync():
        order.append("sync")
        if boundary == "sync":
            raise OSError("synthetic receipt sync failure")
        await sync()

    async def interrupted_cleanup(statement):
        if statement.sql == native_sql.FORGET_WEEK.sql:
            order.append("cleanup")
            if boundary == "cleanup":
                raise OSError("synthetic interruption before membership cleanup")
        return await all_rows(statement)

    monkeypatch.setattr(value.receipts, "finish", interrupted_finish)
    monkeypatch.setattr(storage, "sync", interrupted_sync)
    monkeypatch.setattr(Statement, "all", interrupted_cleanup)
    with pytest.raises(OSError):
        asyncio.run(value.week.reset_ended(value.core, WEEK))
    assert value.database.weeks() == {"synthetic-interrupted-receipt": (OLD_WEEK, 1, 0)}
    before = value.database.db.execute("SELECT * FROM plan_task_state").fetchall()
    assert before[0]["rev"] == 2
    assert order == ["finish", "sync", "cleanup"][: {"finish": 1, "sync": 2, "cleanup": 3}[boundary]]
    retry_order = []

    async def synced():
        retry_order.append("sync")
        await sync()

    async def cleaned(statement):
        if statement.sql == native_sql.FORGET_WEEK.sql:
            retry_order.append("cleanup")
        return await all_rows(statement)

    monkeypatch.setattr(value.receipts, "finish", finish)
    monkeypatch.setattr(storage, "sync", synced)
    monkeypatch.setattr(Statement, "all", cleaned)
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is True
    assert retry_order == ["sync", "cleanup"]
    assert receipt_state(value.core, request_id) == "done"
    assert value.database.db.execute("SELECT * FROM plan_task_state").fetchall() == before


@pytest.mark.parametrize("new_week", [False, True])
def test_native_rollover_cannot_override_a_newer_choice_between_read_and_commit(rollover, monkeypatch, new_week):
    value = rollover
    identity = value.seed("synthetic-raced")
    batch = value.database.batch

    async def intervening_choice(statements):
        value.database.db.execute("UPDATE plan_task_state SET rev=rev+1 WHERE task_id=?", (identity,))
        if new_week:
            value.database.db.execute("UPDATE plus_weeks SET week_start=? WHERE task_id='synthetic-raced'", (WEEK,))
        value.database.db.commit()
        return await batch(statements)

    monkeypatch.setattr(value.database, "batch", intervening_choice)
    assert asyncio.run(value.week.reset_ended(value.core, WEEK)) is new_week
    assert value.database.weeks() == {"synthetic-raced": (WEEK if new_week else OLD_WEEK, 1, 0)}
    assert tuple(value.database.db.execute("SELECT stage,rev FROM plan_task_state").fetchone()) == ("committed", 2)


def test_native_rollover_keeps_existing_maintenance_and_tick_pause_gates(rollover):
    value = rollover
    identity = value.seed("synthetic-paused")
    value.core.env.MAINTENANCE_MODE = "true"
    answer = asyncio.run(
        value.api.handle(
            value.core,
            "AppendTaskSteps",
            json.dumps(
                {
                    "parent_id": "synthetic-paused",
                    "steps": [{"title": "Synthetic step"}],
                    "request_id": str(uuid.uuid4()),
                }
            ),
        )
    )
    assert answer["error"] == "MAINTENANCE" and not value.database.statements
    value.database.db.execute("INSERT INTO plus_settings VALUES(1,'{}','America/Los_Angeles',?,1)", (OLD_WEEK,))
    value.database.db.execute("INSERT INTO plan_settings VALUES('native','{\"initialized\":true}',1)")
    value.database.db.commit()
    value.core.task_writes_wait = lambda _now: 9999999999
    asyncio.run(value.week.tick(value.core))
    assert value.database.weeks() == {"synthetic-paused": (OLD_WEEK, 1, 0)}
    assert value.database.db.execute("SELECT rev FROM plan_task_state WHERE task_id=?", (identity,)).fetchone()[0] == 1
