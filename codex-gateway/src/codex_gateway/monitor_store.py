"""Persist UTC-day inference totals and eight content-free completion samples."""

import pathlib
import sqlite3
from contextlib import closing

from ziyixi_proto.codex.monitor.v1.monitor_pb import (
    InferenceDailyUsage,
    InferenceRequestSample,
)


class MonitorStore:
    def __init__(self, path: pathlib.Path, started_at: str):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
        with closing(self.connect()) as database, database:
            database.execute("""
                CREATE TABLE IF NOT EXISTS monitor_history (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    history_since TEXT NOT NULL
                )
            """)
            database.execute(
                "INSERT OR IGNORE INTO monitor_history VALUES (1, ?)", (started_at,)
            )
            database.execute("""
                CREATE TABLE IF NOT EXISTS daily_usage (
                    day TEXT PRIMARY KEY,
                    request_count INTEGER NOT NULL,
                    success_count INTEGER NOT NULL,
                    failure_count INTEGER NOT NULL,
                    usage_reported_count INTEGER NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    total_duration_ms REAL NOT NULL
                )
            """)
            database.execute("""
                CREATE TABLE IF NOT EXISTS recent_requests (
                    id INTEGER PRIMARY KEY,
                    sequence INTEGER NOT NULL,
                    completed_at TEXT NOT NULL,
                    model TEXT NOT NULL,
                    effort TEXT NOT NULL,
                    duration_ms REAL NOT NULL,
                    error_code TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    usage_available INTEGER NOT NULL
                )
            """)

    def connect(self) -> sqlite3.Connection:
        database = sqlite3.connect(self.path, timeout=5)
        database.row_factory = sqlite3.Row
        return database

    def record(self, sample: InferenceRequestSample) -> None:
        failed = bool(sample.error_code)
        with closing(self.connect()) as database, database:
            database.execute(
                """
                INSERT INTO daily_usage VALUES (?, 1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(day) DO UPDATE SET
                    request_count = request_count + 1,
                    success_count = success_count + excluded.success_count,
                    failure_count = failure_count + excluded.failure_count,
                    usage_reported_count = usage_reported_count + excluded.usage_reported_count,
                    input_tokens = input_tokens + excluded.input_tokens,
                    output_tokens = output_tokens + excluded.output_tokens,
                    total_duration_ms = total_duration_ms + excluded.total_duration_ms
                """,
                (
                    sample.completed_at[:10],
                    not failed,
                    failed,
                    sample.usage_available,
                    sample.input_tokens,
                    sample.output_tokens,
                    sample.duration_ms,
                ),
            )
            database.execute(
                """
                INSERT INTO recent_requests (
                    sequence, completed_at, model, effort, duration_ms,
                    error_code, input_tokens, output_tokens, usage_available
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sample.sequence,
                    sample.completed_at,
                    sample.model,
                    sample.effort,
                    sample.duration_ms,
                    sample.error_code,
                    sample.input_tokens,
                    sample.output_tokens,
                    sample.usage_available,
                ),
            )
            database.execute("""
                DELETE FROM recent_requests WHERE id NOT IN (
                    SELECT id FROM recent_requests ORDER BY id DESC LIMIT 8
                )
            """)

    def snapshot(
        self,
    ) -> tuple[
        str, tuple[InferenceDailyUsage, ...], tuple[InferenceRequestSample, ...]
    ]:
        with closing(self.connect()) as database, database:
            database.execute("BEGIN")
            history_since = database.execute(
                "SELECT history_since FROM monitor_history WHERE id = 1"
            ).fetchone()[0]
            daily = tuple(
                InferenceDailyUsage(**dict(row))
                for row in database.execute(
                    "SELECT * FROM daily_usage ORDER BY day DESC LIMIT 30"
                )
            )
            recent = []
            for row in database.execute(
                "SELECT * FROM recent_requests ORDER BY id DESC LIMIT 8"
            ):
                values = dict(row)
                del values["id"]
                values["usage_available"] = bool(values["usage_available"])
                recent.append(InferenceRequestSample(**values))
        return history_since, daily, tuple(recent)
