"""Authenticated HTTP transport for the shared provider-neutral model client."""

from __future__ import annotations

import dataclasses

import httpx
import model_router_client as models

import newsletter.settings as newsletter_settings


@dataclasses.dataclass(frozen=True)
class ModelTransport:
    """Supply only router authentication; never a provider credential."""

    base_url: str
    token: str = dataclasses.field(repr=False)
    http_transport: httpx.AsyncBaseTransport | None = None

    async def __call__(self, call: models.HttpCall) -> models.HttpResult:
        """Read a bounded final wire JSON response without automatic retries."""
        try:
            async with (
                httpx.AsyncClient(
                    transport=self.http_transport,
                    timeout=call.timeout_seconds,
                    follow_redirects=False,
                ) as client,
                client.stream(
                    call.method,
                    self.base_url.rstrip("/") + call.path,
                    headers={
                        "authorization": "Bearer " + self.token,
                        "content-type": "application/json",
                        "accept": "application/json",
                    },
                    content=call.body,
                ) as response,
            ):
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(raw) + len(chunk) > 16 * 1024 * 1024:
                        raise models.ModelRouterError("UNAVAILABLE")
                    raw.extend(chunk)
                return models.HttpResult(response.status_code, bytes(raw))
        except httpx.TimeoutException:
            raise models.ModelRouterError("DEADLINE_EXCEEDED") from None
        except httpx.HTTPError:
            raise models.ModelRouterError("UNAVAILABLE") from None


def configured_client(
    settings: newsletter_settings.Settings,
    http_transport: httpx.AsyncBaseTransport | None = None,
) -> models.ModelClient:
    """Build the common model client from application connection settings."""
    return models.ModelClient(
        ModelTransport(
            settings.model_router_url,
            settings.model_router_token,
            http_transport,
        )
    )
