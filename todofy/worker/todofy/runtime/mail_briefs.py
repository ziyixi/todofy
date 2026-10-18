"""The one-time brief backfill (docs/planning-api.md, "Mail"): a model-written brief for each mail that was in
the Mailbox when this release first ran and was summarised before the summary prompt asked for one.

It runs by itself after the deploy, in the alarm loop, one step per alarm and only when the ledger had no work:

1. collect (once): read the mail project from Todoist (core/plus.in_mailbox, as the extension's list) and queue the
   mail whose summaries.brief was never derived (NULL; a summary completed since stores its own);
2. one queued mail per alarm, PACE apart: ask the model (prompts.BRIEF_EMAIL) for one sentence from the stored
   subject and summary, and store core/mailbox.brief_of of the answer, only over a brief still NULL;
3. done once the queue is empty: it never runs again, and a mail with a brief is never asked about.

The queue and the job's state are the object's SQLite: losing them only collects again, which finds nothing more
to ask about than what is still NULL. The briefs are D1's. Spending: each call reserves its tokens against
GEMINI_DAILY_TOKEN_BUDGET and stops for the UTC day once the backfill would take the day past BUDGET_SHARE of it,
leaving the rest to new mail; PACE keeps it to two calls a minute, well under Gemini's per-minute limit, which new
mail shares. Each attempt is counted before its call, so one that throws (the model's transport, or the D1 save
after it) counts like one that fails: after MAX_ATTEMPTS a mail keeps the brief its summary's first line gives at
read time. PROCESSING_PAUSED holds it like the ledger. Logs carry counts only.
"""

import json
import math
from datetime import UTC, datetime
from typing import Any, NamedTuple

from todofy.core import mailbox, plus, prompts
from todofy.core.backoff import DAY, GEMINI_STEP_BUDGET, HOUR, MINUTE
from todofy.core.sql import mailbox as sql
from todofy.runtime import gemini, plus_api
from todofy.runtime import plus_store as store
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.config import gemini_email_models, integer, var
from todofy.runtime.interop import now_ms

DO_SCHEMA = (
    # One row: 'collect' until the Mailbox was read, 'queued' while mail_brief_queue has mail, then 'done'.
    "CREATE TABLE IF NOT EXISTS mail_brief_job (id INTEGER PRIMARY KEY CHECK (id = 1),"
    " state TEXT NOT NULL CHECK (state IN ('collect', 'queued', 'done')), next_at INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS mail_brief_queue (event_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0)",
)
# The backfill never takes the day's Gemini spending past this share of the budget.
BUDGET_SHARE = 0.5
# Room for the model's answer on top of the prompt estimate, as the summary step reserves.
OUTPUT_TOKEN_ALLOWANCE = 4096
MAX_ATTEMPTS = 3
RETRY = 10 * MINUTE
# Seconds between two model calls of the backfill (MAIL_BRIEFS_PACE_MS shortens it in tests).
PACE = 30
# While Plus is not set up, or Todoist cannot be read, the collect step looks again this much later.
NOT_READY = HOUR
MAX_LOOKUP = 200


class Job(NamedTuple):
    state: str
    next_at: int


def job(store_sql: Any) -> Job | None:
    rows = store_sql.exec("SELECT state, next_at FROM mail_brief_job WHERE id = 1").toArray()
    return Job(str(rows[0].state), int(rows[0].next_at)) if rows else None


def next_at(store_sql: Any) -> int | None:
    """When the backfill wants its next step (0: now), or None once it is done."""
    current = job(store_sql)
    if current is None:
        return 0
    return None if current.state == "done" else current.next_at


def _set(store_sql: Any, state: str, at: int) -> None:
    store_sql.exec(
        "INSERT INTO mail_brief_job (id, state, next_at) VALUES (1, ?, ?)"
        " ON CONFLICT (id) DO UPDATE SET state = excluded.state, next_at = excluded.next_at",
        state,
        at,
    )


def _log(**fields: Any) -> None:
    print(json.dumps({"mail_briefs": fields}))


async def tick(core: Any, now: int) -> None:
    """One step of the backfill, if one is due (coordinator._run, after an idle ledger step)."""
    current = job(core.sql)
    if current is not None and (current.state == "done" or current.next_at > now):
        return
    if current is None or current.state == "collect":
        await _collect(core, now)
    else:
        await _brief_one(core, now)


