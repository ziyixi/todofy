"""The value rules of the wire JSON profile (common/wire/v1/wire.proto) as the generators read them from a buf image.

gen_py.py (the Python field tables), gen_wire_ts.py (the TypeScript wire types) and gen_schema.py (a contract's
JSON Schema) read the rules through this module, and ``check_image`` refuses a rule that cannot mean anything
(an unknown format, ``allowed`` on a number, a case on a field without presence, a case value the
discriminator does not have), so a mistake stops generation instead of reaching a codec. The codecs read the
same options at run time (proto/ts/wire-rules.ts from the descriptors, wire_json.py from gen_py's tables).

Standard library only; runs on Python 3.9 (a developer's system python3), like gen_py.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

FILE_OPTION = "[common.wire.v1.formats]"
MESSAGE_OPTION = "[common.wire.v1.message]"
FIELD_OPTION = "[common.wire.v1.field]"
METHOD_OPTION = "[common.wire.v1.method]"
REQUIRED_OPTION = "[google.api.field_behavior]"
PRESENCE = {
    "PRESENCE_UNSPECIFIED": "",
    "PRESENCE_REQUIRED": "required",
    "PRESENCE_ABSENT": "absent",
    "PRESENCE_OPTIONAL": "optional",
}
NUMBERS = ("TYPE_INT32", "TYPE_DOUBLE")
# The escapes a pattern may use: ECMAScript's syntax characters and `/` (with the u flag nothing else may be
# escaped outside a class; \d, \w, \b, \1 or \u mean other things, or nothing, in one of the two engines), and
# `-` inside a class.
PATTERN_ESCAPES = set("^$\\.*+?()[]{}|/")


class RuleError(Exception):
    """A rule that cannot apply where it is written."""


@dataclass(frozen=True)
class Format:
    name: str
    pattern: str
    max_length: int
    description: str


@dataclass(frozen=True)
class Bounds:
    allowed: tuple[str, ...] | None
    minimum: float | None
    maximum: float | None


@dataclass(frozen=True)
class Case:
    when: tuple[str, ...]
    presence: str  # "", "required", "absent", "optional"
    bounds: Bounds


@dataclass(frozen=True)
class FieldRules:
    format: Format | None
    bounds: Bounds
    open: bool
    max_items: int
    unique: bool
    key_format: Format | None
    required_keys: tuple[str, ...]
    keep_order: bool
    cases: tuple[Case, ...]
    otherwise: str


def enum_prefix(name: str) -> str:
    """AIP-126 / buf ENUM_VALUE_PREFIX: ErrorCode -> ERROR_CODE_."""
    out = "".join(f"_{c}" if c.isupper() and i > 0 else c for i, c in enumerate(name))
    return out.upper() + "_"


def wire_names(enum: dict[str, Any]) -> tuple[str, ...]:
    """The wire names of an enum's values, zero value excluded, in value order."""
    prefix = enum_prefix(enum["name"])
    return tuple(value["name"][len(prefix) :].lower() for value in enum["value"] if value["number"] != 0)


