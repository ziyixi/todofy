"""Four proto business operations and bounded private deployment controls."""

import fastapi.testclient as testclient
import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.app as app
import newsletter.settings as settings

_RUN_ID = "00000000-0000-4000-8000-000000000000"
_OPERATIONS = {
    ("POST", "/v1/runs"): "StartRun",
    ("GET", "/v1/runs/{run_id}"): "GetRun",
    ("GET", "/v1/editions/{edition_id}"): "GetEdition",
    ("POST", "/v1/editions/{edition_id}/send"): "SendEdition",
}


def test_http_surface_matches_shared_proto(tmp_path):
    application = app.create_app(
        settings.Settings(
            data_dir=tmp_path,
            editor_token="e" * 32,
            send_token="s" * 32,
        ),
        start_worker=False,
    )
    paths = application.openapi()["paths"]
    methods = {
        (method.upper(), path)
        for path, operations in paths.items()
        for method in operations
    }
    assert methods == set(_OPERATIONS) | {
        ("GET", "/healthz"),
        ("GET", "/v1/editions/{edition_id}/preview"),
        ("GET", "/internal/deployment/drain"),
        ("POST", "/internal/deployment/drain/{action}"),
        ("GET", "/internal/monitoring/status"),
    }
    service = editorial_pb2.DESCRIPTOR.services_by_name["NewsletterService"]
    assert {method.name for method in service.methods} == set(
        _OPERATIONS.values()
    )


@pytest.mark.parametrize("role", ["editor", "send"])
def test_retired_routes_have_no_authenticated_alias(tmp_path, role):
    config = settings.Settings(
        data_dir=tmp_path,
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    headers = {"Authorization": "Bearer " + getattr(config, role + "_token")}
    with testclient.TestClient(
        app.create_app(config, start_worker=False)
    ) as client:
        for method, path in (
            ("POST", "/v1/packets"),
            ("POST", "/v1/inbox/query"),
            ("POST", "/v1/editions"),
            ("POST", "/v1/render"),
            ("POST", f"/v1/runs/{_RUN_ID}/retry-stories"),
            ("POST", f"/v1/editions/{_RUN_ID}/send-verification"),
        ):
            response = client.request(method, path, headers=headers)
            assert response.status_code == 404
        assert not list((tmp_path / "outbox").glob("*.eml"))


@pytest.mark.parametrize("role", ["editor", "send"])
@pytest.mark.parametrize(
    "method,path,allowed,validated_status",
    [
        ("POST", "/v1/runs", {"editor"}, 400),
        ("GET", f"/v1/runs/{_RUN_ID}", {"editor"}, 404),
        ("GET", f"/v1/editions/{_RUN_ID}", {"editor", "send"}, 404),
        ("POST", f"/v1/editions/{_RUN_ID}/send", {"send"}, 400),
    ],
)
def test_editor_and_send_permissions(
    tmp_path, role, method, path, allowed, validated_status
):
    config = settings.Settings(
        data_dir=tmp_path,
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    headers = {"Authorization": "Bearer " + getattr(config, role + "_token")}
    with testclient.TestClient(
        app.create_app(config, start_worker=False)
    ) as client:
        response = client.request(method, path, headers=headers, json={})
    assert response.status_code == (
        validated_status if role in allowed else 401
    )
