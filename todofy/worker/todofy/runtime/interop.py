"""Conversions and calls that cross the Python/JavaScript boundary."""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import js
from pyodide.ffi import to_js as _to_js
from workers import fetch

from todofy.core.backoff import parse_retry_after
from todofy.core.classify import Failure, HttpOutcome


def to_js(value: Any) -> Any:
    """Convert dicts to plain JS objects (the default would build a JS Map)."""
    return _to_js(value, dict_converter=js.Object.fromEntries)


async def sha256_hex(data: bytes) -> str:
    digest = await js.crypto.subtle.digest("SHA-256", to_js(data))
    return digest.to_bytes().hex()


def now_ms() -> int:
    return int(js.Date.now())


def now_s() -> int:
    """Unix seconds, the unit of every D1 time column."""
    return now_ms() // 1000


def utc_now() -> datetime:
    return datetime.fromtimestamp(now_ms() / 1000, UTC)


async def read_capped(stream: Any, limit: int) -> bytes | None:
    """Read a JS ReadableStream (or None) fully; None once it exceeds ``limit`` bytes.

    A chunked upload has no Content-Length, so the cap is enforced while reading
    and the rest of an oversized body is never buffered.
    """
    if stream is None:
        return b""
    reader = stream.getReader()
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await reader.read()
        if chunk.done:
            return b"".join(chunks)
        data = chunk.value.to_bytes()
        size += len(data)
        if size > limit:
            await reader.cancel()
            return None
        chunks.append(data)


@dataclass(frozen=True)
class Upstream:
    """Outcome of an outbound call; `failure` is set when no response arrived."""

    status: int | None
    body: bytes
    failure: Failure | None = None
    retry_after: str | None = None

    def outcome(self) -> HttpOutcome:
        """The input the core classifiers take."""
        if self.failure:
            return HttpOutcome(failure=self.failure)
        return HttpOutcome(status=self.status, retry_after=parse_retry_after(self.retry_after, utc_now()))


async def fetch_with_timeout(url: str, *, timeout_ms: int, **options: Any) -> Upstream:
    """The deadline covers both the response headers and reading the body."""
    signal = js.AbortSignal.timeout(timeout_ms)
    try:
        response = await fetch(url, signal=signal, **options)
        return Upstream(response.status, await response.bytes(), retry_after=response.headers.get("retry-after"))
    except OSError:
        # Pyodide raises AbortError (an OSError) for every fetch failure, so only
        # the signal tells a timeout apart. Nothing proves a failed request was
        # never sent, so a network error counts as possibly delivered.
        return Upstream(None, b"", Failure.TIMEOUT if signal.aborted else Failure.LOST)
