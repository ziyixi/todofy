"""Retired IDL elements (proto/README.md, "Retiring an element"): the one reviewed way to delete a published
package, file, enum value, allowed value, method, message or field without weakening the breaking gate for anything
else.

Usage (scripts/breaking.sh and scripts/rules-selftest.sh run it)::

    python3 tools/retired.py retired.json BASE_IMAGE.json HEAD_IMAGE.json OUT_IMAGE.json

Both images are from ``buf build --exclude-source-info -o -#format=json``. ``retired.json`` lists each element by its
full name, with the date and the reason:

- ``packages``: ``{"path": "x/ui/v1/", "package": "x.ui.v1"}``: every file under the path is gone.
- ``files``: ``{"path": "x/ui/v1/old_service.proto"}``: the file is gone with everything it defines (its services,
  messages and enums), while the rest of its package stays.
- ``enum_values``: ``{"enum": "a.v1.Kind", "name": "KIND_X", "number": 1}``: the value is gone and both its number
  and its name are reserved in the enum, so neither can be reused.
- ``allowed_values``: ``{"field": "a.v1.Message.field", "value": "x"}``: the value left the field's
  ``(common.wire.v1.field).allowed`` list.
- ``methods``: ``{"service": "a.v1.Service", "name": "DoThing"}``: the rpc left the service.
- ``messages``: ``{"message": "a.v1.DoThingRequest"}``: the top-level message is gone.
- ``fields``: ``{"field": "a.v1.Message.name", "number": 13}``: the field left its message and both its number and
  its name are reserved there, so neither can be reused.

First the head must keep every promise: no file under a retired path or of a retired package, no retired file, no
retired enum value or field, their numbers and names reserved, no retired allowed value, method or message. Then
OUT_IMAGE is the base without the listed elements, which ``buf breaking`` and tools/profile_breaking.py compare the
head with: a listed deletion is the base's state, every other change is checked exactly as before. An element the base
no longer has (the base is after the retirement) is left alone, so an entry does nothing once every base CI compares
with is newer; it may then be removed. A kept base file that still imports a file of a retired package, or a retired
file, is an error unless it used that file only for retired fields (the base then drops the import), and so is a kept
field or method of the base that uses a retired message: a message is retired with everything that uses it. The files
go first, so an entry for a method or message of a retired file does nothing.
Output names elements only. Exit status 0 when every promise holds, 1 otherwise, 2 on bad usage.
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


def message_types(image: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every message in the image, nested ones included."""

    def walk(prefix: str, message: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        name = f"{prefix}.{message['name']}"
        yield name, message
        for nested in message.get("nestedType", []):
            yield from walk(name, nested)

    for file in image.get("file", []):
        for message in file.get("messageType", []):
            yield from walk(file.get("package", ""), message)


def fields(image: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every message field in the image, nested messages included."""
    for name, message in message_types(image):
        for field in message.get("field", []):
            yield f"{name}.{field['name']}", field


def defined(file: dict[str, Any]) -> list[str]:
    """The full names of the top-level messages and enums a file defines."""
    package = file.get("package", "")
    return [f"{package}.{item['name']}" for item in (*file.get("messageType", []), *file.get("enumType", []))]


def references(file: dict[str, Any]) -> set[str]:
    """The type names a file's fields (nested messages included) and methods use."""
    names = {field.get("typeName", "") for _, field in fields({"file": [file]})}
    for service in file.get("service", []):
        for method in service.get("method", []):
            names |= {method.get("inputType", ""), method.get("outputType", "")}
    return {name.lstrip(".") for name in names if name}


def services(image: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every service in the image."""
    for file in image.get("file", []):
        for service in file.get("service", []):
            yield f"{file.get('package', '')}.{service['name']}", service


def messages(image: dict[str, Any]) -> Iterator[str]:
    """The full name of every top-level message in the image."""
    for file in image.get("file", []):
        for message in file.get("messageType", []):
            yield f"{file.get('package', '')}.{message['name']}"


def uses(type_name: str, retired: set[str]) -> str | None:
    """The retired message a field's or method's type is, or is nested in."""
    name = type_name.lstrip(".")
    return next((message for message in retired if name == message or name.startswith(f"{message}.")), None)


def reserves(enum: dict[str, Any], name: str, number: int) -> bool:
    """Whether the enum reserves both the number (ranges are inclusive) and the name."""
    ranges = enum.get("reservedRange", [])
    by_number = any(r.get("start", 0) <= number <= r.get("end", 0) for r in ranges)
    return by_number and name in enum.get("reservedName", [])


def reserves_field(message: dict[str, Any], name: str, number: int) -> bool:
    """Whether the message reserves both the number (a message's ranges end exclusively) and the name."""
    ranges = message.get("reservedRange", [])
    by_number = any(r.get("start", 0) <= number < r.get("end", 0) for r in ranges)
    return by_number and name in message.get("reservedName", [])


def drop_field(message: dict[str, Any], field: dict[str, Any]) -> None:
    """Remove a field, with the synthetic oneof of a proto3 `optional` field."""
    message["field"] = [item for item in message.get("field", []) if item is not field]
    if field.get("proto3Optional") and "oneofIndex" in field:
        index = field["oneofIndex"]
        del message["oneofDecl"][index]
        for item in message["field"]:
            if item.get("oneofIndex", -1) > index:
                item["oneofIndex"] -= 1


def allowed(field: dict[str, Any]) -> list[str]:
    return field.get("options", {}).get(WIRE_FIELD, {}).get("allowed", [])


def head_problems(retired: dict[str, Any], head: dict[str, Any]) -> list[str]:
    problems = []
    for entry in retired.get("packages", []):
        for file in head.get("file", []):
            if file["name"].startswith(entry["path"]) or file.get("package") == entry["package"]:
                problems.append(f"RETIRED_PACKAGE_BACK {entry['package']}: {file['name']} is in the head")
    head_files = {file["name"] for file in head.get("file", [])}
    for entry in retired.get("files", []):
        if entry["path"] in head_files:
            problems.append(f"RETIRED_FILE_BACK {entry['path']} is in the head")
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
    head_services = dict(services(head))
    for entry in retired.get("methods", []):
        service = head_services.get(entry["service"], {})
        if any(method["name"] == entry["name"] for method in service.get("method", [])):
            problems.append(f"RETIRED_METHOD_BACK {entry['service']}.{entry['name']} is in the head")
    head_messages = set(messages(head))
    for entry in retired.get("messages", []):
        if entry["message"] in head_messages:
            problems.append(f"RETIRED_MESSAGE_BACK {entry['message']} is in the head")
    head_types = dict(message_types(head))
    for entry in retired.get("fields", []):
        where = f"{entry['field']} ({entry['number']})"
        owner, name = entry["field"].rsplit(".", 1)
        message = head_types.get(owner)
        if message is None:
            continue  # the message itself is gone: buf's MESSAGE_NO_DELETE decides
        for field in message.get("field", []):
            if field["name"] == name or field.get("number", 0) == entry["number"]:
                problems.append(f"RETIRED_FIELD_BACK {where}: the head has {field['name']} = {field.get('number', 0)}")
        if not reserves_field(message, name, entry["number"]):
            problems.append(f"RETIRED_FIELD_NOT_RESERVED {where}: reserve both its number and its name")
    return problems


def without_retired(retired: dict[str, Any], base: dict[str, Any]) -> tuple[dict[str, Any], list[str], list[str]]:
    """(the base without the listed elements, what was removed, problems)."""
    removed, problems = [], []
    files = base.get("file", [])
    gone_packages = {
        file["name"]
        for entry in retired.get("packages", [])
        for file in files
        if file["name"].startswith(entry["path"]) or file.get("package") == entry["package"]
    }
    for entry in retired.get("packages", []):
        if any(name.startswith(entry["path"]) for name in gone_packages):
            removed.append(f"package {entry['package']}")
    gone_files = {entry["path"] for entry in retired.get("files", [])} & {file["name"] for file in files}
    removed += [f"file {name}" for name in sorted(gone_files - gone_packages)]
    gone = gone_packages | gone_files
    kept = [file for file in files if file["name"] not in gone]
    image = {**base, "file": kept}
    gone_types = {file["name"]: defined(file) for file in files if file["name"] in gone}

    def imports_used(file: dict[str, Any]) -> set[str]:
        """The retired files whose types the kept file still uses."""
        names = references(file)
        return {path for path, types in gone_types.items() if any(uses(name, set(types)) for name in names)}

    used_before = {file["name"]: imports_used(file) for file in kept}
    base_types = dict(message_types(image))
    for entry in retired.get("fields", []):
        owner, name = entry["field"].rsplit(".", 1)
        message = base_types.get(owner, {})
        values = message.get("field", [])
        match = [f for f in values if f["name"] == name and f.get("number", 0) == entry["number"]]
        clash = [f for f in values if (f["name"] == name) != (f.get("number", 0) == entry["number"])]
        if clash:
            problems.append(
                f"RETIRED_FIELD_MISMATCH {entry['field']}: the base has another "
                f"name or number ({clash[0]['name']} = {clash[0].get('number', 0)})"
            )
        elif match:
            drop_field(message, match[0])
            removed.append(f"field {entry['field']}")
    for file in kept:
        still = imports_used(file)
        for dependency in [name for name in file.get("dependency", []) if name in gone]:
            if dependency in used_before[file["name"]] - still:
                # Only retired fields used it: the base drops the import with them.
                file["dependency"] = [name for name in file["dependency"] if name != dependency]
                removed.append(f"import {dependency} of {file['name']}")
            elif dependency in gone_packages:
                problems.append(f"RETIRED_PACKAGE_IMPORTED {file['name']} imports the retired {dependency}")
            else:
                problems.append(f"RETIRED_FILE_IMPORTED {file['name']} imports the retired {dependency}")
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
    base_services = dict(services(image))
    for entry in retired.get("methods", []):
        service = base_services.get(entry["service"])
        methods = [] if service is None else service.get("method", [])
        kept_methods = [method for method in methods if method["name"] != entry["name"]]
        if service is not None and len(kept_methods) < len(methods):
            service["method"] = kept_methods
            removed.append(f"method {entry['service']}.{entry['name']}")
    gone_messages = {entry["message"] for entry in retired.get("messages", [])} & set(messages(image))
    for file in image["file"]:
        listed = [m for m in file.get("messageType", []) if f"{file.get('package', '')}.{m['name']}" in gone_messages]
        if listed:
            file["messageType"] = [m for m in file["messageType"] if m not in listed]
            removed += [f"message {file.get('package', '')}.{m['name']}" for m in listed]
    for name, field in fields(image):
        message = uses(field.get("typeName", ""), gone_messages)
        if message is not None:
            problems.append(f"RETIRED_MESSAGE_REFERENCED {name} uses the retired {message}")
    for name, service in services(image):
        for method in service.get("method", []):
            for type_name in (method.get("inputType", ""), method.get("outputType", "")):
                message = uses(type_name, gone_messages)
                if message is not None:
                    problems.append(f"RETIRED_MESSAGE_REFERENCED {name}.{method['name']} uses the retired {message}")
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
