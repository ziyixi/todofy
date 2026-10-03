"""Bounded metadata HTTP through the locked shared platform httpx dependency."""

import json
import time

import httpx


class ObserverError(Exception):
    """Safe fixed error code, never contains a command or response body."""


def _request(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    limit: int = 262144,
    transport: httpx.BaseTransport | None = None,
) -> tuple[int, object]:
    deadline = time.monotonic() + 30
    try:
        with (
            httpx.Client(
                trust_env=False, follow_redirects=False, timeout=10, transport=transport
            ) as client,
            client.stream(
                "POST" if data is not None else "GET",
                url,
                headers={"Accept-Encoding": "identity", **(headers or {})},
                content=data,
            ) as response,
        ):
            if response.status_code != 200:
                return response.status_code, None
            if (
                response.headers.get("content-encoding", "identity").lower()
                != "identity"
                or response.headers.get("content-type", "")
                .split(";", 1)[0]
                .strip()
                .lower()
                != "application/json"
            ):
                raise ObserverError("observation_unavailable")
            body = bytearray()
            for chunk in response.iter_raw(chunk_size=1024):
                if len(body) + len(chunk) > limit or time.monotonic() > deadline:
                    raise ObserverError("response_too_large")
                body.extend(chunk)
            return response.status_code, json.loads(body)
    except (httpx.HTTPError, OSError, ValueError):
        raise ObserverError("observation_unavailable") from None
