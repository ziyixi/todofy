"""The console listener serves newsletter.ui.v1's bindings and nothing else."""

import subprocess
import sys

import pytest
import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb

import newsletter.console_api as console_api
import newsletter.console_read as console_read
import newsletter.settings as newsletter_settings


def test_routes_are_the_generated_bindings_under_the_prefix(tmp_path):
    reader = console_read.ConsoleReader(
        newsletter_settings.Settings(data_dir=tmp_path)
    )
    app = console_api.create_console_app(reader, None, lambda: True)
    routes = {
        (method, route.path)
        for route in app.routes
        for method in getattr(route, "methods", ())
    }
    assert routes == {
        ("GET", console_api.route_path(binding.path_template))
        for binding in service_pb.HTTP_BINDINGS
    }
    assert {path for _, path in routes} == {
        "/api/newsletter/v1/overview",
        "/api/newsletter/v1/runs",
        "/api/newsletter/v1/runs/{segment0}",
        "/api/newsletter/v1/runs/{segment0}/modelCalls",
        "/api/newsletter/v1/runs:summarizeModelUsage",
        "/api/newsletter/v1/editions",
        "/api/newsletter/v1/editions/{segment0}",
        "/api/newsletter/v1/editions/{segment0}/rendering",
        "/api/newsletter/v1/sourceCatalog",
        "/api/newsletter/v1/backupStatus",
    }
    assert app.openapi_url is None and app.docs_url is None


@pytest.mark.parametrize("template", ["/v1/runs", "/api/v2/runs"])
def test_only_api_v1_bindings_are_served(template):
    with pytest.raises(ValueError, match="binding prefix"):
        console_api.route_path(template)


def test_the_views_need_no_http_or_engine(tmp_path):
    # A fresh interpreter: the pure rules load without the engine's layers.
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import newsletter.console_views, sys; "
            "assert 'fastapi' not in sys.modules; "
            "assert 'newsletter.app' not in sys.modules; "
            "assert 'newsletter.store' not in sys.modules",
        ],
        cwd=tmp_path,
        env={"PYTHONDONTWRITEBYTECODE": "1"},
        check=True,
        timeout=15,
    )
