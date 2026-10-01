"""Breaking-change rules that `buf breaking` cannot see (proto/README.md, Rules).

Usage (scripts/breaking.sh and scripts/rules-selftest.sh run it)::

    python3 tools/profile_breaking.py BASE_IMAGE.json HEAD_IMAGE.json [--config buf.yaml]

Both arguments are images from ``buf build --exclude-source-info -o -#format=json``. With ``--config``, the
directories buf.yaml's ``breaking.ignore`` lists (the runtimes' test fixtures) are not checked, as buf does
not check them. buf compares names, numbers and types, but no custom option: it treats every annotation as
source-compatible. For these packages some annotations are wire, and this check compares them by message,
method and field (full name and number) and fails on:

The wire JSON profile (REQUIRED decides whether an unset output is written as ``null`` or left out and
whether a reader refuses a missing field; presence decides between ``null`` and the default value):

- ``PROFILE_FIELD_SAME_REQUIRED``: an existing field gained or lost REQUIRED.
- ``PROFILE_FIELD_SAME_PRESENCE``: an existing field gained or lost explicit presence.
- ``PROFILE_FIELD_NEW_NOT_REQUIRED``: a new field of an existing message is REQUIRED (older producers
  and frozen payloads do not write it, so a reader would refuse them).

The HTTP APIs (the URL is the wire: an open tab of an older UI, and every other client, keeps calling the
paths it was built with; the transcoder clears OUTPUT_ONLY input fields and checks formats):

- ``PROFILE_HTTP_BINDING_KEPT``: a binding (verb, path template, body, response_body) of an existing
  method is no longer among its bindings, primary or additional (a changed path, verb or body, a removed
  additional binding or a removed google.api.http). Adding an additional binding, or demoting the primary
  binding to an additional one, is compatible.
- ``PROFILE_METHOD_SIGNATURE_KEPT``: an existing method lost one of its google.api.method_signature entries
  (adding one is compatible).
- ``PROFILE_RESOURCE_SAME``: an existing message's google.api.resource changed its type or lost a pattern,
  or the message stopped being a resource.
- ``PROFILE_INPUT_NOT_OUTPUT_ONLY``: an existing field of a message that is a method's input (or reachable
  from one through message fields) gained OUTPUT_ONLY or IDENTIFIER: what clients send would be ignored.
- ``PROFILE_FIELD_SAME_FORMAT``: an existing field gained a (google.api.field_info).format or changed it:
  values that were accepted are refused (dropping a format is compatible).

Removed or renumbered fields, messages and methods are buf's job (FIELD_NO_DELETE, RPC_NO_DELETE and
friends). Output names elements only, never values. Exit status 0 when nothing breaks, 1 otherwise, 2 on
bad usage.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterator
from typing import Any

BEHAVIOR = "[google.api.field_behavior]"
FIELD_INFO = "[google.api.field_info]"
HTTP = "[google.api.http]"
SIGNATURE = "[google.api.method_signature]"
RESOURCE = "[google.api.resource]"
VERBS = ("get", "put", "post", "delete", "patch", "custom")


def files(image: dict[str, Any], ignore: tuple[str, ...]) -> Iterator[dict[str, Any]]:
    for file in image.get("file", []):
        if not file.get("name", "").startswith(ignore):
            yield file


def messages(image: dict[str, Any], ignore: tuple[str, ...] = ()) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every message in the image, nested ones included."""

    def walk(prefix: str, message: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        name = f"{prefix}.{message['name']}"
        yield name, message
        for nested in message.get("nestedType", []):
            yield from walk(name, nested)

    for file in files(image, ignore):
        for message in file.get("messageType", []):
            yield from walk(file.get("package", ""), message)


def methods(image: dict[str, Any], ignore: tuple[str, ...] = ()) -> Iterator[tuple[str, dict[str, Any]]]:
    """(full name, descriptor) of every method of every service in the image."""
    for file in files(image, ignore):
        for service in file.get("service", []):
            for method in service.get("method", []):
                yield f"{file.get('package', '')}.{service['name']}.{method['name']}", method


def behaviors(field: dict[str, Any]) -> set[str]:
    return set(field.get("options", {}).get(BEHAVIOR, []))


def required(field: dict[str, Any]) -> bool:
    return "REQUIRED" in behaviors(field)


def explicit_presence(field: dict[str, Any]) -> bool:
    return bool(field.get("proto3Optional")) or field.get("type") == "TYPE_MESSAGE"


def field_format(field: dict[str, Any]) -> str | None:
    return field.get("options", {}).get(FIELD_INFO, {}).get("format")


def bindings(method: dict[str, Any]) -> set[tuple[str, str, str, str]]:
    """Every binding of a method's google.api.http rule, primary and additional, as comparable tuples."""
    rule = method.get("options", {}).get(HTTP)
    if rule is None:
        return set()
    found = set()
    for each in (rule, *rule.get("additionalBindings", [])):
        for verb in VERBS:
            if verb in each:
                path = json.dumps(each[verb], sort_keys=True) if verb == "custom" else each[verb]
                found.add((verb, path, each.get("body", ""), each.get("responseBody", "")))
    return found


def input_messages(image: dict[str, Any], ignore: tuple[str, ...]) -> set[str]:
    """Full names of every method input and of every message reachable from one through its fields."""
    by_name = dict(messages(image))
    pending = [method["inputType"].lstrip(".") for _, method in methods(image, ignore)]
    seen: set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen or name not in by_name:
            continue
        seen.add(name)
        pending += [
            f["typeName"].lstrip(".") for f in by_name[name].get("field", []) if f.get("type") == "TYPE_MESSAGE"
        ]
    return seen


def field_violations(name: str, message: dict[str, Any], old: dict[str, Any], is_input: bool) -> list[str]:
    found = []
    previous_fields = {field["number"]: field for field in old.get("field", [])}
    for field in message.get("field", []):
        path = f"{name}.{field['name']} ({field['number']})"
        previous = previous_fields.get(field["number"])
        if previous is None:
            if required(field):
                found.append(f"PROFILE_FIELD_NEW_NOT_REQUIRED {path}: a new field of an existing message is REQUIRED")
            continue
        if required(previous) != required(field):
            change = "gained" if required(field) else "lost"
            found.append(f"PROFILE_FIELD_SAME_REQUIRED {path}: {change} (google.api.field_behavior) = REQUIRED")
        if explicit_presence(previous) != explicit_presence(field):
            change = "gained" if explicit_presence(field) else "lost"
            found.append(f"PROFILE_FIELD_SAME_PRESENCE {path}: {change} explicit presence (optional)")
        gained = (behaviors(field) - behaviors(previous)) & {"OUTPUT_ONLY", "IDENTIFIER"}
        if is_input and gained:
            found.append(f"PROFILE_INPUT_NOT_OUTPUT_ONLY {path}: an input field gained {', '.join(sorted(gained))}")
        if field_format(field) is not None and field_format(field) != field_format(previous):
            found.append(f"PROFILE_FIELD_SAME_FORMAT {path}: (google.api.field_info).format was added or changed")
    return found


def resource_violations(name: str, message: dict[str, Any], old: dict[str, Any]) -> list[str]:
    before = old.get("options", {}).get(RESOURCE)
    if before is None:
        return []
    after = message.get("options", {}).get(RESOURCE)
    if after is None:
        return [f"PROFILE_RESOURCE_SAME {name}: no longer a google.api.resource"]
    found = []
    if after.get("type") != before.get("type"):
        found.append(f"PROFILE_RESOURCE_SAME {name}: the resource type changed")
    if set(before.get("pattern", [])) - set(after.get("pattern", [])):
        found.append(f"PROFILE_RESOURCE_SAME {name}: a resource pattern was removed or changed")
    return found


def method_violations(name: str, method: dict[str, Any], old: dict[str, Any]) -> list[str]:
    found = []
    for verb, path, body, response_body in sorted(bindings(old) - bindings(method)):
        detail = (
            f"{verb.upper()} {path}"
            + (f" body {body!r}" if body else "")
            + (f" response_body {response_body!r}" if response_body else "")
        )
        found.append(f"PROFILE_HTTP_BINDING_KEPT {name}: the binding {detail} is gone")
    lost = set(old.get("options", {}).get(SIGNATURE, [])) - set(method.get("options", {}).get(SIGNATURE, []))
    for signature in sorted(lost):
        found.append(f"PROFILE_METHOD_SIGNATURE_KEPT {name}: the method_signature {signature!r} is gone")
    return found


def violations(base: dict[str, Any], head: dict[str, Any], ignore: tuple[str, ...] = ()) -> list[str]:
    before = dict(messages(base, ignore))
    inputs = input_messages(head, ignore)
    found = []
    for name, message in messages(head, ignore):
        if name not in before:
            continue  # a new message: its REQUIRED fields bind nobody yet
        found += field_violations(name, message, before[name], name in inputs)
        found += resource_violations(name, message, before[name])
    old_methods = dict(methods(base, ignore))
    for name, method in methods(head, ignore):
        if name in old_methods:
            found += method_violations(name, method, old_methods[name])
    return found


def ignored_dirs(buf_yaml: str) -> tuple[str, ...]:
    """The directories of buf.yaml's ``breaking: ignore:`` list, each with a trailing slash (the file is
    written by hand in one layout: two-space keys, four-space list items)."""
    section = re.search(r"^breaking:\n((?:[ #].*\n|\n)*)", buf_yaml, re.MULTILINE)
    block = re.search(r"^  ignore:\n((?:    - .*\n)*)", section.group(1) if section else "", re.MULTILINE)
    return tuple(
        f"{item.rstrip('/')}/" for item in re.findall(r"^    - (\S+)$", block.group(1) if block else "", re.MULTILINE)
    )


def main(argv: list[str]) -> int:
    ignore: tuple[str, ...] = ()
    if len(argv) == 4 and argv[2] == "--config":
        with open(argv[3]) as config:
            ignore = ignored_dirs(config.read())
        argv = argv[:2]
    if len(argv) != 2:
        print("usage: profile_breaking.py BASE_IMAGE.json HEAD_IMAGE.json [--config buf.yaml]", file=sys.stderr)
        return 2
    with open(argv[0]) as base_file, open(argv[1]) as head_file:
        found = violations(json.load(base_file), json.load(head_file), ignore)
    for line in found:
        print(line)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
