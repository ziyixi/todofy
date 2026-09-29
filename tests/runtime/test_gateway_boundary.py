"""The boundary between the gateway ("todofy") and todofy-core (docs/gateway-contract.md §2–§4).

The object trusts only requests the gateway built: it refuses anything without the
internal marker, and the gateway never lets a client's own x-todofy-* headers through.
Hashed assets may be cached, the SPA fallback never; /health never calls the object.
"""

import re
import uuid
from collections.abc import Iterator

import httpx
import pytest

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
    start_gateway,
)
from tests.runtime.owner_support import PRIVATE_HEADERS, assert_private

REQUEST_ID = re.compile(r"[0-9a-f]{16}")
CLIENT_REQUEST_ID = "0123456789abcdef"
INTRUDER = "intruder@example.org"
IMMUTABLE = "private, max-age=31536000, immutable"

# Test-only primary Worker in front of the real core: it forwards every request to the
# object with the client's own headers, so a test can leave out the gateway's. It reads the
# client's body first: the object refuses unmarked requests without reading them, and an
# upload left unread can make wrangler's local proxy drop the next POST (docs/dev-notes.md).
PROBE_SCRIPT = """\
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const target = `https://coordinator${url.pathname}${url.search}`;
    const body = request.body === null ? null : await request.arrayBuffer();
    const init = { method: request.method, headers: request.headers, body };
    return env.COORDINATOR.getByName('inbox-v1').fetch(target, init);
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
class_name = "TodofyCoordinator"
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


INTERNAL_ROUTES = [
    ("POST", "/ingest"),
    ("POST", "/wake"),
    ("GET", "/setup"),
    ("GET", "/newsletter/summary"),
    ("GET", "/newsletter/recommendation?top=3"),
    ("POST", "/newsletter/auth-failure"),
    ("GET", "/api/v1/overview"),
    ("POST", "/api/v1/reports/recompute"),
]


@pytest.mark.parametrize(("method", "path"), INTERNAL_ROUTES)
@pytest.mark.parametrize("marker", [None, "0", "true", "1, 1"])
def test_the_object_refuses_requests_without_the_internal_marker(
    core: Worker, method: str, path: str, marker: str | None
) -> None:
    event_id, body = mail_event()
    headers = {"x-todofy-owner": OWNER, "content-type": "application/json", "idempotency-key": event_id}
    if marker is not None:
        headers["x-todofy-internal"] = marker
    response = core.hooks.request(method, path, headers=headers, content=body if method == "POST" else None)
    assert (response.status_code, error_code(response)) == (404, "not_found")
    _envelope_id(response)


def test_refused_requests_change_nothing(core: Worker) -> None:
    event_id, body = mail_event()
    headers = {"content-type": "application/json", "idempotency-key": event_id}
    assert core.hooks.post("/ingest", headers=headers, content=body).status_code == 404
    assert core.hooks.post("/newsletter/auth-failure").status_code == 404
    assert core.d1("SELECT count(*) AS n FROM mail_events")[0]["n"] == 0
    assert core.d1("SELECT count(*) AS n FROM auth_failures")[0]["n"] == 0
    # The same requests with the marker are served: the probe does reach the object.
    marked = headers | {"x-todofy-internal": "1"}
    assert core.hooks.post("/ingest", headers=marked, content=body).status_code == 204
    assert core.hooks.post("/newsletter/auth-failure", headers={"x-todofy-internal": "1"}).status_code == 401
    assert core.d1(f"SELECT count(*) AS n FROM mail_events WHERE event_id = '{event_id}'")[0]["n"] == 1
    assert core.hooks.get("/setup", headers={"x-todofy-internal": "1"}).status_code == 200


@pytest.mark.parametrize("owner", [None, "", "owner.example.com", "a@" + "x" * 253])
def test_owner_routes_need_a_usable_owner_header(core: Worker, owner: str | None) -> None:
    headers = {"x-todofy-internal": "1"} | ({} if owner is None else {"x-todofy-owner": owner})
    response = core.hooks.get("/api/v1/overview", headers=headers)
    assert (response.status_code, error_code(response)) == (401, "unauthorized")


def test_the_object_uses_the_gateway_request_id_only_when_well_formed(core: Worker) -> None:
    internal = {"x-todofy-internal": "1", "x-todofy-owner": OWNER}
    unknown = f"/api/v1/events/{uuid.uuid4()}"
    kept = core.hooks.get(unknown, headers=internal | {"x-todofy-request-id": CLIENT_REQUEST_ID})
    assert (kept.status_code, _envelope_id(kept)) == (404, CLIENT_REQUEST_ID)
    replaced = core.hooks.get(unknown, headers=internal | {"x-todofy-request-id": "not-a-request-id"})
    assert replaced.status_code == 404 and _envelope_id(replaced) != "not-a-request-id"


def test_client_internal_headers_never_reach_the_object(worker: Worker) -> None:
    forged = {"x-todofy-request-id": CLIENT_REQUEST_ID, "x-todofy-owner": INTRUDER, "x-todofy-internal": "0"}

    # Owner host: the object answers with the gateway's request ID, not the client's.
    missing = worker.owner.get(f"/api/v1/events/{uuid.uuid4()}", headers=forged)
    assert (missing.status_code, error_code(missing)) == (404, "not_found")
    assert _envelope_id(missing) != CLIENT_REQUEST_ID

    # The owner the object records is the one from Access, whatever the client claims.
    action_id = str(uuid.uuid4())
    body = {"kind": "summary", "action_request_id": action_id}
    recomputed = worker.post_owner("/api/v1/reports/recompute", body, headers=forged)
    assert recomputed.status_code == 200, recomputed.text
    rows = worker.d1(f"SELECT owner FROM owner_actions WHERE action_request_id = '{action_id}'")
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

    # Every route that needs the object fails in this process, so /health above did not use it.
    # (wrangler dev itself answers a call to a Worker it does not run with a plain-text 503.) The
    # deploy's core probe, a wrong newsletter credential, is among them: 401 needs the object.
    _, event = mail_event()
    for response in (
        gateway_alone.post_event(event),
        gateway_alone.report("/api/summary", auth=(REPORT_USER, REPORT_PASSWORD)),
        gateway_alone.report("/api/summary", auth=("ci-probe", "wrong")),
        gateway_alone.owner.get("/api/v1/overview"),
    ):
        assert response.status_code == 503
        assert 'Worker "todofy-core" not found' in response.text
