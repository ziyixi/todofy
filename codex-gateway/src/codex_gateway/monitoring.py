"""Process counters and persistent, content-free inference observations."""

import asyncio
import pathlib
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from importlib import metadata

from ziyixi_proto.codex.monitor.v1.monitor_pb import (
    InferenceRequestSample,
    InferenceStatus,
)
from ziyixi_proto.modelrouter.inference.v1.inference_pb import Generation

from codex_gateway.monitor_store import MonitorStore
from codex_gateway.runtime import MODEL

Runner = Callable[[], Awaitable[Generation]]
# The Home monitor contract retains its original field; requested_effort is the actual choice.
HOME_EFFORT = "medium"
ERROR_CODES = {
    1: "codex_cancelled",
    4: "codex_timeout",
    8: "codex_quota",
    13: "codex_bad_answer",
    16: "codex_auth",
}


def utc_now() -> datetime:
    return datetime.now(UTC)


def timestamp(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class InferenceMonitor:
    def __init__(
        self,
        path: pathlib.Path,
        *,
        clock: Callable[[], datetime] = utc_now,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.clock, self.monotonic = clock, monotonic
        self.started_at = timestamp(clock())
        self.store = MonitorStore(path, self.started_at)
        self.sdk_version = metadata.version("openai-codex")
        self.request_count = self.success_count = self.failure_count = 0
        self.active_count = self.input_tokens = self.output_tokens = 0
        self.usage_reported_count = 0
        self.total_duration_ms = 0.0
        self.latest: InferenceRequestSample | None = None

    async def run(
        self,
        runner: Runner,
        *,
        effort: str = "",
    ) -> Generation:
        self.request_count += 1
        sequence = self.request_count
        self.active_count += 1
        started = self.monotonic()
        answer = None
        error_code = "codex_unavailable"
        try:
            answer = await runner()
            error_code = (
                ERROR_CODES.get(answer.error.code, "codex_unavailable")
                if answer.error
                else ""
            )
            return answer
        except asyncio.CancelledError:
            error_code = "codex_cancelled"
            raise
        finally:
            duration_ms = max(0.0, (self.monotonic() - started) * 1000)
            self.active_count -= 1
            self.failure_count += bool(error_code)
            self.success_count += not error_code
            self.total_duration_ms += duration_ms
            usage = answer.usage if answer else None
            usage_available = usage is not None and usage.available
            input_tokens = usage.input_tokens if usage_available else 0
            output_tokens = usage.output_tokens if usage_available else 0
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
            self.usage_reported_count += usage_available
            sample = InferenceRequestSample(
                sequence=sequence,
                completed_at=timestamp(self.clock()),
                model=MODEL,
                effort=HOME_EFFORT,
                requested_effort=effort or "default",
                duration_ms=duration_ms,
                error_code=error_code,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                usage_available=usage_available,
            )
            self.latest = sample
            self.store.record(sample)

    def snapshot(self) -> InferenceStatus:
        latest = self.latest
        completed_count = self.success_count + self.failure_count
        history_since, daily_usage, recent_requests = self.store.snapshot()
        return InferenceStatus(
            started_at=self.started_at,
            model=MODEL,
            effort=HOME_EFFORT,
            sdk_version=self.sdk_version,
            request_count=self.request_count,
            success_count=self.success_count,
            failure_count=self.failure_count,
            active_count=self.active_count,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            usage_reported_count=self.usage_reported_count,
            last_completed_at=latest.completed_at if latest else None,
            last_duration_ms=latest.duration_ms if latest else None,
            average_duration_ms=self.total_duration_ms / completed_count
            if completed_count
            else None,
            last_error_code=latest.error_code if latest else "",
            recent_requests=recent_requests,
            history_since=history_since,
            daily_usage=daily_usage,
            observed_at=timestamp(self.clock()),
        )
