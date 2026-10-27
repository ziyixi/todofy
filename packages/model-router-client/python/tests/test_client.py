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
                b'{"name":"requests/test","state":"succeeded","usage":{"available":false}}',
            )

        answer = await models.ModelClient(transport).generate(
            models.GenerateRequest(
                request_id="c920f6e6-5d4c-4404-95a7-c3a9776f7114",
                input="synthetic",
                config=models.GenerationConfig(model="models/sol-6-1"),
                timeout_ms=840000,
            )
        )
        self.assertFalse(answer.usage.available)
        self.assertEqual(calls[0].path, "/api/model/v1/generations:generate")
        self.assertEqual(calls[0].timeout_seconds, 855)
        self.assertEqual(json.loads(calls[0].body)["config"]["model"], "models/sol-6-1")

    async def test_conversation_named_body_and_request_id_query_match_root_binding(
        self,
    ):
        calls = []

        async def transport(call):
            calls.append(call)
            return models.HttpResult(
                200,
                b'{"name":"conversations/fixture","config":{"model":"models/sol-6-1"},"state":"open"}',
            )

        client = models.ModelClient(transport)
        await client.create_conversation(
            models.CreateConversationRequest(
                request_id="c920f6e6-5d4c-4404-95a7-c3a9776f7114",
                conversation=models.Conversation(
                    name="conversations/fixture",
                    config=models.GenerationConfig(model="models/sol-6-1"),
                ),
            )
        )
        self.assertEqual(
            calls[0].path,
            "/api/model/v1/conversations?request_id=c920f6e6-5d4c-4404-95a7-c3a9776f7114",
        )
        self.assertEqual(json.loads(calls[0].body)["name"], "conversations/fixture")
        self.assertNotIn("conversation", json.loads(calls[0].body))
        await client.get_conversation("conversations/fixture")
        self.assertEqual(calls[1].path, "/api/model/v1/conversations/fixture")
        self.assertIsNone(calls[1].body)
        await client.close_conversation(
            models.CloseConversationRequest(
                name="conversations/fixture",
                request_id="c920f6e6-5d4c-4404-95a7-c3a9776f7114",
            )
        )
        self.assertEqual(calls[2].path, "/api/model/v1/conversations/fixture:close")
        self.assertNotIn("name", json.loads(calls[2].body))

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
