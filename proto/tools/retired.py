"""Retired IDL elements (proto/README.md, "Retiring an element"): the one reviewed way to delete a published
package, enum value or allowed value without weakening the breaking gate for anything else.

Usage (scripts/breaking.sh and scripts/rules-selftest.sh run it)::

    python3 tools/retired.py retired.json BASE_IMAGE.json HEAD_IMAGE.json OUT_IMAGE.json

Both images are from ``buf build --exclude-source-info -o -#format=json``. ``retired.json`` lists each element by its
full name, with the date and the reason:

- ``packages``: ``{"path": "x/ui/v1/", "package": "x.ui.v1"}``: every file under the path is gone.
- ``enum_values``: ``{"enum": "a.v1.Kind", "name": "KIND_X", "number": 1}``: the value is gone and both its number
  and its name are reserved in the enum, so neither can be reused.
- ``allowed_values``: ``{"field": "a.v1.Message.field", "value": "x"}``: the value left the field's
  ``(common.wire.v1.field).allowed`` list.

First the head must keep every promise: no file under a retired path or of a retired package, no retired enum value,
its number and name reserved, no retired allowed value. Then OUT_IMAGE is the base without the listed elements, which
``buf breaking`` and tools/profile_breaking.py compare the head with: a listed deletion is the base's state, every
other change is checked exactly as before. An element the base no longer has (the base is after the retirement) is
left alone, so an entry does nothing once every base CI compares with is newer; it may then be removed. A base file
that still imports a retired file is an error. Output names elements only. Exit status 0 when every promise holds,
1 otherwise, 2 on bad usage.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

WIRE_FIELD = "[common.wire.v1.field]"


def enums(image: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every enum in the image, nested ones included."""

    def walk(prefix: str, message: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        name = f"{prefix}.{message['name']}"
        for enum in message.get("enumType", []):
            yield f"{name}.{enum['name']}", enum
        for nested in message.get("nestedType", []):
            yield from walk(name, nested)

    for file in image.get("file", []):
        package = file.get("package", "")
        for enum in file.get("enumType", []):
            yield f"{package}.{enum['name']}", enum
        for message in file.get("messageType", []):
            yield from walk(package, message)


def fields(image: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every message field in the image, nested messages included."""

    def walk(prefix: str, message: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        name = f"{prefix}.{message['name']}"
        for field in message.get("field", []):
            yield f"{name}.{field['name']}", field
        for nested in message.get("nestedType", []):
            yield from walk(name, nested)

    for file in image.get("file", []):
        for message in file.get("messageType", []):
            yield from walk(file.get("package", ""), message)


def reserves(enum: dict[str, Any], name: str, number: int) -> bool:
    """Whether the enum reserves both the number (ranges are inclusive) and the name."""
    ranges = enum.get("reservedRange", [])
    by_number = any(r.get("start", 0) <= number <= r.get("end", 0) for r in ranges)
    return by_number and name in enum.get("reservedName", [])


def allowed(field: dict[str, Any]) -> list[str]:
    return field.get("options", {}).get(WIRE_FIELD, {}).get("allowed", [])


def head_problems(retired: dict[str, Any], head: dict[str, Any]) -> list[str]:
    problems = []
    for entry in retired.get("packages", []):
        for file in head.get("file", []):
            if file["name"].startswith(entry["path"]) or file.get("package") == entry["package"]:
                problems.append(f"RETIRED_PACKAGE_BACK {entry['package']}: {file['name']} is in the head")
    head_enums = dict(enums(head))
    for entry in retired.get("enum_values", []):
        where = f"{entry['enum']}.{entry['name']} ({entry['number']})"
        enum = head_enums.get(entry["enum"])
        if enum is None:
            continue  # the enum itself is gone: buf's ENUM_NO_DELETE decides
        for value in enum.get("value", []):
            if value["name"] == entry["name"] or value.get("number", 0) == entry["number"]:
                found = f"{value['name']} = {value.get('number', 0)}"
                problems.append(f"RETIRED_ENUM_VALUE_BACK {where}: the head has {found}")
        if not reserves(enum, entry["name"], entry["number"]):
            problems.append(f"RETIRED_ENUM_VALUE_NOT_RESERVED {where}: reserve both its number and its name")
    head_fields = dict(fields(head))
    for entry in retired.get("allowed_values", []):
        field = head_fields.get(entry["field"])
        if field is not None and entry["value"] in allowed(field):
            problems.append(f"RETIRED_ALLOWED_VALUE_BACK {entry['field']}: {entry['value']!r} is allowed in the head")
    return problems


def without_retired(retired: dict[str, Any], base: dict[str, Any]) -> tuple[dict[str, Any], list[str], list[str]]:
    """(the base without the listed elements, what was removed, problems)."""
    removed, problems = [], []
    files = base.get("file", [])
    gone = {
        file["name"]
        for entry in retired.get("packages", [])
        for file in files
        if file["name"].startswith(entry["path"]) or file.get("package") == entry["package"]
    }
    for entry in retired.get("packages", []):
        if any(name.startswith(entry["path"]) for name in gone):
            removed.append(f"package {entry['package']}")
    kept = [file for file in files if file["name"] not in gone]
    for file in kept:
        for dependency in file.get("dependency", []):
            if dependency in gone:
                problems.append(f"RETIRED_PACKAGE_IMPORTED {file['name']} imports the retired {dependency}")
    image = {**base, "file": kept}
    base_enums = dict(enums(image))
    for entry in retired.get("enum_values", []):
        enum = base_enums.get(entry["enum"])
        values = [] if enum is None else enum.get("value", [])
        match = [v for v in values if v["name"] == entry["name"] and v.get("number", 0) == entry["number"]]
        clash = [v for v in values if (v["name"] == entry["name"]) != (v.get("number", 0) == entry["number"])]
        if clash:
            problems.append(
                f"RETIRED_ENUM_VALUE_MISMATCH {entry['enum']}.{entry['name']}: the base has another "
                f"name or number ({clash[0]['name']} = {clash[0].get('number', 0)})"
            )
        elif match and enum is not None:
            enum["value"] = [v for v in values if v not in match]
            removed.append(f"enum value {entry['enum']}.{entry['name']}")
    base_fields = dict(fields(image))
    for entry in retired.get("allowed_values", []):
        field = base_fields.get(entry["field"])
        if field is not None and entry["value"] in allowed(field):
            field["options"][WIRE_FIELD]["allowed"] = [v for v in allowed(field) if v != entry["value"]]
            removed.append(f"allowed value {entry['field']} {entry['value']!r}")
    return image, removed, problems


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print("usage: retired.py retired.json BASE_IMAGE.json HEAD_IMAGE.json OUT_IMAGE.json", file=sys.stderr)
        return 2
    paths = [Path(arg) for arg in argv[1:]]
    retired, base, head = (json.loads(path.read_text(encoding="utf-8")) for path in paths[:3])
    problems = head_problems(retired, head)
    image, removed, more = without_retired(retired, base)
    problems += more
    paths[3].write_text(json.dumps(image), encoding="utf-8")
    for line in removed:
        print(f"retired.json: {line} removed from the base")
    for line in problems:
        print(line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
