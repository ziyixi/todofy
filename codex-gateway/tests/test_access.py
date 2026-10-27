"""Real signed JWT verification at every protected FastAPI route boundary."""

import json
import os
import pathlib
import tempfile
import time
import unittest
import urllib.error
from unittest.mock import patch

import httpx
import jwt
from auth_fixtures import AUDIENCE, ISSUER, JWK, access_headers, assertion, local_jwks
from cryptography.hazmat.primitives.asymmetric import rsa
from model_fixtures import StubExecutor

from codex_gateway.app import create_app

BODY = {"model": "gpt-6.1-sol", "input": "{}", "output_schema_json": "{}"}
RUN = "/api/codex/v1/model/generations:generate"


class AccessRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="access-gateway-test-")
        self.root = pathlib.Path(self.temp.name)
        self.info = self.root / "build-info.json"
        self.info.write_text(
            json.dumps(
                {
                    "source_sha": "a" * 40,
                    "access_issuer": ISSUER,
                    "access_audience": AUDIENCE,
                }
            )
        )
        self.configuration = patch("codex_gateway.app.BUILD_INFO_FILE", self.info)
        self.configuration.start()
        self.environment = patch.dict(
            os.environ, {"CODEX_HOME": str(self.root)}, clear=True
        )
        self.environment.start()
        self.jwks_patch = local_jwks()
        self.fetch = self.jwks_patch.start()
        self.calls = []

        executor = StubExecutor()
        self.calls = executor.calls
        self.app = create_app(
            monitor_db=self.root / "monitor.sqlite3", model_executor=executor
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://127.0.0.1"
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        self.jwks_patch.stop()
        self.environment.stop()
        self.configuration.stop()
        self.temp.cleanup()

    async def test_signed_machine_assertion_authorizes_without_bearer_and_reuses_jwks(
        self,
    ):
        for _ in range(2):
            response = await self.client.post(RUN, json=BODY, headers=access_headers())
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(
            self.fetch.call_args.args[0].full_url, ISSUER + "/cdn-cgi/access/certs"
        )
        catalog = await self.client.get(
            "/api/codex/v1/model/models", headers=access_headers()
        )
        self.assertEqual(catalog.status_code, 200)

    async def test_missing_or_legacy_bearer_auth_fails_before_body_on_localhost(self):
        paths = [
            RUN,
            "/api/model/v1/generations:generate",
            "/api/model/v1/embeddings:embed",
            "/api/model/v1/conversations",
            "/api/model/v1/conversations/synthetic:close",
            "/api/codex/v1/model/generations:generate",
            "/api/codex/v1/model/embeddings:embed",
            "/api/codex/v1/model/conversations",
            "/api/codex/v1/model/conversations/synthetic:close",
        ]

        async def unread():
            raise AssertionError("Unauthenticated body was read")
            yield b""

        for path in paths:
            with self.subTest(path=path):
                response = await self.client.post(
                    path,
                    content=unread(),
                    headers={"authorization": "Bearer obsolete-token"},
                )
                self.assertEqual(response.status_code, 401)
        for path in (
            "/api/model/v1/models",
            "/api/codex/v1/model/models",
        ):
            self.assertEqual((await self.client.get(path)).status_code, 401)
        self.assertEqual(self.calls, [])
        self.fetch.assert_not_called()
        with patch.dict(os.environ, {"DEV_AUTH_BYPASS": "true"}):
            self.assertEqual((await self.client.post(RUN, json=BODY)).status_code, 401)
        self.assertEqual((await self.client.get("/healthz")).status_code, 200)

    async def test_forged_wrong_scope_expired_and_nonmachine_assertions_are_denied(
        self,
    ):
        now = int(time.time())
        claims = [
            {"aud": ["wrong-audience"]},
            {"iss": "https://other.cloudflareaccess.com"},
            {"exp": now - 60},
            {"iat": now + 3600},
            {"nbf": now + 3600},
            {"type": "org"},
            {"sub": "synthetic-human"},
            {"common_name": ""},
        ]
        headers = [access_headers(**value) for value in claims]
        attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        headers.append(access_headers(signing_key=attacker))
        for value in headers:
            response = await self.client.post(RUN, json=BODY, headers=value)
            self.assertEqual(response.status_code, 401, response.text)
            self.assertEqual(
                response.json()["error"]["details"][0]["reason"],
                "INFERENCE_NOT_AUTHORIZED",
            )
        self.assertEqual(self.calls, [])

    async def test_unsigned_wrong_algorithm_and_duplicate_assertions_are_denied(self):
        wrong_alg = jwt.encode(
            {"aud": [AUDIENCE]},
            "synthetic-secret-that-is-at-least-32-bytes",
            algorithm="HS256",
            headers={"kid": JWK["kid"]},
        )
        unsigned = jwt.encode({"aud": [AUDIENCE]}, None, algorithm="none")
        for token in (wrong_alg, unsigned, "not-a-jwt"):
            response = await self.client.post(
                RUN, json=BODY, headers={"cf-access-jwt-assertion": token}
            )
            self.assertEqual(response.status_code, 401)
        duplicated = [
            ("cf-access-jwt-assertion", assertion()),
            ("cf-access-jwt-assertion", assertion()),
        ]
        self.assertEqual(
            (await self.client.post(RUN, json=BODY, headers=duplicated)).status_code,
            401,
        )
        self.fetch.assert_not_called()

    async def test_jwks_outage_fails_closed_without_upstream_text(self):
        self.fetch.side_effect = urllib.error.URLError("synthetic-private-upstream")
        response = await self.client.post(RUN, json=BODY, headers=access_headers())
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("synthetic-private-upstream", response.text)
        self.assertEqual(self.calls, [])

    async def test_unconfigured_image_policy_has_no_environment_or_bearer_fallback(
        self,
    ):
        self.info.write_text(json.dumps({"source_sha": "a" * 40}))
        with patch.dict(
            os.environ,
            {
                "ACCESS_ISSUER": ISSUER,
                "ACCESS_AUDIENCE": AUDIENCE,
                "CODEX_GATEWAY_TOKEN": "obsolete",
            },
        ):
            response = await self.client.post(RUN, json=BODY, headers=access_headers())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.calls, [])
