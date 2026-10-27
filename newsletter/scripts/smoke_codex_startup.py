"""Exercise the installed shared client with synthetic final HTTP responses.

The historical smoke command remains accepted by release tooling. It starts no
SDK, reads no credentials and performs no external network or model request.
"""

import asyncio
import json

import httpx
import model_router_client as models

import newsletter.model_client as model_client


async def check_startups() -> None:
    """Verify two configured-catalog reads through an injected transport."""
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url.path == "/api/model/v1/models"
        assert request.headers["authorization"] == "Bearer synthetic-token"
        return httpx.Response(200, json={"models": []})

    transport = model_client.ModelTransport(
        "https://models.example.test",
        "synthetic-token",
        httpx.MockTransport(respond),
    )
    client = models.ModelClient(transport)
    for _ in range(2):
        assert not (await client.list_models()).models
    assert len(calls) == 2


def main() -> None:
    """Run only synthetic HTTP wire checks."""
    asyncio.run(check_startups())
    print(
        json.dumps({"model_router_client_checks": 2, "external_network": False})
    )


if __name__ == "__main__":
    main()
