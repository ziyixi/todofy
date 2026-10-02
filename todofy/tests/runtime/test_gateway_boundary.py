"""The boundary between the gateway ("todofy") and todofy-core (docs/gateway-contract.md §2–§4).

The object has no HTTP routes: the gateway calls its RPC methods, and every answer is a
plain result the gateway turns into the response. The previous gateway's fetch calls get a
retryable 503 for the one release that moves to RPC (§6.4). A client's own x-todofy-* headers do
nothing. Hashed assets may be cached, the SPA fallback never; /health never calls the object.
"""

import json
import re
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb
from ziyixi_proto.wire_json import from_wire

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import TodoistFake
from tests.runtime.conftest import pipeline_vars
from tests.runtime.harness import (
    OWNER,
    REPORT_PASSWORD,
    REPORT_USER,
    ROOT,
    Worker,
    error_code,
    mail_event,
    reason,
    start_gateway,
)
from tests.runtime.owner_support import PRIVATE_HEADERS, assert_private
from todofy.core.api_errors import MESSAGES, ApiError

REQUEST_ID = re.compile(r"[0-9a-f]{16}")
CLIENT_REQUEST_ID = "0123456789abcdef"
INTRUDER = "intruder@example.org"
IMMUTABLE = "private, max-age=31536000, immutable"

# Test-only primary Worker in front of the real core. /fetch/<path> sends the request to the
# object's fetch with the client's own headers; /rpc/<method>?args=<JSON list> calls an RPC
# method (with the request body stream as the last argument when ?body is set) and answers its
# result as JSON.
# It reads a body it fetches with first: an upload left unread can make wrangler's local proxy
# drop the next POST (docs/dev-notes.md).
PROBE_SCRIPT = """\
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const core = env.COORDINATOR.getByName('inbox-v1');
    if (url.pathname.startsWith('/rpc/')) {
      const args = JSON.parse(url.searchParams.get('args') ?? '[]');
      if (url.searchParams.has('body')) args.push(request.body);
      return Response.json((await core[url.pathname.slice(5)](...args)) ?? null);
    }
    const target = `https://coordinator${url.pathname.slice(6)}${url.search}`;
    const body = request.body === null ? null : await request.arrayBuffer();
    return core.fetch(target, { method: request.method, headers: request.headers, body });
  },
};
"""
PROBE_CONFIG = """\
name = "todofy-boundary-probe"
main = "probe.js"
compatibility_date = "2026-09-08"
workers_dev = false
preview_urls = false

[[durable_objects.bindings]]
name = "COORDINATOR"
class_name = "TodofyCore"
script_name = "todofy-core"
"""


@pytest.fixture(scope="module")
def core(tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake) -> Iterator[Worker]:
    state = tmp_path_factory.mktemp("boundary-probe")
    (state / "probe.js").write_text(PROBE_SCRIPT)
    (state / "wrangler.toml").write_text(PROBE_CONFIG)
    yield from start_gateway(state, pipeline_vars(gemini, todoist), str(state / "wrangler.toml"))


@pytest.fixture(scope="module")
def gateway_alone(
    tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake
) -> Iterator[Worker]:
    yield from start_gateway(tmp_path_factory.mktemp("gateway-alone"), pipeline_vars(gemini, todoist), core=False)


def _envelope_id(response: httpx.Response) -> str:
    request_id = response.json()["error"]["request_id"]
    assert REQUEST_ID.fullmatch(request_id), request_id
    return request_id


def _rpc(core: Worker, method: str, *args: Any, body: bytes | None = None) -> Any:
    params = {"args": json.dumps(args)} | ({} if body is None else {"body": "1"})
    response = core.hooks.post(f"/rpc/{method}", params=params, content=body)
    assert response.status_code == 200, response.text
    return response.json()


def _error(status: int, code: ApiError) -> dict[str, Any]:
    return {"status": status, "body": None, "error": {"code": code, "message": MESSAGES[code]}, "retry_after": None}


FORMER_ROUTES = [
    ("POST", "/ingest"),
    ("POST", "/wake"),
    ("GET", "/setup"),
    ("GET", "/newsletter/summary"),
    ("GET", "/newsletter/recommendation?top=3"),
    ("POST", "/newsletter/auth-failure"),
    ("GET", "/api/v1/overview"),
    ("POST", "/api/v1/reports/recompute"),
    ("GET", "/api/v1/serviceStatus"),
]


