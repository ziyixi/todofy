"""ops/v1/ops.proto is the IDL of contracts/ops-v1, in Python (TypeScript twin: test/ops.test.ts).

Every fixture is the bytes the codec writes (the file itself, pretty-printed, after a read and a write, strict and
lenient); a strict read refuses every invalid fixture, as the generated JSON Schema does; a lenient read tolerates
exactly what ops-v1's consumer rules allow; and producers read the contract's bounds from the generated tables.
"""

import json
import unittest

from proto_test_support import REPO
from ziyixi_proto.ops.v1 import ops_pb as pb
from ziyixi_proto.wire_json import WireJsonError, field_rules, from_wire, to_wire, wire_name

OPS = REPO / "contracts" / "ops-v1" / "fixtures"
MESSAGES = {
    "CanaryDelivery": pb.CanaryDelivery,
    "CanaryResult": pb.CanaryResult,
    "GuardState": pb.GuardState,
    "OpsReport": pb.OpsReport,
    "OpsReportReceipt": pb.OpsReportReceipt,
    "OpsStatus": pb.OpsStatus,
    "SetGuardInput": pb.SetGuardInput,
    "StartCanaryInput": pb.StartCanaryInput,
    "StartCanaryResult": pb.StartCanaryResult,
}
# The invalid fixtures a lenient read accepts, with what it skipped (test/ops.test.ts LENIENT says why).
LENIENT = {
    "CanaryResult/ok-with-summary.json": ["summary"],
    "GuardState/unknown-level.json": ["level"],
    "OpsReport/item-with-text.json": ["items[0].text"],
    "OpsStatus/extra-field-subject.json": ["subject"],
    "StartCanaryInput/extra-field.json": ["to"],
    "StartCanaryResult/unknown-reason.json": [],
}


def pretty(value: object) -> str:
    """The fixtures' own layout: JSON.stringify(value, null, 2) and a newline."""
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


class FixturesTest(unittest.TestCase):
    def test_every_fixture_directory_is_a_message(self) -> None:
        self.assertEqual(sorted(p.name for p in OPS.iterdir() if p.name != "invalid"), sorted(MESSAGES))
        for path in (OPS / "invalid").iterdir():
            self.assertIn(path.name, MESSAGES)

    def test_every_valid_fixture_round_trips_file_bytes_included(self) -> None:
        for definition, cls in MESSAGES.items():
            for path in sorted((OPS / definition).glob("*.json")):
                text = path.read_text(encoding="utf-8")
                for strict in (True, False):
                    with self.subTest(f"{definition}/{path.name}", strict=strict):
                        read = from_wire(cls, json.loads(text), strict=strict)
                        self.assertEqual(read.unrecognized, [])
                        self.assertEqual(pretty(to_wire(read.message)), text)

    def test_a_strict_read_refuses_every_invalid_fixture_and_a_lenient_one_what_consumers_do(self) -> None:
        count = 0
        for definition, cls in MESSAGES.items():
            for path in (
                sorted((OPS / "invalid" / definition).glob("*.json")) if (OPS / "invalid" / definition).exists() else []
            ):
                key, value, count = f"{definition}/{path.name}", json.loads(path.read_text(encoding="utf-8")), count + 1
                with self.subTest(key):
                    with self.assertRaises(WireJsonError):
                        from_wire(cls, value, strict=True)
                    if key in LENIENT:
                        self.assertEqual(from_wire(cls, value).unrecognized, LENIENT[key])
                    else:
                        with self.assertRaises(WireJsonError):
                            from_wire(cls, value)
        self.assertGreaterEqual(count, 28)


class BoundsTest(unittest.TestCase):
    def test_the_bounds_producers_read_are_the_contracts(self) -> None:
        self.assertEqual(field_rules(pb.OpsStatus, "signals").max_items, 16)
        self.assertEqual(field_rules(pb.OpsStatus, "counters").max_items, 32)
        self.assertEqual(field_rules(pb.Signal, "metrics").max_items, 12)
        self.assertEqual(field_rules(pb.OpsReport, "items").max_items, 20)
        self.assertEqual(field_rules(pb.OpsStatus, "app").allowed, frozenset({"mail-hero", "todofy", "lab"}))
        self.assertEqual([wire_name(code) for code in list(pb.ErrorCode)[1:]], ["invalid_input", "busy", "unavailable"])


if __name__ == "__main__":
    unittest.main()
