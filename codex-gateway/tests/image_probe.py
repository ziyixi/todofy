"""Offline image acceptance with real JWT signatures and in-process ASGI routes."""

import asyncio
import io
import json
import os
import tempfile
import time
from importlib.resources import files
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from ziyixi_proto.modelrouter.inference.v1.inference_pb import Generation

from codex_gateway.app import create_app
from codex_gateway.modelrouter import ModelExecutor


async def request(app, token: str | None):
    raw = json.dumps(
        {
            "model": "gpt-6.1-sol",
            "input": "{}",
            "output_schema_json": "{}",
        }
    ).encode()
    headers = [(b"content-type", b"application/json")]
    if token is not None:
        headers.append((b"cf-access-jwt-assertion", token.encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/codex/v1/model/generations:generate",
        "raw_path": b"/api/codex/v1/model/generations:generate",
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "server": ("127.0.0.1", 8080),
        "client": ("127.0.0.1", 12345),
    }
    read = False
    sent = []

    async def receive():
        nonlocal read
        if read:
            return {"type": "http.disconnect"}
        read = True
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(event):
        sent.append(event)

    await app(scope, receive, send)
    status = next(
        event["status"] for event in sent if event["type"] == "http.response.start"
    )
    return status, read


async def main():
    info = json.loads(files("codex_gateway").joinpath("build-info.json").read_text())
    assert info["source_sha"] == os.environ["EXPECTED_SHA"]
    assert info["access_issuer"].startswith("https://") and info["access_audience"]
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = {
        **jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True),
        "kid": "synthetic-image",
        "alg": "RS256",
        "use": "sig",
    }
    now = int(time.time())
    token = jwt.encode(
        {
            "iss": info["access_issuer"],
            "aud": [info["access_audience"]],
            "iat": now,
            "exp": now + 120,
            "type": "app",
            "common_name": "synthetic-image.access",
            "sub": "",
        },
        key,
        algorithm="RS256",
        headers={"kid": public["kid"]},
    )
    calls = []

    class Executor(ModelExecutor):
        async def generate(self, _message, _home):
            calls.append(True)
            return Generation(model="gpt-6.1-sol", output="{}")

    def jwks(_request, **_kwargs):
        assert _request.full_url == info["access_issuer"] + "/cdn-cgi/access/certs"
        return io.BytesIO(json.dumps({"keys": [public]}).encode())

    with tempfile.TemporaryDirectory(prefix="codex-image-probe-") as temporary:
        with (
            patch.dict(os.environ, {"CODEX_HOME": temporary}),
            patch(
                "jwt.jwks_client.urllib.request.OpenerDirector.open", side_effect=jwks
            ),
        ):
            app = create_app(model_executor=Executor())
            assert await request(app, None) == (401, False)
            assert await request(app, token) == (200, True)
            assert calls == [True]
    print(
        "Image acceptance passed: baked public policy, verified machine JWT, unauthenticated localhost denied; no SDK/model call."
    )


if __name__ == "__main__":
    asyncio.run(main())
