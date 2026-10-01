"""The value rules beyond the shared read cases, in Python (TypeScript twin: test/wire-rules.test.ts): a write checks
them too, a consumer passes on what it read (``to_wire(lenient=True)``), errors name a path and a rule but never the
value, and producers read bounds from the generated tables (``field_rules``). Also what the generators refuse
(tools/wire_rules.py): a rule that cannot mean anything where it is written stops generation.
"""

import copy
import dataclasses
import sys
import unittest

from proto_test_support import PROTO
from ziyixi_proto.prototest.v1 import rules_pb as pb
from ziyixi_proto.wire_json import WireJsonError, field_rules, format_matches, from_wire, to_wire

sys.path.insert(0, str(PROTO / "tools"))
import wire_rules

SENT = pb.Parcel(status=pb.Parcel_Status.SENT, code="box_1", tracking_id="AB1234", attempts=1, weights={"base": 1.0})


class WriteTest(unittest.TestCase):
    def test_a_valid_message_is_written(self) -> None:
        self.assertEqual(
            to_wire(SENT),
            {"status": "sent", "code": "box_1", "tracking_id": "AB1234", "attempts": 1, "weights": {"base": 1}},
        )

    def test_a_write_checks_every_rule(self) -> None:
        for change, error in [
            ({"code": "Box 1"}, "code: does not match Code"),
            ({"tracking_id": None}, "tracking_id: required when the discriminator is sent"),
            ({"attempts": 0}, "attempts: below the minimum"),
            (
                {"status": pb.Parcel_Status.LOST, "tracking_id": None, "reason": "burnt"},
                "reason: not an allowed value",
            ),
            ({"weights": {"base": 1.0, "owner@example.com": 2.0}}, "weights{}: a key does not match Code"),
            ({"lines": (pb.ParcelLine(sku="pen", quantity=100),)}, "lines[0].quantity: above the maximum"),
        ]:
            with self.subTest(error):
                with self.assertRaises(WireJsonError) as caught:
                    to_wire(dataclasses.replace(SENT, **change))
                self.assertEqual(str(caught.exception), error)

    def test_an_error_names_the_path_and_the_rule_never_the_value(self) -> None:
        with self.assertRaises(WireJsonError) as caught:
            to_wire(dataclasses.replace(SENT, weights={"base": 1.0, "Mail from boss@example.com": 2.0}))
        self.assertNotIn("boss", str(caught.exception))

    def test_a_consumer_passes_on_a_value_of_an_open_list_it_read(self) -> None:
        wire = {
            "status": "lost",
            "code": "box_1",
            "tracking_id": None,
            "attempts": 2,
            "reason": "burnt",
            "weights": {"base": 1},
        }
        read = from_wire(pb.Parcel, wire)
        self.assertEqual(to_wire(read.message, lenient=True)["reason"], "burnt")
        with self.assertRaises(WireJsonError):
            to_wire(read.message)
        with self.assertRaises(WireJsonError):
            to_wire(dataclasses.replace(read.message, reason="Burnt"), lenient=True)


class FieldRulesTest(unittest.TestCase):
    def test_producers_read_bounds_from_the_tables(self) -> None:
        self.assertEqual(field_rules(pb.Parcel, "tags").max_items, 3)
        self.assertEqual(field_rules(pb.Parcel, "weights").required_keys, ("base",))
        self.assertEqual(field_rules(pb.Parcel, "score").maximum, 1)
        self.assertEqual(field_rules(pb.Parcel, "counts").max_items, 0)
        with self.assertRaises(KeyError):
            field_rules(pb.Parcel, "missing")

    def test_format_matches_checks_a_value_against_a_format_anchored_with_its_length(self) -> None:
        self.assertTrue(format_matches(pb.FORMATS["Code"], "box_1"))
        for value in ("Box", "box\n", "", "a" * 17):
            self.assertFalse(format_matches(pb.FORMATS["Code"], value), value)
        self.assertTrue(format_matches(pb.FORMATS["Tracking"], "AB123456"))
        self.assertFalse(format_matches(pb.FORMATS["Tracking"], "AB1234567"))


