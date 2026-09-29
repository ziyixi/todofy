"""Todoist REST v1: create one task, and the read-only footer lookup (v2 plan §4.9, §5.3 B/B′).

https://developer.todoist.com/api/v1/ — ``POST /api/v1/tasks`` and the cursor-paged
``GET /api/v1/tasks``. A create that may have reached Todoist is never resent
blindly: only the verdicts of ``core.classify`` decide an in-call retry, and each
retry sends the same frozen bytes and ``X-Request-Id``.
"""

import asyncio
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
from todofy.core.classify import TaskVerdict, classify_task_create
from todofy.core.todoist_request import TASKS_PATH, TaskRequest, created_task_id, footer_task_ids, parse_task_page
from todofy.runtime.config import integer, var
from todofy.runtime.interop import fetch_with_timeout, now_ms

DEFAULT_API_BASE = "https://api.todoist.com"
# Todoist's maximum page size; ten pages then cover 2,000 active tasks.
LOOKUP_PAGE_SIZE = 200
# Below this another attempt could not get an answer back in time.
MIN_ATTEMPT_MS = 1000


@dataclass(frozen=True, slots=True)
class CreateResult:
    verdict: TaskVerdict  # of the last attempt; feed it to the state machine as is
    task_id: str  # "" unless created


async def create_task(env: Any, request: TaskRequest, *, budget_ms: int) -> CreateResult:
    """Up to TODOIST_MAX_ATTEMPTS while the verdict allows an inline retry, all within ``budget_ms``."""
    url = _base(env) + TASKS_PATH
    # Test configs shorten the attempt timeout; production uses the constant.
    attempt_ms = integer(env, "TODOIST_ATTEMPT_TIMEOUT_MS", TODOIST_ATTEMPT_TIMEOUT * 1000)
    deadline = now_ms() + budget_ms
    attempt = 1
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
        if not verdict.retry_inline or attempt >= TODOIST_MAX_ATTEMPTS:
            return CreateResult(verdict, task_id)
        delay_ms = int(inline_delay(attempt, verdict.retry_after) * 1000)
        if deadline - now_ms() - delay_ms < MIN_ATTEMPT_MS:
            return CreateResult(verdict, task_id)
        await asyncio.sleep(delay_ms / 1000)
        attempt += 1


async def find_footer_tasks(env: Any, event_id: str) -> list[str] | None:
    """IDs of active tasks whose description carries the event footer.

    None when the scan failed or did not finish within LOOKUP_MAX_PAGES pages:
    only a complete scan can prove how many tasks exist.
    """
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
        matches = footer_task_ids(tasks, event_id)
        if not all(matches):
            return None  # a matching task without an id cannot be counted or resolved
        found += [task_id for task_id in matches if task_id not in found]
        if not cursor:
            return found
        query["cursor"] = cursor
    return None


def _base(env: Any) -> str:
    return var(env, "TODOIST_API_BASE", DEFAULT_API_BASE).rstrip("/")
