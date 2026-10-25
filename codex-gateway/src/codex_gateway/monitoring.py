"""Bounded, content-free inference observations for this process lifetime."""

import asyncio
import pathlib
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from importlib import metadata

from ziyixi_proto.codex.inference.v1.inference_pb import (
    RunInferenceRequest,
    RunInferenceResponse,
)
from ziyixi_proto.codex.monitor.v1.monitor_pb import (
    InferenceRequestSample,
    InferenceStatus,
)

from codex_gateway.runtime import EFFORT, MODEL

Runner = Callable[[RunInferenceRequest, pathlib.Path], Awaitable[RunInferenceResponse]]
MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
ERROR_CODES = frozenset(
    {
        "",
        "codex_auth",
        "codex_quota",
        "codex_timeout",
        "codex_unavailable",
        "codex_bad_answer",
        "codex_configuration",
        "codex_startup",
        "codex_account",
        "codex_skills",
        "codex_cancelled",
    }
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def timestamp(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class InferenceMonitor:
    def __init__(
        self,
        *,
        clock: Callable[[], datetime] = utc_now,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.clock, self.monotonic = clock, monotonic
        self.started_at = timestamp(clock())
        self.sdk_version = metadata.version("openai-codex")
        self.request_count = self.success_count = self.failure_count = 0
        self.active_count = self.input_tokens = self.output_tokens = 0
        self.usage_reported_count = 0
        self.total_duration_ms = 0.0
        self.recent: deque[InferenceRequestSample] = deque(maxlen=8)

    async def run(
        self, request: RunInferenceRequest, home: pathlib.Path, runner: Runner
    ) -> RunInferenceResponse:
        self.request_count += 1
        sequence = self.request_count
        self.active_count += 1
        started = self.monotonic()
        model = request.model or MODEL
        model = model if MODEL_ID.fullmatch(model) else "unknown"
        answer = None
        error_code = "codex_unavailable"
        try:
            answer = await runner(request, home)
            error_code = (
                answer.error_code
                if answer.error_code in ERROR_CODES
                else "codex_unavailable"
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
            usage_available = answer is not None and answer.usage_available
            input_tokens = answer.input_tokens if usage_available else 0
            output_tokens = answer.output_tokens if usage_available else 0
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
            self.usage_reported_count += usage_available
            self.recent.appendleft(
                InferenceRequestSample(
                    sequence=sequence,
                    completed_at=timestamp(self.clock()),
                    model=model,
                    effort=EFFORT,
                    duration_ms=duration_ms,
                    error_code=error_code,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    usage_available=usage_available,
                )
            )

    def snapshot(self) -> InferenceStatus:
        latest = self.recent[0] if self.recent else None
        completed_count = self.success_count + self.failure_count
        return InferenceStatus(
            started_at=self.started_at,
            model=MODEL,
            effort=EFFORT,
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
            recent_requests=tuple(self.recent),
            observed_at=timestamp(self.clock()),
        )
