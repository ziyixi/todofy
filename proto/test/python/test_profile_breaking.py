"""tools/profile_breaking.py's value-rule and closed-enum checks on synthetic buf images (JSON form), next to the
module's own self-test (scripts/rules-selftest.sh, which edits the real .proto files): an output's rules may not
change either way (a case's `empty` and the relations between fields included), an input's may only loosen, an open
list may change, a closed enum may not grow, and a list's write_empty is wire like a map's keep_order.
"""

import copy
import sys
import unittest
from typing import Any

from proto_test_support import PROTO

sys.path.insert(0, str(PROTO / "tools"))
import profile_breaking

CODE = {"name": "Code", "pattern": "[a-z]{1,8}"}


def image(
    out_rules: dict | None = None,
    in_rules: dict | None = None,
    *,
    formats: list | None = None,
    states: int = 2,
    closed: bool = False,
    union: str | None = None,
    case_rules: dict | None = None,
) -> dict[str, Any]:
    """A file `t.v1` with `service S { rpc M(In) returns (Out); }`: Out.code (a string with `out_rules`), In.code
    (with `in_rules`), Out.state (an enum of `states` values, `closed` if asked), and a message `Lone` no method
    reaches, whose `code` has `out_rules` too. `union` makes Out a union on that field; `case_rules` are the rules
    of Out.note."""

    def string(name: str, number: int, rules: dict | None, **extra: Any) -> dict:
        field = {"name": name, "number": number, "label": "LABEL_OPTIONAL", "type": "TYPE_STRING", **extra}
        if rules is not None:
            field["options"] = {"[common.wire.v1.field]": rules}
        return field

    state = {"name": "state", "number": 2, "label": "LABEL_OPTIONAL", "type": "TYPE_ENUM", "typeName": ".t.v1.State"}
    out = {"name": "Out", "field": [string("code", 1, out_rules), state]}
    if case_rules is not None:
        out["field"].append(string("note", 3, case_rules, proto3Optional=True))
    if union is not None:
        out["options"] = {"[common.wire.v1.message]": {"discriminator": union}}
    values = [{"name": "STATE_UNSPECIFIED", "number": 0}] + [
        {"name": f"STATE_V{i}", "number": i} for i in range(1, states + 1)
    ]
    enum: dict[str, Any] = {"name": "State", "value": values}
    if closed:
        enum["options"] = {"[common.wire.v1.closed]": True}
    file: dict[str, Any] = {
        "name": "t/v1/t.proto",
        "package": "t.v1",
        "syntax": "proto3",
        "messageType": [
            {"name": "In", "field": [string("code", 1, in_rules)]},
            out,
            {"name": "Lone", "field": [string("code", 1, out_rules)]},
        ],
        "enumType": [enum],
        "service": [{"name": "S", "method": [{"name": "M", "inputType": ".t.v1.In", "outputType": ".t.v1.Out"}]}],
    }
    if formats is not None:
        file["options"] = {"[common.wire.v1.formats]": formats}
    return {"file": [file]}


def rules_of(base: dict, head: dict) -> list[str]:
    """Each violation's rule and element (`PROFILE_RULE_SAME t.v1.Out.code`), without the field number or detail."""
    return [" ".join(line.split()[:2]).rstrip(":") for line in profile_breaking.violations(base, head)]


