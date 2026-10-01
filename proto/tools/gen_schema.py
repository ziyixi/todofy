"""Generates a contract's JSON Schema (2020-12) from the IDL (proto/README.md, Value rules).

Usage (npm run schema rewrites the committed schemas, npm run check:schema fails when one differs)::

    buf build --exclude-imports -o -#format=json | python3 tools/gen_schema.py [--check]

A contract's published wire description is its JSON Schema, readable without this repository's codecs. It is
generated, never written by hand, in one of two shapes (``Target``):

- a package's document (ops-v1): one ``$defs`` entry per format, enum and message of the package (``OpsStatus``,
  ``Code``), each message a ``$ref`` where it is used;
- one message's schema (``Target.root``: Todofy's reports), self-contained: formats, enums and messages written in
  place, no ``$defs`` or ``$ref`` (an OpenAPI document refers to it, and openapi-typescript would hoist ``$defs`` into
  its components), with the message's and each field's leading comment as their ``description`` (the image needs its
  source info; ``(-- ... --)`` blocks and ``buf:lint`` lines are left out).

Either way every message is closed (``additionalProperties: false``), a REQUIRED field required (``null`` allowed where
a producer may write it: ``wire_rules.may_be_null``), a union (``discriminator``) a ``oneOf`` of one branch per
discriminator value with the fields that value has and the bounds its cases add. Patterns are anchored as ECMAScript
and Python's ``re.search`` both need (``$(?!\\n)``: Python's ``$`` also matches before a final newline). The schema is
the producer's view: an ``open`` allowed list is closed here, as it is for a write; a consumer reads such a field more
leniently (the codecs' lenient read). A format's ``json_schema_format`` is written as ``format`` next to its pattern
(an annotation the codecs do not check; a validator that asserts formats does). Rules the IDL cannot hold (a clock
bound, a whole message's size) are in the contract's README, not here. Characters Python does not print (a pattern's
control characters and Unicode spaces) are written as ``\\u`` escapes, so the committed file shows them.

SCHEMAS lists the committed schemas, each with what must be regenerated after it changes (``Target.then``: Todofy's
reports are copied into its UI's types by openapi-typescript), which a write that changes the file and a check that
finds it stale print. Only keywords contracts/ops-v1/validate.mjs implements are written, so a
TypeScript test may still check a document with it.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import wire_rules

PROTO = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Target:
    """One committed schema."""

    package: str
    # The schema file, relative to proto/.
    path: str
    identity: str
    title: str
    # A package document's description (a root schema's is its message's comment).
    description: str = ""
    # A message of the package: the schema is that message, self-contained. Empty: the package's $defs document.
    root: str = ""
    # What else must be regenerated when the schema changes (a generator that copies it), as a command to run from
    # the repository root; printed by a write that changes the file and by a check that finds it stale.
    then: str = ""


# Todofy's UI types (todofy/web/src/api/schema.d.ts, openapi-typescript) copy the reports' descriptions and formats
# through the owner API's OpenAPI document.
TODOFY_UI_TYPES = "cd todofy/web && npm run gen:api"
SCHEMAS = (
    Target(
        "ops.v1",
        "../contracts/ops-v1/ops-v1.schema.json",
        "https://contracts.local/ops-v1/ops-v1.schema.json",
        "ops-v1: the typed operations surface of Mail Hero, Todofy and Lab",
        'Every input and output of the named WorkerEntrypoint "Ops" of each app, one $defs entry each (README.md maps '
        "methods to entries). Generated from proto/ops/v1/ops.proto by proto/tools/gen_schema.py: do not edit. Outputs "
        "are closed so that nothing but codes, numbers, booleans and timestamps can leave an app; consumers still "
        "ignore fields they do not know.",
    ),
    # Todofy's newsletter reports (todofy/api/): the owner API's OpenAPI document refers to both.
    Target(
        "todofy.report.v1",
        "../todofy/api/summary-v1.schema.json",
        "https://todofy.local/schema/summary-v1.schema.json",
        "Todofy GET /api/summary response",
        root="SummaryReport",
        then=TODOFY_UI_TYPES,
    ),
    Target(
        "todofy.report.v1",
        "../todofy/api/recommendation-v1.schema.json",
        "https://todofy.local/schema/recommendation-v1.schema.json",
        "Todofy GET /api/recommendation response",
        root="RecommendationReport",
        then=TODOFY_UI_TYPES,
    ),
)
SELF_CONTAINED = (
    "Self-contained on purpose (no $defs or $ref): the owner API's OpenAPI document refers to it, and "
    "openapi-typescript hoists those into its components."
)
# package -> {$defs name a published schema had before it was generated: what it names now}. A message's field
# ("OpsStatus.counters") is that field's schema; anything else is a $defs entry. An outside reader that resolves
# "#/$defs/OpsErrorCode" keeps working, and the generated document stays the one description.
ALIASES = {
    "ops.v1": {
        "App": "OpsStatus.app",
        "Counters": "OpsStatus.counters",
        "Metrics": "Signal.metrics",
        "Modes": "OpsStatus.modes",
        "OpsErrorCode": "ErrorCode",
    },
}
SCALARS = {"TYPE_STRING": "string", "TYPE_BOOL": "boolean", "TYPE_INT32": "integer", "TYPE_DOUBLE": "number"}
STRING_WKT = (".google.protobuf.Timestamp", ".google.protobuf.FieldMask")


class GenerateError(Exception):
    """The image uses something this generator cannot say."""


def anchored(pattern: str) -> str:
    return f"^(?:{pattern})$(?!\\n)"


def nullable(schema: dict[str, Any]) -> dict[str, Any]:
    return {"oneOf": [schema, {"type": "null"}]}


def comment_text(raw: str) -> str:
    """A leading comment as a description: lines joined, paragraphs kept, api-linter blocks and buf:lint lines out."""
    text = re.sub(r"\(--.*?--\)", "", raw, flags=re.DOTALL)
    paragraphs: list[list[str]] = [[]]
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("buf:lint:"):
            continue
        if line:
            paragraphs[-1].append(line)
        elif paragraphs[-1]:
            paragraphs.append([])
    return "\n\n".join(" ".join(lines) for lines in paragraphs if lines)


def printable(text: str) -> str:
    """JSON text with every character Python does not print escaped (``\\u007f``), as JSON allows in a string. Only
    a string can hold one: json.dumps escapes control characters, and the layout is ASCII."""
    out = []
    for char in text:
        if char.isprintable() or char == "\n":
            out.append(char)
        elif ord(char) > 0xFFFF:
            high, low = divmod(ord(char) - 0x10000, 0x400)
            out.append(f"\\u{0xD800 + high:04x}\\u{0xDC00 + low:04x}")
        else:
            out.append(f"\\u{ord(char):04x}")
    return "".join(out)


class Package:
    """The schema of one package: its $defs document, or (``inline``) one of its messages written in place."""

    def __init__(self, image: dict[str, Any], package: str, inline: bool = False) -> None:
        self.files = [f for f in image["file"] if f.get("package") == package]
        if not self.files:
            raise GenerateError(f"no file of package {package}")
        self.package = package
        self.inline = inline
        self.enums = wire_rules.enum_index(image)
        self.defs: dict[str, Any] = {}
        # Full type name -> $defs name: formats, enums (nested ones as Message_Enum), messages.
        self.names: dict[str, str] = {}
        # $defs name -> (file, enum or message), for writing one in place.
        self.types: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        # $defs name of a message -> its comment, and (message, field) -> the field's (an image with source info).
        self.comments: dict[Any, str] = {}
        for file in self.files:
            for enum in file.get("enumType", []):
                self.names[f".{package}.{enum['name']}"] = enum["name"]
                self.types[enum["name"]] = (file, enum)
            for message in file.get("messageType", []):
                self.names[f".{package}.{message['name']}"] = message["name"]
                self.types[message["name"]] = (file, message)
                for nested in message.get("enumType", []):
                    name = f"{message['name']}_{nested['name']}"
                    self.names[f".{package}.{message['name']}.{nested['name']}"] = name
                    self.types[name] = (file, nested)
            messages = file.get("messageType", [])
            for location in file.get("sourceCodeInfo", {}).get("location", []):
                path, raw = location.get("path", []), location.get("leadingComments", "")
                if not raw or path[:1] != [4] or len(path) not in (2, 4) or (len(path) == 4 and path[2] != 2):
                    continue
                message = messages[path[1]]
                key = message["name"] if len(path) == 2 else (message["name"], message["field"][path[3]]["name"])
                self.comments[key] = comment_text(raw)
        # The messages being written in place, outermost first: a message that contains itself has no inline form.
        self.writing: list[str] = []

    def ref(self, name: str) -> dict[str, Any]:
        if not self.inline:
            return {"$ref": f"#/$defs/{name}"}
        file, element = self.types[name]
        if "value" in element:  # an enum
            return {"enum": list(wire_rules.wire_names(element))}
        if name in self.writing:
            raise GenerateError(f"{self.package}.{name} contains itself: it has no self-contained schema")
        self.writing.append(name)
        try:
            return self.message(file, element)
        finally:
            self.writing.pop()

    def format_ref(self, fmt: wire_rules.Format) -> dict[str, Any]:
        if not self.inline:
            return self.ref(fmt.name)
        return format_schema(fmt, described=False)

    def value(self, field: dict[str, Any], view: wire_rules.FieldView, where: str) -> dict[str, Any]:
        """One value of a field (a singular field, a list item, a map value) with the view's rules."""
        kind = field["type"]
        rules = view.rules
        if kind == "TYPE_ENUM":
            if view.allowed is not None:
                return {"const": view.allowed[0]} if len(view.allowed) == 1 else {"enum": list(view.allowed)}
            return self.ref(self.names[field["typeName"]])
        if kind == "TYPE_MESSAGE":
            if field["typeName"] in STRING_WKT:
                return {"type": "string"}
            if field["typeName"] not in self.names:
                raise GenerateError(f"{where}: {field['typeName']} is not in {self.package}")
            return self.ref(self.names[field["typeName"]])
        if kind not in SCALARS:
            raise GenerateError(f"{where}: {kind} is not in the wire profile")
        if kind == "TYPE_STRING":
            if view.allowed is not None:
                return {"const": view.allowed[0]} if len(view.allowed) == 1 else {"enum": list(view.allowed)}
            if rules is not None and rules.format is not None:
                return self.format_ref(rules.format)
            return {"type": "string"}
        schema: dict[str, Any] = {"type": SCALARS[kind]}
        if kind != "TYPE_BOOL":
            if view.minimum is not None and view.minimum == view.maximum:
                return {"const": int(view.minimum) if kind == "TYPE_INT32" else view.minimum}
            if view.minimum is not None:
                schema["minimum"] = int(view.minimum) if kind == "TYPE_INT32" else view.minimum
            if view.maximum is not None:
                schema["maximum"] = int(view.maximum) if kind == "TYPE_INT32" else view.maximum
        return schema

    def field(self, view: wire_rules.FieldView, where: str) -> dict[str, Any]:
        field = view.field
        rules = view.rules
        if view.map_entry is not None:
            _key, value = view.map_entry["field"]
            schema: dict[str, Any] = {"type": "object"}
            if rules is not None and rules.required_keys:
                schema["required"] = list(rules.required_keys)
            if view.max_items is not None:
                schema["maxProperties"] = view.max_items
            if rules is not None and rules.key_format is not None:
                schema["propertyNames"] = self.format_ref(rules.key_format)
            plain = wire_rules.FieldView(value, None, None, "", None, view.minimum, view.maximum)
            schema["additionalProperties"] = self.value(value, plain, where)
            return schema
        if field["label"] == "LABEL_REPEATED":
            schema = {"type": "array"}
            if view.max_items is not None:
                schema["maxItems"] = view.max_items
            if rules is not None and rules.unique:
                schema["uniqueItems"] = True
            schema["items"] = self.value(field, view, where)
            return schema
        schema = self.value(field, view, where)
        if wire_rules.may_be_null(field, rules) and view.presence != "required":
            return nullable(schema)
        return schema

    def object(self, name: str, fields: tuple[wire_rules.FieldView, ...]) -> dict[str, Any]:
        properties: dict[str, Any] = {}
        required: list[str] = []
        for view in fields:
            field = view.field
            where = f"{self.package}.{name}.{field['name']}"
            if view.presence == "absent":
                if wire_rules.required(field):  # always written: as null
                    properties[field["name"]] = self.described(name, field, {"type": "null"})
                    required.append(field["name"])
                continue
            properties[field["name"]] = self.described(name, field, self.field(view, where))
            if wire_rules.required(field) or view.presence == "required":
                required.append(field["name"])
        schema: dict[str, Any] = {"type": "object"}
        if required:
            schema["required"] = required
        schema["properties"] = properties
        schema["additionalProperties"] = False
        return schema

    def described(self, message: str, field: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
        """A field's schema with its comment first, in a self-contained schema."""
        text = self.comments.get((message, field["name"])) if self.inline else None
        return {"description": text, **schema} if text else schema

    def message(self, file: dict[str, Any], message: dict[str, Any]) -> dict[str, Any]:
        variants = wire_rules.variants(file, message, self.enums)
        if variants[0].value is None:
            return self.object(message["name"], variants[0].fields)
        return {"oneOf": [self.object(message["name"], variant.fields) for variant in variants]}

    def schema(self, identity: str, title: str, description: str) -> dict[str, Any]:
        defs: dict[str, Any] = {}
        for file in self.files:
            for fmt in wire_rules.formats(file).values():
                if fmt.name in defs:
                    raise GenerateError(f"{self.package}: the format {fmt.name} is defined in two files")
                defs[fmt.name] = format_schema(fmt, described=True)
        for file in self.files:
            for enum in file.get("enumType", []):
                defs[enum["name"]] = {"enum": list(wire_rules.wire_names(enum))}
            for message in file.get("messageType", []):
                for nested in message.get("enumType", []):
                    defs[f"{message['name']}_{nested['name']}"] = {"enum": list(wire_rules.wire_names(nested))}
            for message in file.get("messageType", []):
                if message["name"] in defs:
                    raise GenerateError(f"{self.package}.{message['name']}: its $defs name is taken")
                defs[message["name"]] = self.message(file, message)
        for alias, target in sorted(ALIASES.get(self.package, {}).items()):
            if alias in defs:
                raise GenerateError(f"{self.package}: the alias {alias} is a generated $defs name")
            description = (
                f"The name this schema used for {target} before it was generated from the IDL; kept for readers."
            )
            if "." in target:
                message, field = target.split(".", 1)
                found = defs.get(message, {}).get("properties", {}).get(field)
                if found is None:
                    raise GenerateError(f"{self.package}: the alias {alias} names no field {target}")
                defs[alias] = {"description": description, **found}
            elif target in defs:
                defs[alias] = {"description": description, "$ref": f"#/$defs/{target}"}
            else:
                raise GenerateError(f"{self.package}: the alias {alias} names no $defs entry {target}")
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": identity,
            "title": title,
            "description": description,
            "$defs": defs,
        }

    def root(self, target: Target) -> dict[str, Any]:
        """The self-contained schema of the message ``target.root``."""
        if target.root not in self.types or "value" in self.types[target.root][1]:
            raise GenerateError(f"{self.package} has no message {target.root}")
        source = self.types[target.root][0]["name"]
        head: dict[str, Any] = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": target.identity,
            "$comment": f"Generated from proto/{source} by proto/tools/gen_schema.py: do not edit. {SELF_CONTAINED}",
            "title": target.title,
        }
        if self.comments.get(target.root):
            head["description"] = self.comments[target.root]
        return {**head, **self.ref(target.root)}