def image(*fields: dict, message_options: dict | None = None, formats: list | None = None) -> dict:
    """A one-file buf image (JSON form) whose message `M` has `fields` and an enum `M.State`."""
    message = {
        "name": "M",
        "field": [
            {"name": "state", "number": 1, "label": "LABEL_OPTIONAL", "type": "TYPE_ENUM", "typeName": ".t.v1.M.State"},
            *fields,
        ],
        "enumType": [
            {"name": "State", "value": [{"name": "STATE_UNSPECIFIED", "number": 0}, {"name": "STATE_ON", "number": 1}]}
        ],
    }
    if message_options is not None:
        message["options"] = message_options
    file = {"name": "t/v1/t.proto", "package": "t.v1", "syntax": "proto3", "messageType": [message]}
    if formats is not None:
        file["options"] = {"[common.wire.v1.formats]": formats}
    return {"file": [file]}


def field(name: str, kind: str, rules: dict, **extra) -> dict:
    return {
        "name": name,
        "number": 2,
        "label": "LABEL_OPTIONAL",
        "type": kind,
        "options": {"[common.wire.v1.field]": rules},
        **extra,
    }


CODE = {"name": "Code", "pattern": "[a-z]+"}
UNION = {"[common.wire.v1.message]": {"discriminator": "state"}}


class GeneratorChecksTest(unittest.TestCase):
    def test_well_placed_rules_pass(self) -> None:
        wire_rules.check_image(image(field("a", "TYPE_STRING", {"format": "Code", "allowed": ["x"]}), formats=[CODE]))
        wire_rules.check_image(
            image(
                field(
                    "a",
                    "TYPE_STRING",
                    {"cases": [{"when": ["on"], "presence": "PRESENCE_REQUIRED"}]},
                    proto3Optional=True,
                ),
                message_options=UNION,
            )
        )

    def test_misplaced_rules_stop_generation(self) -> None:
        for name, bad in [
            ("an unknown format", image(field("a", "TYPE_STRING", {"format": "Nope"}), formats=[CODE])),
            ("a format on a number", image(field("a", "TYPE_INT32", {"format": "Code"}), formats=[CODE])),
            ("allowed on a number", image(field("a", "TYPE_INT32", {"allowed": ["1"]}))),
            ("bounds on a string", image(field("a", "TYPE_STRING", {"minimum": 1}))),
            ("minimum above maximum", image(field("a", "TYPE_INT32", {"minimum": 2, "maximum": 1}))),
            ("open without a list", image(field("a", "TYPE_STRING", {"open": True}))),
            ("max_items on a singular field", image(field("a", "TYPE_STRING", {"maxItems": 2}))),
            ("unique on a singular field", image(field("a", "TYPE_STRING", {"unique": True}))),
            ("keep_order on a list", image(field("a", "TYPE_STRING", {"keepOrder": True}, label="LABEL_REPEATED"))),
            (
                "cases without a discriminator",
                image(field("a", "TYPE_STRING", {"otherwise": "PRESENCE_ABSENT"}, proto3Optional=True)),
            ),
            (
                "a case value the discriminator does not have",
                image(
                    field("a", "TYPE_STRING", {"cases": [{"when": ["off"]}]}, proto3Optional=True),
                    message_options=UNION,
                ),
            ),
            (
                "presence on an implicit scalar",
                image(field("a", "TYPE_STRING", {"otherwise": "PRESENCE_ABSENT"}), message_options=UNION),
            ),
            (
                "an enum value allowed list naming no value",
                image({**field("a", "TYPE_ENUM", {"allowed": ["off"]}), "typeName": ".t.v1.M.State"}),
            ),
            (
                "a discriminator that is not an enum",
                image(
                    field("a", "TYPE_STRING", {}), message_options={"[common.wire.v1.message]": {"discriminator": "a"}}
                ),
            ),
            ("a pattern ECMAScript reads differently", image(formats=[{"name": "Digits", "pattern": "\\d+"}])),
            ("an anchored pattern", image(formats=[{"name": "Code", "pattern": "^[a-z]+$"}])),
            ("a format defined twice", image(formats=[CODE, copy.deepcopy(CODE)])),
            ("a format name that is not PascalCase", image(formats=[{"name": "code", "pattern": "[a-z]+"}])),
        ]:
            with self.subTest(name), self.assertRaises(wire_rules.RuleError):
                wire_rules.check_image(bad)


if __name__ == "__main__":
    unittest.main()
