import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.runtime.harness import ROOT, Worker, _wrangler, mail_event

RETIRE_TASK_WRITES = "0014_retire_task_writes.sql"
# One row the code removed with 0014 would still have had to finish, for each of its guard's counts.
GUARDED = {
    "summarized": "INSERT INTO mail_events (source_id, event_id, payload_hash, state, created_at, updated_at)"
    f" VALUES ('mail-hero-personal', 'e1', '{'0' * 64}', 'summarized', 1, 1)",
    "todo_unknown": "INSERT INTO mail_events (source_id, event_id, payload_hash, state, created_at, updated_at)"
    f" VALUES ('mail-hero-personal', 'e1', '{'0' * 64}', 'todo_unknown', 1, 1)",
    "intent_pending": "INSERT INTO task_intents (source, intent_id, payload_sha256, mode, tasks_total, state,"
    f" created_at, updated_at) VALUES ('watch', 'i1', '{'0' * 64}', 'subtasks', 1, 'pending', 1, 1)",
    "intent_task_unknown": "INSERT INTO task_intent_tasks (source, intent_id, n, request_id, state, started_at,"
    f" updated_at) VALUES ('watch', 'i1', 0, '{'0' * 36}', 'unknown', 1, 1)",
}
DROPPED = {"task_intents", "task_intent_tasks", "gtd_snapshots", "gtd_snapshot_tasks"}


def test_all_migrations_are_applied(worker: Worker) -> None:
    files = sorted(path.name for path in (ROOT / "migrations").glob("*.sql"))
    if not files:
        pytest.skip("no D1 migrations in the tree yet")
    assert [row["name"] for row in worker.d1("SELECT name FROM d1_migrations ORDER BY id")] == files


def test_the_retired_tables_are_dropped_and_the_copied_ones_kept(worker: Worker) -> None:
    tables = {row["name"] for row in worker.d1("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert not tables & {"plus_connections", "plus_actions", "plus_settings", "plus_weeks"}
    assert not tables & {"plan_task_state", "plan_tasks", "plan_edges", "plan_marks", "plan_notes"}
    assert not tables & (DROPPED | {"_release_guard"})
    # What Tasks' one-time import still reads.
    assert {"plan_settings", "plan_categories", "gtd_daily", "gtd_reviews", "mail_reminders"} <= tables
    indexes = {row["name"] for row in worker.d1("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert not indexes & {"summaries_expiring", "summaries_task"} and "summaries_pending" in indexes


def test_worker_writes_land_in_the_persisted_d1_that_wrangler_reads(worker: Worker) -> None:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    rows = worker.d1(f"SELECT source_id, imported FROM mail_events WHERE event_id = '{event_id}'")
    assert rows == [{"source_id": "mail-hero-personal", "imported": 0}]


class Staged:
    """A local D1 migrated up to the migration before 0014, in its own persist directory."""

    def __init__(self, root: Path) -> None:
        self.migrations = root / "migrations"
        self.migrations.mkdir()
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            if path.name < RETIRE_TASK_WRITES:
                shutil.copy(path, self.migrations)
        self.config = root / "wrangler.json"
        database = {"binding": "DB", "database_name": "guard", "database_id": "00000000-0000-4000-8000-0000000000bb"}
        database["migrations_dir"] = str(self.migrations)
        self.config.write_text(json.dumps({"name": "todofy-guard", "main": "x.js", "d1_databases": [database]}))
        self.state = str(root / "state")
        self.apply()

    def apply(self) -> None:
        _wrangler(
            "d1", "migrations", "apply", "DB", "--local", "--persist-to", self.state, "--config", str(self.config)
        )

    def sql(self, sql: str) -> list[dict[str, object]]:
        args = ("d1", "execute", "DB", "--local", "--persist-to", self.state, "--config", str(self.config))
        return json.loads(_wrangler(*args, "--json", "--command", sql).stdout)[-1]["results"]

    def tables(self) -> set[str]:
        return {str(row["name"]) for row in self.sql("SELECT name FROM sqlite_master WHERE type = 'table'")}


@pytest.mark.parametrize("row", GUARDED.values(), ids=GUARDED.keys())
def test_a_row_the_removed_task_writes_still_had_to_finish_stops_0014(tmp_path: Path, row: str) -> None:
    staged = Staged(tmp_path)
    staged.sql(row)
    shutil.copy(ROOT / "migrations" / RETIRE_TASK_WRITES, staged.migrations)
    with pytest.raises(subprocess.CalledProcessError):
        staged.apply()
    assert staged.tables() >= DROPPED
    assert RETIRE_TASK_WRITES not in {str(row["name"]) for row in staged.sql("SELECT name FROM d1_migrations")}
    # Settled (the owner's event page, or the intent's end), the same migration then applies.
    staged.sql(
        "UPDATE mail_events SET state = 'ignored';"
        " UPDATE task_intents SET state = 'failed'; UPDATE task_intent_tasks SET state = 'failed'"
    )
    staged.apply()
    assert not staged.tables() & (DROPPED | {"_release_guard"})


def test_0014_applies_cleanly_over_finished_rows(tmp_path: Path) -> None:
    staged = Staged(tmp_path)
    staged.sql(GUARDED["summarized"].replace("'summarized'", "'complete'"))
    staged.sql(GUARDED["intent_pending"].replace("'pending'", "'failed'"))
    shutil.copy(ROOT / "migrations" / RETIRE_TASK_WRITES, staged.migrations)
    staged.apply()
    assert not staged.tables() & (DROPPED | {"_release_guard"})
    assert staged.sql("SELECT state FROM mail_events") == [{"state": "complete"}]
