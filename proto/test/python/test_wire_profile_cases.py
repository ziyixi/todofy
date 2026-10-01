"""The shared edge cases of the wire JSON profile in Python (TypeScript twin: test/wire-profile-cases.test.ts).

Both suites run testdata/wire-profile-cases.json, so the two codecs give the same verdict and the same
bytes on every case: timestamps, integer and double spellings, enum look-alikes, maps, missing REQUIRED fields.
"""

import json
import unittest

from proto_test_support import CASES_FILE, compact
from ziyixi_proto.prototest.v1 import prototest_pb
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

CASES = json.loads(CASES_FILE.read_text(encoding="utf-8"))["cases"]
# task-intent-v1 messages by short name, the fixtures of prototest/v1 by full name.
MESSAGES = {
    "TaskIntent": pb.TaskIntent,
    "TaskIntentRef": pb.TaskIntentRef,
    "TaskIntentResult": pb.TaskIntentResult,
    "prototest.v1.Book": prototest_pb.Book,
    "prototest.v1.BookCard": prototest_pb.BookCard,
}


class WireProfileCasesTest(unittest.TestCase):
    def test_the_file_has_every_case_each_under_its_own_name(self) -> None:
        # 34 when this suite was ported from the spike; cases are only ever added (the TS suite checks the same).
        self.assertGreaterEqual(len(CASES), 34)
        self.assertEqual(len({case["name"] for case in CASES}), len(CASES))

    def test_cases(self) -> None:
        for case in CASES:
            with self.subTest(case["name"]):
                cls = MESSAGES[case["message"]]
                if case.get("error"):
                    with self.assertRaises(WireJsonError):
                        from_wire(cls, case["input"], strict=case["strict"])
                    continue
                read = from_wire(cls, case["input"], strict=case["strict"])
                self.assertEqual(read.unrecognized, case["unrecognized"])
                self.assertEqual(compact(to_wire(read.message)), compact(case["wire"]))


if __name__ == "__main__":
    unittest.main()
