"""End to end on a throwaway local D1: synthetic sources -> export -> wrangler import -> verify_d1 PASS."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
from fixtures import synthetic

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
WRANGLER = ROOT / "node_modules" / ".bin" / "wrangler"
CONFIG = "wrangler.test.toml"
ENV = {**os.environ, "CI": "true", "WRANGLER_SEND_METRICS": "false"}

pytestmark = pytest.mark.skipif(not WRANGLER.exists(), reason="run `npm ci` first")


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=180)


def test_local_d1_round_trip(tmp_path: Path) -> None:
    synthetic.build(tmp_path)
    out, persist = tmp_path / "out", str(tmp_path / "d1")
    exported = run(
        sys.executable,
        str(HERE / "legacy_to_d1.py"),
        "--inbox",
        str(tmp_path / "inbox.sqlite"),
        "--legacy",
        str(tmp_path / "todofy.db"),
        "--out",
        str(out),
        "--include-cloudmailin",
    )
    assert exported.returncode == 0, exported.stderr
    local = ("--local", "--persist-to", persist, "--config", CONFIG)
    applied = run(str(WRANGLER), "d1", "migrations", "apply", "DB", *local)
    assert applied.returncode == 0, applied.stderr
    files = sorted(path.name for path in out.glob("*.sql"))
    assert files == ["01-ledger.sql", "02-reminders.sql", "03-summaries.sql", "04-legacy-text.sql"]
    # Twice: the second pass must change nothing.
    for name in files + files:
        executed = run(str(WRANGLER), "d1", "execute", "DB", *local, "--file", str(out / name))
        assert executed.returncode == 0, f"{name}: {executed.stderr[-2000:]}"
    verified = run(
        sys.executable,
        str(HERE / "verify_d1.py"),
        "--manifest",
        str(out / "manifest.json"),
        "--db",
        "DB",
        *local,
        "--wrangler",
        shlex.quote(str(WRANGLER)),
    )
    assert verified.returncode == 0, verified.stdout + verified.stderr
    assert verified.stdout.splitlines() == [
        "PASS mail_events rows=40",
        'PASS mail_events state_counts {"complete": 39, "ignored": 1}',
        "PASS mail_reminders rows=3",
        "PASS summaries rows=47",
        "PASS legacy_mail_text rows=46",
        "verify PASS",
    ]
