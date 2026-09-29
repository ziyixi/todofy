"""Task step and the read-only footer lookup (v2 plan §5.3 B/B′) against the fake Todoist."""

import time
import uuid
from collections.abc import Callable

import pytest

from tests.fakes.gemini_fake import GeminiFake, text_reply
from tests.fakes.server import PASS, Recorded, Reply, rate_limited, retry_after_http_date, retry_after_seconds
from tests.fakes.todoist_fake import PROJECT_ID, TASKS_PATH, TOKEN, TodoistFake
from tests.runtime.harness import Worker, mail_event, transitions
from todofy.core.contract import parse_mail_event
from todofy.core.render import FOOTER_PREFIX, clean_summary, render_todo_body
from todofy.core.request_id import todoist_request_id

# LOOKUP_DELAY_MS is 500 in wrangler.test.toml; this leaves time for a lookup and a stray resend.
SETTLE_S = 3


def _arrive(worker: Worker, **fields: object) -> tuple[str, bytes]:
    event_id, body = mail_event(**fields)
    assert worker.post_event(body).status_code == 204
    return event_id, body


def _frozen(posts: list[Recorded]) -> None:
    """Every attempt of one task carries the same bytes and X-Request-Id."""
    assert len({post.body for post in posts}) == 1
    assert len({post.headers["x-request-id"] for post in posts}) == 1


def _to_states(event: dict) -> list[str]:
    return [to for _, to, _, _ in transitions(event)]


def _dismiss(worker: Worker, event_id: str) -> None:
    """Park an unresolved row so its later lookups cannot consume the next test's replies."""
    assert worker.reconcile(event_id, "dismiss").status_code == 200


def test_task_is_created_once_with_the_frozen_go_rendering(
    worker: Worker, fresh_gemini: GeminiFake, fresh_todoist: TodoistFake
) -> None:
    event_id = str(uuid.uuid4())
    model_output = "## 摘要\n请缴税 & 确认 <b>'引号'\"双引号\" #urgent 结束"
    fresh_gemini.queue_generate(text_reply(model_output))
    _, body = _arrive(worker, event_id=event_id, subject="Q3 税 & <b>", text=f"正文 marker {event_id}")

    event = worker.wait_event(event_id, {"complete"})

    [post] = fresh_todoist.creates_for(event_id)
    parsed = parse_mail_event(body)
    description = render_todo_body(parsed, clean_summary(model_output, parsed))
    assert post.json() == {"content": "Q3 税 & <b>", "description": description, "project_id": PROJECT_ID}
    assert "&amp;" not in post.body.decode() and "#urgent" not in description
    assert description.endswith(f"\n\n{FOOTER_PREFIX}{event_id}")
    assert post.headers["authorization"] == f"Bearer {TOKEN}"
    assert post.headers["x-request-id"] == todoist_request_id("Q3 税 & <b>", description, "sender@example.org")
    [task] = [task for task in fresh_todoist.tasks if task.description == description]
    assert (event["task_id"], event["error_code"]) == (task.id, None)
    assert _to_states(event) == ["pending", "summarizing", "summarized", "todo_sending", "complete"]
    assert {actor for *_, actor in transitions(event)} == {"worker"}
    [row] = worker.d1(
        "SELECT e.payload IS NULL AS dropped, s.task_id FROM mail_events e JOIN summaries s USING (event_id)"
        f" WHERE e.event_id = '{event_id}'"
    )
    assert row == {"dropped": 1, "task_id": task.id}


@pytest.mark.reaches("todoist_rejected")
def test_a_rejected_task_backs_off_and_resends_the_same_request(worker: Worker, fresh_todoist: TodoistFake) -> None:
    fresh_todoist.queue("POST", TASKS_PATH, Reply(400, {"error": "bad request"}))
    event_id, _ = _arrive(worker)

    rejected = worker.wait_event(event_id, lambda e: e["error_code"] == "todoist_rejected")
    assert rejected["state"] == "summarized"
    worker.wait_event(event_id, {"complete"})

    posts = fresh_todoist.creates_for(event_id)
    assert len(posts) == 2
    _frozen(posts)


