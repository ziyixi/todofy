"""A self-contained report embeds only shared IDL dependencies, with their own field rules intact."""
import sys
import unittest

from proto_test_support import PROTO

sys.path.insert(0, str(PROTO / "tools"))
import gen_schema


def message_field(name, number, target):
    return {"name": name, "number": number, "label": "LABEL_OPTIONAL", "type": "TYPE_MESSAGE",
            "typeName": target, "options": {"[google.api.field_behavior]": ["REQUIRED"],
                                            "[common.wire.v1.field]": {"nonNull": True}}}


class SharedSchemaImports(unittest.TestCase):
    def image(self):
        leaf = {"name": "shared/leaf.proto", "package": "shared.v1", "syntax": "proto3",
                "options": {"[common.wire.v1.formats]": [{"name": "StableKey", "pattern": "[a-z]{1,8}"}]},
                "messageType": [{"name": "Leaf", "field": [{"name": "key", "number": 1,
                 "label": "LABEL_OPTIONAL", "type": "TYPE_STRING", "options": {
                   "[google.api.field_behavior]": ["REQUIRED"], "[common.wire.v1.field]": {"format": "StableKey"}}}]}]}
        middle = {"name": "shared/middle.proto", "package": "shared.v2", "syntax": "proto3",
                  "dependency": [leaf["name"]], "messageType": [{"name": "Leaf", "field": [
                      message_field("nested", 1, ".shared.v1.Leaf")]}]}
        report = {"name": "report.proto", "package": "report.v1", "syntax": "proto3",
                  "dependency": [middle["name"]], "messageType": [{"name": "Report", "field": [
                      message_field("observation", 1, ".shared.v2.Leaf")]}]}
        private = {"name": "unrelated.proto", "package": "private.v1", "syntax": "proto3",
                   "messageType": [{"name": "Unrelated", "field": []}]}
        return {"file": [report, middle, leaf, private]}

    def test_transitive_imports_are_scoped_and_keep_foreign_formats(self):
        package = gen_schema.Package(self.image(), "report.v1", inline=True)
        value = package.ref("Report")["properties"]["observation"]["properties"]["nested"]
        self.assertEqual(value["properties"]["key"]["pattern"], r"^(?:[a-z]{1,8})$(?!\n)")
        self.assertEqual(value["required"], ["key"])
        self.assertFalse(value["additionalProperties"])
        self.assertIn("shared.v1.Leaf", package.types)
        self.assertIn("shared.v2.Leaf", package.types)
        self.assertNotIn("private.v1.Unrelated", package.types)

    def test_unimported_or_noninline_foreign_messages_are_not_silently_adopted(self):
        image = self.image()
        image["file"][0]["dependency"] = []
        for package in (gen_schema.Package(image, "report.v1", inline=True),
                        gen_schema.Package(self.image(), "report.v1")):
            with self.assertRaises(gen_schema.GenerateError):
                package.message(image["file"][0], image["file"][0]["messageType"][0])
