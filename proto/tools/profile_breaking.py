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
- ``PROFILE_FIELD_SAME_ORDER``: an existing map field gained or lost ``(common.wire.v1.field).keep_order``: every
  producer's bytes of that map change.
- ``PROFILE_METHOD_SAME_ARGUMENTS``: an existing method gained or lost ``(common.wire.v1.method).positional``: a
  service binding's callers and receivers would pass and expect different arguments.

The value rules of ``common/wire/v1`` (both codecs check them on every read, a consumer's lenient read included, so
a rule is as much wire as a field's type). Older and newer builds of each side run at the same time, so:

- ``PROFILE_RULE_SAME``: a rule of an existing field of an output (a message reachable from a method's output, or
  from no method at all) changed. Each side's readers check what the other side's writers write, old against new
  and new against old, so any change breaks one of them: a narrower format, bound, size or list refuses what older
  producers write; a wider one lets newer producers write what older consumers refuse. Formats compare by pattern
  and length (a renamed format with the same pattern is the same rule). One exception: an ``open`` allowed list
  (a lenient read accepts any value of its format) may change while the list stays open on the side that reads it,
  and a list may become ``open``.
- ``PROFILE_RULE_NOT_TIGHTER``: a rule of an existing field of an input (reachable only from methods' inputs, read
  strictly by the method's implementation) accepts less than it did: a changed format pattern, a lower
  ``max_length``, ``max_items``, ``maximum`` or a higher ``minimum``, a value removed from ``allowed`` (or a list
  added), a new ``unique``, ``key_format`` or required key, ``non_null`` added, or a case presence that now
  requires or forbids a value. Older callers' inputs would be refused. Loosening is compatible: the apps deploy
  before the dashboard that calls them (README.md, CI).
- ``PROFILE_RULE_SAME_UNION``: an existing message gained, lost or changed its discriminator.
- ``PROFILE_ENUM_CLOSED``: a closed enum (``(common.wire.v1.closed)``) gained a value (its consumers refuse it: a new
  major version), or an existing enum gained or lost ``closed``.

A case for a value the discriminator did not have before is new and compared with nothing (a new value of an open
enum is compatible).

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

import wire_rules

BEHAVIOR = "[google.api.field_behavior]"
FIELD_INFO = "[google.api.field_info]"
HTTP = "[google.api.http]"
SIGNATURE = "[google.api.method_signature]"
RESOURCE = "[google.api.resource]"
WIRE_FIELD = "[common.wire.v1.field]"
WIRE_METHOD = "[common.wire.v1.method]"
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


def keeps_order(field: dict[str, Any]) -> bool:
    return bool(field.get("options", {}).get(WIRE_FIELD, {}).get("keepOrder", False))


def positional(method: dict[str, Any]) -> bool:
    return bool(method.get("options", {}).get(WIRE_METHOD, {}).get("positional", False))


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
        if keeps_order(previous) != keeps_order(field):
            change = "gained" if keeps_order(field) else "lost"
            found.append(f"PROFILE_FIELD_SAME_ORDER {path}: {change} (common.wire.v1.field).keep_order")
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
    if positional(old) != positional(method):
        change = "gained" if positional(method) else "lost"
        found.append(f"PROFILE_METHOD_SAME_ARGUMENTS {name}: {change} (common.wire.v1.method).positional")
    lost = set(old.get("options", {}).get(SIGNATURE, [])) - set(method.get("options", {}).get(SIGNATURE, []))
    for signature in sorted(lost):
        found.append(f"PROFILE_METHOD_SIGNATURE_KEPT {name}: the method_signature {signature!r} is gone")
    return found


def output_messages(image: dict[str, Any], ignore: tuple[str, ...]) -> set[str]:
    """Full names of every method output and of every message reachable from one through its fields."""
    by_name = dict(messages(image))
    pending = [method["outputType"].lstrip(".") for _, method in methods(image, ignore)]
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


def top_level(image: dict[str, Any], ignore: tuple[str, ...]) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Full name -> (file, message) of every top-level message (the ones that carry value rules)."""
    return {
        f"{file.get('package', '')}.{message['name']}": (file, message)
        for file in files(image, ignore)
        for message in file.get("messageType", [])
    }


class Rules:
    """A field's resolved value rules (a format by its pattern and length, not its name), and its per-variant view."""

    def __init__(self, file: dict[str, Any], message: dict[str, Any], field: dict[str, Any], enums: dict) -> None:
        rules = wire_rules.field_rules(file, message, field, enums, wire_rules.entry_of(message, field))
        self.format = None if rules is None or rules.format is None else (rules.format.pattern, rules.format.max_length)
        self.key_format = (
            None
            if rules is None or rules.key_format is None
            else (rules.key_format.pattern, rules.key_format.max_length)
        )
        self.allowed = None if rules is None else rules.bounds.allowed
        self.open = bool(rules and rules.open)
        self.minimum = None if rules is None else rules.bounds.minimum
        self.maximum = None if rules is None else rules.bounds.maximum
        self.max_items = 0 if rules is None else rules.max_items
        self.unique = bool(rules and rules.unique)
        self.required_keys = frozenset(rules.required_keys if rules else ())
        self.non_null = bool(rules and rules.non_null)
        # Discriminator value -> (presence, allowed, minimum, maximum) of this field in that variant (cases merged).
        self.variants: dict[str, tuple[str, Any, Any, Any]] = {}
        for variant in wire_rules.variants(file, message, enums):
            if variant.value is None:
                continue
            view = next(v for v in variant.fields if v.field["number"] == field["number"])
            self.variants[variant.value] = (view.presence, view.allowed, view.minimum, view.maximum)


def _accepts_allowed(reader: Any, writer: Any) -> bool:
    """Whether a reader with the allowed list ``reader`` accepts every value a writer with ``writer`` writes."""
    return reader is None or (writer is not None and set(writer) <= set(reader))


def _accepts_bounds(reader: tuple[Any, Any], writer: tuple[Any, Any]) -> bool:
    """Whether a reader's (minimum, maximum) accepts every number a writer's bounds allow."""
    low, high = reader
    w_low, w_high = writer
    return (low is None or (w_low is not None and w_low >= low)) and (
        high is None or (w_high is not None and w_high <= high)
    )


def _accepts_size(reader: int, writer: int) -> bool:
    """Whether a reader's max_items (0: no bound) accepts every list a writer's allows."""
    return reader == 0 or (writer != 0 and writer <= reader)


def _accepts_format(reader: Any, writer: Any) -> bool:
    """Whether a reader's format accepts every value a writer's allows (patterns compare only as equal)."""
    if reader is None:
        return True
    if writer is None or writer[0] != reader[0]:
        return False
    return _accepts_size(reader[1], writer[1])


def accepts(reader: Rules, writer: Rules, lenient: bool) -> list[str]:
    """What a reader with ``reader``'s rules refuses of what a writer with ``writer``'s rules writes (rule names)."""
    refused = []
    if not _accepts_format(reader.format, writer.format):
        refused.append("format")
    if not _accepts_format(reader.key_format, writer.key_format):
        refused.append("key_format")
    if not (lenient and reader.open) and not _accepts_allowed(reader.allowed, writer.allowed):
        refused.append("allowed")
    if not _accepts_bounds((reader.minimum, reader.maximum), (writer.minimum, writer.maximum)):
        refused.append("minimum/maximum")
    if not _accepts_size(reader.max_items, writer.max_items):
        refused.append("max_items")
    if reader.unique and not writer.unique:
        refused.append("unique")
    if not reader.required_keys <= writer.required_keys:
        refused.append("required_keys")
    if reader.non_null and not writer.non_null:
        refused.append("non_null")
    for value in sorted(set(reader.variants) & set(writer.variants)):
        r_presence, r_allowed, r_min, r_max = reader.variants[value]
        w_presence, w_allowed, w_min, w_max = writer.variants[value]
        if r_presence in ("required", "absent") and w_presence != r_presence:
            refused.append(f"presence when {value}")
        if not (lenient and reader.open) and not _accepts_allowed(r_allowed, w_allowed):
            refused.append(f"allowed when {value}")
        if not _accepts_bounds((r_min, r_max), (w_min, w_max)):
            refused.append(f"minimum/maximum when {value}")
    return refused


def rule_violations(base: dict[str, Any], head: dict[str, Any], ignore: tuple[str, ...]) -> list[str]:
    """The value rules and closed enums (common/wire/v1) of existing elements, by direction (module docstring)."""
    found = []
    before = top_level(base, ignore)
    inputs, outputs = input_messages(head, ignore), output_messages(head, ignore)
    base_enums, head_enums = wire_rules.enum_index(base), wire_rules.enum_index(head)
    for name, (file, message) in top_level(head, ignore).items():
        if name not in before:
            continue
        old_file, old = before[name]
        if wire_rules.discriminator(old) != wire_rules.discriminator(message):
            found.append(f"PROFILE_RULE_SAME_UNION {name}: (common.wire.v1.message).discriminator changed")
            continue
        # An input only: the implementation reads strictly what older callers write. Anything else (an output, a
        # message both ways, or one no method reaches yet) is read by older and newer builds both ways.
        input_only = name in inputs and name not in outputs
        previous_fields = {f["number"]: f for f in old.get("field", [])}
        for field in message.get("field", []):
            previous = previous_fields.get(field["number"])
            if previous is None or previous.get("type") != field.get("type"):
                continue  # a new field, or buf's FIELD_SAME_TYPE
            path = f"{name}.{field['name']} ({field['number']})"
            was = Rules(old_file, old, previous, base_enums)
            now = Rules(file, message, field, head_enums)
            if input_only:
                refused = accepts(now, was, lenient=False)
                if refused:
                    found.append(
                        f"PROFILE_RULE_NOT_TIGHTER {path}: refuses what older callers send ({', '.join(refused)})"
                    )
                continue
            refused = sorted(set(accepts(was, now, lenient=True)) | set(accepts(now, was, lenient=True)))
            if was.open and not now.open:
                refused.append("open")
            if refused:
                found.append(f"PROFILE_RULE_SAME {path}: changed ({', '.join(refused)})")
    checked = wire_rules.enum_index({"file": list(files(head, ignore))})
    for name, enum in checked.items():
        old_enum = base_enums.get(name)
        if old_enum is None:
            continue
        if wire_rules.closed(old_enum) != wire_rules.closed(enum):
            change = "gained" if wire_rules.closed(enum) else "lost"
            found.append(f"PROFILE_ENUM_CLOSED {name.lstrip('.')}: {change} (common.wire.v1.closed)")
        elif wire_rules.closed(enum):
            added = {v["number"] for v in enum.get("value", [])} - {v["number"] for v in old_enum.get("value", [])}
            if added:
                found.append(
                    f"PROFILE_ENUM_CLOSED {name.lstrip('.')}: a closed enum gained a value (a new major version)"
                )
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
    found += rule_violations(base, head, ignore)
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
