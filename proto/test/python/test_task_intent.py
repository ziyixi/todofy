"""task_intent.proto mirrors contracts/task-intent-v1 exactly, in Python (TypeScript twin: test/task-intent.test.ts).

The generated enums and field tables equal the JSON Schema's, every valid fixture reads (strict for inputs,
lenient for outputs) and writes back to the same compact bytes, a strict read refuses what the structure
can see, and a newer producer's answer reads leniently into the default branch.
"""

import json
import unittest

from proto_test_support import CONTRACT, compact, fixtures
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

SCHEMA = json.loads((CONTRACT / "task-intent-v1.schema.json").read_text(encoding="utf-8"))
# The invalid TaskIntent fixtures a strict read refuses on its own; every other one breaks a value rule.
STRUCTURAL = {
    "missing-parent.json",
    "unknown-item-field.json",
    "unknown-mode.json",
    "unknown-source.json",
    "unknown-top-field.json",
}


# A newer Todofy's answer: one more state, one more error code and one more field than this IDL knows.
NEWER = {
    **dict(fixtures("TaskIntentResult"))["created.json"],
    "state": "archived",
    "error_code": "quota_exhausted",
    "hint_code": "synthetic_hint",
}


def wire_names(cls: type) -> list[str]:
    return [member.name.lower() for member in cls if member != 0]


def branch(result: pb.TaskIntentResult) -> str:
    """The shape of a consumer's branch on the state: every known state, then a default."""
    match result.state:
        case pb.State.PENDING | pb.State.PAUSED:
            return "poll"
        case pb.State.CREATED | pb.State.DUPLICATE:
            return "done"
        case pb.State.FAILED | pb.State.REJECTED | pb.State.NOT_FOUND:
            return "final"
        case _:
            return "unknown_poll_later"


class IdlEqualsSchemaTest(unittest.TestCase):
    def test_enums(self) -> None:
        for definition, cls in (
            ("Source", pb.Source),
            ("Mode", pb.Mode),
            ("State", pb.State),
            ("ErrorCode", pb.ErrorCode),
        ):
            with self.subTest(definition):
                self.assertEqual(wire_names(cls), SCHEMA["$defs"][definition]["enum"])
                self.assertEqual(cls(0).name, "UNSPECIFIED")

    def test_fields(self) -> None:
        for definition, cls in (
            ("Parent", pb.TaskIntentParent),
            ("Item", pb.TaskIntentItem),
            ("TaskIntent", pb.TaskIntent),
            ("TaskIntentRef", pb.TaskIntentRef),
            ("TaskIntentResult", pb.TaskIntentResult),
        ):
            with self.subTest(definition):
                names = [field.name for field in pb.FIELDS[cls]]
                self.assertEqual(names, list(SCHEMA["$defs"][definition]["properties"]))


class RoundTripTest(unittest.TestCase):
    def test_inputs_read_strictly_and_keep_their_bytes(self) -> None:
        for definition, cls in (("TaskIntent", pb.TaskIntent), ("TaskIntentRef", pb.TaskIntentRef)):
            for name, value in fixtures(definition):
                with self.subTest(f"{definition}/{name}"):
                    self.assertEqual(compact(to_wire(from_wire(cls, value, strict=True).message)), compact(value))

    def test_results_read_leniently_and_keep_their_bytes(self) -> None:
        for name, value in fixtures("TaskIntentResult"):
            with self.subTest(name):
                read = from_wire(pb.TaskIntentResult, value)
                self.assertEqual(read.unrecognized, [])
                self.assertEqual(compact(to_wire(read.message)), compact(value))


class StrictReadTest(unittest.TestCase):
    def test_refuses_structural_errors_only(self) -> None:
        for name, value in fixtures("TaskIntent", invalid=True):
            with self.subTest(name):
                if name in STRUCTURAL:
                    with self.assertRaises(WireJsonError):
                        from_wire(pb.TaskIntent, value, strict=True)
                else:
                    # Lengths, patterns, item counts and URL hosts stay with the contract's own validation.
                    from_wire(pb.TaskIntent, value, strict=True)


class NewerProducerTest(unittest.TestCase):
    def test_lenient_read_takes_the_default_branch(self) -> None:
        read = from_wire(pb.TaskIntentResult, NEWER)
        self.assertEqual(read.unrecognized, ["state", "error_code", "hint_code"])
        self.assertEqual(read.message.state, pb.State.UNSPECIFIED)
        self.assertEqual(read.message.error_code, pb.ErrorCode.UNSPECIFIED)
        self.assertEqual(branch(read.message), "unknown_poll_later")
        self.assertEqual(read.message.tasks_created, 4)

    def test_strict_read_refuses(self) -> None:
        with self.assertRaises(WireJsonError):
            from_wire(pb.TaskIntentResult, NEWER, strict=True)


if __name__ == "__main__":
    unittest.main()
