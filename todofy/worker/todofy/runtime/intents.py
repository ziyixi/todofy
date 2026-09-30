"""task-intent-v1 inside TodofyCore (contracts/task-intent-v1; core/intents.py has the rules).

Another app in the account (today only Lab) proposes Todoist tasks through the gateway's ``Ops``
entrypoint; Todofy stays the only Todoist writer.

- ``propose``: replay an intent already recorded (same hash; a failed one is re-queued), else
  refuse it (source, URL, a pause, the daily limit) or record it with its task rows in one D1
  batch and wake the alarm. Never calls Gemini or Todoist.
- ``status``: one primary-key read.
- ``step``: one unit of alarm work on the oldest due intent: at most one read-only footer lookup
  and ``STEP_CREATES`` creates through the existing Todoist client, each gated like mail by
  ``_todoist_wait`` (force pause, auth block, the 15-minute window) and counted in that window.

D1 budget of a step: two reads, two writes per create (``sending``, then the outcome), one per
lookup and one for the intent: at most 17 statements, under the 50 a Workers Free invocation may
run with the rest of the alarm. Logs carry the source, intent ID, task number, counts and codes only.
"""

import json
import math
import uuid
from dataclasses import replace
from typing import Any

from todofy.core import intents as rules
from todofy.core.backoff import LOOKUP_MAX_PAGES, TODOIST_AUTH_BLOCK, TODOIST_MAX_ATTEMPTS, TODOIST_STEP_BUDGET
from todofy.core.classify import TaskResult
from todofy.core.intents import IntentError, IntentState, Task, TaskState
from todofy.core.metrics import Step, StepPoint
from todofy.core.ops import InvalidInput
from todofy.core.sql import intents as sql
from todofy.core.todoist_request import RequestTooLarge, build_task_request
from todofy.runtime import metrics, todoist
from todofy.runtime.config import csv, var
from todofy.runtime.interop import now_ms, now_s


def _log(**fields: Any) -> None:
    print(json.dumps(fields))


def accepted_sources(env: Any) -> tuple[str, ...]:
    """TASK_INTENT_SOURCES (comma-separated) when set, an empty value refusing every source;
    unset: every source the contract knows. It turns the intake off without holding mail."""
    if getattr(env, "TASK_INTENT_SOURCES", None) is None:
        return rules.SOURCES
    return tuple(source for source in csv(env, "TASK_INTENT_SOURCES") if source in rules.SOURCES)


async def _get(db: Any, source: str, intent_id: str) -> Any:
    return await db.prepare(sql.INTENT.sql).bind(source, intent_id).first()


# ---- the Ops methods -----------------------------------------------------------------------


async def propose(env: Any, core: Any, text: Any, now: int) -> dict[str, Any]:
    """proposeTasks: a TaskIntentResult; InvalidInput for input the schema refuses."""
    value = rules.intent(rules.loads(text))
    db = env.DB
    existing = await _get(db, value.source, value.intent_id)
    if existing:
        return await _replay(env, core, value, existing, now)
    if value.source not in accepted_sources(env):
        return _refused(value, IntentError.SOURCE_NOT_ALLOWED, now)
    if not rules.urls_allowed(value):
        return _refused(value, IntentError.URL_NOT_ALLOWED, now)
    if (held := core.intent_pause(now)) is not None:
        _log(intent="paused", source=value.source, intent_id=value.intent_id, code=held[0])
        return rules.paused_new(value.source, value.intent_id, held, now)
    # One frozen X-Request-Id per task, fixed here for every attempt that will ever be made.
    tasks = json.dumps([[n, str(uuid.uuid4())] for n in value.task_numbers])
    key = (value.source, value.intent_id)
    inserted, _, stored = await db.batch(
        [
            db.prepare(sql.RECORD.sql).bind(
                *key,
                value.sha256,
                value.mode,
                value.tasks_total,
                value.canonical,
                now,
                now,
                now,
                value.source,
                rules.day_start(now),
                rules.INTENTS_PER_SOURCE_PER_DAY,
            ),
            db.prepare(sql.RECORD_TASKS.sql).bind(*key, now, now, now, tasks),
            db.prepare(sql.INTENT.sql).bind(*key),
        ]
    )
    if inserted.meta.changes == 1:
        _log(intent="recorded", source=value.source, intent_id=value.intent_id, tasks=value.tasks_total)
        await core.wake()
        return rules.recorded_new(value, now)
    if stored.results:
        # The same intent_id was recorded between the read above and this batch.
        return await _replay(env, core, value, stored.results[0], now)
    return _refused(value, IntentError.DAILY_LIMIT, now, rules.until_tomorrow(now))


