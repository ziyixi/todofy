"""todoist.create_task and find_footer_tasks in real workerd against loopback fakes:
frozen bytes on every inline retry, no resend after a possibly delivered
request, and a footer lookup that only answers after a complete scan."""

import socket
import threading
from collections.abc import Iterator
from typing import Any

import pytest

from tests.fakes.server import FakeServer, Reply
from tests.runtime.clients_probe import start_probe
from tests.runtime.harness import Worker
from todofy.core.render import FOOTER_PREFIX
from todofy.core.todoist_request import TASKS_PATH, build_task_request

TOKEN = "fake-todoist-token"
PROJECT = "proj-1"
EVENT_ID = "f8c1e9a0-0000-4000-8000-000000000001"
TASK = {
    "content": "合成主题 & <b>",
    "description": f"**FROM: a@example.org**\n合成摘要\n\n{FOOTER_PREFIX}{EVENT_ID}",
    "project_id": PROJECT,
    "request_id": "todofy-0123456789abcdef0123456789ab",
}


class DroppingServer:
    """Reads each request, then closes the socket without answering (a lost response)."""

    def __init__(self) -> None:
        self.sock = socket.create_server(("127.0.0.1", 0))
        self.connections = 0
        threading.Thread(target=self._serve, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}"

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            with conn:
                conn.recv(65536)

    def close(self) -> None:
        self.sock.close()


@pytest.fixture(scope="module")
def upstream() -> Iterator[FakeServer]:
    server = FakeServer()
    yield server
    server.close()


@pytest.fixture(scope="module")
def probe(tmp_path_factory: pytest.TempPathFactory, upstream: FakeServer) -> Iterator[Worker]:
    yield from start_probe(
        tmp_path_factory.mktemp("clients-todoist"),
        {"TODOIST_API_BASE": upstream.url, "TODOIST_API_KEY": TOKEN, "TODOIST_DEFAULT_PROJECT_ID": PROJECT},
    )


@pytest.fixture
def fake(upstream: FakeServer) -> FakeServer:
    upstream.reset()
    return upstream


def call(probe: Worker, route: str, **args: Any) -> dict[str, Any]:
    response = probe.hooks.post(route, json=args)
    assert response.status_code == 200, response.text
    return response.json()


def create(probe: Worker, budget_ms: int = 10_000, **args: Any) -> dict[str, Any]:
    return call(probe, "/todoist/create", **TASK, budget_ms=budget_ms, **args)


def find(probe: Worker, **args: Any) -> list[str] | None:
    return call(probe, "/todoist/find", event_id=EVENT_ID, **args)["ids"]


def page(*tasks: dict[str, Any], cursor: str | None = None) -> Reply:
    return Reply(200, {"results": list(tasks), "next_cursor": cursor})


def task(task_id: str, event_id: str = EVENT_ID) -> dict[str, Any]:
    return {"id": task_id, "content": "t", "description": f"摘要\n\n{FOOTER_PREFIX}{event_id}"}


# --- create_task ---------------------------------------------------------------------------


def test_created_task_sends_the_frozen_request(probe, fake):
    fake.queue("POST", TASKS_PATH, Reply(200, {"id": "6X7rM8997g3RQmvh", "content": TASK["content"]}))
    result = create(probe)
    assert (result["result"], result["task_id"], result["code"]) == ("created", "6X7rM8997g3RQmvh", None)

    [sent] = fake.received("POST", TASKS_PATH)
    frozen = build_task_request(TASK["content"], TASK["description"], PROJECT, TASK["request_id"], TOKEN)
    assert sent.body == frozen.body
    assert sent.json() == {"content": TASK["content"], "description": TASK["description"], "project_id": PROJECT}
    assert sent.headers["authorization"] == f"Bearer {TOKEN}"
    assert sent.headers["x-request-id"] == TASK["request_id"]
    assert sent.headers["content-type"] == "application/json"


@pytest.mark.parametrize("status", [502, 503, 504])
def test_gateway_errors_retry_inline_with_identical_bytes(probe, fake, status):
    fake.queue("POST", TASKS_PATH, Reply(status, b"busy"))
    fake.queue("POST", TASKS_PATH, Reply(status, b"busy"))
    fake.queue("POST", TASKS_PATH, Reply(200, {"id": "42"}))
    assert create(probe)["task_id"] == "42"
    sent = fake.received("POST", TASKS_PATH)
    assert len(sent) == 3
    assert len({(r.body, r.headers["x-request-id"]) for r in sent}) == 1


def test_gateway_errors_exhaust_three_attempts_and_retry_later(probe, fake):
    fake.default("POST", TASKS_PATH, Reply(503, b"busy"))
    result = create(probe)
    assert (result["result"], result["code"], result["task_id"]) == ("retry_later", "todoist_unavailable", "")
    assert len(fake.received("POST", TASKS_PATH)) == 3


def test_rate_limit_waits_for_retry_after_then_retries(probe, fake):
    fake.queue("POST", TASKS_PATH, Reply(429, {"error": "Too many requests"}, {"retry-after": "1"}))
    fake.queue("POST", TASKS_PATH, Reply(200, {"id": "43"}))
    result = create(probe)
    assert (result["result"], result["task_id"]) == ("created", "43")
    assert result["elapsed_ms"] >= 1000
    assert len(fake.received("POST", TASKS_PATH)) == 2


