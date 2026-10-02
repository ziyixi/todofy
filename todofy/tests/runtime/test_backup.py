"""The weekly D1 -> R2 backup on real workerd, D1, R2 and alarms, restored into a second local D1.

The shared runtime-test config has no BACKUPS binding (a backup would pause the ledger
under other scenarios), so this module starts its own server with the bucket and a
one-statement query budget: the job then spans many alarm invocations and parts.
"""

import json
import os
import re
import subprocess
import sys
import time
import tomllib
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tests.runtime.harness import (
    CORE_CONFIG,
    CSRF_SIGNING_KEY,
    GATEWAY_CONFIG,
    ROOT,
    WRANGLER,
    Worker,
    _run,
    reason,
    wait_until,
)
from todofy.core.sql import backup as sql

BUCKET = "todofy-backups"
TOOL = ROOT / "tools" / "backup_restore.py"
EVENTS, TRANSITIONS, LEGACY_TEXTS = 30, 1100, 4
# Seeded prefixes: six complete ones and an incomplete one, all older than the jobs' own.
OLD_COMPLETE = [f"backups/2020-0{month}-05/" for month in range(1, 7)]
OLD_INCOMPLETE = "backups/2020-01-12/"


@pytest.fixture(scope="module")
def backup_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    config = tomllib.loads(CORE_CONFIG.read_text())
    config["r2_buckets"] = [{"binding": "BACKUPS", "bucket_name": BUCKET}]
    config["vars"]["BACKUP_QUERY_BUDGET"] = "1"
    generated = ROOT / f"wrangler.test-run-{uuid.uuid4().hex}.json"
    generated.write_text(json.dumps(config))
    worker = Worker(
        [GATEWAY_CONFIG, generated.name],
        generated.name,
        tmp_path_factory.mktemp("backup-worker"),
        {"CSRF_SIGNING_KEY": CSRF_SIGNING_KEY},
    )
    try:
        yield from _run(worker)
    finally:
        generated.unlink(missing_ok=True)


def wrangler(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(WRANGLER), *args],
        cwd=ROOT,
        env=os.environ | {"CI": "true", "WRANGLER_SEND_METRICS": "false"},
        capture_output=True,
        text=True,
        timeout=120,
    )


def local(worker: Worker, persist_to: Path | None = None) -> list[str]:
    return ["--local", "--persist-to", str(persist_to or worker.persist_to)]


def r2_put(worker: Worker, key: str, path: Path) -> None:
    put = wrangler("r2", "object", "put", f"{BUCKET}/{key}", "--file", str(path), *local(worker))
    assert put.returncode == 0, put.stderr[-2000:]


def r2_exists(worker: Worker, key: str, tmp_path: Path) -> bool:
    return (
        wrangler("r2", "object", "get", f"{BUCKET}/{key}", "--file", str(tmp_path / "probe"), *local(worker)).returncode
        == 0
    )


def restore_tool(*args: str) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(TOOL), *args]
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)


