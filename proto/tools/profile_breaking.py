"""Breaking-change rules of the wire JSON profile that `buf breaking` cannot see (proto/README.md, Rules).

Usage (scripts/breaking.sh and scripts/rules-selftest.sh run it)::

    python3 tools/profile_breaking.py BASE_IMAGE.json HEAD_IMAGE.json

Both arguments are images from ``buf build --exclude-source-info -o -#format=json``. In the profile,
``(google.api.field_behavior) = REQUIRED`` and field presence are part of the wire: REQUIRED decides
whether an unset output is written as ``null`` or left out and whether a reader refuses a missing field,
and presence (``optional``) decides between ``null`` and the default value. buf treats both as
source-compatible, so this check compares them field by field (by message full name and field number)
and fails on:

- ``PROFILE_FIELD_SAME_REQUIRED``: an existing field gained or lost REQUIRED.
- ``PROFILE_FIELD_SAME_PRESENCE``: an existing field gained or lost explicit presence.
- ``PROFILE_FIELD_NEW_NOT_REQUIRED``: a new field of an existing message is REQUIRED (older producers
  and frozen payloads do not write it, so a reader would refuse them).

Removed or renumbered fields and messages are buf's job (FIELD_NO_DELETE and friends). Output names
elements only, never values. Exit status 0 when nothing breaks, 1 otherwise, 2 on bad usage.
"""

import json
import sys
from collections.abc import Iterator
from typing import Any

REQUIRED_OPTION = "[google.api.field_behavior]"


def messages(image: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every message in the image, nested ones included."""

    def walk(prefix: str, message: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        name = f"{prefix}.{message['name']}"
        yield name, message
        for nested in message.get("nestedType", []):
            yield from walk(name, nested)

    for file in image.get("file", []):
        for message in file.get("messageType", []):
            yield from walk(file.get("package", ""), message)


def required(field: dict[str, Any]) -> bool:
    return "REQUIRED" in field.get("options", {}).get(REQUIRED_OPTION, [])


def explicit_presence(field: dict[str, Any]) -> bool:
    return bool(field.get("proto3Optional")) or field.get("type") == "TYPE_MESSAGE"


def violations(base: dict[str, Any], head: dict[str, Any]) -> list[str]:
    before = dict(messages(base))
    found = []
    for name, message in messages(head):
        if name not in before:
            continue  # a new message: its REQUIRED fields bind nobody yet
        old = {field["number"]: field for field in before[name].get("field", [])}
        for field in message.get("field", []):
            path = f"{name}.{field['name']} ({field['number']})"
            previous = old.get(field["number"])
            if previous is None:
                if required(field):
                    found.append(
                        f"PROFILE_FIELD_NEW_NOT_REQUIRED {path}: a new field of an existing message is REQUIRED"
                    )
                continue
            if required(previous) != required(field):
                change = "gained" if required(field) else "lost"
                found.append(f"PROFILE_FIELD_SAME_REQUIRED {path}: {change} (google.api.field_behavior) = REQUIRED")
            if explicit_presence(previous) != explicit_presence(field):
                change = "gained" if explicit_presence(field) else "lost"
                found.append(f"PROFILE_FIELD_SAME_PRESENCE {path}: {change} explicit presence (optional)")
    return found


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: profile_breaking.py BASE_IMAGE.json HEAD_IMAGE.json", file=sys.stderr)
        return 2
    with open(sys.argv[1]) as base_file, open(sys.argv[2]) as head_file:
        found = violations(json.load(base_file), json.load(head_file))
    for line in found:
        print(line)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
