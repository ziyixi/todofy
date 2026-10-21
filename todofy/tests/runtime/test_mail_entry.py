"""Todofy's Mail entry end to end in workerd: a Worker bound to the gateway's ``Mail`` entrypoint, as Tasks and the
Personal MCP bind it, reaches the real TodofyCore and D1 through the shared transcoder (gateway/src/mail.ts,
runtime/mail.py). Every answer is read strictly as its todofy.mail.v1 message. Synthetic mail only."""

import json
import time
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from ziyixi_proto.todofy.mail.v1 import mail_service_pb as pb
from ziyixi_proto.wire_json import from_wire

from tests.runtime.harness import Worker, start_gateway

# A test-only primary Worker: /rw/<path> and /ro/<path> go to the gateway's Mail entrypoint through a read-write and
# a read binding, the way Tasks' and the Personal MCP's bindings call it.
PROBE_SCRIPT = """\
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const binding = url.pathname.startsWith('/ro/') ? env.MAIL_READ : env.MAIL;
    const body = request.method === 'GET' ? null : await request.text();
    return binding.fetch(`https://mail.internal${url.pathname.slice(3)}${url.search}`, {
      method: request.method, headers: { 'content-type': 'application/json' }, body,
    });
  },
};
"""
PROBE_CONFIG = """\
name = "todofy-mail-probe"
main = "probe.js"
compatibility_date = "2026-09-08"
workers_dev = false
preview_urls = false

[[services]]
binding = "MAIL"
service = "todofy-test"
entrypoint = "Mail"
props = { access = "read-write" }

[[services]]
binding = "MAIL_READ"
service = "todofy-test"
entrypoint = "Mail"
props = { access = "read" }
"""
SOURCE = "mail-hero-personal"
DAY = 86_400


@pytest.fixture(scope="module")
def probe(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    state = tmp_path_factory.mktemp("mail-entry")
    (state / "probe.js").write_text(PROBE_SCRIPT)
    (state / "wrangler.toml").write_text(PROBE_CONFIG)
    yield from start_gateway(state, {}, front=str(state / "wrangler.toml"))


def seed(worker: Worker, event_id: str, received: int, summary: str, **columns: Any) -> None:
    row = {"event_id": event_id, "created_at": received + 30, "subject": "合成主题", "summary": summary, "model": "m"}
    row |= columns
    values = ", ".join(
        "'" + value.replace("'", "''") + "'" if isinstance(value, str) else str(value) for value in row.values()
    )
    worker.d1(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, state, created_at, updated_at)"
        f" VALUES ('{SOURCE}', '{event_id}', '{'0' * 64}', 'complete', {received}, {received});"
        f"INSERT INTO summaries ({', '.join(row)}) VALUES ({values})"
    )


def answer(response: httpx.Response, cls: type) -> Any:
    assert response.status_code == 200, response.text
    return from_wire(cls, response.json(), strict=True).message


def refusal(response: httpx.Response) -> tuple[int, str, str]:
    error = response.json()["error"]
    [info] = [detail for detail in error["details"] if detail["@type"] == "type.googleapis.com/google.rpc.ErrorInfo"]
    assert info["domain"] == "todofy.ziyixi.science", info
    return response.status_code, error["status"], info["reason"]