def seed(worker: Worker, now: int) -> None:
    worker.d1(
        # Events: every sixth one still active with its payload (one of ~150 KB), the rest complete.
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)"
        " INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, summary, todo_body,"
        " created_at, updated_at)"
        " SELECT 'mail-hero-personal', printf('00000000-0000-4000-8000-%012d', i), printf('%064d', i),"
        " CASE WHEN i = 6 THEN '{\"x\":\"' || replace(hex(zeroblob(50000)), '00', '正文') || '\"}'"
        "  WHEN i % 6 = 0 THEN '{\"n\":' || i || '}' END,"
        " CASE WHEN i % 6 = 0 THEN 'failed_summary' ELSE 'complete' END,"
        f" '摘要 ' || i, 'body', {now} - i, {now} FROM n;"
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100)"
        " INSERT INTO event_transitions (event_id, at, from_state, to_state, actor)"
        f" SELECT printf('00000000-0000-4000-8000-%012d', i % 30 + 1), {now} - i, NULL, 'pending', 'worker' FROM n;"
        "INSERT INTO mail_reminders (day, state, attention_count, created_at, updated_at)"
        f" VALUES ('2026-09-01', 'created', 2, {now}, {now});"
        "INSERT INTO summaries (event_id, created_at, subject, summary, model)"
        f" VALUES ('00000000-0000-4000-8000-000000000001', {now}, '主题', 'it''s 摘要', 'm');"
        "INSERT INTO daily_reports (kind, top_n, day, status, payload_json, task_count, window_start, window_end,"
        f" computed_at) VALUES ('summary', 0, '2026-09-28', 'ok', '{{}}', 1, 0, 0, {now});"
        "INSERT INTO owner_actions (owner, action_request_id, kind, request_hash, created_at)"
        f" VALUES ('owner@example.com', 'a1', 'recompute', 'h', {now});"
        "INSERT INTO auth_failures (hour, count) VALUES ('2099-01-01T00', 1);"
        "INSERT INTO daily_metrics (day, key, value) VALUES ('2026-09-27', 'mails_received', 3);"
        # Legacy text: one of ~300 KB (with a NUL), three short ones.
        "INSERT INTO legacy_mail_text (event_id, created_at, text) VALUES"
        " ('legacy:big', 1, replace(hex(zeroblob(50000)), '00', '旧文' || char(0) || 'x')),"
        " ('legacy:a', 2, 'a'), ('legacy:b', 3, 'b'), ('legacy:c', 4, 'c')"
    )


def seed_old_backups(worker: Worker, tmp_path: Path) -> None:
    marker = tmp_path / "marker.json"
    marker.write_text("{}")
    for prefix in OLD_COMPLETE:
        r2_put(worker, prefix + "manifest.json", marker)
        r2_put(worker, prefix + "events/00001.ndjson.gz", marker)
    r2_put(worker, OLD_INCOMPLETE + "events/00001.ndjson.gz", marker)


def backup_status(worker: Worker) -> dict[str, Any]:
    return worker.overview()["backup"]


def wait_for_backup(worker: Worker) -> dict[str, Any]:
    def finished() -> dict[str, Any] | None:
        status = backup_status(worker)
        return status if status["state"] in ("ok", "failed") else None

    status = wait_until(finished, 120, "backup")
    assert status["state"] == "ok", status
    return status


def dump(worker: Worker, persist_to: Path) -> dict[str, list[dict[str, Any]]]:
    """Every backed-up table in key order, read with one `d1 execute` (one result per statement)."""
    tables = list(sql.TABLES.values())
    statements = [
        f"SELECT {', '.join(table.columns)} FROM {table.name} ORDER BY {', '.join(table.key)};" for table in tables
    ]
    result = wrangler(
        "d1",
        "execute",
        "DB",
        *local(worker, persist_to),
        "--config",
        worker.d1_config,
        "--json",
        "--command",
        " ".join(statements),
    )
    assert result.returncode == 0, result.stderr[-2000:]
    results = json.loads(result.stdout)
    assert len(results) == len(tables), [entry.get("meta") for entry in results]
    return {table.name: entry["results"] for table, entry in zip(tables, results, strict=True)}


def next_sunday_ten(now: datetime) -> str:
    """After a backup: the next Sunday 10:00 UTC on a later day (a Sunday's own slot is skipped)."""
    at = (now + timedelta(days=(6 - now.weekday()) % 7 or 7)).replace(hour=10, minute=0, second=0, microsecond=0)
    return at.strftime("%Y-%m-%dT%H:%M:%SZ")