async def _collect(core: Any, now: int) -> None:
    env = core.env
    settings = await store.settings(env.DB)
    inbox = var(env, "TODOIST_DEFAULT_PROJECT_ID")
    if not settings or not settings["enabled"] or not inbox:
        # No Mailbox to fill yet; Plus may be set up later.
        _set(core.sql, "collect", now + NOT_READY)
        return
    if (wait := core.todoist_wait(now)) is not None:
        _set(core.sql, "collect", max(wait, now + MINUTE))
        return
    try:
        # Plus's Todoist reads share the metadata cache, so they wait for any Plus call; the model calls below
        # hold no lock.
        async with core.plus_lock:
            current = await plus_api.plan(core)
            tasks = await todoist.project_tasks(core, inbox)
    except todoist.PlusError as error:
        _log(collect="failed", code=error.reason)
        _set(core.sql, "collect", now + NOT_READY)
        return
    views = (plus.task_view(task, current["today"], current["labels"]) for task in tasks)
    members = [view["id"] for view in views if plus.in_mailbox(view, inbox)]
    statements = [
        env.DB.prepare(sql.UNBRIEFED.sql).bind(json.dumps(members[offset : offset + MAX_LOOKUP]))
        for offset in range(0, len(members), MAX_LOOKUP)
    ]
    results = await env.DB.batch(statements) if statements else []
    queued = [str(dict(row)["event_id"]) for result in results for row in result.results]
    for event_id in queued:
        core.sql.exec("INSERT INTO mail_brief_queue (event_id) VALUES (?) ON CONFLICT DO NOTHING", event_id)
    _set(core.sql, "queued" if queued else "done", now)
    _log(collected=len(queued), mailbox=len(members))


async def _brief_one(core: Any, now: int) -> None:
    env = core.env
    rows = core.sql.exec("SELECT event_id, attempts FROM mail_brief_queue ORDER BY event_id LIMIT 1").toArray()
    if not rows:
        _set(core.sql, "done", now)
        _log(state="done")
        return
    event_id, attempts = str(rows[0].event_id), int(rows[0].attempts)
    if attempts >= MAX_ATTEMPTS:
        # Every attempt failed or threw: the read-time brief stays.
        _log(given_up=1)
        _drop(core.sql, event_id, now)
        return
    row = await env.DB.prepare(sql.BRIEF_INPUT.sql).bind(event_id).first()
    row = dict(row) if row is not None else None
    if row is None or row["brief"] is not None or not row["summary"]:
        _drop(core.sql, event_id, now)
        return
    content = f"{row['subject']}\n\n{row['summary']}"
    reserved = math.ceil(len((prompts.BRIEF_EMAIL + content).encode()) / 2) + OUTPUT_TOKEN_ALLOWANCE
    if not core.reserve_tokens(reserved, now, share=BUDGET_SHARE):
        # This UTC day's share is spent: on with the next one.
        _set(core.sql, "queued", now - now % DAY + DAY)
        _log(state="budget")
        return
    used = reserved
    core.sql.exec("UPDATE mail_brief_queue SET attempts = attempts + 1 WHERE event_id = ?", event_id)
    core.sql.exec(
        "INSERT OR REPLACE INTO llm_inflight (event_id, day, reserved) VALUES (?, ?, ?)",
        "brief:" + event_id,
        datetime.fromtimestamp(now, UTC).strftime("%Y-%m-%d"),
        reserved,
    )
    try:
        result = await gemini.generate(
            env,
            system=prompts.BRIEF_EMAIL,
            user=content,
            deadline_ms=now_ms() + GEMINI_STEP_BUDGET * 1000,
            models=gemini_email_models(env),
        )
        used = result.tokens
    finally:
        core.sql.exec("DELETE FROM llm_inflight WHERE event_id = ?", "brief:" + event_id)
        core.settle_tokens(reserved, used, now)
    paced = now + integer(env, "MAIL_BRIEFS_PACE_MS", PACE * 1000) // 1000
    if result.verdict.ok:
        brief = mailbox.brief_of(result.text)
        await env.DB.prepare(sql.SAVE_BRIEF.sql).bind(brief, event_id).run()
        _drop(core.sql, event_id, paced)
    elif attempts + 1 >= MAX_ATTEMPTS:
        _log(given_up=1, code=result.verdict.code or "")
        _drop(core.sql, event_id, paced)
    else:
        _set(core.sql, "queued", now + RETRY)


def postpone(store_sql: Any, now: int) -> None:
    """After a step failed unexpectedly (D1 or the model's transport threw): the same step again RETRY later,
    never at once, so a failure cannot keep the alarm busy."""
    current = job(store_sql)
    _set(store_sql, current.state if current is not None else "collect", now + RETRY)


def _drop(store_sql: Any, event_id: str, at: int) -> None:
    """Off the queue; the next step at ``at``."""
    store_sql.exec("DELETE FROM mail_brief_queue WHERE event_id = ?", event_id)
    _set(store_sql, "queued", at)
