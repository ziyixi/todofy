"""Generated typed HTTP bindings over one fixed HTTPS origin; no redirects, proxies or unbounded bodies."""

import asyncio
import re
from urllib.parse import quote

import httpx
from ziyixi_proto.common.errors.v1.errors_pb import CommonReason
from ziyixi_proto.http_routes import HttpBinding, decode_json_body, match_path
from ziyixi_proto.platform.runtime.v1.errors_pb import ErrorReason
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire


class ReleaseFailure(RuntimeError):
    """Only a safe diagnostic code may leave the client; never upstream content or credentials."""


class TransientFailure(ReleaseFailure):
    """The same frozen request may be retried after a transport/dependency failure."""


def request_parts(
    binding: HttpBinding, request: object
) -> tuple[str, dict, dict | None]:
    """The IDL alone selects path variables, query fields and named/whole JSON body."""
    if not isinstance(request, binding.request):
        raise ReleaseFailure("INVALID_TYPED_REQUEST")
    values = to_wire(request)
    path = binding.path_template
    for match in list(re.finditer(r"\{([a-z][a-z0-9_]*)(?:=[^{}]+)?\}", path)):
        key = match.group(1)
        value = values.pop(key, None)
        if not isinstance(value, str):
            raise ReleaseFailure("INVALID_TYPED_REQUEST")
        path = path.replace(match.group(0), quote(value, safe="/"), 1)
    if match_path(binding, path) is None:
        raise ReleaseFailure("INVALID_TYPED_REQUEST")
    if binding.body == "*":
        return path, {}, values
    body = values.pop(binding.body) if binding.body else None
    if any(not isinstance(value, (str, int, bool)) for value in values.values()):
        raise ReleaseFailure("INVALID_TYPED_REQUEST")
    return path, values, body


class Transport:
    def __init__(
        self,
        host: str,
        credentials: dict[str, str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        if not isinstance(host, str) or not re.fullmatch(
            r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host
        ):
            raise ReleaseFailure("INVALID_DEPLOYMENT_HOST")
        expected = {
            "PLATFORM_ACCESS_CLIENT_ID",
            "PLATFORM_ACCESS_CLIENT_SECRET",
            "PLATFORM_DEPLOY_TOKEN",
        }
        if set(credentials) != expected or any(
            not isinstance(value, str)
            or not 1 <= len(value) <= 512
            or any(char.isspace() for char in value)
            for value in credentials.values()
        ):
            raise ReleaseFailure("DEPLOYMENT_CREDENTIALS_MISSING_OR_INVALID")
        if len(credentials["PLATFORM_DEPLOY_TOKEN"]) < 32:
            raise ReleaseFailure("DEPLOYMENT_CREDENTIALS_MISSING_OR_INVALID")
        self.options = {
            "base_url": "https://" + host,
            "trust_env": False,
            "follow_redirects": False,
            "timeout": httpx.Timeout(connect=10, read=15, write=10, pool=10),
            "transport": transport,
            "headers": {
                "CF-Access-Client-Id": credentials["PLATFORM_ACCESS_CLIENT_ID"],
                "CF-Access-Client-Secret": credentials["PLATFORM_ACCESS_CLIENT_SECRET"],
                "Authorization": "Bearer " + credentials["PLATFORM_DEPLOY_TOKEN"],
            },
        }

    def close(self) -> None:
        # Each bounded request owns and closes its connection/async event loop.
        pass

    def call(
        self, binding: HttpBinding, request: object, *, timeout: float = 30
    ) -> object:
        path, query, body = request_parts(binding, request)
        if not 0 < timeout <= 30:
            raise ReleaseFailure("INVALID_DEPLOYMENT_TIMEOUT")
        try:
            return asyncio.run(self._call(binding, path, query, body, timeout))
        except (httpx.RequestError, TimeoutError):
            raise TransientFailure("DEPLOYMENT_TRANSPORT_UNAVAILABLE") from None

    async def _call(self, binding, path, query, body, timeout):
        # httpx's per-stage/read timeout cannot bound a complete response. asyncio adds
        # a total wall-clock budget, including connection, response streaming and cleanup.
        async with asyncio.timeout(timeout):
            async with (
                httpx.AsyncClient(**self.options) as client,
                client.stream(
                    binding.method, path, params=query, json=body
                ) as response,
            ):
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 32768:
                        raise ReleaseFailure("UPSTREAM_RESPONSE_TOO_LARGE")
                status = response.status_code
            return self._response(binding, status, bytes(raw))

    @staticmethod
    def _response(binding, status, raw):
        if status == 429 or status >= 500:
            raise TransientFailure("DEPLOYMENT_DEPENDENCY_UNAVAILABLE")
        if 300 <= status < 400:
            raise ReleaseFailure("UPSTREAM_REDIRECT_REFUSED")
        if not 200 <= status < 300:
            reason = "DEPLOYMENT_API_REJECTED"
            try:
                envelope = decode_json_body(raw, max_bytes=32768)
                details = envelope["error"]["details"]
                allowed = {
                    value.name
                    for cls in (CommonReason, ErrorReason)
                    for value in cls
                    if value.value
                }
                if isinstance(details, list) and len(details) == 1:
                    info = details[0]
                    if (
                        info.get("@type") == "type.googleapis.com/google.rpc.ErrorInfo"
                        and info.get("domain") == "platform.ziyixi.science"
                        and info.get("reason") in allowed
                    ):
                        reason = info["reason"]
            except (WireJsonError, KeyError, TypeError, AttributeError):
                pass
            raise ReleaseFailure(reason)
        try:
            return from_wire(
                binding.response,
                decode_json_body(raw, max_bytes=32768),
                strict=True,
            ).message
        except WireJsonError:
            raise ReleaseFailure("DEPLOYMENT_RESPONSE_INVALID") from None