def download(worker: Worker, prefix: str, out: Path) -> str:
    result = restore_tool(
        "download", "--backup", prefix, "--out", str(out), *local(worker), "--wrangler", str(WRANGLER)
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


@pytest.mark.reaches("UNAVAILABLE")
def test_weekly_backup_restores_into_an_empty_database(backup_worker: Worker, tmp_path: Path) -> None:
    worker, now = backup_worker, int(time.time())
    today = datetime.now(UTC)
    # The object has not run yet (the harness waits on the gateway's /health only).
    seed(worker, now)
    seed_old_backups(worker, tmp_path)

    # The first alarm finds the backup due (new object storage) and holds owner writes while it runs.
    assert worker.trigger_cron().status_code == 200
    wait_until(lambda: backup_status(worker)["state"] == "running" or None, 30, "backup start")
    held = worker.post_owner("/api/v1/latestReports:recompute", {"kind": "summary", "request_id": str(uuid.uuid4())})
    assert (held.status_code, reason(held)) == (503, "UNAVAILABLE")

    status = wait_for_backup(worker)
    prefix = status["last_backup_key"]
    assert re.fullmatch(rf"backups/{today:%Y-%m-%d}T\d{{6}}Z/", prefix), prefix  # the job's start second
    rows = EVENTS + TRANSITIONS + 1 + 1 + 1 + 1 + 1 + 1 + LEGACY_TEXTS
    assert status | {"last_backup_time": None, "last_backup_size_bytes": 0} == {
        "state": "ok",
        "last_backup_time": None,
        "last_backup_key": prefix,
        "last_backup_size_bytes": 0,
        "last_backup_row_count": rows,
        "last_failure_time": None,
        "last_error_code": None,
        "next_backup_time": next_sunday_ten(today),
    }
    assert status["last_backup_size_bytes"] > 0

    # Retention: today's and the five newest complete old ones stay; the oldest and the incomplete one go.
    for kept in OLD_COMPLETE[1:]:
        assert r2_exists(worker, kept + "manifest.json", tmp_path), kept
    assert not r2_exists(worker, OLD_COMPLETE[0] + "manifest.json", tmp_path)
    assert not r2_exists(worker, OLD_INCOMPLETE + "events/00001.ndjson.gz", tmp_path)

    # Download (checks every part), write SQL, load it into a second empty local D1, verify, compare.
    out, target = tmp_path / "restore", tmp_path / "target"
    downloaded = download(worker, prefix, out)
    assert "PASS event_transitions rows=1100 parts=" in downloaded
    assert f"PASS legacy_mail_text rows={LEGACY_TEXTS} parts=" in downloaded
    parts = json.loads((out / "manifest.json").read_text())["tables"][1]["parts"]
    assert len(parts) >= 3  # one page (one statement) per invocation
    written = restore_tool("sql", "--in", str(out), "--out", str(out / "restore.sql"))
    assert written.returncode == 0, written.stdout + written.stderr
    target_flags = [*local(worker, target), "--config", worker.d1_config]
    applied = wrangler("d1", "migrations", "apply", "DB", *target_flags)
    assert applied.returncode == 0, applied.stderr[-2000:]
    loaded = wrangler("d1", "execute", "DB", *target_flags, "--file", str(out / "restore.sql"))
    assert loaded.returncode == 0, loaded.stderr[-2000:]
    verified = restore_tool("verify", "--in", str(out), *target_flags, "--wrangler", str(WRANGLER))
    assert verified.returncode == 0, verified.stdout + verified.stderr
    assert verified.stdout.splitlines()[-1] == "verify PASS"
    source = dump(worker, worker.persist_to)
    assert dump(worker, target) == source
    assert len(source["legacy_mail_text"]) == LEGACY_TEXTS

    # A second job on the same day (here: the object lost its state) writes a new prefix and leaves
    # the complete one alone, byte for byte. It copies the legacy text afresh, so a row that retention
    # deleted is in no newer backup.
    first_manifest = (out / "manifest.json").read_bytes()
    worker.d1("DELETE FROM legacy_mail_text WHERE event_id = 'legacy:a'")
    worker.crash_and_restart(lose_object_storage=True)
    assert worker.trigger_cron().status_code == 200
    again = wait_for_backup(worker)
    assert again["last_backup_key"] > prefix
    assert again["last_backup_row_count"] == rows - 1
    assert f"PASS legacy_mail_text rows={LEGACY_TEXTS} " in download(worker, prefix, tmp_path / "first")
    assert (tmp_path / "first" / "manifest.json").read_bytes() == first_manifest
    assert f"PASS legacy_mail_text rows={LEGACY_TEXTS - 1} " in download(
        worker, again["last_backup_key"], tmp_path / "second"
    )
    # Seven complete backups now: the oldest seeded one that was kept above goes.
    assert not r2_exists(worker, OLD_COMPLETE[1] + "manifest.json", tmp_path)
    for kept in OLD_COMPLETE[2:]:
        assert r2_exists(worker, kept + "manifest.json", tmp_path), kept
