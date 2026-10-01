"""wire_name and wire_member (ziyixi_proto.wire_json), the twin of test/wire-enum.test.ts."""

import json
import unittest

from proto_test_support import CONTRACT
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import wire_member, wire_name

SCHEMA = json.loads((CONTRACT / "task-intent-v1.schema.json").read_text(encoding="utf-8"))


class WireEnumTest(unittest.TestCase):
    def test_names_are_the_json_schema_enum(self) -> None:
        for definition, cls in (("Mode", pb.Mode), ("State", pb.State), ("ErrorCode", pb.ErrorCode)):
            with self.subTest(definition):
                names = [wire_name(member) for member in cls if member != 0]
                self.assertEqual(names, SCHEMA["$defs"][definition]["enum"])
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
