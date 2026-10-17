"""Todoist REST v1: create one task, and the read-only footer lookup (v2 plan §4.9, §5.3 B/B′).

https://developer.todoist.com/api/v1/ — ``POST /api/v1/tasks`` and the cursor-paged
``GET /api/v1/tasks``. A create that may have reached Todoist is never resent
blindly: only the verdicts of ``core.classify`` decide an in-call retry, and each
retry sends the same frozen bytes and ``X-Request-Id``.
"""

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from todofy.core.backoff import (
    LOOKUP_MAX_PAGES,
    LOOKUP_PAGE_TIMEOUT,
    TODOIST_ATTEMPT_TIMEOUT,
    TODOIST_MAX_ATTEMPTS,
    inline_delay,
)
from todofy.core.classify import Failure, HttpOutcome, TaskResult, TaskVerdict, classify_task_create, final_task_verdict
from todofy.core.render import FOOTER_PREFIX, has_footer
from todofy.core.todoist_request import TASKS_PATH, TaskRequest, created_task_id, matching_task_ids, parse_task_page
from todofy.runtime import native_tasks
from todofy.runtime.config import integer, var
from todofy.runtime.interop import fetch_with_timeout, now_ms

DEFAULT_API_BASE = "https://api.todoist.com"
# Todoist's maximum page size; ten pages then cover 2,000 active tasks.
LOOKUP_PAGE_SIZE = 200
# Below this another attempt could not get an answer back in time.
MIN_ATTEMPT_MS = 1000


@dataclass(frozen=True, slots=True)
class CreateResult:
    verdict: TaskVerdict  # of the whole call (classify.final_task_verdict); feed it to the state machine
    task_id: str  # "" unless created
    attempts: int  # POST requests sent (the same frozen bytes each time)


async def create_task(env: Any, request: TaskRequest, *, budget_ms: int) -> CreateResult:
    """Up to TODOIST_MAX_ATTEMPTS while the verdict allows an inline retry, all within ``budget_ms``.

    Once an attempt may have created the task, the call can only end CREATED or UNKNOWN.
    """
    if native_tasks.enabled(env):
        return await _create_native_task(env, request, budget_ms=budget_ms)
    url = _base(env) + TASKS_PATH
    # Test configs shorten the attempt timeout; production uses the constant.
    attempt_ms = integer(env, "TODOIST_ATTEMPT_TIMEOUT_MS", TODOIST_ATTEMPT_TIMEOUT * 1000)
    deadline = now_ms() + budget_ms
    attempt = 1
    possibly_delivered = False
    while True:
        upstream = await fetch_with_timeout(
            url,
            timeout_ms=max(min(attempt_ms, deadline - now_ms()), MIN_ATTEMPT_MS),
            method="POST",
            headers=request.headers,
            body=request.body,
        )
        outcome = upstream.outcome()
        task_id = created_task_id(upstream.body) if outcome.ok else ""
        verdict = classify_task_create(outcome, task_id)
        possibly_delivered |= verdict.result is TaskResult.UNKNOWN
        if not verdict.retry_inline or attempt >= TODOIST_MAX_ATTEMPTS:
            return CreateResult(final_task_verdict(verdict, possibly_delivered), task_id, attempt)
        delay_ms = int(inline_delay(attempt, verdict.retry_after) * 1000)
        if deadline - now_ms() - delay_ms < MIN_ATTEMPT_MS:
            return CreateResult(final_task_verdict(verdict, possibly_delivered), task_id, attempt)
        await asyncio.sleep(delay_ms / 1000)
        attempt += 1


async def find_footer_tasks(env: Any, event_id: str) -> list[str] | None:
    """IDs of active tasks whose description carries the event footer.

    None when the scan failed or did not finish within LOOKUP_MAX_PAGES pages:
    only a complete scan can prove how many tasks exist.
    """
    return await find_tasks(env, lambda description: has_footer(description, event_id), query=FOOTER_PREFIX + event_id)


