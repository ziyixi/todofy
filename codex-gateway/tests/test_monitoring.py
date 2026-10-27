"""Persistent telemetry uses synthetic requests and deterministic clocks only."""

import asyncio
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from auth_fixtures import AUDIENCE, ISSUER, access_headers, local_jwks, verifier
from ziyixi_proto.codex.inference.v1.inference_pb import (
    CheckInferenceResponse,
    RunInferenceRequest,
    RunInferenceResponse,
)
from ziyixi_proto.codex.monitor.v1.monitor_pb import InferenceStatus
from ziyixi_proto.wire_json import from_wire, to_wire

from codex_gateway.app import create_app
from codex_gateway.monitoring import InferenceMonitor
from codex_gateway.runtime import EFFORT, MODEL

START = datetime(2026, 10, 25, 12, tzinfo=UTC)
PATH = "/api/codex/v1/inference:run"
HEADERS = access_headers()
BODY = {
    "instructions": "Private synthetic instructions",
    "input_json": '{"private":"synthetic input"}',
    "output_schema_json": '{"type":"object"}',
}


class Clock:
    seconds = 0.0

    def now(self):
        return START + timedelta(seconds=self.seconds)

    def monotonic(self):
        return self.seconds


class MonitoringTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temp.name)
        self.monitor_db = self.home / "monitor.sqlite3"
        self.environment = patch.dict(
            os.environ,
            {
                "CODEX_HOME": str(self.home),
                "ACCESS_ISSUER": ISSUER,
                "ACCESS_AUDIENCE": AUDIENCE,
            },
            clear=True,
        )
        self.environment.start()
        self.jwks_mock = local_jwks()
        self.jwks_mock.start()
        self.clock = Clock()

    async def asyncTearDown(self):
        self.environment.stop()
        self.jwks_mock.stop()
        self.temp.cleanup()

    def app(self, runner):
        async def checker(_home):
            return CheckInferenceResponse(model=MODEL, effort=EFFORT)

        return create_app(
            access_verifier=verifier(),
            monitor_db=self.monitor_db,
            runner=runner,
            checker=checker,
            clock=self.clock.now,
            monotonic=self.clock.monotonic,
        )

    async def status(self, client):
        response = await client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        return from_wire(
            InferenceStatus, response.json()["inference_status"], strict=True
        ).message

    async def test_health_preflight_authentication_and_invalid_requests_do_not_count(
        self,
    ):
        async def runner(_request, _home):
            raise AssertionError("Inference must not run")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app(runner)), base_url="http://test"
        ) as client:
            await client.get("/healthz")
            self.assertEqual((await client.post(PATH, json=BODY)).status_code, 401)
            self.assertEqual(
                (await client.post(PATH, json={}, headers=HEADERS)).status_code, 400
            )
            self.assertEqual(
                (
                    await client.post(
                        "/api/codex/v1/inference:check", json={}, headers=HEADERS
                    )
                ).status_code,
                200,
            )
            snapshot = await self.status(client)
        self.assertEqual(snapshot.request_count, 0)
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual(snapshot.started_at, "2026-10-25T12:00:00Z")
        self.assertEqual(snapshot.observed_at, "2026-10-25T12:00:00Z")
        self.assertIsNone(snapshot.last_completed_at)
        self.assertIsNone(snapshot.last_duration_ms)
        self.assertIsNone(snapshot.average_duration_ms)
        self.assertEqual(snapshot.recent_requests, ())
        self.assertEqual(snapshot.history_since, snapshot.started_at)
        self.assertEqual(snapshot.daily_usage, ())

    async def test_counts_model_failures_and_reported_usage_without_retaining_content(
        self,
    ):
        answers = iter(
            [
                RunInferenceResponse(
                    model=MODEL,
                    effort=EFFORT,
                    output_json='{"private":"synthetic output"}',
                    input_tokens=100,
                    output_tokens=20,
                    usage_available=True,
                ),
                RunInferenceResponse(
                    model=MODEL,
                    effort=EFFORT,
                    error_code="codex_bad_answer",
                    input_tokens=10,
                    output_tokens=2,
                    usage_available=True,
                ),
                RunInferenceResponse(model=MODEL, error_code="codex_quota"),
            ]
        )

        async def runner(_request, _home):
            self.clock.seconds += 0.5
            return next(answers)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app(runner)), base_url="http://test"
        ) as client:
            for _ in range(3):
                response = await client.post(PATH, json=BODY, headers=HEADERS)
                self.assertEqual(response.status_code, 200)
            snapshot = await self.status(client)
        self.assertEqual(
            (snapshot.request_count, snapshot.success_count, snapshot.failure_count),
            (3, 1, 2),
        )
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual((snapshot.input_tokens, snapshot.output_tokens), (110, 22))
        self.assertEqual(snapshot.usage_reported_count, 2)
        self.assertEqual(snapshot.last_error_code, "codex_quota")
        self.assertEqual(snapshot.last_duration_ms, 500)
        self.assertEqual(snapshot.average_duration_ms, 500)
        self.assertEqual(snapshot.last_completed_at, "2026-10-25T12:00:01.500Z")
        self.assertEqual(
            [item.sequence for item in snapshot.recent_requests], [3, 2, 1]
        )
        self.assertFalse(snapshot.recent_requests[0].usage_available)
        self.assertTrue(snapshot.recent_requests[1].usage_available)
        self.assertNotIn("private", json.dumps(to_wire(snapshot)).lower())
        day = snapshot.daily_usage[0]
        self.assertEqual(day.day, "2026-10-25")
        self.assertEqual(
            (day.request_count, day.success_count, day.failure_count), (3, 1, 2)
        )
        self.assertEqual(day.usage_reported_count, 2)
        self.assertEqual((day.input_tokens, day.output_tokens), (110, 22))
        self.assertEqual(day.total_duration_ms, 1500)
        self.assertNotIn(b"private", self.monitor_db.read_bytes().lower())

    async def test_cancellation_releases_active_count(self):
        entered = asyncio.Event()

        async def runner(_request, _home):
            entered.set()
            await asyncio.Future()

        monitor = InferenceMonitor(
            self.monitor_db, clock=self.clock.now, monotonic=self.clock.monotonic
        )
        request = asyncio.create_task(
            monitor.run(RunInferenceRequest(**BODY), self.home, runner)
        )
        await entered.wait()
        self.assertEqual(monitor.snapshot().active_count, 1)
        self.clock.seconds = 2
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual(snapshot.failure_count, 1)
        self.assertEqual(snapshot.last_error_code, "codex_cancelled")
        self.assertEqual(snapshot.last_duration_ms, 2000)
        self.assertEqual(snapshot.daily_usage[0].failure_count, 1)
        self.assertEqual(snapshot.daily_usage[0].usage_reported_count, 0)

    async def test_overlapping_requests_count_active_work_and_keep_completion_order(
        self,
    ):
        ready = asyncio.Event()
        releases = {model: asyncio.Event() for model in ("model-a", "model-b")}
        entered = 0

        async def runner(request, _home):
            nonlocal entered
            entered += 1
            if entered == 2:
                ready.set()
            await releases[request.model].wait()
            return RunInferenceResponse(model=request.model)

        monitor = InferenceMonitor(
            self.monitor_db, clock=self.clock.now, monotonic=self.clock.monotonic
        )
        first, second = [
            asyncio.create_task(
                monitor.run(RunInferenceRequest(**BODY, model=model), self.home, runner)
            )
            for model in releases
        ]
        await ready.wait()
        self.assertEqual(monitor.snapshot().active_count, 2)
        self.assertEqual(monitor.snapshot().request_count, 2)
        self.clock.seconds = 1
        releases["model-b"].set()
        await second
        self.assertEqual(monitor.snapshot().active_count, 1)
        self.clock.seconds = 2
        releases["model-a"].set()
        await first
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual(snapshot.success_count, 2)
        self.assertEqual([item.sequence for item in snapshot.recent_requests], [1, 2])
        self.assertEqual(snapshot.average_duration_ms, 1500)

    async def test_recent_samples_are_bounded_sanitized_and_survive_restart(self):
        async def runner(_request, _home):
            self.clock.seconds += 1
            return RunInferenceResponse(error_code="Private synthetic exception")

        app = self.app(runner)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for _ in range(10):
                await client.post(
                    PATH,
                    json={**BODY, "model": "Private synthetic model\n/path"},
                    headers=HEADERS,
                )
            snapshot = await self.status(client)
            response = await client.get("/healthz")
        self.assertEqual(snapshot.request_count, 10)
        self.assertEqual(len(snapshot.recent_requests), 8)
        self.assertEqual(
            [item.sequence for item in snapshot.recent_requests], list(range(10, 2, -1))
        )
        self.assertTrue(
            all(item.model == "unknown" for item in snapshot.recent_requests)
        )
        self.assertTrue(
            all(
                item.error_code == "codex_unavailable"
                for item in snapshot.recent_requests
            )
        )
        self.assertNotIn("Private", response.text)
        self.assertLess(len(response.content), 4096)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app(runner)), base_url="http://test"
        ) as client:
            reset = await self.status(client)
        self.assertEqual(reset.request_count, 0)
        self.assertNotEqual(reset.started_at, snapshot.started_at)
        self.assertEqual(reset.history_since, snapshot.history_since)
        self.assertEqual(reset.recent_requests, snapshot.recent_requests)
        self.assertEqual(reset.daily_usage, snapshot.daily_usage)
        self.assertEqual(reset.success_count, 0)
        self.assertEqual(reset.failure_count, 0)
        self.assertEqual(reset.usage_reported_count, 0)
        self.assertEqual((reset.input_tokens, reset.output_tokens), (0, 0))
        self.assertIsNone(reset.last_completed_at)
        self.assertIsNone(reset.last_duration_ms)
        self.assertIsNone(reset.average_duration_ms)
        self.assertEqual(reset.last_error_code, "")
        with closing(sqlite3.connect(self.monitor_db)) as database:
            self.assertEqual(
                database.execute("SELECT COUNT(*) FROM recent_requests").fetchone()[0],
                8,
            )

    async def test_thirty_days_and_eight_full_width_samples_fit_health_response_budget(
        self,
    ):
        async def runner(request, _home):
            self.clock.seconds += 86400
            return RunInferenceResponse(
                model=request.model,
                effort=EFFORT,
                error_code="codex_configuration",
                input_tokens=100_000,
                output_tokens=10_000,
                usage_available=True,
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app(runner)), base_url="http://test"
        ) as client:
            for _ in range(35):
                await client.post(
                    PATH, json={**BODY, "model": "m" * 64}, headers=HEADERS
                )
            response = await client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertLess(len(response.content), 12_288)
        status = response.json()["inference_status"]
        self.assertEqual(len(status["recent_requests"]), 8)
        self.assertEqual(len(status["daily_usage"]), 30)
        self.assertEqual(status["daily_usage"][0]["day"], "2026-11-29")
        self.assertEqual(status["daily_usage"][-1]["day"], "2026-10-31")
        with closing(sqlite3.connect(self.monitor_db)) as database:
            self.assertEqual(
                database.execute("SELECT COUNT(*) FROM daily_usage").fetchone()[0], 35
            )

    async def test_unexpected_runner_failure_remains_an_exception_and_is_counted_safely(
        self,
    ):
        async def runner(_request, _home):
            raise RuntimeError("Private synthetic runtime failure")

        monitor = InferenceMonitor(
            self.monitor_db, clock=self.clock.now, monotonic=self.clock.monotonic
        )
        with self.assertRaisesRegex(RuntimeError, "Private synthetic runtime failure"):
            await monitor.run(RunInferenceRequest(**BODY), self.home, runner)
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot.active_count, 0)
        self.assertEqual(snapshot.failure_count, 1)
        self.assertEqual(snapshot.last_error_code, "codex_unavailable")
        self.assertNotIn("Private", json.dumps(to_wire(snapshot)))

    async def test_completion_utc_day_determines_daily_usage(self):
        self.clock.seconds = 43199
        monitor = InferenceMonitor(
            self.monitor_db,
            clock=lambda: self.clock.now().astimezone(timezone(timedelta(hours=9))),
            monotonic=self.clock.monotonic,
        )

        async def runner(_request, _home):
            self.clock.seconds += 0.75
            return RunInferenceResponse(usage_available=True)

        await monitor.run(RunInferenceRequest(**BODY), self.home, runner)
        await monitor.run(RunInferenceRequest(**BODY), self.home, runner)
        snapshot = monitor.snapshot()
        self.assertEqual(
            [(day.day, day.request_count) for day in snapshot.daily_usage],
            [("2026-10-26", 1), ("2026-10-25", 1)],
        )
        self.assertEqual(snapshot.daily_usage[0].usage_reported_count, 1)
        self.assertEqual(snapshot.daily_usage[0].total_duration_ms, 750)
        self.assertEqual(
            snapshot.recent_requests[0].completed_at, "2026-10-26T00:00:00.500Z"
        )

    async def test_two_live_instances_accumulate_without_resetting_daily_totals(self):
        first = InferenceMonitor(
            self.monitor_db, clock=self.clock.now, monotonic=self.clock.monotonic
        )
        self.clock.seconds = 1
        second = InferenceMonitor(
            self.monitor_db, clock=self.clock.now, monotonic=self.clock.monotonic
        )

        async def runner(_request, _home):
            self.clock.seconds += 0.25
            return RunInferenceResponse(
                input_tokens=12, output_tokens=3, usage_available=True
            )

        for monitor in (first, second, first, second):
            await monitor.run(RunInferenceRequest(**BODY), self.home, runner)
        snapshot = second.snapshot()
        self.assertEqual(snapshot.request_count, 2)
        self.assertEqual(snapshot.success_count, 2)
        self.assertEqual((snapshot.input_tokens, snapshot.output_tokens), (24, 6))
        self.assertEqual(snapshot.history_since, first.started_at)
        day = snapshot.daily_usage[0]
        self.assertEqual(day.request_count, 4)
        self.assertEqual(day.success_count, 4)
        self.assertEqual((day.input_tokens, day.output_tokens), (48, 12))
        self.assertEqual(day.total_duration_ms, 1000)
        self.assertEqual(len(snapshot.recent_requests), 4)

    async def test_database_failure_is_reported_without_an_in_memory_fallback(self):
        self.monitor_db.mkdir()
        with self.assertRaises((OSError, sqlite3.Error)):
            self.app(None)