async def status(env: Any, core: Any, text: Any, now: int) -> dict[str, Any]:
    """taskIntentStatus: a TaskIntentResult from one primary-key read."""
    source, intent_id = rules.ref(rules.loads(text))
    row = await _get(env.DB, source, intent_id)
    if not row:
        return rules.not_found(source, intent_id, now)
    return rules.describe(rules.IntentRow.from_row(row), core.intent_pause(now), now, proposing=False)


def _refused(value: rules.Intent, code: IntentError, now: int, retry_after: float | None = None) -> dict[str, Any]:
    _log(intent="rejected", source=value.source, intent_id=value.intent_id, code=str(code))
    return rules.rejected_new(value.source, value.intent_id, code, now, retry_after)


async def _replay(env: Any, core: Any, value: rules.Intent, existing: Any, now: int) -> dict[str, Any]:
    """A proposal of an intent_id already recorded: answered before any other check."""
    row = rules.IntentRow.from_row(existing)
    if row.payload_sha256 != value.sha256:
        _log(intent="conflict", source=row.source, intent_id=row.intent_id)
        return rules.conflict(row)
    held = core.intent_pause(now)
    if row.state == IntentState.FAILED and held is None:
        db, key = env.DB, (row.source, row.intent_id)
        requeued, _ = await db.batch(
            [
                db.prepare(sql.REQUEUE.sql).bind(now, now, value.canonical, *key),
                db.prepare(sql.REQUEUE_TASKS.sql).bind(now, now, now, *key),
            ]
        )
        if requeued.meta.changes == 1:
            _log(intent="requeued", source=row.source, intent_id=row.intent_id, created=row.tasks_created)
            await core.wake()
        fresh = await _get(db, *key)
        row = rules.IntentRow.from_row(fresh) if fresh else row
    return rules.describe(row, held, now, proposing=True)


# ---- the alarm step ------------------------------------------------------------------------


async def next_due(db: Any, now: int) -> Any:
    """The oldest due pending intent row, or None."""
    return await db.prepare(sql.NEXT_DUE.sql).bind(now).first()


async def next_wake_at(db: Any) -> int | None:
    row = await db.prepare(sql.NEXT_WAKE.sql).first()
    return None if not row or row["at"] is None else int(row["at"])


