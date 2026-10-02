"""Small import boundaries that keep offline tools independent of the server."""

import subprocess
import sys

import pytest

import newsletter.app as app
import newsletter.rendering as rendering


@pytest.mark.parametrize(
    ("module", "unneeded"),
    [
        ("cli", "app"),
        ("charts", "rendering"),
        ("model_io", "editor"),
        ("model_schema", "editor"),
    ],
)
def test_import_does_not_load_higher_layer(module, unneeded, tmp_path):
    # A fresh interpreter avoids depending on pytest's module import order.
    subprocess.run(
        [
            sys.executable,
            "-c",
            f"import newsletter.{module}; import sys; "
            f"assert 'newsletter.{unneeded}' not in sys.modules; "
            "assert 'newsletter.app' not in sys.modules",
        ],
        cwd=tmp_path,
        env={"PYTHONDONTWRITEBYTECODE": "1"},
        check=True,
        timeout=15,
    )


def test_app_does_not_reexport_renderer_helpers():
    assert not hasattr(app, "preview_html")


@pytest.mark.parametrize("chart_png", ["abc", ""])
def test_preview_does_not_mutate_frozen_email(chart_png):
    frozen = {
        "html": '<p>cid:newsletter-chart</p><img src="cid:newsletter-chart">',
        "chart_png": chart_png,
        "render_hash": "unchanged",
    }
    original = frozen.copy()
    assert rendering.preview_html(frozen) == (
        '<p>cid:newsletter-chart</p><img src="data:image/png;base64,'
        + chart_png
        + '">'
    )
    assert frozen == original


def test_preview_without_chart_is_unchanged():
    assert (
        rendering.preview_html({"html": "<p>No chart</p>"}) == "<p>No chart</p>"
    )
