"""The test configs must exercise the same two-Worker shape that ships."""

import tomllib
from pathlib import Path
from typing import Any

import pytest

from tests.runtime.harness import CORE_CONFIG, GATEWAY_AUTH_CONFIG, GATEWAY_CONFIG, ROOT


def _load(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text())


CORE = _load(ROOT / "wrangler.toml")
GATEWAY = _load(ROOT / "gateway" / "wrangler.toml")
CORE_SHAPE = ("main", "base_dir", "compatibility_date", "compatibility_flags", "d1_databases", "migrations")
GATEWAY_SHAPE = ("main", "compatibility_date", "assets", "durable_objects", "migrations", "triggers")


def test_core_test_config_matches_the_shipped_core() -> None:
    config = _load(CORE_CONFIG)
    assert config["name"] == CORE["name"] == "todofy-core"
    for key in CORE_SHAPE:
        assert config[key] == CORE[key], key
    for key in ("assets", "durable_objects", "triggers", "routes"):
        assert key not in config and key not in CORE, key
    assert config["vars"]["TODOFY_PUBLIC_HOST"].endswith(".localhost")


@pytest.mark.parametrize("name", [GATEWAY_CONFIG, GATEWAY_AUTH_CONFIG])
def test_gateway_test_configs_match_the_shipped_gateway(name: str) -> None:
    config = _load(ROOT / name)
    for key in GATEWAY_SHAPE:
        assert config[key] == GATEWAY[key], key
    assert "d1_databases" not in config and "d1_databases" not in GATEWAY
    assert config["vars"]["TODOFY_PUBLIC_HOST"].endswith(".localhost")


def test_dev_switches_never_appear_in_the_shipped_configs() -> None:
    for shipped in (CORE, GATEWAY):
        assert not [name for name in shipped["vars"] if name.startswith("DEV_")]
        assert shipped["workers_dev"] is False and shipped["preview_urls"] is False


def test_shipped_core_pins_python_314() -> None:
    # pywrangler maps compatibility_date >= 2026-09-08 to Python 3.14 and reads only the root wrangler.toml.
    assert CORE["compatibility_date"] == "2026-09-08"
    assert CORE["compatibility_flags"] == ["python_workers"]


def test_shipped_gateway_sends_every_request_through_the_worker_and_binds_the_core() -> None:
    assert GATEWAY["name"] == "todofy"
    assert GATEWAY["assets"]["run_worker_first"] is True
    assert GATEWAY["assets"]["not_found_handling"] == "single-page-application"
    [binding] = GATEWAY["durable_objects"]["bindings"]
    assert binding == {"name": "COORDINATOR", "class_name": "TodofyCore", "script_name": CORE["name"]}
    # The core owns the class now; the gateway's history keeps v1 and deletes it in v2.
    assert GATEWAY["migrations"] == [
        {"tag": "v1", "new_sqlite_classes": ["TodofyCoordinator"]},
        {"tag": "v2", "deleted_classes": ["TodofyCoordinator"]},
    ]
    assert CORE["migrations"] == [
        {"tag": "v1", "new_sqlite_classes": ["TodofyCoordinator"]},
        {"tag": "v2", "renamed_classes": [{"from": "TodofyCoordinator", "to": "TodofyCore"}]},
    ]