@pytest.mark.reaches("not_found")
@pytest.mark.parametrize(("method", "path"), FORMER_ROUTES)
@pytest.mark.parametrize("marker", ["1", "0"])
def test_the_object_has_no_http_routes(core: Worker, method: str, path: str, marker: str) -> None:
    # Even a request carrying the former internal marker is refused; the gateway uses RPC only.
    event_id, body = mail_event()
    headers = {
        "x-todofy-internal": marker,
        "x-todofy-owner": OWNER,
        "x-todofy-request-id": CLIENT_REQUEST_ID,
        "content-type": "application/json",
        "idempotency-key": event_id,
    }
    response = core.hooks.request(method, f"/fetch{path}", headers=headers, content=body if method == "POST" else None)
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert response.headers.get("retry-after") is None
    assert _envelope_id(response) != CLIENT_REQUEST_ID


def test_fetch_changes_nothing_and_rpc_answers_results(core: Worker) -> None:
    event_id, body = mail_event()
    headers = {"x-todofy-internal": "1", "content-type": "application/json", "idempotency-key": event_id}
    assert core.hooks.post("/fetch/ingest", headers=headers, content=body).status_code == 404
    assert core.hooks.post("/fetch/newsletter/auth-failure", headers=headers).status_code == 404
    assert core.d1("SELECT count(*) AS n FROM mail_events")[0]["n"] == 0
    assert core.d1("SELECT count(*) AS n FROM auth_failures")[0]["n"] == 0

    # The same work through the RPC methods is served, as plain results.
    no_content = {"status": 204, "body": None, "error": None, "retry_after": None}
    assert _rpc(core, "ingest", event_id, body=body) == no_content
    assert core.d1(f"SELECT count(*) AS n FROM mail_events WHERE event_id = '{event_id}'")[0]["n"] == 1
    assert _rpc(core, "ingest", str(uuid.uuid4()), body=body) == _error(400, ApiError.INVALID_PAYLOAD)
    assert _rpc(core, "newsletter_auth_failure") == _error(401, ApiError.UNAUTHORIZED)
    assert _rpc(core, "newsletter", "weekly", "") == _error(404, ApiError.NOT_FOUND)
    setup = _rpc(core, "setup")
    assert set(setup) == {"mail_source_id", "configured"}
    assert set(setup["configured"]) == {"gemini_api_key", "todoist_api_key", "todoist_project"}

    # todofy.ui.v1: the response message as wire JSON text, and the next page's cursor.
    page = _rpc(core, "owner_ui", OWNER, "ListMailEvents", '{"page_size":1}', None)
    assert set(page) == {"ok", "next_cursor"}
    listed = from_wire(pb.ListMailEventsResponse, json.loads(page["ok"]), strict=True).message
    assert [event.name for event in listed.mail_events] == [f"mailEvents/{event_id}"]

    # The owner API before todofy.ui.v1, which only the previous gateway calls during this deploy (one release).
    old = _rpc(core, "owner_api", OWNER, "GET", "/api/v1/events", "limit=1", None, None)
    assert (old["status"], old["error"], old["retry_after"]) == (200, None, None)
    assert json.loads(old["body"])["items"][0]["event_id"] == event_id


@pytest.mark.parametrize("owner", ["", "owner.example.com", "a@" + "x" * 253])
def test_owner_api_needs_a_usable_owner(core: Worker, owner: str) -> None:
    result = _rpc(core, "owner_ui", owner, "GetServiceStatus", '{"name":"serviceStatus"}', None)
    assert result == {"error": "UNAUTHORIZED", "detail": None, "retry_after": None}
    old = _rpc(core, "owner_api", owner, "GET", "/api/v1/overview", "", None, None)
    assert old == _error(401, ApiError.UNAUTHORIZED)


@pytest.mark.parametrize(
    ("method", "request_json"),
    [
        ("ListMailEvents", '{"limit":1}'),
        ("ListMailEvents", "not json"),
        ("ReconcileMailEvent", '{"name":"mailEvents/x"}'),
        ("GetServiceStatus", '{"name":"overview"}'),
    ],
)
def test_owner_ui_reads_every_request_strictly(core: Worker, method: str, request_json: str) -> None:
    assert _rpc(core, "owner_ui", OWNER, method, request_json, None) == {
        "error": "BAD_REQUEST",
        "detail": None,
        "retry_after": None,
    }
    unknown = _rpc(core, "owner_ui", OWNER, "GetIntegration", '{"name":"integration"}', None)
    assert unknown["error"] == "NOT_FOUND"  # the gateway's own rpc


