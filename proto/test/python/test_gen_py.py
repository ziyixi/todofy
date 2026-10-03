"""tools/gen_py.py and the wheel (python/build_backend.py): which packages Python gets, FieldMask fields, fields named
like Python keywords and string literals above U+FFFF.

Synthetic buf images only: no generated module is read, so these tests say what the generator does with
a package before any .proto file uses it.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

from proto_test_support import PROTO
from ziyixi_proto.prototest.v1 import prototest_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

sys.path.insert(0, str(PROTO / "tools"))
sys.path.insert(0, str(PROTO / "python"))
import build_backend
import gen_py

STRING = {"name": "id", "number": 1, "label": "LABEL_OPTIONAL", "type": "TYPE_STRING", "jsonName": "id"}


def file(name: str, package: str, *messages: dict) -> dict:
    return {"name": name, "package": package, "syntax": "proto3", "messageType": list(messages)}


class PackagesTest(unittest.TestCase):
    def test_only_the_python_packages_are_generated(self) -> None:
        # A TypeScript-only package may use what the Python profile lacks (here a real oneof).
        ui = file(
            "lab/ui/v1/home.proto",
            "lab.ui.v1",
            {"name": "Choice", "field": [{**STRING, "oneofIndex": 0}], "oneofDecl": [{"name": "kind"}]},
        )
        intents = file(
            "todofy/taskintent/v1/task_intent.proto", "todofy.taskintent.v1", {"name": "Ref", "field": [STRING]}
        )
        out = gen_py.generate({"file": [ui, intents]})
        self.assertIn("todofy/taskintent/v1/task_intent_pb.py", out)
        self.assertFalse([path for path in out if path.startswith("lab/")])

    def test_a_python_package_cannot_name_a_typescript_only_type(self) -> None:
        ui = file("lab/ui/v1/paper.proto", "lab.ui.v1", {"name": "Paper", "field": [STRING]})
        ref = {
            "name": "paper",
            "number": 1,
            "label": "LABEL_OPTIONAL",
            "type": "TYPE_MESSAGE",
            "typeName": ".lab.ui.v1.Paper",
        }
        intents = file(
            "todofy/taskintent/v1/task_intent.proto", "todofy.taskintent.v1", {"name": "Item", "field": [ref]}
        )
        with self.assertRaises(gen_py.GenerateError):
            gen_py.generate({"file": [ui, intents]})

    def test_the_wheel_leaves_the_test_only_packages_out(self) -> None:
        self.assertEqual(
            {name.split(".")[0] for name, shipped in gen_py.PYTHON_PACKAGES.items() if not shipped},
            set(build_backend.TEST_ONLY_PACKAGES),
        )
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / "ziyixi_proto"
            for path in (
                "__init__.py",
                "wire_json.py",
                "todofy/taskintent/v1/task_intent_pb.py",
                "prototest/v1/prototest_pb.py",
            ):
                (package / path).parent.mkdir(parents=True, exist_ok=True)
                (package / path).write_text("# synthetic\n")
            shipped = [name for name, _ in build_backend._package_files(Path(root))]
        self.assertEqual(
            shipped,
            [
                "ziyixi_proto/__init__.py",
                "ziyixi_proto/todofy/taskintent/v1/task_intent_pb.py",
                "ziyixi_proto/wire_json.py",
            ],
        )


class HttpBindingsTest(unittest.TestCase):
    def image(self, rule):
        source = file("platform/runtime/v1/service.proto", "platform.runtime.v1",
                      {"name": "Input", "field": [STRING]}, {"name": "Output", "field": [STRING]})
        source["service"] = [{"name": "RuntimeService", "method": [{"name": "CreateRelease",
                              "inputType": ".platform.runtime.v1.Input", "outputType": ".platform.runtime.v1.Output",
                              "options": {"[google.api.http]": rule}}]}]
        return {"file": [source]}

    def test_primary_and_additional_http_bindings_preserve_typed_body_metadata(self):
        source = gen_py.generate(self.image({"post": "/api/v1/releases", "body": "release",
                                            "additionalBindings": [{"post": "/api/v1/releases:resume", "body": "*"}]}))
        module = source["platform/runtime/v1/service_pb.py"]
        self.assertIn('HttpBinding("platform.runtime.v1.RuntimeService", "CreateRelease", "POST", "/api/v1/releases", Input, Output, "release")', module)
        self.assertIn('"/api/v1/releases:resume", Input, Output, "*")', module)
        self.assertIn("from ziyixi_proto.http_routes import HttpBinding", module)

    def test_unsupported_or_ambiguous_http_shapes_fail_generation(self):
        for rule in ({"get": "/one", "post": "/two"}, {"custom": {"kind": "HEAD", "path": "/one"}},
                     {"get": "/one", "responseBody": "field"}):
            with self.subTest(rule=rule), self.assertRaises(gen_py.GenerateError):
                gen_py.generate(self.image(rule))

    def test_existing_empty_rpc_response_needs_no_duplicate_generated_message(self):
        image = self.image({"delete": "/api/v1/{id=*}"})
        image["file"][0]["service"][0]["method"][0]["outputType"] = ".google.protobuf.Empty"
        module = gen_py.generate(image)["platform/runtime/v1/service_pb.py"]
        self.assertIn('Input, type(None), "")', module)


class NamesAndLiteralsTest(unittest.TestCase):
    def test_a_keyword_field_is_an_attribute_with_an_underscore(self) -> None:
        keyword_field = {**STRING, "name": "from", "jsonName": "from"}
        source = gen_py.generate(
            {"file": [file("t/v1/t.proto", "prototest.v1", {"name": "M", "field": [keyword_field]})]}
        )
        module = source["t/v1/t_pb.py"]
        self.assertIn('    from_: str = ""', module)
        self.assertIn(
            'Field("from", 1, "string", None, repeated=False, optional=False, required=False, attr="from_")', module
        )
        clash = {**STRING, "name": "from_", "number": 2, "jsonName": "from_"}
        with self.assertRaises(gen_py.GenerateError):
            gen_py.generate(
                {"file": [file("t/v1/t.proto", "prototest.v1", {"name": "M", "field": [keyword_field, clash]})]}
            )

    def test_a_literal_keeps_every_character_python_reads(self) -> None:
        for value in ('a"b\\c', "\x00\t\n", "\u00e4\u3000", "\U0001f600\U0010ffff", "[\x00-\U0010ffff]"):
            literal = gen_py.literal(value)
            self.assertTrue(literal.isascii(), literal)
            self.assertEqual(eval(literal), value)  # the generated module's own reading of it


class FieldMaskTest(unittest.TestCase):
    def test_a_field_mask_is_a_tuple_of_paths(self) -> None:
        book = from_wire(pb.Book, {"highlights": "title,author.display_name"}, strict=True).message
        self.assertEqual(book.highlights, ("title", "author.display_name"))
        self.assertEqual(json.dumps(to_wire(book)), '{"highlights": "title,author.display_name"}')
        self.assertEqual(to_wire(pb.Book(highlights=())), {"highlights": ""})
        self.assertEqual(to_wire(pb.Book()), {})

    def test_the_writer_refuses_paths_a_reader_would_refuse(self) -> None:
        for paths in (("Title",), ("a,b",), ("",), "title", (1,)):
            with self.subTest(paths=paths), self.assertRaises(WireJsonError):
                to_wire(pb.Book(highlights=paths))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