def test_rate_limit_that_persists_keeps_the_retry_after(probe, fake):
    fake.default("POST", TASKS_PATH, Reply(429, {"error": "Too many requests"}, {"retry-after": "90"}))
    result = create(probe)
    assert (result["result"], result["code"], result["retry_after"]) == ("retry_later", "todoist_rate_limited", 90)
    assert len(fake.received("POST", TASKS_PATH)) == 3  # inline pauses are capped at 2 s each


@pytest.mark.parametrize(
    ("reply", "result", "code"),
    [
        (Reply(500, b"internal"), "unknown", "todo_result_unknown"),
        (Reply(200, {"content": "no id"}), "unknown", "todo_result_unknown"),
        (Reply(200, b"not json"), "unknown", "todo_result_unknown"),
        (Reply(401, b"unauthorized"), "blocked", "todoist_auth_blocked"),
        (Reply(403, b"forbidden"), "blocked", "todoist_auth_blocked"),
        (Reply(400, b"bad request"), "retry_later", "todoist_rejected"),
        (Reply(404, b"not found"), "retry_later", "todoist_rejected"),
    ],
)
def test_final_answers_are_never_retried_inline(probe, fake, reply, result, code):
    fake.queue("POST", TASKS_PATH, reply)
    answer = create(probe)
    assert (answer["result"], answer["code"], answer["task_id"]) == (result, code, "")
    assert len(fake.received("POST", TASKS_PATH)) == 1


def test_timeout_is_unknown_and_bounded_by_the_budget(probe, fake):
    fake.default("POST", TASKS_PATH, Reply(hang=True))
    result = create(probe, budget_ms=1500)
    assert (result["result"], result["code"], result["task_id"]) == ("unknown", "todo_result_unknown", "")
    assert 1500 <= result["elapsed_ms"] < 1500 + 1500
    assert len(fake.received("POST", TASKS_PATH)) == 1  # no time left for the inline retry
    fake.wait_for(lambda: TASKS_PATH in fake.disconnects)


def test_lost_connection_is_unknown_and_sent_once(probe):
    """A non-timeout fetch failure may have created the task: no inline resend."""
    dropping = DroppingServer()
    try:
        result = create(probe, vars={"TODOIST_API_BASE": dropping.url})
        assert (result["result"], result["code"], result["task_id"]) == ("unknown", "todo_result_unknown", "")
        assert dropping.connections == 1
    finally:
        dropping.close()


# --- find_footer_tasks ---------------------------------------------------------------------


def test_lookup_pages_through_the_default_project(probe, fake):
    fake.queue("GET", TASKS_PATH, page(task("t1", "f8c1e9a0-0000-4000-8000-000000000002"), cursor="c1"))
    fake.queue("GET", TASKS_PATH, page(task("t2"), {"id": "t3", "description": "no footer"}))
    assert find(probe) == ["t2"]

    first, second = fake.received("GET", TASKS_PATH)
    assert first.query == {"project_id": [PROJECT], "limit": ["200"]}
    assert second.query == {"project_id": [PROJECT], "limit": ["200"], "cursor": ["c1"]}
    assert first.headers["authorization"] == f"Bearer {TOKEN}"


def test_lookup_reports_every_match_once(probe, fake):
    fake.queue("GET", TASKS_PATH, page(task("a"), task("b"), cursor="c1"))
    fake.queue("GET", TASKS_PATH, page(task("a")))  # a cursor may repeat a task
    assert find(probe) == ["a", "b"]


def test_lookup_without_matches_is_an_empty_list(probe, fake):
    fake.queue("GET", TASKS_PATH, page({"id": "x", "description": f"{FOOTER_PREFIX}{EVENT_ID}0"}))
    assert find(probe) == []


def test_lookup_accepts_the_older_bare_array(probe, fake):
    fake.queue("GET", TASKS_PATH, Reply(200, [task("t9")]))
    assert find(probe) == ["t9"]


def test_lookup_without_a_default_project_scans_all_active_tasks(probe, fake):
    fake.queue("GET", TASKS_PATH, page(task("t1")))
    assert find(probe, vars={"TODOIST_DEFAULT_PROJECT_ID": ""}) == ["t1"]
    assert fake.received("GET", TASKS_PATH)[0].query == {"limit": ["200"]}


@pytest.mark.parametrize(
    "failure",
    [
        Reply(500, b"oops"),
        Reply(429, b"slow down", {"retry-after": "5"}),
        Reply(401, b"unauthorized"),
        Reply(200, b"not json"),
        Reply(200, {"items": []}),
        Reply(200, {"results": [task("")]}),
    ],
)
def test_any_failed_page_fails_the_whole_lookup(probe, fake, failure):
    fake.queue("GET", TASKS_PATH, page(task("t1"), cursor="c1"))
    fake.queue("GET", TASKS_PATH, failure)
    assert find(probe) is None
    assert len(fake.received("GET", TASKS_PATH)) == 2


def test_lookup_that_hits_the_page_cap_proves_nothing(probe, fake):
    fake.default("GET", TASKS_PATH, page(task("t1"), cursor="more"))
    assert find(probe) is None
    assert len(fake.received("GET", TASKS_PATH)) == 10


def test_lookup_never_writes(probe, fake):
    fake.queue("GET", TASKS_PATH, page(task("t1")))
    find(probe)
    assert {r.method for r in fake.received()} == {"GET"}
