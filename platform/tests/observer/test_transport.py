"""HTTP library boundary uses synthetic streams; no network or private credentials."""

import json
import unittest

import httpx
from personal_cloud.observer.transport import ObserverError, _request


class Transport(unittest.TestCase):
    def test_response_is_bounded_and_redirects_do_not_forward_credentials(self):
        calls = []

        def remote(request):
            calls.append(request)
            return httpx.Response(307, headers={"location": "https://foreign.example/"})

        self.assertEqual(
            _request(
                "https://fleet.example/",
                headers={"X-Fleet-Signature": "synthetic"},
                transport=httpx.MockTransport(remote),
            ),
            (307, None),
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].headers["accept-encoding"], "identity")
        oversized = httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-type": "application/json"},
                stream=httpx.ByteStream(b"1234567890"),
            )
        )
        with self.assertRaises(ObserverError) as error:
            _request("https://fleet.example/", limit=9, transport=oversized)
        self.assertEqual(str(error.exception), "response_too_large")

    def test_only_plain_json_metadata_is_decoded_and_errors_are_safe(self):
        body = json.dumps(
            {"version": "fleet-receipt-v1", "accepted": True, "sequence": 2}
        ).encode()
        valid = httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-type": "application/json; charset=utf-8"},
                stream=httpx.ByteStream(body),
            )
        )
        self.assertEqual(
            _request("https://fleet.example/", data=b"synthetic", transport=valid)[1][
                "sequence"
            ],
            2,
        )
        for headers in (
            {"content-type": "text/html"},
            {"content-type": "application/json", "content-encoding": "gzip"},
        ):
            with self.subTest(headers=headers), self.assertRaises(ObserverError):
                invalid = httpx.MockTransport(
                    lambda request, response_headers=headers: httpx.Response(
                        200, headers=response_headers, stream=httpx.ByteStream(body)
                    )
                )
                _request("https://fleet.example/", transport=invalid)
