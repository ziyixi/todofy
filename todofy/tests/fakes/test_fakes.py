import email.utils
import socket
import time
from collections.abc import Iterator

import httpx
import pytest

from tests.fakes.gemini_fake import API_KEY, GeminiFake, error_reply, model_path, text_reply
from tests.fakes.server import (
    PASS,
    FakeServer,
    Reply,
    rate_limited,
    retry_after_http_date,
    retry_after_seconds,
)
from tests.fakes.todoist_fake import COMPLETED_PATH, PROJECT_ID, TASKS_PATH, TOKEN, TodoistFake, stamp

GEMINI_KEY = {"x-goog-api-key": API_KEY}
TODOIST_AUTH = {"authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def fake() -> Iterator[FakeServer]:
    server = FakeServer()
    yield server
    server.close()


@pytest.fixture
def gemini() -> Iterator[GeminiFake]:
    server = GeminiFake()
    yield server
    server.close()


@pytest.fixture
def todoist() -> Iterator[TodoistFake]:
    server = TodoistFake()
    yield server
    server.close()


def test_queued_replies_are_fifo_then_default(fake: FakeServer) -> None:
    fake.queue("POST", "/x", Reply(429, "slow down", {"retry-after": "7"}))
    fake.queue("POST", "/x", Reply(200, {"ok": True}))
    fake.default("POST", "/x", Reply(204))

    first = httpx.post(f"{fake.url}/x")
    second = httpx.post(f"{fake.url}/x")
    third = httpx.post(f"{fake.url}/x")

    assert (first.status_code, first.headers["retry-after"], first.text) == (429, "7", "slow down")
    assert (second.status_code, second.json()) == (200, {"ok": True})
    assert third.status_code == 204
    assert httpx.get(f"{fake.url}/unknown").status_code == 404


def test_records_method_path_query_headers_and_body(fake: FakeServer) -> None:
    fake.default("POST", "/tasks", Reply(200, {}))
    httpx.post(f"{fake.url}/tasks?cursor=abc", json={"a": 1}, headers={"X-Request-Id": "r1"})

    [request] = fake.received("POST", "/tasks")
    assert request.query == {"cursor": ["abc"]} and request.param("cursor") == "abc"
    assert request.headers["x-request-id"] == "r1"
    assert request.json() == {"a": 1}


def test_chunked_request_bodies_are_recorded(fake: FakeServer) -> None:
    fake.default("POST", "/chunked", Reply(204))
    httpx.post(f"{fake.url}/chunked", content=iter([b'{"a":', b" 1}"]))
    assert fake.received("POST", "/chunked")[0].json() == {"a": 1}


def test_delay_postpones_the_reply(fake: FakeServer) -> None:
    fake.queue("GET", "/slow", Reply(200, delay_ms=300))
    started = time.monotonic()
    assert httpx.get(f"{fake.url}/slow").status_code == 200
    assert time.monotonic() - started >= 0.3


def test_hang_lasts_until_the_client_disconnects(fake: FakeServer) -> None:
    fake.queue("GET", "/hang", Reply(hang=True))
    port = int(fake.url.rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port)) as client:
        client.sendall(b"GET /hang HTTP/1.1\r\nHost: fake\r\n\r\n")
        fake.wait_for(lambda: fake.received("GET", "/hang"))
        client.settimeout(0.3)
        with pytest.raises(TimeoutError):
            client.recv(1)
    assert fake.wait_for(lambda: fake.disconnects) == ["/hang"]


def test_retry_after_in_seconds_and_http_date(fake: FakeServer) -> None:
    fake.queue("GET", "/limited", rate_limited(retry_after_seconds(7)))
    fake.queue("GET", "/limited", rate_limited(retry_after_http_date(30)))

    seconds = httpx.get(f"{fake.url}/limited")
    dated = httpx.get(f"{fake.url}/limited")

    assert (seconds.status_code, seconds.headers["retry-after"]) == (429, "7")
    moment = email.utils.parsedate_to_datetime(dated.headers["retry-after"]).timestamp()
    assert dated.status_code == 429 and 28 <= moment - time.time() <= 31