def test_pending_mail_is_listed_read_converted_and_deleted(probe: Worker) -> None:
    now = int(time.time())
    first, second, converted = (str(uuid.uuid4()) for _ in range(3))
    seed(probe, first, now - 3 * DAY, "第一封合成邮件。\n\n细节。")
    seed(probe, second, now - 3600, "第二封合成邮件。")
    seed(probe, converted, now - 2 * DAY, "已转成任务。", task_id="task-0", triaged_at=now - DAY)

    page = answer(probe.hooks.get("/rw/api/mail/v1/mailItems", params={"page_size": 1}), pb.ListMailItemsResponse)
    assert [item.id for item in page.mail_items] == [second] and page.next_page_token
    rest = probe.hooks.get("/rw/api/mail/v1/mailItems", params={"page_token": page.next_page_token})
    [item] = answer(rest, pb.ListMailItemsResponse).mail_items
    assert (item.id, item.title, item.brief, item.pending, item.summary) == (
        first,
        "合成主题",
        "第一封合成邮件。",
        True,
        "",
    )

    read = answer(probe.hooks.get(f"/rw/api/mail/v1/mailItems/{first}"), pb.MailItem)
    assert read.summary == "第一封合成邮件。\n\n细节。" and read.etag == item.etag
    inbox = answer(probe.hooks.get("/rw/api/mail/v1/mailInbox"), pb.MailInbox)
    assert (inbox.pending_count, inbox.carryover_count) == (2, 1)

    mark = f"/rw/api/mail/v1/mailItems/{first}:markConverted"
    stale = probe.hooks.post(mark, json={"etag": "stale", "task_id": "task-1"})
    assert refusal(stale) == (409, "ABORTED", "ETAG_MISMATCH")
    done = answer(probe.hooks.post(mark, json={"etag": item.etag, "task_id": "task-1"}), pb.MailItem)
    assert (done.task_id, done.pending) == ("task-1", False)
    assert answer(probe.hooks.post(mark, json={"etag": item.etag, "task_id": "task-1"}), pb.MailItem) == done
    other = probe.hooks.post(mark, json={"etag": item.etag, "task_id": "task-2"})
    assert refusal(other) == (400, "FAILED_PRECONDITION", "NOT_PENDING")
    [row] = probe.d1(
        f"SELECT task_id, category_id, triaged_at IS NOT NULL AS triaged FROM summaries WHERE event_id = '{first}'"
    )
    assert row == {"task_id": "task-1", "category_id": None, "triaged": 1}

    deleted = probe.hooks.post("/rw/api/mail/v1/mailItems:deleteSummaries", json={"event_ids": [second, converted]})
    assert answer(deleted, pb.DeleteMailSummariesResponse) == pb.DeleteMailSummariesResponse(
        deleted_event_ids=(second,), kept_event_ids=(converted,)
    )
    assert probe.d1("SELECT count(*) AS n FROM mail_events") == [{"n": 3}]
    assert answer(probe.hooks.get("/rw/api/mail/v1/mailItems"), pb.ListMailItemsResponse).mail_items == ()
    missing = probe.hooks.get(f"/rw/api/mail/v1/mailItems/{second}")
    assert refusal(missing) == (404, "NOT_FOUND", "NOT_FOUND")


def test_readiness_moves_past_every_transition_to_the_pending_mail(probe: Worker) -> None:
    baseline = answer(
        probe.hooks.get("/rw/api/mail/v1/mailItems:pollReady", params={"baseline": "true"}), pb.PollMailReadyResponse
    )
    ready = str(uuid.uuid4())
    seed(probe, ready, int(time.time()), "就绪的合成邮件。")
    probe.d1(
        f"INSERT INTO event_transitions (event_id, at, to_state, actor) VALUES ('{ready}', 1, 'complete', 'worker')"
    )
    polled = probe.hooks.get("/rw/api/mail/v1/mailItems:pollReady", params={"cursor": baseline.cursor})
    page = answer(polled, pb.PollMailReadyResponse)
    assert [item.event_id for item in page.mail_items] == [ready] and int(page.cursor) > int(baseline.cursor)
    ahead = probe.hooks.get("/rw/api/mail/v1/mailItems:pollReady", params={"cursor": "9223372036854775807"})
    assert refusal(ahead) == (400, "FAILED_PRECONDITION", "CURSOR_RESET_REQUIRED")


def test_a_read_binding_reads_and_cannot_write(probe: Worker) -> None:
    event_id = str(uuid.uuid4())
    seed(probe, event_id, int(time.time()) - 60, "只读的合成邮件。")
    item = answer(probe.hooks.get(f"/ro/api/mail/v1/mailItems/{event_id}"), pb.MailItem)
    for path, body in (
        (f"/ro/api/mail/v1/mailItems/{event_id}:markConverted", {"etag": item.etag, "task_id": "task-1"}),
        ("/ro/api/mail/v1/mailItems:deleteSummaries", {"event_ids": [event_id]}),
    ):
        response = probe.hooks.post(path, content=json.dumps(body))
        assert refusal(response) == (403, "PERMISSION_DENIED", "FORBIDDEN"), path
    [row] = probe.d1(f"SELECT triaged_at FROM summaries WHERE event_id = '{event_id}'")
    assert row == {"triaged_at": None}
