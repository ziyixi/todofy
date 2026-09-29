"""Stage and start the reports probe Worker (see entry.py) under real workerd."""

import shutil
from collections.abc import Iterator
from pathlib import Path

from tests.runtime.harness import ROOT, Worker, start_worker

# Same runtime as the shipped core; D1 with the real migrations. No assets, cron or
# Durable Object: the probe passes its own budget to the modules as the coordinator.
CONFIG = """\
name = "todofy-reports-probe"
main = "entry.py"
compatibility_date = "2026-09-08"
compatibility_flags = ["python_workers"]
workers_dev = false
preview_urls = false

[[d1_databases]]
binding = "DB"
database_name = "todofy"
database_id = "00000000-0000-4000-8000-000000000000"
migrations_dir = "{migrations}"
"""


def start_probe(state: Path, variables: dict[str, str]) -> Iterator[Worker]:
    stage = state / "probe"
    shutil.copytree(ROOT / "worker" / "todofy", stage / "todofy", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(Path(__file__).with_name("entry.py"), stage / "entry.py")
    # wrangler bundles python_modules next to the config; `pywrangler dev` (re)creates it in ROOT.
    (stage / "python_modules").symlink_to(ROOT / "python_modules", target_is_directory=True)
    config = stage / "wrangler.toml"
    config.write_text(CONFIG.format(migrations=ROOT / "migrations"))
    yield from start_worker(str(config), state, variables)