def test_admin_endpoints_control_the_fake_over_http(fake: FakeServer) -> None:
    reply = {"status": 503, "body": {"down": True}, "headers": {"retry-after": "3"}}
    assert (
        httpx.post(f"{fake.url}/admin/queue", json={"method": "GET", "path": "/x", "reply": reply}).status_code == 200
    )
    queued = httpx.get(f"{fake.url}/x", headers={"x-trace": "t"})
    assert (queued.status_code, queued.json(), queued.headers["retry-after"]) == (503, {"down": True}, "3")

    [recorded] = httpx.get(f"{fake.url}/admin/state").json()["requests"]
    assert (recorded["method"], recorded["path"], recorded["headers"]["x-trace"]) == ("GET", "/x", "t")

    assert httpx.post(f"{fake.url}/admin/reset").status_code == 200
    assert httpx.get(f"{fake.url}/admin/state").json()["requests"] == []
    assert httpx.post(f"{fake.url}/admin/nope").status_code == 404


def test_gemini_checks_the_api_key_and_records_the_request(gemini: GeminiFake) -> None:
    url = gemini.url + model_path("model-a")
    assert httpx.post(url, json={}).status_code == 401
    body = {
        "systemInstruction": {"parts": [{"text": "system prompt"}]},
        "contents": [{"role": "user", "parts": [{"text": "mail body"}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {"type": "ARRAY", "maxItems": 2},
        },
    }
    response = httpx.post(url, json=body, headers=GEMINI_KEY).json()

    items = response["candidates"][0]["content"]["parts"][0]["text"]
    assert [item["rank"] for item in httpx.Response(200, content=items).json()] == [1, 2]
    assert response["usageMetadata"]["totalTokenCount"] > 0
    unauthorized, call = gemini.calls("model-a")
    assert unauthorized.api_key is None
    assert (call.api_key, call.system, call.user) == (API_KEY, "system prompt", "mail body")
    assert (call.response_mime_type, call.response_schema) == ("application/json", {"type": "ARRAY", "maxItems": 2})


def test_gemini_default_summary_and_count_tokens(gemini: GeminiFake) -> None:
    body = {"contents": [{"parts": [{"text": "x" * 400}]}]}
    summary = httpx.post(gemini.url + model_path("m"), json=body, headers=GEMINI_KEY).json()
    assert summary["candidates"][0]["content"]["parts"][0]["text"].startswith("合成摘要")
    counted = httpx.post(gemini.url + model_path("m", "countTokens"), json=body, headers=GEMINI_KEY).json()
    assert counted["totalTokens"] == summary["usageMetadata"]["totalTokenCount"]


def test_gemini_queues_per_model_before_any_model(gemini: GeminiFake) -> None:
    gemini.queue_generate(error_reply(429, retry_after_seconds(5)))
    gemini.queue_generate(text_reply("for b", tokens=7), model="model-b")

    b = httpx.post(gemini.url + model_path("model-b"), json={}, headers=GEMINI_KEY)
    a = httpx.post(gemini.url + model_path("model-a"), json={}, headers=GEMINI_KEY)
    again = httpx.post(gemini.url + model_path("model-a"), json={}, headers=GEMINI_KEY)

    assert b.json()["usageMetadata"]["totalTokenCount"] == 7
    assert (a.status_code, a.headers["retry-after"], a.json()["error"]["status"]) == (429, "5", "RESOURCE_EXHAUSTED")
    assert again.status_code == 200


def test_todoist_rejects_a_wrong_token(todoist: TodoistFake) -> None:
    response = httpx.post(todoist.url + TASKS_PATH, json={"content": "x"}, headers={"authorization": "Bearer nope"})
    assert response.status_code == 401
    assert todoist.tasks == []


def test_todoist_creates_tasks_with_increasing_ids_and_records_the_request_id(todoist: TodoistFake) -> None:
    ids = []
    for n in range(2):
        response = httpx.post(
            todoist.url + TASKS_PATH,
            json={"content": f"t{n}", "description": "d", "project_id": "p1"},
            headers=TODOIST_AUTH | {"x-request-id": f"todofy-{n}"},
        )
        assert response.status_code == 200 and response.json()["labels"] == []
        ids.append(response.json()["id"])
    assert ids == sorted(ids) and len(set(ids)) == 2
    assert [task.request_id for task in todoist.tasks] == ["todofy-0", "todofy-1"]
    assert httpx.post(todoist.url + TASKS_PATH, json={"content": " "}, headers=TODOIST_AUTH).status_code == 400


def test_todoist_lists_active_tasks_of_one_project_in_pages(todoist: TodoistFake) -> None:
    todoist.max_page_size = 2
    wanted = [todoist.add_task(f"a{n}", f"footer {n}") for n in range(5)]
    todoist.add_task("done", checked=True)
    todoist.add_task("gone", is_deleted=True)
    todoist.add_task("elsewhere", project_id="other")

    seen, cursor, pages = [], None, 0
    while True:
        params = {"project_id": PROJECT_ID, "limit": 200} | ({"cursor": cursor} if cursor else {})
        page = httpx.get(todoist.url + TASKS_PATH, params=params, headers=TODOIST_AUTH).json()
        seen += [task["id"] for task in page["results"]]
        pages += 1
        if not (cursor := page["next_cursor"]):
            break
    assert (seen, pages) == ([task.id for task in wanted], 3)
    assert httpx.get(todoist.url + TASKS_PATH, params={"cursor": "bad"}, headers=TODOIST_AUTH).status_code == 400


def test_applied_reply_creates_the_task_but_answers_differently(todoist: TodoistFake) -> None:
    todoist.queue("POST", TASKS_PATH, Reply(500, {"error": "boom"}, applied=True))
    response = httpx.post(todoist.url + TASKS_PATH, json={"content": "lost"}, headers=TODOIST_AUTH)
    assert response.status_code == 500
    assert [task.content for task in todoist.tasks] == ["lost"]


def test_pass_serves_the_route_after_a_delay_and_only_then_the_queue(todoist: TodoistFake) -> None:
    todoist.add_task("t", "d")
    todoist.queue("GET", TASKS_PATH, Reply(None, delay_ms=200))
    todoist.queue("GET", TASKS_PATH, Reply(500))
    started = time.monotonic()
    first = httpx.get(todoist.url + TASKS_PATH, headers=TODOIST_AUTH)
    assert first.status_code == 200 and len(first.json()["results"]) == 1
    assert time.monotonic() - started >= 0.2
    assert httpx.get(todoist.url + TASKS_PATH, headers=TODOIST_AUTH).status_code == 500
    assert PASS.status is None and todoist.pending("GET", TASKS_PATH) == 0


def test_todoist_seed_and_state_over_http(todoist: TodoistFake) -> None:
    seed = {"tasks": [{"content": "seeded", "description": "Mail Hero event: x", "checked": True}]}
    assert httpx.post(todoist.url + "/admin/seed", json=seed).status_code == 200
    [task] = httpx.get(todoist.url + "/admin/state").json()["tasks"]
    assert (task["content"], task["checked"], task["project_id"]) == ("seeded", True, PROJECT_ID)
    httpx.post(todoist.url + "/admin/reset")
    assert todoist.tasks == []


def test_todoist_lists_every_project_without_a_filter(todoist: TodoistFake) -> None:
    todoist.add_task("a")
    todoist.add_task("b", project_id="other", priority=4, due={"date": "2026-10-05"}, labels=["x"])
    page = httpx.get(todoist.url + TASKS_PATH, params={"limit": 200}, headers=TODOIST_AUTH).json()
    assert [(task["project_id"], task["priority"]) for task in page["results"]] == [(PROJECT_ID, 1), ("other", 4)]
    assert page["results"][1]["due"] == {"date": "2026-10-05"} and page["next_cursor"] is None


def test_todoist_lists_completed_tasks_in_a_window_and_omits_the_last_cursor(todoist: TodoistFake) -> None:
    todoist.max_page_size = 2
    now = 1_790_000_000.0
    done = [todoist.add_task(f"d{n}", added_at=stamp(now - 86_400)) for n in range(3)]
    for offset, task in enumerate(done):
        todoist.complete(task.id, now - 60 * offset)
    old = todoist.add_task("old")
    todoist.complete(old.id, now - 8 * 86_400)
    todoist.add_task("open")
    params = {"since": stamp(now - 7 * 86_400), "until": stamp(now + 1), "limit": 200}
    first = httpx.get(todoist.url + COMPLETED_PATH, params=params, headers=TODOIST_AUTH).json()
    assert [task["content"] for task in first["items"]] == ["d0", "d1"] and first["next_cursor"]
    second = httpx.get(
        todoist.url + COMPLETED_PATH, params=params | {"cursor": first["next_cursor"]}, headers=TODOIST_AUTH
    ).json()
    assert [task["content"] for task in second["items"]] == ["d2"] and "next_cursor" not in second
    active = httpx.get(todoist.url + TASKS_PATH, headers=TODOIST_AUTH).json()["results"]
    assert [task["content"] for task in active] == ["open"]
    assert httpx.get(todoist.url + COMPLETED_PATH, params={"limit": 5}, headers=TODOIST_AUTH).status_code == 400
