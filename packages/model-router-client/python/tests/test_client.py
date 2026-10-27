"""Wire transport tests with no network or provider implementation."""

import json
import unittest

import model_router_client as models


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_sends_final_json_and_preserves_unknown_usage(self):
        calls = []

        async def transport(call):
            calls.append(call)
            return models.HttpResult(
                200,
                b'{"name":"requests/test","usage":{"available":false}}',
            )

        answer = await models.ModelClient(transport).generate(
            models.GenerateRequest(
                input="synthetic",
                model="gpt-6.1-sol",
                timeout_ms=840000,
            )
        )
        self.assertFalse(answer.usage.available)
        self.assertEqual(calls[0].path, "/api/model/v1/generations:generate")
        self.assertEqual(calls[0].timeout_seconds, 855)
        self.assertEqual(json.loads(calls[0].body)["model"], "gpt-6.1-sol")

    async def test_conversation_flat_body_and_empty_cleanup_acknowledgement(self):
        calls = []

        async def transport(call):
            calls.append(call)
            return models.HttpResult(200, b"{}")

        client = models.ModelClient(transport)
        await client.create_conversation(
            models.CreateConversationRequest(
                name="conversations/fixture", model="gpt-6.1-sol"
            )
        )
        self.assertEqual(calls[0].path, "/api/model/v1/conversations")
        self.assertEqual(
            json.loads(calls[0].body),
            {"name": "conversations/fixture", "model": "gpt-6.1-sol"},
        )
        await client.close_conversation(
            models.CloseConversationRequest(name="conversations/fixture")
        )
        self.assertEqual(calls[1].path, "/api/model/v1/conversations/fixture:close")
        self.assertEqual(json.loads(calls[1].body), {})

    async def test_cleanup_rejects_a_nonempty_success_response(self):
        async def transport(call):
            return models.HttpResult(200, b'{"state":"open"}')

        with self.assertRaises(models.ModelRouterError):
            await models.ModelClient(transport).close_conversation(
                models.CloseConversationRequest(name="conversations/fixture")
            )

    async def test_rpc_failures_drop_response_text(self):
        async def transport(call):
            return models.HttpResult(
                429,
                b'{"error":{"status":"RESOURCE_EXHAUSTED","message":"synthetic-private"}}',
            )

        with self.assertRaises(models.ModelRouterError) as caught:
            await models.ModelClient(transport).list_models()
        self.assertEqual(caught.exception.code, "RESOURCE_EXHAUSTED")
        self.assertNotIn("synthetic-private", str(caught.exception))

    async def test_invalid_and_duplicate_wire_json_are_rejected(self):
        for body in (b'{"models":[],"models":[]}', b"not JSON", b'{"unexpected":true}'):

            async def transport(call, body=body):
                return models.HttpResult(200, body)

            with self.assertRaises(models.ModelRouterError):
                await models.ModelClient(transport).list_models()


if __name__ == "__main__":
    unittest.main()
