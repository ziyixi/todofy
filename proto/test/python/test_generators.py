"""tools/gen_wire_ts.py and tools/gen_schema.py on synthetic buf images (JSON form): what they make of a union, a
nullable field, a map and a positional method, a case's empty list, a self-contained schema of one message, a
consumer's (open) schema with the relations between fields, and which packages they write. The real outputs are
checked where they are used: test/ops.test.ts type-checks ops_wire.ts against toWire, the Contracts CI job compares
contracts/ops-v1/ops-v1.schema.json with gen_schema.py's output and gives every fixture the reference validator's
verdict on it, and Todofy's tests validate its reports with todofy/api/*.schema.json.
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

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

    def test_a_type_of_another_file_is_imported(self) -> None:
        # dashboard/ui/v1/v.proto: a message V embedding ops.v1's M and its nested enum, and a sibling file's P.
        def field(name: str, number: int, type_name: str, kind: str = "TYPE_MESSAGE") -> dict:
            return {"name": name, "number": number, "label": "LABEL_OPTIONAL", "type": kind, "typeName": type_name}

        sibling = {
            "name": "dashboard/ui/v1/p.proto",
            "package": "dashboard.ui.v1",
            "syntax": "proto3",
            "messageType": [{"name": "P", "field": []}],
        }
        view = {
            "name": "dashboard/ui/v1/v.proto",
            "package": "dashboard.ui.v1",
            "syntax": "proto3",
            "messageType": [
                {
                    "name": "V",
                    "field": [
                        field("m", 1, ".ops.v1.M"),
                        field("state", 2, ".ops.v1.M.State", "TYPE_ENUM"),
                        field("p", 3, ".dashboard.ui.v1.P"),
                    ],
                }
            ],
        }
        out = gen_wire_ts.generate({"file": [union_file(), sibling, view]})
        source = out["dashboard/ui/v1/v_wire.ts"]
        self.assertIn("import type { P } from './p_wire.ts';", source)
        self.assertIn("import type { M, M_State } from '../../../ops/v1/m_wire.ts';", source)
        self.assertIn("readonly m?: M;\n  readonly state?: M_State;\n  readonly p?: P;", source)

    def test_a_type_outside_the_wire_packages_is_refused(self) -> None:
        view = {
            "name": "dashboard/ui/v1/v.proto",
            "package": "dashboard.ui.v1",
            "syntax": "proto3",
            "messageType": [
                {
                    "name": "V",
                    "field": [
                        {
                            "name": "x",
                            "number": 1,
                            "label": "LABEL_OPTIONAL",
                            "type": "TYPE_MESSAGE",
                            "typeName": ".other.v1.X",
                        }
                    ],
                }
            ],
        }
        with self.assertRaises(gen_wire_ts.GenerateError):
            gen_wire_ts.generate({"file": [view]})

    def test_an_http_service_is_not_a_binding(self) -> None:
        file = union_file("dashboard.ui.v1")
        file["service"][0]["method"][1]["options"] = {"[google.api.http]": {"post": "/v1/m"}}
        source = gen_wire_ts.generate({"file": [file]})["dashboard/ui/v1/m_wire.ts"]
        self.assertNotIn("export interface S", source)
        self.assertIn("export type M =", source)

    def test_a_string_literal_is_escaped(self) -> None:
        self.assertEqual(gen_wire_ts.string_literal("ops-v1"), "'ops-v1'")
        self.assertEqual(gen_wire_ts.string_literal('it\'s "x"\\\n'), "'it\\'s \"x\"\\\\\\n'")


class SchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = gen_schema.SCHEMAS, gen_schema.ALIASES
        gen_schema.SCHEMAS = (gen_schema.Target("ops.v1", "x.json", "https://contracts.local/x.json", "T", "D"),)
        gen_schema.ALIASES = {"ops.v1": {"Old": "M_State", "OldId": "GetRequest.event_id"}}
        self.schema = json.loads(gen_schema.generate({"file": [union_file()]})["x.json"])

    def tearDown(self) -> None:
        gen_schema.SCHEMAS, gen_schema.ALIASES = self.saved

    def test_a_changed_schema_names_what_must_be_regenerated_after_it(self) -> None:
        image = json.dumps({"file": [union_file()]})

        def run(*args: str) -> tuple[int, str]:
            err = io.StringIO()
            with contextlib.redirect_stderr(err), unittest.mock.patch.object(sys, "stdin", io.StringIO(image)):
                code = gen_schema.main(["gen_schema.py", *args])
            return code, err.getvalue()

        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "x.json")
            gen_schema.SCHEMAS = (
                gen_schema.Target("ops.v1", path, "https://contracts.local/x.json", "T", "D", then="cd ui && make"),
            )
            gen_schema.ALIASES = {}
            code, err = run("--check")
            self.assertEqual(code, 1)
            self.assertIn("then regenerate what copies the changed schemas: cd ui && make", err)
            self.assertEqual(run(), (0, "gen_schema: then regenerate what copies the changed schemas: cd ui && make\n"))
            # Nothing changed: nothing to say, and the file is not rewritten.
            self.assertEqual(run(), (0, ""))
            self.assertEqual(run("--check"), (0, ""))

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


def report_file() -> dict:
    """union_file's M with a list of messages that is empty when off, a discriminator limited to on and off, a format
    and the comments a self-contained schema describes its fields with."""
    file = union_file("t.v1")
    message = file["messageType"][0]
    message["field"][0]["options"] = REQUIRED | {"[common.wire.v1.field]": {"allowed": ["on", "off"]}}
    message["field"].append(
        {
            "name": "lines",
            "number": 6,
            "label": "LABEL_REPEATED",
            "type": "TYPE_MESSAGE",
            "typeName": ".t.v1.Line",
            "options": REQUIRED
            | {"[common.wire.v1.field]": {"maxItems": 5, "cases": [{"when": ["off"], "rules": {"empty": True}}]}},
        }
    )
    line = {
        "name": "Line",
        "field": [
            {
                "name": "text",
                "number": 1,
                "label": "LABEL_OPTIONAL",
                "type": "TYPE_STRING",
                "options": REQUIRED | {"[common.wire.v1.field]": {"format": "Text"}},
            }
        ],
    }
    file["messageType"].append(line)
    file["options"] = {"[common.wire.v1.formats]": [{"name": "Text", "pattern": "[^\x00-\x1f\x7f]+", "maxLength": 9}]}
    file["sourceCodeInfo"] = {
        "location": [
            {
                "path": [4, 0],
                "leadingComments": " The report.\n\n Second paragraph,\n wrapped.\n (-- api-linter: x=disabled --)\n",
            },
            {"path": [4, 0, 2, 5], "leadingComments": " Its lines.\n buf:lint:ignore FIELD_LOWER_SNAKE_CASE\n"},
            {"path": [4, 2, 2, 0], "leadingComments": " One line's text.\n"},
        ]
    }
    return file


class RootSchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = gen_schema.SCHEMAS
        gen_schema.SCHEMAS = (gen_schema.Target("t.v1", "r.json", "https://x.local/r.json", "R", root="M"),)
        self.text = gen_schema.generate({"file": [report_file()]})["r.json"]
        self.schema = json.loads(self.text)

    def tearDown(self) -> None:
        gen_schema.SCHEMAS = self.saved

    def test_self_contained_with_the_comments_as_descriptions(self) -> None:
        self.assertNotIn('"$ref":', self.text)
        self.assertNotIn("$defs", self.schema)
        self.assertEqual(self.schema["description"], "The report.\n\nSecond paragraph, wrapped.")
        self.assertIn("Generated from proto/t/v1/m.proto", self.schema["$comment"])
        on = self.schema["oneOf"][0]
        self.assertEqual(on["properties"]["lines"]["description"], "Its lines.")
        line = on["properties"]["lines"]["items"]
        self.assertEqual(line["properties"]["text"]["description"], "One line's text.")
        self.assertEqual(line["properties"]["text"]["maxLength"], 9)
        self.assertEqual(line["additionalProperties"], False)

    def test_a_case_bounds_a_list_and_the_discriminator_keeps_its_allowed_values(self) -> None:
        self.assertEqual([b["properties"]["state"] for b in self.schema["oneOf"]], [{"const": "on"}, {"const": "off"}])
        on, off = self.schema["oneOf"]
        self.assertEqual(on["properties"]["lines"]["maxItems"], 5)
        self.assertEqual(off["properties"]["lines"]["maxItems"], 0)

    def test_control_characters_are_escaped_in_the_file(self) -> None:
        self.assertIn("\\u007f", self.text)
        self.assertNotIn("\x7f", self.text)
        self.assertEqual(gen_schema.printable('"\u2028\U0001f600 \u4e2d"'), '"\\u2028\U0001f600 \u4e2d"')
        self.assertEqual(gen_schema.printable("\U000e0001"), "\\udb40\\udc01")

    def test_a_message_that_contains_itself_has_no_self_contained_schema(self) -> None:
        file = report_file()
        file["messageType"][2]["field"].append(
            {"name": "next", "number": 2, "label": "LABEL_OPTIONAL", "type": "TYPE_MESSAGE", "typeName": ".t.v1.Line"}
        )
        with self.assertRaises(gen_schema.GenerateError):
            gen_schema.generate({"file": [file]})
        gen_schema.SCHEMAS = (gen_schema.Target("t.v1", "r.json", "https://x.local/r.json", "R", root="Nope"),)
        with self.assertRaises(gen_schema.GenerateError):
            gen_schema.generate({"file": [report_file()]})


def related_file() -> dict:
    """A file `r.v1` whose message E has a REQUIRED subject, an optional text (one of them Visible: any_match), an
    optional bool cut, an optional int32 size present when cut, and a nested message A."""

    def scalar(name: str, number: int, kind: str, **extra: object) -> dict:
        return {"name": name, "number": number, "label": "LABEL_OPTIONAL", "type": kind, **extra}

    event = {
        "name": "E",
        "field": [
            scalar("subject", 1, "TYPE_STRING", options=REQUIRED),
            scalar("text", 2, "TYPE_STRING", proto3Optional=True),
            scalar("cut", 3, "TYPE_BOOL", proto3Optional=True),
            scalar(
                "size", 4, "TYPE_INT32", proto3Optional=True, options={"[common.wire.v1.field]": {"presentWhen": "cut"}}
            ),
            scalar("a", 5, "TYPE_MESSAGE", typeName=".r.v1.A"),
            scalar("id", 6, "TYPE_STRING", options=REQUIRED | {"[common.wire.v1.field]": {"format": "Uuid"}}),
        ],
        "options": {"[common.wire.v1.message]": {"anyMatch": [{"fields": ["subject", "text"], "format": "Visible"}]}},
    }
    nested = {"name": "A", "field": [scalar("name", 1, "TYPE_STRING", options=REQUIRED)]}
    formats = [
        {"name": "Visible", "pattern": "[ ]*[^ ][\\s\\S]*"},
        {"name": "Uuid", "pattern": "[0-9a-f]{8}", "jsonSchemaFormat": "uuid"},
    ]
    return {
        "name": "r/v1/r.proto",
        "package": "r.v1",
        "syntax": "proto3",
        "messageType": [event, nested],
        "options": {"[common.wire.v1.formats]": formats},
    }


class ConsumerSchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = gen_schema.SCHEMAS
        gen_schema.SCHEMAS = (gen_schema.Target("r.v1", "e.json", "https://x.local/e.json", "E", root="E", open=True),)
        self.schema = json.loads(gen_schema.generate({"file": [related_file()]})["e.json"])

    def tearDown(self) -> None:
        gen_schema.SCHEMAS = self.saved

    def test_every_message_takes_properties_it_does_not_know(self) -> None:
        self.assertIs(self.schema["additionalProperties"], True)
        self.assertIs(self.schema["properties"]["a"]["additionalProperties"], True)
        gen_schema.SCHEMAS = (gen_schema.Target("r.v1", "e.json", "https://x.local/e.json", "E", root="E"),)
        closed = json.loads(gen_schema.generate({"file": [related_file()]})["e.json"])
        self.assertIs(closed["additionalProperties"], False)

    def test_any_match_is_an_any_of_one_branch_per_field(self) -> None:
        visible = {"type": "string", "pattern": "^(?:[ ]*[^ ][\\s\\S]*)$(?!\\n)"}
        self.assertEqual(
            self.schema["anyOf"],
            [
                {"required": ["subject"], "properties": {"subject": visible}},
                {"required": ["text"], "properties": {"text": visible}},
            ],
        )

    def test_present_when_is_an_if_then(self) -> None:
        self.assertEqual(
            self.schema["allOf"],
            [{"if": {"required": ["cut"], "properties": {"cut": {"const": True}}}, "then": {"required": ["size"]}}],
        )

    def test_a_uuid_format_is_written_next_to_its_pattern(self) -> None:
        self.assertEqual(
            self.schema["properties"]["id"], {"type": "string", "format": "uuid", "pattern": "^(?:[0-9a-f]{8})$(?!\\n)"}
        )


if __name__ == "__main__":
    unittest.main()