class OutputRulesTest(unittest.TestCase):
    def test_an_outputs_rule_may_not_change_either_way(self) -> None:
        base = image({"maxItems": 0, "allowed": ["a", "b"]})
        for name, rules in [
            ("a value added to a closed list", {"allowed": ["a", "b", "c"]}),
            ("a value removed", {"allowed": ["a"]}),
            ("the list dropped", {}),
        ]:
            with self.subTest(name):
                self.assertEqual(
                    rules_of(base, image(rules)),
                    ["PROFILE_RULE_SAME t.v1.Out.code", "PROFILE_RULE_SAME t.v1.Lone.code"],
                )
        wide = image({"format": "Code"}, formats=[{**CODE, "pattern": "[a-z]{1,16}"}])
        narrow = image({"format": "Code"}, formats=[CODE])
        self.assertIn("PROFILE_RULE_SAME t.v1.Out.code", rules_of(narrow, wide))
        # A JSON Schema format is a rule too for a validator that asserts formats: adding or dropping one is refused.
        dated = image({"format": "Code"}, formats=[{**CODE, "jsonSchemaFormat": "date-time"}])
        self.assertIn("PROFILE_RULE_SAME t.v1.Out.code", rules_of(narrow, dated))
        self.assertIn("PROFILE_RULE_SAME t.v1.Out.code", rules_of(dated, narrow))
        self.assertEqual(rules_of(dated, copy.deepcopy(dated)), [])
        self.assertIn("PROFILE_RULE_SAME t.v1.Out.code", rules_of(wide, narrow))

    def test_an_open_list_may_change_and_a_list_may_open(self) -> None:
        base = image({"allowed": ["a", "b"], "open": True})
        self.assertEqual(rules_of(base, image({"allowed": ["a", "b", "c"], "open": True})), [])
        self.assertEqual(rules_of(base, image({"allowed": ["a"], "open": True})), [])
        self.assertEqual(rules_of(image({"allowed": ["a", "b"]}), base), [])
        self.assertEqual(
            rules_of(base, image({"allowed": ["a", "b"]})),
            ["PROFILE_RULE_SAME t.v1.Out.code", "PROFILE_RULE_SAME t.v1.Lone.code"],
        )

    def test_a_format_compares_by_pattern_not_name(self) -> None:
        base = image({"format": "Code"}, formats=[CODE])
        renamed = image({"format": "Name"}, formats=[{**CODE, "name": "Name"}])
        self.assertEqual(rules_of(base, renamed), [])


class InputRulesTest(unittest.TestCase):
    def test_an_inputs_rule_may_loosen_never_tighten(self) -> None:
        base = image(None, {"allowed": ["a", "b"]})
        self.assertEqual(rules_of(base, image(None, {"allowed": ["a", "b", "c"]})), [])
        self.assertEqual(rules_of(base, image(None, {})), [])
        self.assertEqual(rules_of(base, image(None, {"allowed": ["a"]})), ["PROFILE_RULE_NOT_TIGHTER t.v1.In.code"])
        self.assertEqual(
            rules_of(image(None, {}), image(None, {"format": "Code"}, formats=[CODE])),
            ["PROFILE_RULE_NOT_TIGHTER t.v1.In.code"],
        )


class UnionAndEnumTest(unittest.TestCase):
    def test_a_changed_discriminator_breaks(self) -> None:
        self.assertEqual(rules_of(image(), image(union="state")), ["PROFILE_RULE_SAME_UNION t.v1.Out"])

    def test_a_case_for_a_new_value_of_an_open_enum_is_new(self) -> None:
        case = {"cases": [{"when": ["v1"], "presence": "PRESENCE_REQUIRED"}]}
        grown = copy.deepcopy(case)
        grown["cases"].append({"when": ["v3"], "presence": "PRESENCE_ABSENT"})
        self.assertEqual(
            rules_of(image(union="state", case_rules=case), image(union="state", case_rules=grown, states=3)), []
        )
        changed = {"cases": [{"when": ["v1"], "presence": "PRESENCE_ABSENT"}]}
        self.assertEqual(
            rules_of(image(union="state", case_rules=case), image(union="state", case_rules=changed)),
            ["PROFILE_RULE_SAME t.v1.Out.note"],
        )

    def test_a_cases_list_size_may_not_change_on_an_output(self) -> None:
        def sized(rules: dict) -> dict:
            built = image(union="state", case_rules=rules)
            note = built["file"][0]["messageType"][1]["field"][-1]
            note["label"] = "LABEL_REPEATED"
            del note["proto3Optional"]
            return built

        empty = {"cases": [{"when": ["v1"], "rules": {"empty": True}}]}
        self.assertEqual(rules_of(sized(empty), sized(empty)), [])
        for name, rules in [
            ("the case's empty dropped", {"cases": [{"when": ["v1"], "rules": {}}]}),
            ("no case at all", {}),
        ]:
            with self.subTest(name):
                self.assertEqual(rules_of(sized(empty), sized(rules)), ["PROFILE_RULE_SAME t.v1.Out.note"])
                self.assertEqual(rules_of(sized(rules), sized(empty)), ["PROFILE_RULE_SAME t.v1.Out.note"])

    def test_a_closed_enum_may_not_grow_or_change_its_closedness(self) -> None:
        self.assertEqual(rules_of(image(states=2), image(states=3)), [])
        self.assertEqual(
            rules_of(image(states=2, closed=True), image(states=3, closed=True)), ["PROFILE_ENUM_CLOSED t.v1.State"]
        )
        self.assertEqual(rules_of(image(closed=True), image()), ["PROFILE_ENUM_CLOSED t.v1.State"])
        self.assertEqual(rules_of(image(), image(closed=True)), ["PROFILE_ENUM_CLOSED t.v1.State"])


