"""The test configs must exercise the same Worker shape that ships."""

import tomllib

import pytest

from tests.runtime.harness import ROOT

SHIPPED = tomllib.loads((ROOT / "wrangler.toml").read_text())
TEST_CONFIGS = ["wrangler.test.toml", "wrangler.test-auth.toml"]


@pytest.mark.parametrize("name", TEST_CONFIGS)
def test_test_config_matches_the_shipped_worker_shape(name: str) -> None:
    config = tomllib.loads((ROOT / name).read_text())
    for key in (
        "main",
        "base_dir",
        "compatibility_date",
        "compatibility_flags",
        "assets",
        "d1_databases",
        "durable_objects",
        "migrations",
        "triggers",
    ):
        assert config[key] == SHIPPED[key], key
    assert config["vars"]["TODOFY_PUBLIC_HOST"].endswith(".localhost")


def test_dev_switches_never_appear_in_the_shipped_config() -> None:
    assert not [name for name in SHIPPED["vars"] if name.startswith("DEV_")]
    assert SHIPPED["workers_dev"] is False and SHIPPED["preview_urls"] is False


def test_shipped_config_pins_python_314_and_sends_every_request_through_the_worker() -> None:
    # pywrangler maps compatibility_date >= 2026-09-08 to Python 3.14 and reads only wrangler.toml.
    assert SHIPPED["compatibility_date"] == "2026-09-08"
    assert SHIPPED["compatibility_flags"] == ["python_workers"]
    assert SHIPPED["assets"]["run_worker_first"] is True
    assert SHIPPED["assets"]["not_found_handling"] == "single-page-application"