@pytest.mark.reaches("todoist_rate_limited")
# The date is fixed when queued; the summary step and two in-call pauses (≤ 2 s each) pass before the last 429.
@pytest.mark.parametrize(
    "retry_after", [lambda: retry_after_seconds(2), lambda: retry_after_http_date(10)], ids=["seconds", "http_date"]
)
def test_rate_limits_retry_inline_then_wait_for_retry_after(
    worker: Worker, fresh_todoist: TodoistFake, retry_after: Callable[[], dict[str, str]]
) -> None:
    for _ in range(3):
        fresh_todoist.queue("POST", TASKS_PATH, rate_limited(retry_after()))
    event_id, _ = _arrive(worker)

    limited = worker.wait_event(event_id, lambda e: e["error_code"] == "todoist_rate_limited")
    assert limited["state"] == "summarized"
    worker.wait_event(event_id, {"complete"})

    posts = fresh_todoist.creates_for(event_id)
    assert len(posts) == 4
    _frozen(posts)
    assert posts[3].at - posts[2].at >= 1.8


@pytest.mark.reaches("todoist_unavailable")
def test_gateway_errors_retry_inline_then_later(worker: Worker, fresh_todoist: TodoistFake) -> None:
    for _ in range(3):
        fresh_todoist.queue("POST", TASKS_PATH, Reply(503, "unavailable"))
    event_id, _ = _arrive(worker)

    unavailable = worker.wait_event(event_id, lambda e: e["error_code"] == "todoist_unavailable")
    assert unavailable["state"] == "summarized"
    worker.wait_event(event_id, {"complete"})

    posts = fresh_todoist.creates_for(event_id)
    assert len(posts) == 4
    _frozen(posts)


@pytest.mark.reaches("todo_result_unknown", "lookup_not_found")
@pytest.mark.parametrize(
    "reply", [Reply(500, "boom"), Reply(200, {"content": "no id"})], ids=["server_error", "created_without_id"]
)
def test_an_unknown_result_is_looked_up_and_never_resent(
    worker: Worker, fresh_todoist: TodoistFake, reply: Reply
) -> None:
    fresh_todoist.queue("POST", TASKS_PATH, reply)
    event_id, _ = _arrive(worker)

    event = worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_not_found")
    time.sleep(SETTLE_S)

    assert len(fresh_todoist.creates_for(event_id)) == 1
    event = worker.event(event_id)
    assert (event["state"], event["attention"], event["next_attempt_at"]) == ("todo_unknown", True, None)
    assert event["allowed_actions"] == ["task_created", "task_not_created", "dismiss"]
    assert ("todo_sending", "todo_unknown", "todo_result_unknown", "worker") in transitions(event)
    lookups = fresh_todoist.lists()
    assert lookups and all(lookup.param("project_id") == PROJECT_ID for lookup in lookups)


def test_a_timeout_retries_inline_with_the_same_request_then_is_unknown(
    worker: Worker, fresh_todoist: TodoistFake
) -> None:
    for _ in range(3):
        fresh_todoist.queue("POST", TASKS_PATH, Reply(hang=True))
    event_id, _ = _arrive(worker)

    # TODOIST_ATTEMPT_TIMEOUT_MS = 1500; without it three 14 s attempts take about 45 s.
    event = worker.wait_event(event_id, {"todo_unknown"}, timeout_s=90)

    assert event["error_code"] in ("todo_result_unknown", "lookup_not_found")
    posts = fresh_todoist.creates_for(event_id)
    assert len(posts) == 3
    _frozen(posts)
    assert fresh_todoist.wait_for(lambda: len(fresh_todoist.disconnects) == 3, timeout_s=10)
    worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_not_found")


@pytest.mark.parametrize("then", [Reply(503, "busy"), rate_limited(retry_after_seconds(1))], ids=["503", "429"])
def test_a_timeout_then_a_retryable_error_is_unknown_not_resent(
    worker: Worker, fresh_todoist: TodoistFake, then: Reply
) -> None:
    # The timed-out attempt may have created the task; a later 5xx/429 must not turn the
    # call into an automatic resend (X-Request-Id deduplication is never relied on).
    fresh_todoist.queue("POST", TASKS_PATH, Reply(hang=True))
    for _ in range(2):
        fresh_todoist.queue("POST", TASKS_PATH, then)
    event_id, _ = _arrive(worker)

    worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_not_found", timeout_s=60)
    time.sleep(SETTLE_S)

    event = worker.event(event_id)
    assert (event["state"], event["next_attempt_at"]) == ("todo_unknown", None)
    assert ("todo_sending", "todo_unknown", "todo_result_unknown", "worker") in transitions(event)
    posts = fresh_todoist.creates_for(event_id)
    assert 2 <= len(posts) <= 3
    _frozen(posts)
    _dismiss(worker, event_id)


