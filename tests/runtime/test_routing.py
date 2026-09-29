import re

from tests.runtime.harness import AUTH, PYODIDE_CACHE, Worker

NAVIGATE = {"accept": "text/html", "sec-fetch-mode": "navigate"}


def test_health_reports_the_build_on_the_hooks_host(worker: Worker) -> None:
    response = worker.hooks.get("/health")
    body = response.json()
    assert response.status_code == 200
    # The newsletter's startup preflight checks service and status (Go-era shape).
    expected = {"build": "test", "service": "todofy", "status": "healthy"}
    assert {k: body[k] for k in expected} == expected
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", body["timestamp"])


def test_workerd_reuses_a_cached_pyodide_bundle(worker: Worker) -> None:
    """Dev servers must not download Pyodide on every start (see harness._cached_workerd)."""
    assert list(PYODIDE_CACHE.glob("pyodide_*.capnp.bin"))


def test_unknown_hosts_get_404(worker: Worker) -> None:
    with worker.client("other.example") as client:
        for path in ("/health", "/", "/api/v1/overview"):
            assert client.get(path).status_code == 404


def test_machine_paths_are_not_served_on_the_public_host(worker: Worker) -> None:
    # Static assets answer the POST; the webhook handler never sees it.
    assert worker.owner.post("/hooks/mail", headers=AUTH).status_code == 405
    health = worker.owner.get("/health", headers={"accept": "application/json"})
    assert health.headers["content-type"].startswith("text/html")


def test_spa_fallback_and_security_headers_on_the_public_host(worker: Worker) -> None:
    response = worker.owner.get("/events/some-id", headers=NAVIGATE)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_errors_use_the_openapi_envelope(worker: Worker) -> None:
    response = worker.owner.get("/api/v1/nope")
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found" and error["message"]
    assert re.fullmatch(r"[0-9a-f]{16}", error["request_id"])


def test_owner_api_is_not_reachable_through_the_hooks_host(worker: Worker) -> None:
    assert worker.hooks.get("/api/v1/overview").status_code == 404
