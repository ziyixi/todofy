import re

import pytest

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
        for path in ("/health", "/", "/api/v1/serviceStatus"):
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


def test_owner_api_errors_are_google_rpc_status(worker: Worker) -> None:
    response = worker.owner.get("/api/v1/nope")
    assert response.status_code == 404
    error = response.json()["error"]
    assert (error["code"], error["status"]) == (404, "NOT_FOUND") and error["message"]
    by_type = {detail["@type"].rsplit(".", 1)[1]: detail for detail in error["details"]}
    assert by_type["ErrorInfo"] == {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "NOT_FOUND",
        "domain": "todofy.ziyixi.science",
    }
    assert re.fullmatch(r"[0-9a-f]{16}", by_type["RequestInfo"]["request_id"])
    assert by_type["LocalizedMessage"]["locale"] == "zh-CN"


def test_the_owner_api_before_todofy_ui_v1_asks_to_reload(worker: Worker) -> None:
    for path in ("/api/v1/overview", "/api/v1/events?view=recent&limit=50", "/api/v1/csrf"):
        response = worker.owner.get(path)
        assert response.status_code == 410, path
        error = response.json()["error"]
        assert error["code"] == "reload_required" and error["message"]
        assert re.fullmatch(r"[0-9a-f]{16}", error["request_id"])


@pytest.mark.reaches("METHOD_NOT_ALLOWED")
def test_another_method_on_a_known_owner_path_is_405_with_allow(worker: Worker) -> None:
    for method, path, allow in (
        ("DELETE", "/api/v1/serviceStatus", "GET, HEAD, OPTIONS"),
        ("PUT", "/api/csrf", "GET"),
    ):
        response = worker.owner.request(method, path, headers=worker.csrf_headers())
        assert response.status_code == 405, (method, path)
        assert response.headers["allow"] == allow
        assert response.json()["error"]["status"] == "UNIMPLEMENTED"


def test_owner_api_is_not_reachable_through_the_hooks_host(worker: Worker) -> None:
    assert worker.hooks.get("/api/v1/serviceStatus").status_code == 404
    assert worker.hooks.get("/api/v1/overview").status_code == 404