def related(
    out: dict | None = None, inp: dict | None = None, *, out_match: bool = False, in_match: bool = False
) -> dict[str, Any]:
    """image() with a REQUIRED string `title`, an optional bool `cut`, an optional int32 `size` (with `out` or `inp` as
    its rules) and a list `flags` in Out and In, and an any_match group (title, code: Code) on each if asked."""
    built = image(formats=[copy.deepcopy(CODE)])
    In, Out = built["file"][0]["messageType"][:2]
    for message, rules, match in ((Out, out, out_match), (In, inp, in_match)):
        message["field"] += [
            {
                "name": "title",
                "number": 4,
                "label": "LABEL_OPTIONAL",
                "type": "TYPE_STRING",
                "options": {"[google.api.field_behavior]": ["REQUIRED"]},
            },
            {"name": "cut", "number": 5, "label": "LABEL_OPTIONAL", "type": "TYPE_BOOL", "proto3Optional": True},
            {"name": "size", "number": 6, "label": "LABEL_OPTIONAL", "type": "TYPE_INT32", "proto3Optional": True},
            {"name": "flags", "number": 7, "label": "LABEL_REPEATED", "type": "TYPE_STRING"},
        ]
        if rules is not None:
            message["field"][-2]["options"] = {"[common.wire.v1.field]": rules}
        if match:
            group = {"fields": ["title"], "format": "Code"}
            message["options"] = {"[common.wire.v1.message]": {"anyMatch": [group]}}
    return built


class RelationsTest(unittest.TestCase):
    def test_present_when_is_a_rule_of_the_field(self) -> None:
        when = {"presentWhen": "cut"}
        self.assertEqual(rules_of(related(when, when), related(when, when)), [])
        self.assertEqual(rules_of(related(when), related()), ["PROFILE_RULE_SAME t.v1.Out.size"])
        self.assertEqual(rules_of(related(), related(when)), ["PROFILE_RULE_SAME t.v1.Out.size"])
        # An input may drop it (older callers' inputs still read), never gain it.
        self.assertEqual(rules_of(related(None, when), related()), [])
        self.assertEqual(rules_of(related(), related(None, when)), ["PROFILE_RULE_NOT_TIGHTER t.v1.In.size"])

    def test_any_match_is_a_rule_of_the_message(self) -> None:
        self.assertEqual(rules_of(related(out_match=True), related(out_match=True)), [])
        self.assertEqual(rules_of(related(out_match=True), related()), ["PROFILE_RULE_SAME_MATCH t.v1.Out"])
        self.assertEqual(rules_of(related(), related(out_match=True)), ["PROFILE_RULE_SAME_MATCH t.v1.Out"])
        self.assertEqual(rules_of(related(in_match=True), related()), [])
        self.assertEqual(rules_of(related(), related(in_match=True)), ["PROFILE_RULE_SAME_MATCH t.v1.In"])
        # The group's format compares by pattern, like a field's.
        wider = related(out_match=True)
        wider["file"][0]["options"]["[common.wire.v1.formats]"][0]["pattern"] = "[a-z]{1,16}"
        self.assertEqual(rules_of(related(out_match=True), wider), ["PROFILE_RULE_SAME_MATCH t.v1.Out"])

    def test_write_empty_changes_the_bytes_of_an_empty_list(self) -> None:
        def empty_flags(on: bool) -> dict:
            built = related()
            if on:
                built["file"][0]["messageType"][1]["field"][-1]["options"] = {
                    "[common.wire.v1.field]": {"writeEmpty": True}
                }
            return built

        self.assertEqual(rules_of(empty_flags(True), empty_flags(True)), [])
        self.assertEqual(rules_of(empty_flags(False), empty_flags(True)), ["PROFILE_FIELD_SAME_EMPTY t.v1.Out.flags"])
        self.assertEqual(rules_of(empty_flags(True), empty_flags(False)), ["PROFILE_FIELD_SAME_EMPTY t.v1.Out.flags"])


if __name__ == "__main__":
    unittest.main()
