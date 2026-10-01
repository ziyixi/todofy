"""Generates a contract's JSON Schema (2020-12) from the IDL (proto/README.md, Value rules).

Usage (npm run schema rewrites the committed schemas, npm run check:schema fails when one differs)::

    buf build --exclude-source-info -o -#format=json | python3 tools/gen_schema.py [--check]

A contract's published wire description is its JSON Schema, readable without this repository's codecs. It is
generated, never written by hand: one ``$defs`` entry per format, enum and message of the package (``OpsStatus``,
``Code``), every message closed (``additionalProperties: false``), a REQUIRED field required (``null`` allowed where a
producer may write it: ``wire_rules.may_be_null``), a union (``discriminator``) a ``oneOf`` of one branch per
discriminator value with the fields that value has. Patterns are anchored as ECMAScript and Python's ``re.search``
both need (``$(?!\\n)``: Python's ``$`` also matches before a final newline). The schema is the producer's view: an
``open`` allowed list is closed here, as it is for a write; a consumer reads such a field more leniently (the codecs'
lenient read). Rules the IDL cannot hold (a clock bound, a whole message's size) are in the contract's README, not
here.

SCHEMAS maps a package to its committed schema and the schema's identity. Only keywords
contracts/task-intent-v1/validate.mjs implements are written, so a TypeScript test may still check a fixture with it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import wire_rules

PROTO = Path(__file__).resolve().parents[1]
# package -> (schema file relative to proto/, $id, title, description).
SCHEMAS = {
    "ops.v1": (
        "../contracts/ops-v1/ops-v1.schema.json",
        "https://contracts.local/ops-v1/ops-v1.schema.json",
        "ops-v1: the typed operations surface of Mail Hero, Todofy and Lab",
        'Every input and output of the named WorkerEntrypoint "Ops" of each app, one $defs entry each (README.md maps '
        "methods to entries). Generated from proto/ops/v1/ops.proto by proto/tools/gen_schema.py: do not edit. Outputs "
        "are closed so that nothing but codes, numbers, booleans and timestamps can leave an app; consumers still "
        "ignore fields they do not know.",
    ),
}
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


class Package:
    """The schema of one package."""

    def __init__(self, image: dict[str, Any], package: str) -> None:
        self.files = [f for f in image["file"] if f.get("package") == package]
        if not self.files:
            raise GenerateError(f"no file of package {package}")
        self.package = package
        self.enums = wire_rules.enum_index(image)
        self.defs: dict[str, Any] = {}
        # Full type name -> $defs name: formats, enums (nested ones as Message_Enum), messages.
        self.names: dict[str, str] = {}
        for file in self.files:
            for enum in file.get("enumType", []):
                self.names[f".{package}.{enum['name']}"] = enum["name"]
            for message in file.get("messageType", []):
                self.names[f".{package}.{message['name']}"] = message["name"]
                for nested in message.get("enumType", []):
                    self.names[f".{package}.{message['name']}.{nested['name']}"] = f"{message['name']}_{nested['name']}"

    def ref(self, name: str) -> dict[str, Any]:
        return {"$ref": f"#/$defs/{name}"}

    def format_ref(self, fmt: wire_rules.Format) -> dict[str, Any]:
        return self.ref(fmt.name)

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
            if rules is not None and rules.max_items:
                schema["maxProperties"] = rules.max_items
            if rules is not None and rules.key_format is not None:
                schema["propertyNames"] = self.format_ref(rules.key_format)
            plain = wire_rules.FieldView(value, None, None, "", None, view.minimum, view.maximum)
            schema["additionalProperties"] = self.value(value, plain, where)
            return schema
        if field["label"] == "LABEL_REPEATED":
            schema = {"type": "array"}
            if rules is not None and rules.max_items:
                schema["maxItems"] = rules.max_items
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
                    properties[field["name"]] = {"type": "null"}
                    required.append(field["name"])
                continue
            properties[field["name"]] = self.field(view, where)
            if wire_rules.required(field) or view.presence == "required":
                required.append(field["name"])
        schema: dict[str, Any] = {"type": "object"}
        if required:
            schema["required"] = required
        schema["properties"] = properties
        schema["additionalProperties"] = False
        return schema

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
                entry: dict[str, Any] = {"description": fmt.description, "type": "string"}
                if fmt.max_length:
                    entry["maxLength"] = fmt.max_length
                entry["pattern"] = anchored(fmt.pattern)
                defs[fmt.name] = entry
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


def generate(image: dict[str, Any]) -> dict[str, str]:
    """Schema path (relative to proto/) -> JSON text, for every package of SCHEMAS."""
    wire_rules.check_image(image)
    out = {}
    for package, (path, identity, title, description) in SCHEMAS.items():
        schema = Package(image, package).schema(identity, title, description)
        out[path] = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
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
    stale = []
    for path, text in schemas.items():
        target = (PROTO / path).resolve()
        if check:
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                stale.append(path)
            continue
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    if stale:
        print(
            f"gen_schema: not generated from the IDL (run npm run schema in proto/): {', '.join(stale)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