def enum_index(image: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Full type name (".pkg.Enum", ".pkg.Message.Enum") -> enum descriptor, for every enum of the image."""
    found: dict[str, dict[str, Any]] = {}
    for file in image["file"]:
        for enum in file.get("enumType", []):
            found[f".{file['package']}.{enum['name']}"] = enum
        for message in file.get("messageType", []):
            for enum in message.get("enumType", []):
                found[f".{file['package']}.{message['name']}.{enum['name']}"] = enum
    return found


def formats(file: dict[str, Any]) -> dict[str, Format]:
    """The file's named formats."""
    out: dict[str, Format] = {}
    for item in file.get("options", {}).get(FILE_OPTION, []):
        name, pattern = item.get("name", ""), item.get("pattern", "")
        where = f"{file['name']}: format {name!r}"
        if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", name):
            raise RuleError(f"{where}: a name is PascalCase (a JSON Schema $defs name)")
        if name in out:
            raise RuleError(f"{where}: defined twice")
        if not portable(pattern):
            raise RuleError(f"{where}: the pattern uses what ECMAScript and Python read differently (or is empty)")
        re.compile(pattern)
        if int(item.get("maxLength", 0)) < 0:
            raise RuleError(f"{where}: max_length is negative")
        out[name] = Format(name, pattern, int(item.get("maxLength", 0)), item.get("description", ""))
    return out


def portable(pattern: str) -> bool:
    """Whether ECMAScript (u flag) and Python's re read ``pattern`` alike: literals, character classes, groups,
    alternation and quantifiers. Outside a class no anchor (the match is always whole), no `.` and no (?...)
    construct; anywhere, only punctuation is escaped."""
    in_class = False
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "\\":
            escaped = pattern[i + 1] if i + 1 < len(pattern) else ""
            if not escaped or not (escaped in PATTERN_ESCAPES or (in_class and escaped == "-")):
                return False
            i += 2
            continue
        if in_class:
            in_class = char != "]"
        elif char == "[":
            in_class = True
        elif char in "^$." or pattern.startswith("(?", i):
            return False
        i += 1
    return bool(pattern) and not in_class


def discriminator(message: dict[str, Any]) -> str | None:
    """The name of a union message's discriminator field (common.wire.v1.Message), or None."""
    return message.get("options", {}).get(MESSAGE_OPTION, {}).get("discriminator") or None


def positional(method: dict[str, Any]) -> bool:
    """Whether a binding passes the method's request as positional arguments (common.wire.v1.Method)."""
    return bool(method.get("options", {}).get(METHOD_OPTION, {}).get("positional", False))


def required(field: dict[str, Any]) -> bool:
    return "REQUIRED" in field.get("options", {}).get(REQUIRED_OPTION, [])


def _bounds(raw: dict[str, Any]) -> Bounds:
    allowed = tuple(raw["allowed"]) if raw.get("allowed") else None
    minimum = float(raw["minimum"]) if "minimum" in raw else None
    maximum = float(raw["maximum"]) if "maximum" in raw else None
    return Bounds(allowed, minimum, maximum)


def _kind(field: dict[str, Any], map_entry: dict[str, Any] | None) -> str:
    """'map', 'list' or 'single' (a singular field)."""
    if map_entry is not None:
        return "map"
    return "list" if field["label"] == "LABEL_REPEATED" else "single"


def field_rules(
    file: dict[str, Any],
    message: dict[str, Any],
    field: dict[str, Any],
    enums: dict[str, dict[str, Any]],
    map_entry: dict[str, Any] | None = None,
) -> FieldRules | None:
    """The rules of one field (None when it has none), checked against the field's type. ``map_entry`` is the
    field's synthetic map entry message when it is a map."""
    raw = field.get("options", {}).get(FIELD_OPTION)
    if raw is None:
        return None
    where = f"{file['package']}.{message['name']}.{field['name']}"
    named = formats(file)
    shape = _kind(field, map_entry)
    value = map_entry["field"][1] if map_entry is not None else field
    value_type = value["type"]

    def format_of(key: str) -> Format | None:
        name = raw.get(key, "")
        if not name:
            return None
        if name not in named:
            raise RuleError(f"{where}: no format {name!r} in {file['name']}")
        return named[name]

    def check_bounds(bounds: Bounds, label: str) -> None:
        if bounds.allowed is not None:
            if value_type == "TYPE_ENUM":
                unknown = set(bounds.allowed) - set(wire_names(enums[value["typeName"]]))
                if unknown:
                    raise RuleError(f"{where}: {label}allowed names no value of the enum: {sorted(unknown)}")
            elif value_type != "TYPE_STRING" or shape == "map":
                raise RuleError(f"{where}: {label}allowed applies to a string or enum field")
        if (bounds.minimum is not None or bounds.maximum is not None) and value_type not in NUMBERS:
            raise RuleError(f"{where}: {label}minimum and maximum apply to an int32 or double field")
        if bounds.minimum is not None and bounds.maximum is not None and bounds.minimum > bounds.maximum:
            raise RuleError(f"{where}: {label}minimum is above maximum")

    rules = FieldRules(
        format=format_of("format"),
        bounds=_bounds(raw),
        open=bool(raw.get("open", False)),
        max_items=int(raw.get("maxItems", 0)),
        unique=bool(raw.get("unique", False)),
        key_format=format_of("keyFormat"),
        required_keys=tuple(raw.get("requiredKeys", [])),
        keep_order=bool(raw.get("keepOrder", False)),
        cases=tuple(
            Case(
                tuple(case.get("when", [])),
                PRESENCE[case.get("presence", "PRESENCE_UNSPECIFIED")],
                _bounds(case.get("rules", {})),
            )
            for case in raw.get("cases", [])
        ),
        otherwise=PRESENCE[raw.get("otherwise", "PRESENCE_UNSPECIFIED")],
    )
    if rules.format is not None and (value_type != "TYPE_STRING" or shape == "map"):
        raise RuleError(f"{where}: format applies to a string field (key_format to a map's keys)")
    check_bounds(rules.bounds, "")
    if rules.open and rules.bounds.allowed is None and not any(case.bounds.allowed for case in rules.cases):
        raise RuleError(f"{where}: open needs an allowed list")
    if rules.max_items < 0 or (rules.max_items and shape == "single"):
        raise RuleError(f"{where}: max_items applies to a repeated field or a map")
    if rules.unique and (shape != "list" or value_type == "TYPE_MESSAGE"):
        raise RuleError(f"{where}: unique applies to a repeated scalar or enum field")
    if (rules.key_format or rules.required_keys or rules.keep_order) and shape != "map":
        raise RuleError(f"{where}: key_format, required_keys and keep_order apply to a map")
    union = discriminator(message)
    if (rules.cases or rules.otherwise) and union is None:
        raise RuleError(f"{where}: cases need a discriminator on {message['name']}")
    if rules.cases or rules.otherwise:
        target = next((f for f in message.get("field", []) if f["name"] == union), None)
        names = wire_names(enums[target["typeName"]]) if target is not None and target["type"] == "TYPE_ENUM" else ()
        seen: set[str] = set()
        for case in rules.cases:
            if not case.when or set(case.when) - set(names) or seen & set(case.when):
                raise RuleError(f"{where}: a case names a value {union} does not have, or one another case names")
            seen |= set(case.when)
            check_bounds(case.bounds, "a case's ")
        presences = [case.presence for case in rules.cases if case.presence] + (
            [rules.otherwise] if rules.otherwise else []
        )
        has_presence = shape == "single" and (
            value_type in ("TYPE_ENUM", "TYPE_MESSAGE") or bool(field.get("proto3Optional"))
        )
        if presences and not has_presence:
            raise RuleError(f"{where}: a presence rule needs a field that can lack a value (optional, enum, message)")
    return rules


def check_image(image: dict[str, Any]) -> None:
    """Every rule of every file of the image fits where it is written."""
    enums = enum_index(image)
    for file in image["file"]:
        formats(file)
        for message in file.get("messageType", []):
            union = discriminator(message)
            if union is not None:
                target = next((f for f in message.get("field", []) if f["name"] == union), None)
                if target is None or target["type"] != "TYPE_ENUM" or target["label"] == "LABEL_REPEATED":
                    raise RuleError(
                        f"{file['package']}.{message['name']}: the discriminator {union!r} is not an enum field"
                    )
            entries = {
                nested["name"]: nested
                for nested in message.get("nestedType", [])
                if nested.get("options", {}).get("mapEntry")
            }
            for field in message.get("field", []):
                entry = (
                    entries.get(field.get("typeName", "").rsplit(".", 1)[-1])
                    if field["type"] == "TYPE_MESSAGE"
                    else None
                )
                field_rules(file, message, field, enums, entry)


# ---- the shape of a message for the generators of types and schemas ------------------------------------------


@dataclass(frozen=True)
class FieldView:
    """One field of a message as a reader sees it in one variant (or in a message that is not a union)."""

    field: dict[str, Any]
    map_entry: dict[str, Any] | None
    rules: FieldRules | None
    # "required": has a value; "absent": has none; "": as declared (REQUIRED or not, explicit presence or not).
    presence: str
    # The values a producer may write (the field's and the case's lists both apply), None for no list.
    allowed: tuple[str, ...] | None
    minimum: float | None
    maximum: float | None


@dataclass(frozen=True)
class Variant:
    """A message's fields for one value of its discriminator (``value``), or all of a plain message (None)."""

    value: str | None
    fields: tuple[FieldView, ...]


def map_entries(message: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The map entry types nested in ``message`` (protoc's synthetic ``<Field>Entry``), by full type name suffix."""
    return {
        nested["name"]: nested for nested in message.get("nestedType", []) if nested.get("options", {}).get("mapEntry")
    }


def entry_of(message: dict[str, Any], field: dict[str, Any]) -> dict[str, Any] | None:
    if field["type"] != "TYPE_MESSAGE":
        return None
    return map_entries(message).get(field.get("typeName", "").rsplit(".", 1)[-1])


def _merge(case: Case | None, rules: FieldRules | None) -> tuple[tuple[str, ...] | None, float | None, float | None]:
    lists = [b.allowed for b in (rules.bounds if rules else None, case.bounds if case else None) if b and b.allowed]
    allowed = None
    for values in lists:
        allowed = values if allowed is None else tuple(v for v in allowed if v in values)
    mins = [
        b.minimum
        for b in (rules.bounds if rules else None, case.bounds if case else None)
        if b and b.minimum is not None
    ]
    maxs = [
        b.maximum
        for b in (rules.bounds if rules else None, case.bounds if case else None)
        if b and b.maximum is not None
    ]
    return allowed, (max(mins) if mins else None), (min(maxs) if maxs else None)


def variants(file: dict[str, Any], message: dict[str, Any], enums: dict[str, dict[str, Any]]) -> list[Variant]:
    """The message's variants: one per value of its discriminator (in value order), or one for a plain message."""
    fields = sorted(message.get("field", []), key=lambda f: f["number"])
    rules = {f["name"]: field_rules(file, message, f, enums, entry_of(message, f)) for f in fields}
    union = discriminator(message)
    if union is None:
        return [
            Variant(
                None,
                tuple(
                    FieldView(f, entry_of(message, f), rules[f["name"]], "", *_merge(None, rules[f["name"]]))
                    for f in fields
                ),
            )
        ]
    target = next(f for f in fields if f["name"] == union)
    out = []
    for value in wire_names(enums[target["typeName"]]):
        views = []
        for f in fields:
            r = rules[f["name"]]
            case = next((c for c in r.cases if value in c.when), None) if r else None
            presence = (case.presence if case else r.otherwise) if r else ""
            allowed, minimum, maximum = _merge(case, r)
            if f is target:
                presence, allowed = "required", (value,)
            views.append(FieldView(f, entry_of(message, f), r, presence, allowed, minimum, maximum))
        out.append(Variant(value, tuple(views)))
    return out