def test_lookup_finds_the_task_of_a_lost_response(worker: Worker, fresh_todoist: TodoistFake) -> None:
    fresh_todoist.queue("POST", TASKS_PATH, Reply(500, "lost after commit", applied=True))
    event_id, _ = _arrive(worker)

    event = worker.wait_event(event_id, {"complete"})

    [post] = fresh_todoist.creates_for(event_id)
    [task] = [task for task in fresh_todoist.tasks if event_id in task.description]
    assert event["task_id"] == task.id and post.headers["x-request-id"] == task.request_id
    assert _to_states(event)[-3:] == ["todo_unknown", "todo_created", "complete"]


def test_lookup_walks_every_page_of_the_default_project_only(worker: Worker, fresh_todoist: TodoistFake) -> None:
    event_id = str(uuid.uuid4())
    footer = f"{FOOTER_PREFIX}{event_id}"
    fresh_todoist.max_page_size = 2
    for n in range(5):
        fresh_todoist.add_task(f"unrelated {n}", f"{FOOTER_PREFIX}{uuid.uuid4()}")
    fresh_todoist.add_task("elsewhere", footer, project_id="another-project")
    fresh_todoist.add_task("done", footer, checked=True)
    fresh_todoist.add_task("longer id", f"{footer}0")
    fresh_todoist.queue("POST", TASKS_PATH, Reply(500, "lost after commit", applied=True))
    _arrive(worker, event_id=event_id, text=f"marker {event_id}")

    event = worker.wait_event(event_id, {"complete"})

    [created] = [task for task in fresh_todoist.tasks if task.request_id]
    assert event["task_id"] == created.id
    pages = fresh_todoist.lists()
    assert len(pages) == 4
    assert [page.param("cursor") for page in pages] == [None, "fake-cursor-2", "fake-cursor-4", "fake-cursor-6"]
    assert {page.param("project_id") for page in pages} == {PROJECT_ID}


@pytest.mark.reaches("lookup_ambiguous")
def test_two_tasks_with_the_footer_are_left_to_the_owner(worker: Worker, fresh_todoist: TodoistFake) -> None:
    event_id = str(uuid.uuid4())
    for n in range(2):
        fresh_todoist.add_task(f"copy {n}", f"x\n\n{FOOTER_PREFIX}{event_id}")
    fresh_todoist.queue("POST", TASKS_PATH, Reply(500, "boom"))
    _arrive(worker, event_id=event_id, text=f"marker {event_id}")

    event = worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_ambiguous")

    assert (event["state"], event["task_id"]) == ("todo_unknown", None)
    assert len(fresh_todoist.creates_for(event_id)) == 1
    _dismiss(worker, event_id)


@pytest.mark.reaches("lookup_failed")
@pytest.mark.parametrize("first_page", [Reply(500, "boom"), PASS], ids=["first_page", "second_page"])
def test_a_failed_lookup_proves_nothing(worker: Worker, fresh_todoist: TodoistFake, first_page: Reply) -> None:
    fresh_todoist.max_page_size = 1
    for n in range(3):
        fresh_todoist.add_task(f"unrelated {n}")
    fresh_todoist.queue("GET", TASKS_PATH, first_page)
    fresh_todoist.queue("GET", TASKS_PATH, Reply(500, "boom"))
    fresh_todoist.queue("POST", TASKS_PATH, Reply(500, "boom"))
    event_id, _ = _arrive(worker)

    event = worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_failed")

    assert (event["state"], event["attention"]) == ("todo_unknown", True)
    assert len(fresh_todoist.creates_for(event_id)) == 1
    _dismiss(worker, event_id)
