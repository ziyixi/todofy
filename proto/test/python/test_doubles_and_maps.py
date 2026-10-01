"""Doubles and maps beyond what JSON can spell (TypeScript twin: test/doubles-and-maps.test.ts).

The shared cases (testdata/wire-profile-cases.json) are JSON, which has no NaN or infinity; json.loads and
hand-built messages do, and the codec refuses them on both sides.
"""

import json
import math
import unittest

from proto_test_support import compact
from ziyixi_proto.prototest.v1 import prototest_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire


class DoublesAndMapsTest(unittest.TestCase):
    def test_non_finite_doubles_are_refused_on_read(self) -> None:
        for text in ('{"rating": NaN}', '{"rating": Infinity}', '{"edition_ratings": [-Infinity]}'):
            with self.subTest(text), self.assertRaises(WireJsonError):
                from_wire(pb.Book, json.loads(text))

    def test_non_finite_doubles_are_refused_on_write(self) -> None:
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value), self.assertRaises(WireJsonError):
                to_wire(pb.Book(rating=value))

    def test_a_zero_enum_map_value_cannot_be_written(self) -> None:
        with self.assertRaises(WireJsonError):
            to_wire(pb.Book(regional_genres={"eu": pb.Genre.UNSPECIFIED}))

    def test_the_writer_refuses_scalars_a_reader_would_refuse(self) -> None:
        for book in (
            pb.Book(pages=1.5),  # type: ignore[arg-type]
            pb.Book(pages=2**31),
            pb.Book(pages=True),
            pb.Book(copies={"a": -0.5}),  # type: ignore[dict-item]
            pb.Book(title=7),  # type: ignore[arg-type]
            pb.Book(hardcover=1),  # type: ignore[arg-type]
        ):
            with self.subTest(book=book), self.assertRaises(WireJsonError):
                to_wire(book)

    def test_map_entries_set_in_any_order_write_the_same_bytes(self) -> None:
        first = pb.Book(copies={"b": 1, "a": 2})
        second = pb.Book(copies={"a": 2, "b": 1})
        self.assertEqual(compact(to_wire(first)), compact(to_wire(second)))
        self.assertEqual(compact(to_wire(first)), '{"copies":{"a":2,"b":1}}')


if __name__ == "__main__":
    unittest.main()
