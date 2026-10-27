"""Persistent Home telemetry reads slim final results without a legacy inference bridge."""

import asyncio
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from ziyixi_proto.codex.monitor.v1.monitor_pb import InferenceStatus
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    Generation,
    ModelError,
    Usage,
)
from ziyixi_proto.wire_json import from_wire, to_wire

from codex_gateway.monitoring import InferenceMonitor
from codex_gateway.runtime import MODEL

START = datetime(2026, 10, 28, 12, tzinfo=UTC)


class Clock:
    seconds = 0.0

    def now(self):
        return START + timedelta(seconds=self.seconds)

    def monotonic(self):
        return self.seconds


class MonitoringTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = pathlib.Path(self.temp.name) / "monitor.sqlite3"
        self.clock = Clock()

    def monitor(self):
        return InferenceMonitor(
            self.database, clock=self.clock.now, monotonic=self.clock.monotonic
        )

    async def test_success_failure_unknown_usage_and_safe_persisted_metadata(self):
        monitor = self.monitor()
        answers = iter(
            [
                Generation(
                    model=MODEL,
                    output="Synthetic private output",
                    usage=Usage(available=True, input_tokens=101, output_tokens=23),
                ),
                Generation(
                    error=ModelError(code=8, message="Synthetic private error"),
                    usage=Usage(available=True, input_tokens=5, output_tokens=2),
                ),
                Generation(
                    error=ModelError(code=99, reason="Synthetic private reason")
                ),
            ]
        )

        async def run():
            self.clock.seconds += 0.5
            return next(answers)

        for _ in range(3):
            await monitor.run(run)
        snapshot = monitor.snapshot()
        from_wire(InferenceStatus, to_wire(snapshot), strict=True)
        self.assertEqual(
            (snapshot.request_count, snapshot.success_count, snapshot.failure_count),
            (3, 1, 2),
        )
        self.assertEqual(
            (
                snapshot.input_tokens,
                snapshot.output_tokens,
                snapshot.usage_reported_count,
            ),
            (106, 25, 2),
        )
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual(snapshot.last_error_code, "codex_unavailable")
        self.assertEqual(snapshot.average_duration_ms, 500)
        self.assertEqual(
            [sample.sequence for sample in snapshot.recent_requests], [3, 2, 1]
        )
        self.assertEqual(snapshot.recent_requests[0].requested_effort, "default")
        self.assertFalse(snapshot.recent_requests[0].usage_available)
        self.assertNotIn("Synthetic private", str(to_wire(snapshot)))
        day = snapshot.daily_usage[0]
        self.assertEqual(
            (day.request_count, day.success_count, day.failure_count), (3, 1, 2)
        )
        self.assertEqual(day.usage_reported_count, 2)

    async def test_active_calls_and_cancellation_release_counters(self):
        monitor = self.monitor()
        started = asyncio.Event()

        async def run():
            started.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(monitor.run(run))
        await started.wait()
        self.assertEqual(monitor.snapshot().active_count, 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual(snapshot.failure_count, 1)
        self.assertEqual(snapshot.last_error_code, "codex_cancelled")

    async def test_samples_days_and_actual_effort_survive_restart(self):
        monitor = self.monitor()

        async def run():
            self.clock.seconds += 86_400
            return Generation(
                usage=Usage(available=True, input_tokens=10, output_tokens=2)
            )

        for _ in range(35):
            await monitor.run(run, effort="max")
        before = monitor.snapshot()
        after = self.monitor().snapshot()
        self.assertEqual(len(before.daily_usage), 30)
        self.assertEqual(len(before.recent_requests), 8)
        self.assertEqual(after.daily_usage, before.daily_usage)
        self.assertEqual(after.recent_requests, before.recent_requests)
        self.assertEqual(after.request_count, 0)
        self.assertEqual(after.history_since, before.history_since)
        self.assertEqual(before.recent_requests[0].effort, "medium")
        self.assertEqual(before.recent_requests[0].requested_effort, "max")
        from_wire(InferenceStatus, to_wire(after), strict=True)

    async def test_completion_day_and_reported_zero_stay_distinct_from_unknown(self):
        monitor = self.monitor()
        self.clock.seconds = 11 * 3600 + 59 * 60

        async def run():
            self.clock.seconds += 120
            return Generation(usage=Usage(available=True))

        await monitor.run(run)
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot.daily_usage[0].day, "2026-10-29")
        self.assertTrue(snapshot.recent_requests[0].usage_available)
        self.assertEqual(snapshot.input_tokens, 0)
        self.assertEqual(snapshot.usage_reported_count, 1)

    async def test_historical_medium_sample_retains_its_original_value(self):
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("""
                CREATE TABLE recent_requests (
                    id INTEGER PRIMARY KEY, sequence INTEGER NOT NULL,
                    completed_at TEXT NOT NULL, model TEXT NOT NULL,
                    effort TEXT NOT NULL, duration_ms REAL NOT NULL,
                    error_code TEXT NOT NULL, input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL, usage_available INTEGER NOT NULL
                )
            """)
            database.execute(
                "INSERT INTO recent_requests VALUES (1,1,?,?,'medium',0,'',0,0,1)",
                ("2026-10-28T12:00:00Z", MODEL),
            )
        sample = self.monitor().snapshot().recent_requests[0]
        self.assertEqual(sample.effort, "medium")
        self.assertIsNone(sample.requested_effort)

    async def test_database_failure_has_no_memory_fallback(self):
        with patch(
            "codex_gateway.monitor_store.sqlite3.connect",
            side_effect=sqlite3.OperationalError("synthetic failure"),
        ):
            with self.assertRaises(sqlite3.OperationalError):
                self.monitor()

    async def test_two_process_lifetimes_share_daily_totals(self):
        first, second = self.monitor(), self.monitor()

        async def run():
            return Generation(
                usage=Usage(available=True, input_tokens=7, output_tokens=3)
            )

        await first.run(run)
        await second.run(run)
        day = first.snapshot().daily_usage[0]
        self.assertEqual(
            (day.request_count, day.input_tokens, day.output_tokens), (2, 14, 6)
        )
