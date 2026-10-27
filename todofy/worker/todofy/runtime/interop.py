"""Conversions and calls that cross the Python/JavaScript boundary."""

from typing import Any

import js
from pyodide.ffi import to_js as _to_js


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
