"""Read-only telemetry cannot acquire editor or send capabilities."""

import json

import fastapi.testclient as clients
import pytest

import newsletter.app as application
import newsletter.config_sync as config_sync
import newsletter.content_config as content_config
import newsletter.monitoring_api as monitoring_api
import newsletter.monitoring_status as monitoring
import newsletter.settings as settings
import newsletter.store as storage
import newsletter.workflow.definition as workflow_definition
import newsletter.workflow.engine as workflow_engine
import newsletter.workflow.repository as workflow_repository

MONITOR = "m" * 32
PATH = "/internal/monitoring/status"
SHA = "a" * 40


@pytest.fixture
def configured_monitor(tmp_path):
    root = tmp_path / "config"
    snapshot = content_config.build_snapshot(
        content_config.packaged_snapshot()["files"], SHA
    )
    content_config.install_snapshot(root, snapshot)
    config = settings.Settings(
        data_dir=tmp_path / "data",
        content_config_dir=root,
        monitor_token=MONITOR,
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    with clients.TestClient(
        application.create_app(config, start_worker=False)
    ) as client:
        client.headers["Authorization"] = "Bearer " + MONITOR
        yield client, root, snapshot


def test_monitor_is_separate_and_frozen_process_remains_healthy(tmp_path):
    monitor, editor, send = "m" * 32, "e" * 32, "s" * 32
    config = settings.Settings(
        data_dir=tmp_path,
        monitor_token=monitor,
        editor_token=editor,
        send_token=send,
        bootstrap_drain_key="bootstrap-test",
    )
    with clients.TestClient(
        application.create_app(config, start_worker=False)
    ) as client:
        path = "/internal/monitoring/status"
        for token in (None, editor, send):
            headers = {"Authorization": "Bearer " + token} if token else {}
            assert client.get(path, headers=headers).status_code == 401
        headers = {"Authorization": "Bearer " + monitor}
        value = client.get(path, headers=headers).json()
        assert value == {
            "version": 2,
            "unknown_by_kind": dict.fromkeys(
                (
                    "interrupted_activities",
                    "packets",
                    "workflow_attempts",
                    "notion_entities",
                    "notion_versions",
                    "delivery",
                ),
                0,
            ),
            "unknown_revision": 0,
            "latest_delivery": None,
            "worker_healthy": True,
            "drain_state": "draining",
            "queued_count": 0,
            "inflight_count": 0,
            "unknown_count": 0,
            "build_source_sha": None,
            "release_request_id": None,
            "config_sync": None,
        }
        assert (
            client.get(
                "/internal/deployment/drain", headers=headers
            ).status_code
            == 401
        )
        assert (
            client.post("/v1/runs", headers=headers, json={}).status_code == 401
        )


def test_unconfigured_monitor_fails_closed(tmp_path):
    config = settings.Settings(
        data_dir=tmp_path, editor_token="e" * 32, send_token="s" * 32
    )
    with clients.TestClient(
        application.create_app(config, start_worker=False)
    ) as client:
        assert client.get("/internal/monitoring/status").status_code == 401


@pytest.mark.parametrize("state", ("matching", "pending", "pinned", "error"))
def test_config_observation_is_content_free_and_read_only(
    configured_monitor, monkeypatch, state
):
    client, root, active = configured_monitor
    pending = state != "matching"
    expected = {
        "active_revision": SHA,
        "active_digest": active["digest"],
        "wanted_revision": "b" * 40 if pending else SHA,
        "wanted_digest": "b" * 64 if pending else active["digest"],
        "wanted_commit": "c" * 40,
        "pinned_digest": active["digest"] if state == "pinned" else None,
        "last_attempt": 1793232000.5,
        "last_success": 1793231000,
        "error": "CONFIG_GITHUB_NETWORK_ERROR" if state == "error" else None,
    }
    report = {
        **expected,
        "repository": "synthetic-source/example",
        "prompt": "synthetic prompt MUST_NOT_APPEAR",
    }
    (root / "sync-status.json").write_text(json.dumps(report))
    if state == "pinned":
        (root / "pin.json").write_text(json.dumps({"digest": active["digest"]}))
    before = {
        path: path.read_bytes() for path in root.rglob("*") if path.is_file()
    }

    def forbidden(*args, **kwargs):
        pytest.fail("Monitoring must not sync, activate or fetch configuration")

    monkeypatch.setattr(config_sync.ConfigSync, "once", forbidden)
    monkeypatch.setattr(config_sync.GitHubSource, "resolve", forbidden)
    monkeypatch.setattr(config_sync.GitHubSource, "fetch", forbidden)
    monkeypatch.setattr(content_config, "install_snapshot", forbidden)
    response = client.get(PATH)
    value = response.json()
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert value["version"] == 2
    assert value["worker_healthy"] is True
    assert value["config_sync"] == expected
    assert "synthetic-source" not in response.text
    assert "MUST_NOT_APPEAR" not in response.text
    assert str(root) not in response.text
    assert MONITOR not in response.text
    assert {
        path: path.read_bytes() for path in root.rglob("*") if path.is_file()
    } == before


@pytest.mark.parametrize("failure", ("bad_json", "missing_active", "denied"))
def test_config_unavailable_does_not_break_business_health(
    configured_monitor, monkeypatch, caplog, failure
):
    client, root, _ = configured_monitor
    if failure == "bad_json":
        (root / "sync-status.json").write_text("synthetic invalid JSON")
    elif failure == "missing_active":
        (root / "active.json").unlink()
    else:

        def denied(self):
            raise PermissionError("synthetic private path MUST_NOT_APPEAR")

        monkeypatch.setattr(config_sync.ConfigSync, "status", denied)
    response = client.get(PATH)
    assert response.status_code == 200
    value = response.json()
    assert value["worker_healthy"] is True
    assert client.get("/healthz").status_code == 200
    child = value["config_sync"]
    assert child.pop("error") == "CONFIG_STATUS_UNAVAILABLE"
    assert set(child.values()) == {None}
    assert "MUST_NOT_APPEAR" not in response.text + caplog.text


@pytest.mark.parametrize(
    "report",
    (
        {"error": "synthetic private error MUST_NOT_APPEAR"},
        {"wanted_revision": "synthetic private content MUST_NOT_APPEAR"},
        {"last_attempt": "synthetic private time MUST_NOT_APPEAR"},
        {"last_attempt": True},
        {"last_success": float("inf")},
    ),
)
def test_malformed_config_status_cannot_expose_free_text(
    configured_monitor, report
):
    client, root, _ = configured_monitor
    (root / "sync-status.json").write_text(json.dumps(report))
    response = client.get(PATH)
    assert response.status_code == 200
    assert (
        response.json()["config_sync"]["error"] == "CONFIG_STATUS_UNAVAILABLE"
    )
    assert "MUST_NOT_APPEAR" not in response.text


def test_monitor_auth_precedes_config_read(configured_monitor, monkeypatch):
    client, _, _ = configured_monitor

    def forbidden(self):
        pytest.fail("Unauthorized requests must not read configuration")

    monkeypatch.setattr(config_sync.ConfigSync, "status", forbidden)
    assert client.get(PATH, headers={"Authorization": ""}).status_code == 401
    assert (
        client.get(
            PATH, headers={"Authorization": "Bearer " + "e" * 32}
        ).status_code
        == 401
    )
    assert client.post(PATH).status_code == 405


def test_revision_tracks_new_records_not_counts(tmp_path):
    store = storage.Store(tmp_path / "state.sqlite", "production")
    store.db.execute(
        "INSERT INTO packets(id,principal,request_key,digest,body,projection) "
        "VALUES('one','test','one','hash','{}','unknown')"
    )
    first = monitoring.snapshot(store)
    assert first["unknown_revision"] == 1
    assert first["unknown_by_kind"]["packets"] == 1
    assert monitoring.snapshot(store) == first
    store.db.execute("UPDATE packets SET projection='complete'")
    assert monitoring.snapshot(store)["unknown_revision"] == 1
    store.db.execute(
        "INSERT INTO packets(id,principal,request_key,digest,body,projection) "
        "VALUES('two','test','two','hash','{}','unknown')"
    )
    assert monitoring.snapshot(store)["unknown_revision"] == 2
    assert monitoring.snapshot(store)["unknown_by_kind"]["packets"] == 1
    assert (
        store.db.execute(
            "SELECT projection FROM packets WHERE id='two'"
        ).fetchone()[0]
        == "unknown"
    )


def test_latest_delivery_excludes_fixtures_and_has_no_content(tmp_path):
    store = storage.Store(tmp_path / "state.sqlite", "production")
    for identity, fixture, time in (
        ("live", False, "2026-10-04T10:00:00Z"),
        ("fixture", True, "2026-10-04T11:00:00Z"),
    ):
        body = json.dumps(
            {
                "delivery_state": "provider_accepted",
                "updated_at": time,
                "is_fixture": fixture,
                "draft": {"private": "must not leave"},
            }
        )
        store.db.execute(
            "INSERT INTO editions VALUES(?,?,?,'complete',?,'{}')",
            (identity, identity, "hash", body),
        )
    assert monitoring.snapshot(store)["latest_delivery"] == {
        "state": "provider_accepted",
        "time": "2026-10-04T10:00:00Z",
    }


async def test_node_timeout_does_not_reopen_unknown_monitoring(tmp_path):
    store = storage.Store(tmp_path / "state.sqlite", "production")
    before = monitoring.snapshot(store)
    repository = workflow_repository.WorkflowRepository(store)
    repository.start(
        "run",
        workflow_definition.parse_definition(
            {
                "version": 1,
                "id": "daily-newsletter",
                "nodes": [{"id": "discover", "type": "discovery"}],
            }
        ),
        {},
    )

    async def slow(context):
        raise TimeoutError()

    await workflow_engine.WorkflowEngine(repository, {"discovery": slow}).run(
        "run"
    )
    after = monitoring.snapshot(store)
    assert after["unknown_by_kind"]["workflow_attempts"] == 0
    assert after["unknown_revision"] == before["unknown_revision"]


def test_config_status_direct_missing_snapshot_fallback(tmp_path):
    assert monitoring_api.config_status(None) is None
    missing_dir = tmp_path / "uninitialized-config"
    fallback = monitoring_api.config_status(missing_dir)
    assert fallback is not None
    assert fallback["error"] == "CONFIG_STATUS_UNAVAILABLE"
    assert all(
        value is None for key, value in fallback.items() if key != "error"
    )
