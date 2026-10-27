"""Pinned SDK categories survive normalization; free-form messages never classify errors."""

import unittest
from types import SimpleNamespace

from openai_codex.errors import (
    CodexRpcError,
    InvalidParamsError,
    InvalidRequestError,
    RetryLimitExceededError,
    ServerBusyError,
)
from openai_codex.generated.v2_all import TurnError

from codex_gateway.model_events import TurnEvents
from codex_gateway.runtime import execution_error


class FailureErrorTests(unittest.TestCase):
    def test_known_sdk_rpc_categories_have_fixed_safe_reasons(self):
        for data, code, reason in (
            ({"codexErrorInfo": "serverOverloaded"}, 14, "MODEL_BUSY"),
            ({"codex_error_info": "server_overloaded"}, 14, "MODEL_BUSY"),
            ({"errorInfo": "usageLimitExceeded"}, 8, "MODEL_QUOTA"),
            ({"codexErrorInfo": "sessionBudgetExceeded"}, 8, "MODEL_QUOTA"),
            ({"codexErrorInfo": "rateLimitExceeded"}, 8, "MODEL_RATE_LIMIT"),
            ({"codexErrorInfo": "unauthorized"}, 16, "MODEL_AUTH"),
            ({"codexErrorInfo": "badRequest"}, 3, "MODEL_INVALID_REQUEST"),
            (
                {"codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 400}}},
                3,
                "MODEL_INVALID_REQUEST",
            ),
            (
                {
                    "codexErrorInfo": {
                        "responseStreamConnectionFailed": {"httpStatusCode": 403}
                    }
                },
                16,
                "MODEL_AUTH",
            ),
            (
                {
                    "codexErrorInfo": {
                        "responseTooManyFailedAttempts": {"httpStatusCode": 429}
                    }
                },
                8,
                "MODEL_RATE_LIMIT",
            ),
            (
                {"codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 503}}},
                14,
                "MODEL_UNAVAILABLE",
            ),
            ({"codexErrorInfo": "other"}, 14, "MODEL_UNAVAILABLE"),
        ):
            with self.subTest(data=data):
                error = execution_error(
                    CodexRpcError(
                        -32000, "Private synthetic provider message and URL", data
                    )
                )
                self.assertEqual((error.code, error.reason), (code, reason))
                self.assertNotIn("Private", error.message)
                self.assertNotIn("URL", error.message)

    def test_typed_busy_and_unknown_retry_limit_are_not_usage_quota(self):
        busy = execution_error(ServerBusyError(-32000, "Private synthetic details"))
        self.assertEqual((busy.code, busy.reason), (14, "MODEL_BUSY"))
        retry_limit = execution_error(
            RetryLimitExceededError(-32000, "Private synthetic retry details")
        )
        self.assertEqual(
            (retry_limit.code, retry_limit.reason), (14, "MODEL_UNAVAILABLE")
        )

    def test_typed_invalid_request_and_params_are_not_model_outages(self):
        for error in (
            InvalidRequestError(-32600, "Private synthetic invalid request"),
            InvalidParamsError(-32602, "Private synthetic invalid schema"),
        ):
            failure = execution_error(error)
            self.assertEqual(
                (failure.code, failure.reason), (3, "MODEL_INVALID_REQUEST")
            )
            self.assertNotIn("Private", failure.message)

    def test_unknown_message_text_does_not_fabricate_auth_quota_or_busy(self):
        error = execution_error(
            RuntimeError(
                "Private synthetic text: 401 429 quota authentication server busy"
            )
        )
        self.assertEqual((error.code, error.reason), (14, "MODEL_UNAVAILABLE"))

    def test_failed_turn_retains_the_pinned_sdk_error_type(self):
        events = TurnEvents(None, True, False)
        with self.assertRaises(RuntimeError) as failed:
            events.observe(
                "turn/completed",
                {
                    "turn": {
                        "status": "failed",
                        "error": {
                            "message": "Private synthetic details",
                            "codexErrorInfo": "serverOverloaded",
                        },
                    }
                },
                SimpleNamespace(),
            )
        self.assertIsInstance(failed.exception.args[0], TurnError)
        self.assertEqual(execution_error(failed.exception).reason, "MODEL_BUSY")