async def find_tasks(env: Any, matches: Callable[[str], bool], *, query: str = "") -> list[str] | None:
    """IDs of active tasks in the default project whose description ``matches`` (a footer test:
    the mail event's, or a task intent's); None unless the whole scan finished."""
    if native_tasks.enabled(env):
        return await _find_native_tasks(env, matches, query=query)
    headers = {"Authorization": f"Bearer {var(env, 'TODOIST_API_KEY')}"}
    query: dict[str, str | int] = {"limit": LOOKUP_PAGE_SIZE}
    if project_id := var(env, "TODOIST_DEFAULT_PROJECT_ID"):
        query["project_id"] = project_id
    found: list[str] = []
    for _ in range(LOOKUP_MAX_PAGES):
        upstream = await fetch_with_timeout(
            f"{_base(env)}{TASKS_PATH}?{urlencode(query)}",
            timeout_ms=LOOKUP_PAGE_TIMEOUT * 1000,
            method="GET",
            headers=headers,
        )
        if not upstream.outcome().ok:
            return None
        try:
            tasks, cursor = parse_task_page(upstream.body)
        except ValueError:
            return None
        ids = matching_task_ids(tasks, matches)
        if not all(ids):
            return None  # a matching task without an id cannot be counted or resolved
        found += [task_id for task_id in ids if task_id not in found]
        if not cursor:
            return found
        query["cursor"] = cursor
    return None


def _base(env: Any) -> str:
    return var(env, "TODOIST_API_BASE", DEFAULT_API_BASE).rstrip("/")


async def _create_native_task(env: Any, request: TaskRequest, *, budget_ms: int) -> CreateResult:
    """One bounded native attempt; the existing ledger keeps its frozen IDs and unknown outcome rules."""
    if getattr(env, "TASKS", None) is None or budget_ms <= 0:
        return CreateResult(classify_task_create(HttpOutcome(failure=Failure.NOT_SENT), ""), "", 0)
    try:
        source = json.loads(request.body)
        task = {"title": source["content"], "description": source["description"]}
        for name in ("project_id", "parent_id"):
            if source.get(name):
                task[name] = source[name]
        body = {"request_id": native_tasks.request_id(request.headers["X-Request-Id"]), "task": task}
    except (KeyError, TypeError, ValueError):
        return CreateResult(classify_task_create(HttpOutcome(status=400), ""), "", 0)
    try:
        row = await asyncio.wait_for(native_tasks.call(env, "CreateTask", body), timeout=budget_ms / 1000)
    except TimeoutError:
        return CreateResult(classify_task_create(HttpOutcome(failure=Failure.TIMEOUT), ""), "", 1)
    except native_tasks.NativeTasksError as error:
        outcome = HttpOutcome(failure=Failure.LOST) if error.uncertain else HttpOutcome(status=error.status)
        return CreateResult(classify_task_create(outcome, ""), "", 1)
    task_id = row.get("id", "")
    return CreateResult(classify_task_create(HttpOutcome(status=200), task_id), task_id, 1)


async def _find_native_tasks(env: Any, matches: Callable[[str], bool], *, query: str) -> list[str] | None:
    found: list[str] = []
    cursor = ""
    try:
        metadata = await asyncio.wait_for(native_tasks.catalog(env), timeout=LOOKUP_PAGE_TIMEOUT)
        for _ in range(LOOKUP_MAX_PAGES):
            tasks, cursor = await asyncio.wait_for(
                native_tasks.page(
                    env,
                    cursor=cursor,
                    limit=20,
                    project_id=var(env, "TODOIST_DEFAULT_PROJECT_ID"),
                    metadata=metadata,
                    include_description=True,
                    query=query,
                ),
                timeout=LOOKUP_PAGE_TIMEOUT,
            )
            ids = matching_task_ids(tasks, matches)
            if not all(ids):
                return None
            found += [task_id for task_id in ids if task_id not in found]
            if not cursor:
                return found
    except (native_tasks.NativeTasksError, TimeoutError, ValueError):
        return None
    return None
