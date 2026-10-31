"""Explicit package generation reuses the shared wire codecs without changing default inventories."""

import json
import sys
import types
import unittest

import gen_py
import gen_schema
import gen_wire_ts
from ziyixi_proto.wire_json import from_wire, to_wire


def source(package="selected.v1", path="selected/v1/item.proto"):
    return {
        "name": path,
        "package": package,
        "syntax": "proto3",
        "messageType": [
            {
                "name": "Item",
                "field": [{"name": "value", "number": 1, "label": "LABEL_OPTIONAL", "type": "TYPE_STRING"}],
            }
        ],
    }


class SelectedGenerationTest(unittest.TestCase):
    def test_unlisted_packages_remain_absent_from_default_outputs(self):
        image = {"file": [source()]}
        self.assertEqual(gen_py.generate(image), {})
        self.assertEqual(gen_wire_ts.generate(image), {})

    def test_explicit_python_package_uses_the_existing_wire_codec(self):
        generated = gen_py.generate({"file": [source()]}, {"selected.v1"})
        module = types.ModuleType("selected_generation_fixture")
        sys.modules[module.__name__] = module
        try:
            exec(generated["selected/v1/item_pb.py"], module.__dict__)
            item = from_wire(module.Item, {"value": "synthetic"}, strict=True).message
            self.assertEqual(to_wire(item), {"value": "synthetic"})
        finally:
            del sys.modules[module.__name__]

    def test_explicit_package_indexes_shared_imports_without_emitting_them(self):
        item = source()
        item["messageType"][0]["field"] = [
            {
                "name": "shared",
                "number": 1,
                "label": "LABEL_OPTIONAL",
                "type": "TYPE_MESSAGE",
                "typeName": ".ops.v1.Shared",
            }
        ]
        shared = source("ops.v1", "ops/v1/item.proto")
        shared["messageType"][0]["name"] = "Shared"
        image = {"file": [item, shared]}
        python = gen_py.generate(image, {"selected.v1"})
        wire = gen_wire_ts.generate(image, {"selected.v1"})
        self.assertIn("import ziyixi_proto.ops.v1.item_pb", python["selected/v1/item_pb.py"])
        self.assertIn("from '../../ops/v1/item_wire.ts'", wire["selected/v1/item_wire.ts"])
        self.assertNotIn("ops/v1/item_pb.py", python)
        self.assertNotIn("ops/v1/item_wire.ts", wire)

    def test_selected_wire_types_augment_the_shared_package_runtime(self):
        generated = gen_wire_ts.generate(
            {"file": [source()]},
            {"selected.v1"},
            wire_runtime="@ziyixi/proto/wire-json",
        )
        text = generated["selected/v1/item_wire.ts"]
        self.assertIn("import type {} from '@ziyixi/proto/wire-json';", text)
        self.assertIn("declare module '@ziyixi/proto/wire-json'", text)
        self.assertIn("'selected.v1.Item': Item;", text)

    def test_explicit_schema_target_does_not_require_a_public_registry_entry(self):
        target = gen_schema.Target("selected.v1", "selected.schema.json", "https://schema.local/selected", "Selected")
        generated = gen_schema.generate({"file": [source()]}, {"selected.v1"}, targets=(target,))
        schema = json.loads(generated[target.path])
        self.assertEqual(schema["$id"], target.identity)
        self.assertEqual(schema["$defs"]["Item"]["properties"]["value"]["type"], "string")
        self.assertFalse(any(item.package == "selected.v1" for item in gen_schema.SCHEMAS))


if __name__ == "__main__":
    unittest.main()
