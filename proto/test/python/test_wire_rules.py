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
            (
                {
                    "status": pb.Parcel_Status.WAITING,
                    "tracking_id": None,
                    "attempts": 0,
                    "lines": (pb.ParcelLine(sku="pen", quantity=1),),
                },
                "lines: not empty when the discriminator is waiting",
            ),
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


LABEL = pb.Label(priority=pb.Priority.HIGH, status=pb.Parcel_Status.SENT, line=pb.ParcelLine(sku="pen", quantity=2))
WAITING = {"status": "waiting", "code": "box_1", "tracking_id": None, "attempts": 0, "weights": {"base": 1}}


class NonNullAndClosedTest(unittest.TestCase):
    def test_a_write_refuses_a_non_null_field_without_a_value(self) -> None:
        self.assertEqual(
            to_wire(LABEL),
            {"priority": "high", "status": "sent", "line": {"sku": "pen", "quantity": 2}, "previous": None},
        )
        for change, error in [
            ({"priority": pb.Priority.UNSPECIFIED}, "priority: required"),
            ({"status": pb.Parcel_Status.UNSPECIFIED}, "status: required"),
            ({"line": None}, "line: required"),
        ]:
            with self.subTest(error):
                with self.assertRaises(WireJsonError) as caught:
                    to_wire(dataclasses.replace(LABEL, **change))
                self.assertEqual(str(caught.exception), error)
                with self.assertRaises(WireJsonError):
                    to_wire(dataclasses.replace(LABEL, **change), lenient=True)

    def test_a_lenient_read_refuses_null_where_non_null_and_names_the_path(self) -> None:
        wire = to_wire(LABEL)
        for name in ("priority", "status", "line"):
            with self.subTest(name), self.assertRaises(WireJsonError) as caught:
                from_wire(pb.Label, {**wire, name: None})
            self.assertEqual(str(caught.exception), f"{name}: required")

    def test_a_newer_name_of_an_open_non_null_enum_is_read_but_cannot_be_passed_on(self) -> None:
        # The value is a value (non_null holds on the read); this build cannot write it, so passing it on is refused
        # rather than turned into null. A contract whose consumers pass messages on closes such an enum instead.
        read = from_wire(pb.Label, {**to_wire(LABEL), "status": "returned"})
        self.assertEqual(read.unrecognized, ["status"])
        with self.assertRaises(WireJsonError) as caught:
            to_wire(read.message, lenient=True)
        self.assertEqual(str(caught.exception), "status: required")

    def test_a_closed_enum_refuses_an_unknown_name_on_every_read(self) -> None:
        for strict in (False, True):
            with self.subTest(strict=strict), self.assertRaises(WireJsonError) as caught:
                from_wire(pb.Label, {**to_wire(LABEL), "priority": "urgent"}, strict=strict)
            self.assertEqual(str(caught.exception), "priority: unknown enum value")

    def test_a_list_item_after_a_dropped_enum_name_is_checked_at_its_own_index(self) -> None:
        with self.assertRaises(WireJsonError) as caught:
            from_wire(pb.Parcel, {**WAITING, "next": ["zzz_new", "waiting"]})
        self.assertEqual(str(caught.exception), "next[1]: not an allowed value")
        with self.assertRaises(WireJsonError) as caught:
            from_wire(pb.Parcel, {**WAITING, "next": ["sent", "zzz_a", "zzz_b", "waiting"]})
        self.assertEqual(str(caught.exception), "next[3]: not an allowed value")
        read = from_wire(pb.Parcel, {**WAITING, "next": ["zzz_new", "sent"]})
        self.assertEqual((read.message.next, read.unrecognized), ((pb.Parcel_Status.SENT,), ["next[0]"]))


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


def field(name: str, kind: str, rules: dict, options_required: bool = False, **extra) -> dict:
    """A field with these rules; ``options_required`` adds (google.api.field_behavior) = REQUIRED."""
    options: dict = {"[common.wire.v1.field]": rules}
    if options_required:
        options["[google.api.field_behavior]"] = ["REQUIRED"]
    return {"name": name, "number": 2, "label": "LABEL_OPTIONAL", "type": kind, "options": options, **extra}


ENUM = {"typeName": ".t.v1.M.State"}


CODE = {"name": "Code", "pattern": "[a-z]+"}
UNION = {"[common.wire.v1.message]": {"discriminator": "state"}}


class GeneratorChecksTest(unittest.TestCase):
    def test_well_placed_rules_pass(self) -> None:
        wire_rules.check_image(image(field("a", "TYPE_STRING", {"format": "Code", "allowed": ["x"]}), formats=[CODE]))
        wire_rules.check_image(
            image(
                field(
                    "a", "TYPE_STRING", {"cases": [{"when": ["on"], "rules": {"empty": True}}]}, label="LABEL_REPEATED"
                ),
                message_options=UNION,
            )
        )
        wire_rules.check_image(image(field("a", "TYPE_ENUM", {"nonNull": True}, options_required=True, **ENUM)))
        wire_rules.check_image(
            image(field("a", "TYPE_MESSAGE", {"nonNull": True}, options_required=True, typeName=".t.v1.M"))
        )
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
            (
                "a case rule other than allowed, minimum, maximum and empty (an image edited by hand)",
                image(
                    field(
                        "a",
                        "TYPE_STRING",
                        {"cases": [{"when": ["on"], "rules": {"format": "Nope", "maxItems": 0}}]},
                        proto3Optional=True,
                    ),
                    message_options=UNION,
                ),
            ),
            (
                "a case's empty on a singular field",
                image(
                    field("a", "TYPE_STRING", {"cases": [{"when": ["on"], "rules": {"empty": True}}]}),
                    message_options=UNION,
                ),
            ),
            (
                "a case's size bound (CaseRules has `empty`, never a max_items whose 0 would mean the opposite)",
                image(
                    field(
                        "a",
                        "TYPE_STRING",
                        {"cases": [{"when": ["on"], "rules": {"maxItems": 0}}]},
                        label="LABEL_REPEATED",
                    ),
                    message_options=UNION,
                ),
            ),
            (
                "a JSON Schema format the generator does not know",
                image(formats=[{**CODE, "jsonSchemaFormat": "email"}]),
            ),
            ("non_null on a field that is not REQUIRED", image(field("a", "TYPE_ENUM", {"nonNull": True}, **ENUM))),
            ("non_null on a scalar", image(field("a", "TYPE_STRING", {"nonNull": True}, options_required=True))),
            (
                "non_null on a field declared optional",
                image(field("a", "TYPE_ENUM", {"nonNull": True}, options_required=True, proto3Optional=True, **ENUM)),
            ),
            (
                "non_null on a list",
                image(
                    field("a", "TYPE_ENUM", {"nonNull": True}, options_required=True, label="LABEL_REPEATED", **ENUM)
                ),
            ),
            (
                "non_null on a field a case makes absent",
                image(
                    field(
                        "a",
                        "TYPE_ENUM",
                        {"nonNull": True, "otherwise": "PRESENCE_ABSENT"},
                        options_required=True,
                        **ENUM,
                    ),
                    message_options=UNION,
                ),
            ),
        ]:
            with self.subTest(name), self.assertRaises(wire_rules.RuleError):
                wire_rules.check_image(bad)


if __name__ == "__main__":
    unittest.main()
