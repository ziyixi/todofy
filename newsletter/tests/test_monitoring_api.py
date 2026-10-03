"""Read-only telemetry cannot acquire editor or send capabilities."""

import fastapi.testclient as clients

import newsletter.app as application
import newsletter.settings as settings


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
            "version": 1,
            "worker_healthy": True,
            "drain_state": "draining",
            "queued_count": 0,
            "inflight_count": 0,
            "unknown_count": 0,
            "build_source_sha": None,
            "release_request_id": None,
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