def format_schema(fmt: wire_rules.Format, described: bool) -> dict[str, Any]:
    """A format as a string schema: a $defs entry (``described``), or in place, where the field describes itself."""
    entry: dict[str, Any] = {"description": fmt.description} if described else {}
    entry["type"] = "string"
    if fmt.json_schema_format:
        entry["format"] = fmt.json_schema_format
    if fmt.max_length:
        entry["maxLength"] = fmt.max_length
    entry["pattern"] = anchored(fmt.pattern)
    return entry


def generate(image: dict[str, Any]) -> dict[str, str]:
    """Schema path (relative to proto/) -> JSON text, for every target of SCHEMAS."""
    wire_rules.check_image(image)
    out = {}
    for target in SCHEMAS:
        if target.root:
            schema = Package(image, target.package, inline=True).root(target)
        else:
            schema = Package(image, target.package).schema(target.identity, target.title, target.description)
        out[target.path] = printable(json.dumps(schema, indent=2, ensure_ascii=False)) + "\n"
    return out


def main(argv: list[str]) -> int:
    check = argv[1:] == ["--check"]
    if argv[1:] not in ([], ["--check"]):
        print("usage: gen_schema.py [--check] < image.json", file=sys.stderr)
        return 2
    try:
        schemas = generate(json.load(sys.stdin))
    except (GenerateError, wire_rules.RuleError) as error:
        print(f"gen_schema: {error}", file=sys.stderr)
        return 1
    stale, then = [], []
    for target_schema in SCHEMAS:
        path, text = target_schema.path, schemas[target_schema.path]
        target = (PROTO / path).resolve()
        changed = not target.exists() or target.read_text(encoding="utf-8") != text
        if changed and target_schema.then and target_schema.then not in then:
            then.append(target_schema.then)
        if check:
            if changed:
                stale.append(path)
            continue
        if changed:
            with open(target, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
    if then:
        print(f"gen_schema: then regenerate what copies the changed schemas: {'; '.join(then)}", file=sys.stderr)
    if stale:
        print(
            f"gen_schema: not generated from the IDL (run npm run schema in proto/): {', '.join(stale)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
