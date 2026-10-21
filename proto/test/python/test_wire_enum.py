"""wire_name and wire_member (ziyixi_proto.wire_json), the twin of test/wire-enum.test.ts."""

import unittest

import proto_test_support  # noqa: F401  (puts the generated package on the path)
from ziyixi_proto.prototest.v1 import intent_pb as pb
from ziyixi_proto.wire_json import wire_member, wire_name

# The wire names of prototest/v1/intent.proto's enums, in value order (the TypeScript twin has the same lists).
NAMES = {
    "Mode": ["subtasks", "separate"],
    "State": ["pending", "created", "duplicate", "paused", "failed", "rejected", "not_found"],
    "ErrorCode": [
        "maintenance",
        "processing_paused",
        "todoist_paused",
        "todoist_blocked",
        "backup_active",
        "rate_limited",
        "retry_wait",
        "todoist_rejected",
        "todoist_result_unknown",
        "intent_conflict",
        "daily_limit",
        "url_not_allowed",
        "source_not_allowed",
    ],
}


class WireEnumTest(unittest.TestCase):
    def test_names_are_the_lower_case_values_without_the_prefix(self) -> None:
        for definition, cls in (("Mode", pb.Mode), ("State", pb.State), ("ErrorCode", pb.ErrorCode)):
            with self.subTest(definition):
                names = [wire_name(member) for member in cls if member != 0]
                self.assertEqual(names, NAMES[definition])
                self.assertEqual([wire_member(cls, name) for name in names], list(cls)[1:])

    def test_the_zero_value_has_no_name(self) -> None:
        self.assertIsNone(wire_name(pb.State.UNSPECIFIED))
        self.assertIsNone(wire_member(pb.State, "unspecified"))

    def test_a_lookup_is_exact(self) -> None:
        for name in ("SUBTASKS", "MODE_SUBTASKS", "ſubtasks", " subtasks", "", None, 1, True):
            with self.subTest(repr(name)):
                self.assertIsNone(wire_member(pb.Mode, name))


if __name__ == "__main__":
    unittest.main()
