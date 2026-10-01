"""tools/gen_wire_ts.py and tools/gen_schema.py on synthetic buf images (JSON form): what they make of a union, a
nullable field, a map and a positional method, and which packages they write. The real outputs are checked where
they are used: test/ops.test.ts type-checks ops_wire.ts against toWire, and the Contracts CI job compares
contracts/ops-v1/ops-v1.schema.json with gen_schema.py's output and gives every fixture the reference validator's
verdict on it.
"""

import json
import sys
import unittest

from proto_test_support import PROTO

sys.path.insert(0, str(PROTO / "tools"))
import gen_schema
import gen_wire_ts

REQUIRED = {"[google.api.field_behavior]": ["REQUIRED"]}


def union_file(package: str = "ops.v1") -> dict:
    """A file with a union message M (discriminator `state`), a plain message P and a binding service S."""
    state = {
        "name": "state",
        "number": 1,
        "label": "LABEL_OPTIONAL",
        "type": "TYPE_ENUM",
        "typeName": f".{package}.M.State",
        "options": REQUIRED,
    }
    when_on = {
        "[common.wire.v1.field]": {
            "cases": [{"when": ["on"], "presence": "PRESENCE_REQUIRED"}],
            "otherwise": "PRESENCE_ABSENT",
        }
    }
    message = {
        "name": "M",
        "field": [
            state,
            {
                "name": "since",
                "number": 2,
                "label": "LABEL_OPTIONAL",
                "type": "TYPE_STRING",
                "proto3Optional": True,
                "options": when_on | REQUIRED,
            },
            {
                "name": "note",
                "number": 3,
                "label": "LABEL_OPTIONAL",
                "type": "TYPE_STRING",
                "proto3Optional": True,
                "options": when_on,
            },
            {
                "name": "kind",
                "number": 4,
                "label": "LABEL_OPTIONAL",
                "type": "TYPE_STRING",
                "options": {"[common.wire.v1.field]": {"allowed": ["a", "b"]}},
            },
            {
                "name": "counts",
                "number": 5,
                "label": "LABEL_REPEATED",
                "type": "TYPE_MESSAGE",
                "typeName": f".{package}.M.CountsEntry",
                "options": REQUIRED,
            },
        ],
        "nestedType": [
            {
                "name": "CountsEntry",
                "field": [
                    {"name": "key", "number": 1, "label": "LABEL_OPTIONAL", "type": "TYPE_STRING"},
                    {"name": "value", "number": 2, "label": "LABEL_OPTIONAL", "type": "TYPE_DOUBLE"},
                ],
                "options": {"mapEntry": True},
            }
        ],
        "enumType": [
            {
                "name": "State",
                "value": [
                    {"name": "STATE_UNSPECIFIED", "number": 0},
                    {"name": "STATE_ON", "number": 1},
                    {"name": "STATE_OFF", "number": 2},
                    {"name": "STATE_IDLE", "number": 3},
                ],
            }
        ],
        "options": {"[common.wire.v1.message]": {"discriminator": "state"}},
    }
    request = {
        "name": "GetRequest",
        "field": [
            {"name": "event_id", "number": 1, "label": "LABEL_OPTIONAL", "type": "TYPE_STRING", "options": REQUIRED}
        ],
    }
    service = {
        "name": "S",
        "method": [
            {
                "name": "Get",
                "inputType": f".{package}.GetRequest",
                "outputType": f".{package}.M",
                "options": {"[common.wire.v1.method]": {"positional": True}},
            },
            {"name": "Put", "inputType": f".{package}.M", "outputType": f".{package}.M"},
        ],
    }
    return {
        "name": f"{package.replace('.', '/')}/m.proto",
        "package": package,
        "syntax": "proto3",
        "messageType": [message, request],
        "service": [service],
    }


class WireTypesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.source = gen_wire_ts.generate({"file": [union_file()]})["ops/v1/m_wire.ts"]

    def test_a_union_is_one_member_per_shape(self) -> None:
        self.assertIn(
            "export type M =\n  | {\n      readonly state: 'on';\n"
            "      readonly since: string;\n      readonly note: string;",
            self.source,
        )
        # off and idle have the same shape: one member.
        self.assertIn(
            "readonly state: 'off' | 'idle';\n      readonly since: null;\n      readonly kind?: 'a' | 'b';",
            self.source,
        )

    def test_maps_lists_and_bindings(self) -> None:
        self.assertIn("readonly counts: Readonly<Record<string, number>>;", self.source)
        self.assertIn("get(eventId: string): Promise<M>;", self.source)
        self.assertIn("put(input: M): Promise<M>;", self.source)
        self.assertIn("declare module '../../wire-json.ts' {\n  interface WireTypes {\n    'ops.v1.M': M;", self.source)

    def test_only_the_listed_packages_get_wire_types(self) -> None:
        self.assertEqual(gen_wire_ts.generate({"file": [union_file("other.v1")]}), {})


class SchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = gen_schema.SCHEMAS, gen_schema.ALIASES
        gen_schema.SCHEMAS = {"ops.v1": ("x.json", "https://contracts.local/x.json", "T", "D")}
        gen_schema.ALIASES = {"ops.v1": {"Old": "M_State", "OldId": "GetRequest.event_id"}}
        self.schema = json.loads(gen_schema.generate({"file": [union_file()]})["x.json"])

    def tearDown(self) -> None:
        gen_schema.SCHEMAS, gen_schema.ALIASES = self.saved

    def test_an_earlier_defs_name_is_an_alias_of_what_the_idl_generates(self) -> None:
        old = self.schema["$defs"]["Old"]
        self.assertEqual({k: v for k, v in old.items() if k != "description"}, {"$ref": "#/$defs/M_State"})
        old_id = self.schema["$defs"]["OldId"]
        self.assertEqual(
            {k: v for k, v in old_id.items() if k != "description"},
            self.schema["$defs"]["GetRequest"]["properties"]["event_id"],
        )
        for aliases in ({"Gone": "Nope"}, {"Gone": "M.nope"}, {"M": "M_State"}):
            gen_schema.ALIASES = {"ops.v1": aliases}
            with self.subTest(aliases=aliases), self.assertRaises(gen_schema.GenerateError):
                gen_schema.generate({"file": [union_file()]})

    def test_a_union_is_a_one_of_with_a_branch_per_value(self) -> None:
        branches = self.schema["$defs"]["M"]["oneOf"]
        self.assertEqual(
            [b["properties"]["state"] for b in branches], [{"const": "on"}, {"const": "off"}, {"const": "idle"}]
        )
        on, off, _ = branches
        self.assertEqual(on["required"], ["state", "since", "note", "counts"])
        self.assertEqual(on["properties"]["since"], {"type": "string"})
        # Absent: a REQUIRED field is written as null, any other is not there at all (and the object is closed).
        self.assertEqual(off["properties"]["since"], {"type": "null"})
        self.assertNotIn("note", off["properties"])
        self.assertFalse(off["additionalProperties"])
        self.assertEqual(off["properties"]["kind"], {"enum": ["a", "b"]})
        self.assertEqual(off["properties"]["counts"], {"type": "object", "additionalProperties": {"type": "number"}})

    def test_a_formats_json_schema_format_is_written_next_to_its_pattern(self) -> None:
        file = union_file()
        file["options"] = {
            "[common.wire.v1.formats]": [
                {"name": "Time", "pattern": "[0-9]{4}", "description": "d", "jsonSchemaFormat": "date-time"},
                {"name": "Code", "pattern": "[a-z]+", "description": "c"},
            ]
        }
        defs = json.loads(gen_schema.generate({"file": [file]})["x.json"])["$defs"]
        self.assertEqual(
            defs["Time"],
            {"description": "d", "type": "string", "format": "date-time", "pattern": "^(?:[0-9]{4})$(?!\\n)"},
        )
        self.assertNotIn("format", defs["Code"])

    def test_enums_and_identity(self) -> None:
        self.assertEqual(self.schema["$defs"]["M_State"], {"enum": ["on", "off", "idle"]})
        self.assertEqual(self.schema["$id"], "https://contracts.local/x.json")
        self.assertEqual(self.schema["$schema"], "https://json-schema.org/draft/2020-12/schema")


if __name__ == "__main__":
    unittest.main()