def test_client_internal_headers_never_reach_the_object(worker: Worker) -> None:
    forged = {"x-todofy-request-id": CLIENT_REQUEST_ID, "x-todofy-owner": INTRUDER, "x-todofy-internal": "0"}

    # Owner host: the answer carries the gateway's request ID, not the client's.
    missing = worker.owner.get(f"/api/v1/mailEvents/{uuid.uuid4()}", headers=forged)
    assert (missing.status_code, reason(missing)) == (404, "NOT_FOUND")
    [info] = [d for d in missing.json()["error"]["details"] if d["@type"].endswith("google.rpc.RequestInfo")]
    assert REQUEST_ID.fullmatch(info["request_id"]) and info["request_id"] != CLIENT_REQUEST_ID

    # The owner the object records is the one from Access, whatever the client claims.
    request_id = str(uuid.uuid4())
    body = {"kind": "summary", "request_id": request_id}
    recomputed = worker.post_owner("/api/v1/latestReports:recompute", body, headers=forged)
    assert recomputed.status_code == 200, recomputed.text
    rows = worker.d1(f"SELECT owner FROM owner_actions WHERE action_request_id = '{request_id}'")
    assert rows == [{"owner": OWNER}]

    # Hooks host: a forged marker of "0" does not stop the gateway's own request.
    event_id, event = mail_event()
    assert worker.post_event(event, headers=forged).status_code == 204
    assert worker.event(event_id) is not None
    rejected = worker.post_event(b'{"type":"mail.received.v1"}', event_id=event_id, headers=forged)
    assert (rejected.status_code, error_code(rejected)) == (400, "invalid_payload")
    assert _envelope_id(rejected) != CLIENT_REQUEST_ID


def test_hashed_assets_are_cached_but_the_spa_fallback_is_not(worker: Worker) -> None:
    asset = next(path for path in sorted((ROOT / "uiassets" / "dist" / "assets").iterdir()) if path.is_file())
    served = worker.owner.get(f"/assets/{asset.name}")
    assert served.status_code == 200
    assert served.content == asset.read_bytes()
    assert not served.headers["content-type"].startswith("text/html")
    assert served.headers["cache-control"] == IMMUTABLE
    for name, value in PRIVATE_HEADERS.items():
        assert name == "cache-control" or served.headers[name] == value, name
    assert "frame-ancestors 'none'" in served.headers["content-security-policy"]

    # A missing hashed file gets the SPA's index.html (200): it must not be cached as that file.
    navigate = {"accept": "text/html", "sec-fetch-mode": "navigate"}
    script = {"accept": "*/*", "sec-fetch-dest": "script"}
    missing = f"/assets/missing-{uuid.uuid4().hex[:8]}.js"
    for path, headers in ((missing, script), (missing, navigate), ("/", navigate), ("/attention", navigate)):
        fallback = worker.owner.get(path, headers=headers)
        assert fallback.status_code == 200, path
        assert fallback.headers["content-type"].startswith("text/html"), path
        assert_private(fallback)

    # Assets exist only on the owner host.
    assert worker.hooks.get(f"/assets/{asset.name}").status_code == 404


def test_health_answers_without_the_object(gateway_alone: Worker) -> None:
    response = gateway_alone.hooks.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"build", "service", "status", "timestamp"}
    assert (body["build"], body["service"], body["status"]) == ("test", "todofy", "healthy")
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", body["timestamp"])

    # Every route that needs the object fails in this process, so /health above did not use it:
    # an RPC call to a Worker wrangler dev does not run throws, which the gateway answers with
    # 503 unavailable. The deploy's core probe, a wrong newsletter credential, is among them:
    # 401 needs the object.
    _, event = mail_event()
    for response in (
        gateway_alone.post_event(event),
        gateway_alone.report("/api/summary", auth=(REPORT_USER, REPORT_PASSWORD)),
        gateway_alone.report("/api/summary", auth=("ci-probe", "wrong")),
    ):
        assert (response.status_code, error_code(response)) == (503, "unavailable")
    owner = gateway_alone.owner.get("/api/v1/serviceStatus")
    assert (owner.status_code, reason(owner)) == (503, "UNAVAILABLE")
