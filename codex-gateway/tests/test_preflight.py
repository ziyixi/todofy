"""Read-only preflight metadata and cleanup; the SDK is not started."""

import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from openai_codex.generated.v2_all import ModelListResponse
from ziyixi_proto.wire_json import to_wire

from codex_gateway.runtime import EFFORT, MODEL, check_runtime

PRIVATE = "Private synthetic account, description and cursor content"


def catalog() -> ModelListResponse:
    return ModelListResponse.model_validate(
        {
            "data": [
                {
                    "id": "synthetic-picker-id",
                    "model": MODEL,
                    "hidden": False,
                    "displayName": PRIVATE,
                    "description": PRIVATE,
                    "isDefault": True,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "medium", "description": PRIVATE},
                        {"reasoningEffort": "high", "description": PRIVATE},
                    ],
                }
            ],
            "nextCursor": PRIVATE,
        }
    )


def fake_sdk(page: ModelListResponse):
    client = SimpleNamespace(
        __aenter__=AsyncMock(),
        close=AsyncMock(),
        account=AsyncMock(
            return_value=SimpleNamespace(
                account=SimpleNamespace(
                    root=SimpleNamespace(type="chatgpt", email=PRIVATE)
                )
            )
        ),
        _client=SimpleNamespace(request=AsyncMock(return_value=page)),
        thread_start=AsyncMock(
            side_effect=AssertionError("Preflight started a thread")
        ),
    )
    sdk = SimpleNamespace(
        CodexConfig=SimpleNamespace, AsyncCodex=Mock(return_value=client)
    )
    return sdk, client


class PreflightTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codex-preflight-test-")
        self.home = pathlib.Path(self.temp.name)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_only_bounded_model_metadata_is_returned_without_a_thread(self):
        sdk, client = fake_sdk(catalog())
        answer = await check_runtime(self.home, sdk=sdk)
        self.assertEqual(
            to_wire(answer),
            {
                "model": MODEL,
                "effort": EFFORT,
                "authenticated": True,
                "models": [
                    {
                        "id": "synthetic-picker-id",
                        "model": MODEL,
                        "supported_efforts": ["medium", "high"],
                    }
                ],
                "has_more_models": True,
            },
        )
        self.assertNotIn(PRIVATE, json.dumps(to_wire(answer)))
        client.account.assert_awaited_once_with(refresh_token=False)
        client._client.request.assert_awaited_once_with(
            "model/list",
            {"includeHidden": True, "limit": 100},
            response_model=ModelListResponse,
        )
        client.thread_start.assert_not_called()
        client.close.assert_awaited_once()
        self.assertFalse(pathlib.Path(sdk.AsyncCodex.call_args.args[0].cwd).exists())

    async def test_model_page_is_limited_to_one_hundred_entries(self):
        page = catalog()
        page.data *= 101
        page.next_cursor = None
        sdk, client = fake_sdk(page)
        answer = await check_runtime(self.home, sdk=sdk)
        self.assertEqual(len(answer.models), 100)
        self.assertTrue(answer.has_more_models)
        client._client.request.assert_awaited_once()
        client.close.assert_awaited_once()

    async def test_non_subscription_login_skips_model_catalog(self):
        for account in (None, SimpleNamespace(root=SimpleNamespace(type="apikey"))):
            with self.subTest(account_type=None if account is None else "apikey"):
                sdk, client = fake_sdk(catalog())
                client.account.return_value = SimpleNamespace(account=account)
                answer = await check_runtime(self.home, sdk=sdk)
                self.assertFalse(answer.authenticated)
                self.assertEqual(answer.error_code, "codex_auth")
                client._client.request.assert_not_called()
                client.thread_start.assert_not_called()
                client.close.assert_awaited_once()

    async def test_catalog_or_account_failure_closes_client_and_exposes_only_safe_code(
        self,
    ):
        for method, error, code in (
            ("startup", RuntimeError(PRIVATE), "codex_startup"),
            ("account", RuntimeError(PRIVATE), "codex_account"),
            ("catalog", RuntimeError(PRIVATE), "codex_unavailable"),
            ("catalog", RuntimeError("usage_limit " + PRIVATE), "codex_quota"),
            ("catalog", TimeoutError(PRIVATE), "codex_timeout"),
        ):
            with self.subTest(method=method, code=code):
                sdk, client = fake_sdk(catalog())
                call = {
                    "startup": client.__aenter__,
                    "account": client.account,
                    "catalog": client._client.request,
                }[method]
                call.side_effect = error
                answer = await check_runtime(self.home, sdk=sdk)
                self.assertEqual(answer.error_code, code)
                self.assertEqual(answer.models, ())
                self.assertNotIn(PRIVATE, json.dumps(to_wire(answer)))
                client.thread_start.assert_not_called()
                client.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