class _Step:
    """One step on one intent; ``core`` is the TodofyCore (budgets, watchdog, Todoist gate)."""

    def __init__(self, env: Any, core: Any, row: Any) -> None:
        self.env, self.core, self.db = env, core, env.DB
        self.row = rules.IntentRow.from_row(row)
        self.key = (self.row.source, self.row.intent_id)
        self.payload = row["payload_json"]

    def _lookup_at(self) -> int:
        return math.ceil(now_ms() / 1000 + self.core.lookup_delay())

    async def _write(self, before: Task, after: Task) -> None:
        await (
            self.db.prepare(sql.TASK_RESULT.sql)
            .bind(
                after.state,
                after.attempts,
                after.next_attempt_at,
                after.todoist_id,
                after.error_code,
                now_s(),
                *self.key,
                after.n,
                before.state,
            )
            .run()
        )

    async def run(self) -> None:
        loaded = await self.db.prepare(sql.TASKS.sql).bind(*self.key).all()
        tasks = {task.n: task for task in map(Task.from_row, loaded.results)}
        try:
            value = rules.stored(self.payload) if self.payload is not None else None
        except InvalidInput:
            value = None
        if value is None or value.sha256 != self.row.payload_sha256 or len(tasks) != self.row.tasks_total:
            # Only a damaged row gets here (a pending intent always keeps its text): hold it for the
            # proposer, whose retry brings the text back.
            await self._finish(
                rules.Summary(IntentState.FAILED, self.row.tasks_created, IntentError.TODOIST_REJECTED, 0)
            )
            return
        for n, task in list(tasks.items()):
            if task.state == TaskState.SENDING:
                # One step runs at a time, so a call still marked in flight was cut short.
                tasks[n] = rules.interrupted(task, self._lookup_at())
                await self._write(task, tasks[n])
        started, acted = now_ms(), set()
        lookups, creates = rules.STEP_LOOKUPS, rules.STEP_CREATES
        while now_ms() - started < rules.STEP_BUDGET * 1000:
            ordered = [tasks[n] for n in sorted(tasks)]
            action = rules.next_action(
                value.mode, ordered, now_s(), lookups_left=lookups, creates_left=creates, acted=acted
            )
            if action is None or self.core.todoist_wait(now_s()) is not None:
                break
            kind, n = action
            if kind == "lookup":
                lookups -= 1
                tasks[n] = await self._lookup(tasks[n])
                continue
            creates -= 1
            acted.add(n)
            tasks[n], stop = await self._create(value, tasks, tasks[n])
            if stop:
                break
        await self._finish(rules.summarize(value.mode, [tasks[n] for n in sorted(tasks)]))

    async def _create(self, value: rules.Intent, tasks: dict[int, Task], task: Task) -> tuple[Task, bool]:
        env, core = self.env, self.core
        content, description = rules.task_text(value, task.n)
        parent = tasks[0].todoist_id if value.mode == "subtasks" and task.n > 0 else None
        try:
            # A child's body exists only once its parent's ID is known; it is the same on every attempt.
            request = build_task_request(
                content,
                description,
                var(env, "TODOIST_DEFAULT_PROJECT_ID"),
                task.request_id,
                var(env, "TODOIST_API_KEY"),
                parent_id=parent or "",
            )
        except RequestTooLarge:
            after = rules.failed(task, IntentError.TODOIST_REJECTED)
            await self._write(task, after)
            return after, False
        marked = (
            await self.db.prepare(sql.TASK_STATE.sql)
            .bind(TaskState.SENDING, now_s(), *self.key, task.n, task.state)
            .run()
        )
        if marked.meta.changes != 1:
            return task, True  # changed underneath: leave it to the next step
        sending = replace(task, state=TaskState.SENDING)
        await core.arm_watchdog()
        core.count_todoist_calls(TODOIST_MAX_ATTEMPTS, now_s())
        started = now_ms()
        result = await todoist.create_task(env, request, budget_ms=TODOIST_STEP_BUDGET * 1000)
        point = metrics.task_point(Step.INTENT, result, now_ms() - started)
        verdict, done = result.verdict, now_s()
        blocked_until = done + TODOIST_AUTH_BLOCK
        if verdict.result is TaskResult.BLOCKED:
            core.block_todoist(done)  # sets done + TODOIST_AUTH_BLOCK, as blocked_until
        after, stop = rules.after_create(
            sending,
            verdict.result,
            verdict.code,
            verdict.retry_after,
            result.task_id,
            done,
            backoff_base=core.backoff_base(),
            lookup_at=self._lookup_at(),
            blocked_until=blocked_until,
        )
        await self._write(sending, after)
        # After the commit: the task already exists, and only the ledger may say so first.
        core.record_step(point, done)
        _log(
            intent_task=str(verdict.result),
            source=self.row.source,
            intent_id=self.row.intent_id,
            n=task.n,
            state=after.state,
            code=verdict.code,
        )
        return after, stop

    async def _lookup(self, task: Task) -> Task:
        footer = rules.footer(self.row.source, self.row.intent_id, task.n)
        await self.core.arm_watchdog()
        self.core.count_todoist_calls(LOOKUP_MAX_PAGES, now_s())
        started = now_ms()
        found = await todoist.find_tasks(self.env, lambda description: rules.has_footer(description, footer))
        after = rules.after_lookup(task, found, now_s(), backoff_base=self.core.backoff_base())
        await self._write(task, after)
        code = "lookup_failed" if found is None else ("" if found else "lookup_not_found")
        self.core.record_step(
            StepPoint(Step.INTENT_LOOKUP, after.state, code=code, upstream_ms=now_ms() - started), now_s()
        )
        _log(
            intent_lookup=code or "found",
            source=self.row.source,
            intent_id=self.row.intent_id,
            n=task.n,
            matches=None if found is None else len(found),
            state=after.state,
        )
        return after

    async def _finish(self, summary: rules.Summary) -> None:
        await (
            self.db.prepare(sql.INTENT_STEP.sql)
            .bind(
                summary.state,
                summary.tasks_created,
                summary.error_code,
                summary.next_attempt_at,
                now_s(),
                summary.state,
                *self.key,
            )
            .run()
        )
        if summary.state != IntentState.PENDING:
            _log(
                intent=str(summary.state),
                source=self.row.source,
                intent_id=self.row.intent_id,
                created=summary.tasks_created,
                total=self.row.tasks_total,
                code=summary.error_code,
            )


async def step(env: Any, core: Any, row: Any) -> None:
    """One unit of work on ``row`` (from ``next_due``); Todoist was open when it was picked."""
    await _Step(env, core, row).run()
