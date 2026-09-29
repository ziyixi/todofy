"""snapshot.py keeps committed rows that are still only in the WAL; copying the main file loses them."""

import json
import shutil
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

import pytest
import snapshot
from fixtures import synthetic

# Commits a change in WAL mode and exits without a checkpoint, like the Go binary on `docker compose stop`.
UNCHECKPOINTED = """
import os, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA wal_autocheckpoint=0")
db.execute("DELETE FROM mail_inbox_reminders WHERE day = '2026-09-20'")
db.commit()
os._exit(0)
"""


@pytest.fixture
def live(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "live"
    source.mkdir()
    synthetic.build(source)
    inbox = source / "inbox.sqlite"
    subprocess.run([sys.executable, "-c", UNCHECKPOINTED, str(inbox)], check=True)
    assert Path(f"{inbox}-wal").stat().st_size > 0
    return inbox, source / "todofy.db"


def reminders(path: Path) -> int:
    return sqlite3.connect(path).execute("SELECT count(*) FROM mail_inbox_reminders").fetchone()[0]


def test_the_snapshot_keeps_rows_that_only_the_wal_holds(live: tuple[Path, Path], tmp_path: Path, capsys) -> None:
    inbox, legacy = live
    naive = tmp_path / "naive.sqlite"
    shutil.copyfile(inbox, naive)
    assert reminders(naive) == 3  # the plain copy still has the deleted row: it misses the WAL

    out = tmp_path / "snap"
    assert snapshot.main(["--inbox", str(inbox), "--legacy", str(legacy), "--out", str(out)]) == 0
    copy = out / "inbox.sqlite"
    assert reminders(copy) == 2
    assert stat.S_IMODE(copy.stat().st_mode) == 0o600
    # Rollback-journal mode, so the export's ?mode=ro open works on every SQLite build.
    assert sqlite3.connect(copy).execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    report = json.loads(capsys.readouterr().out)
    assert report["inbox.sqlite"]["mail_inbox_reminders"] == 2
    assert report["inbox.sqlite"]["state_counts"] == {"complete": 39, "ignored": 1}
    assert report["todofy.db"]["database_entries"] > 0


def test_the_snapshot_refuses_a_non_empty_directory(live: tuple[Path, Path], tmp_path: Path) -> None:
    inbox, legacy = live
    out = tmp_path / "snap"
    out.mkdir()
    (out / "old").write_text("x")
    assert snapshot.main(["--inbox", str(inbox), "--legacy", str(legacy), "--out", str(out)]) == 2
