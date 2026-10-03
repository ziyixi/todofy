"""Synthetic JSON UI diagnostics: no OpenTofu, credentials, network or production values."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import apply_diagnostics as parser
import infra_state

RESOURCE = "cloudflare_zero_trust_tunnel_cloudflared.platform"
VERSION = {"@module": "tofu.ui", "type": "version", "ui": "1.2"}
PRIVATE = "short-secret"


def detail(status=403, errors=None, *, origin="https://api.cloudflare.com/client/v4"):
    return f'POST "{origin}/accounts/{"a" * 32}/private": {status} Error ' + json.dumps(
        {
            "errors": errors
            if errors is not None
            else [{"code": 10000, "message": PRIVATE}],
            "result": {"value": PRIVATE},
        }
    )


def diagnostic(address=RESOURCE, text=None):
    return {
        "@module": "tofu.ui",
        "@message": PRIVATE,
        "type": "diagnostic",
        "diagnostic": {
            "severity": "error",
            "summary": PRIVATE,
            "address": address,
            "detail": detail() if text is None else text,
            "snippet": {"code": PRIVATE},
        },
    }


def decode(*records, addresses=None):
    return parser.diagnostics(
        [json.dumps(VERSION), *(json.dumps(record) for record in records)],
        {RESOURCE: RESOURCE} if addresses is None else addresses,
    )


class Diagnostics(unittest.TestCase):
    def test_only_three_safe_fields_survive_and_interleaved_resources_stay_associated(
        self,
    ):
        second = 'cloudflare_dns_record.platform["runtime"]'
        records = (
            diagnostic(),
            {"@module": "tofu.ui", "type": "outputs", "outputs": {"value": PRIVATE}},
            diagnostic(second, detail(400, [{"code": 2005, "message": PRIVATE}])),
        )
        result = decode(*records, addresses={RESOURCE: RESOURCE, second: second})
        self.assertEqual(
            result,
            [
                {"resource": RESOURCE, "http_status": 403, "api_codes": [10000]},
                {"resource": second, "http_status": 400, "api_codes": [2005]},
            ],
        )
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertNotIn("https", json.dumps(result))
        self.assertNotIn("a" * 32, json.dumps(result))

    def test_unknown_address_and_injection_cannot_be_printed(self):
        for address in (
            "unmanaged.resource",
            PRIVATE,
            [RESOURCE],
            RESOURCE + "\n::warning::" + PRIVATE,
            f'cloudflare_dns_record.platform["{PRIVATE}"]',
            "\x1b[31m" + RESOURCE,
        ):
            with self.subTest(address_type=type(address).__name__):
                result = decode(diagnostic(address))
                self.assertEqual(result[0]["resource"], None)
                self.assertNotIn(PRIVATE, json.dumps(result))

    def test_only_bounded_integer_codes_from_the_cloudflare_errors_array_are_returned(
        self,
    ):
        codes = [10000, True, "123", 1.5, -1, 100_000_000, 10000]
        result = decode(
            diagnostic(text=detail(errors=[{"code": code} for code in codes]))
        )
        self.assertEqual(result[0]["api_codes"], [10000])
        result = decode(
            diagnostic(text=detail(errors=[{"code": code} for code in range(20)]))
        )
        self.assertEqual(result[0]["api_codes"], list(range(parser.MAX_API_CODES)))

    def test_foreign_urls_timeouts_and_malformed_responses_never_imply_http_status(
        self,
    ):
        for text in (
            PRIVATE,
            'GET "https://other.invalid/private": 403 ' + PRIVATE,
            'POST "https://api.cloudflare.com/client/v4/private": 999 ' + PRIVATE,
            'POST "https://api.cloudflare.com.evil.invalid/client/v4/private": 403 '
            + PRIVATE,
            'POST "https://api.cloudflare.com/client/v4/private"\n: 403 ' + PRIVATE,
            detail(origin="http://api.cloudflare.com/client/v4"),
        ):
            with self.subTest(text_shape=len(text)):
                self.assertEqual(
                    decode(diagnostic(text=text))[0],
                    {"resource": RESOURCE, "http_status": None, "api_codes": []},
                )
        self.assertEqual(
            decode(
                diagnostic(
                    text='POST "https://api.cloudflare.com/client/v4/x": 429 HTML'
                )
            )[0],
            {"resource": RESOURCE, "http_status": 429, "api_codes": []},
        )

    def test_ui_version_duplicates_nonfinite_and_oversized_input_fail_closed(self):
        line = json.dumps(diagnostic())
        for version in (None, "0.1", "2.0", PRIVATE, 1):
            version_record = {**VERSION, "ui": version}
            self.assertEqual(
                parser.diagnostics(
                    [json.dumps(version_record), line], {RESOURCE: RESOURCE}
                ),
                [],
            )
        self.assertEqual(parser.diagnostics([line], {RESOURCE: RESOURCE}), [])
        malformed = (
            '{"@module":"tofu.ui","type":"diagnostic","diagnostic":{},"diagnostic":null}',
            '{"@module":"tofu.ui","type":"diagnostic","diagnostic":NaN}',
            "x" * (parser.MAX_LINE + 1),
        )
        for record in malformed:
            self.assertEqual(
                parser.diagnostics([json.dumps(VERSION), record], {RESOURCE: RESOURCE}),
                [],
            )
        self.assertIsNone(
            decode(diagnostic(text="x" * (parser.MAX_DETAIL + 1)))[0]["http_status"]
        )
        duplicate_body = 'POST "https://api.cloudflare.com/client/v4/x": 403 {"errors":[],"errors":[{"code":1}]}'
        self.assertEqual(decode(diagnostic(text=duplicate_body))[0]["api_codes"], [])

    def test_warning_and_other_messages_are_not_diagnostics_and_output_is_bounded(self):
        warning = diagnostic()
        warning["diagnostic"]["severity"] = "warning"
        self.assertEqual(decode(warning), [])
        wrong_module = {**diagnostic(), "@module": PRIVATE}
        self.assertEqual(decode(wrong_module), [])
        result = decode(*(diagnostic(text=detail(400 + code)) for code in range(10)))
        self.assertEqual(len(result), parser.MAX_DIAGNOSTICS)


class Driver(unittest.TestCase):
    def test_gated_addresses_use_existing_key_redaction_and_ignore_old_log_diagnostics(
        self,
    ):
        raw = f'cloudflare_zero_trust_access_application.owner["{PRIVATE}"]'
        plan = {
            "resource_changes": [
                {
                    "mode": "managed",
                    "type": "cloudflare_zero_trust_access_application",
                    "address": raw,
                },
                {"mode": "data", "type": "cloudflare_dns_record", "address": RESOURCE},
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "private.log"
            log.write_text(
                "\n".join((json.dumps(VERSION), json.dumps(diagnostic()))) + "\n"
            )
            tofu = infra_state.Tofu({}, log)

            def run(*args):
                self.assertIn("-json", args)
                with log.open("a") as output:
                    output.write(
                        "\n".join((json.dumps(VERSION), json.dumps(diagnostic(raw))))
                        + "\n"
                    )
                return 1

            with patch.object(tofu, "run", run), self.assertRaises(infra_state.Refused):
                tofu.apply(Path(directory) / "saved.tfplan", diagnostic_plan=plan)
            result = tofu.apply_diagnostics()
        self.assertEqual(
            result,
            [
                {
                    "resource": 'cloudflare_zero_trust_access_application.owner["<key 1>"]',
                    "http_status": 403,
                    "api_codes": [10000],
                }
            ],
        )
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_import_only_apply_keeps_its_existing_arguments_and_no_public_diagnostics(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            tofu = infra_state.Tofu({}, Path(directory) / "private.log")
            with patch.object(tofu, "run", return_value=0) as run:
                tofu.apply(Path(directory) / "import.tfplan")
            self.assertNotIn("-json", run.call_args.args)
            self.assertEqual(tofu.apply_diagnostics(), [])


if __name__ == "__main__":
    unittest.main()
