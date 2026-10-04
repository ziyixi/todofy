"""ops/v1/ops.proto is the IDL of contracts/ops-v1, in Python (TypeScript twin: test/ops.test.ts).

Every fixture is the bytes the codec writes (the file itself, pretty-printed, after a read and a write, strict and
lenient); a strict read refuses every invalid fixture, as the generated JSON Schema does; a lenient read tolerates
exactly what ops-v1's consumer rules allow; and producers read the contract's bounds from the generated tables.
"""

import dataclasses
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
    "OpsReport/item-with-text.json": ["items[0].text"],
    "OpsStatus/extra-field-subject.json": ["subject"],
    "OpsStatus/unknown-app.json": [],
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
        self.assertEqual(field_rules(pb.OpsStatus, "app").allowed, frozenset({"mail-hero", "todofy", "lab", "watch", "fleet", "newsletter", "notion-publish"}))
        self.assertTrue(field_rules(pb.OpsStatus, "app").open)  # an app may join within ops-v1
        self.assertEqual([wire_name(code) for code in list(pb.ErrorCode)[1:]], ["invalid_input", "busy", "unavailable"])

    def test_a_receipt_counts_at_most_the_items_a_report_holds(self) -> None:
        self.assertEqual(
            field_rules(pb.OpsReportReceipt, "item_count").maximum, field_rules(pb.OpsReport, "items").max_items
        )


class SchemaTest(unittest.TestCase):
    def test_every_defs_name_of_the_hand_written_schema_still_resolves(self) -> None:
        """Readers outside the monorepo may resolve "#/$defs/<name>" by the names the schema had before it was
        generated: each one is still there and says the same (descriptions aside), except that App lists the apps
        that joined since (the watch app, 2026-10-01) after the frozen ones: OpsStatus.app is an open list."""
        root = REPO / "contracts" / "ops-v1"
        legacy = json.loads((root / "legacy" / "ops-v1.schema.json").read_text(encoding="utf-8"))["$defs"]
        generated = json.loads((root / "ops-v1.schema.json").read_text(encoding="utf-8"))["$defs"]

        def resolved(entry: dict) -> dict:
            while "$ref" in entry:
                entry = generated[entry["$ref"].removeprefix("#/$defs/")]
            return {key: value for key, value in entry.items() if key != "description"}

        self.assertLessEqual(set(legacy), set(generated))
        for name in ("App", "Counters", "Metrics", "Modes", "OpsErrorCode"):
            with self.subTest(name):
                now = resolved(generated[name])
                was = {k: v for k, v in legacy[name].items() if k != "description"}
                if name == "App":
                    self.assertEqual(now["enum"][: len(was["enum"])], was["enum"])
                    self.assertEqual(now["enum"][len(was["enum"]) :], ["watch", "fleet", "newsletter", "notion-publish"])
                    now, was = {**now, "enum": None}, {**was, "enum": None}
                self.assertEqual(now, was)


class NonNullTest(unittest.TestCase):
    def test_every_required_enum_and_message_is_non_null_and_every_enum_on_the_wire_closed(self) -> None:
        checked = []
        for cls, fields in pb.FIELDS.items():
            for field in fields:
                if field.kind == "enum":
                    self.assertIn(field.ref, pb.CLOSED, field.ref.__name__)
                singular = not field.repeated and field.kind in ("enum", "message")
                if singular and field.required and not field.declared_optional:
                    self.assertTrue(field.rules.non_null, f"{cls.__name__}.{field.name}")
                    checked.append(f"{cls.__name__}.{field.name}")
        self.assertEqual(len(checked), 9)

    def test_a_producer_cannot_write_null_for_a_required_enum_or_message(self) -> None:
        status = from_wire(pb.OpsStatus, json.loads((OPS / "OpsStatus" / "lab-ok.json").read_text(encoding="utf-8")))
        for message, error in [
            (pb.CanaryDelivery(attempts=0), "state: required"),
            (pb.CanaryResult(), "state: required"),
            (pb.StartCanaryResult(), "state: required"),
            (dataclasses.replace(status.message, health=pb.Health.UNSPECIFIED), "health: required"),
            (dataclasses.replace(status.message, guard=None), "guard: required"),
            (pb.GuardState(), "level: required"),
        ]:
            with self.subTest(error), self.assertRaises(WireJsonError) as caught:
                to_wire(message)
            self.assertEqual(str(caught.exception), error)


if __name__ == "__main__":
    unittest.main()
