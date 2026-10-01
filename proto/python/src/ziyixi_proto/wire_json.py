"""The wire JSON profile in Python, stdlib only (proto/README.md). Hand-written runtime of the generated
``ziyixi_proto.<package path>.<file>_pb`` modules; its TypeScript twin is proto/ts/wire-json.ts and both
must give the same results on the same input (proto/testdata/wire-profile-cases.json runs in both).

It reads and writes the frozen dataclasses that proto/tools/gen_py.py generates (their ``FIELDS``
tables), uses only the standard library and therefore runs on Pyodide unchanged.

- Names are the proto field names; enum values are written lower case without the enum prefix and the
  zero value is never written; a REQUIRED field (google.api.field_behavior) is always written, as null
  when it has no value; fields come in field-number order, so ``json.dumps(..., separators=(",", ":"),
  ensure_ascii=False)`` gives today's compact bytes.
- ``strict`` (inputs): unknown fields, unknown enum names, null, wrong types and missing REQUIRED fields
  raise ``WireJsonError``. Lenient (outputs): unknown fields are skipped and unknown enum names read as
  the zero value; both are reported as field paths in ``unrecognized`` (never values). A wrong type or
  a missing REQUIRED field raises in both modes (REQUIRED means "always written"). null reads as "no
  value" only where ``to_wire`` writes it (a REQUIRED enum, message or optional scalar); anywhere else
  (``"recorded": null``, a list, a field that is omitted when unset) it is a wrong type.
- ``wire_name`` and ``wire_member`` give one enum value's wire name and back, for code that stores or
  shows wire names outside a message (a database column); messages go through ``to_wire``/``from_wire``.
- Enum names are matched exactly against the wire names (no case folding: "ſubtasks" is not "subtasks").
- A timestamp is RFC 3339 UTC with 0-3 fraction digits and a real calendar time; it is kept in one
  canonical form: no fraction for a whole second, else exactly 3 digits ("07.5Z" becomes "07.500Z").
- An integer is a JSON number with a zero fractional part (JSON Schema's rule): 1.0 and 1e0 read as 1,
  as they must in TypeScript, where JSON.parse cannot tell them apart.
- A double is a finite JSON number (NaN and the infinities are refused, though ``json.loads`` accepts
  them). An integral double below 2^53 is written as an integer (``1.0`` as ``1``, ``-0.0`` as ``0``) and
  any other with ``repr``: the same value as JSON.stringify writes, and the same bytes for
  1e-4 <= |x| < 1e16; outside that range the exponent may be spelled differently (``1e-05`` against
  ``0.00001``).
- A map (string keys only) is a JSON object written in one canonical order, the one JSON.stringify gives
  a JavaScript object (array-index keys such as ``"10"`` first in numeric order, then the others in code
  point order), so both languages write the same bytes; a REQUIRED map is written as ``{}`` when empty,
  and a map value is never null. An unrecognized map value is reported as the map's path with ``{}``
  (``decisions{}``): a map key is data, and paths never carry data.
- A proto3 scalar without ``optional`` (implicit presence) is omitted at its default value (``""``, 0,
  false) unless it is REQUIRED, as protobuf-es does.
- A google.protobuf.FieldMask is a tuple of paths in Python and one string of comma-separated snake_case
  paths on the wire (``"send_mode,author.name"``; ``""`` has none); a path is ``*`` or dotted field names
  (proto/ts/field-mask.ts).
- A map with ``(common.wire.v1.field).keep_order`` is written in the order its entries were set (a read keeps
  the wire's order), array-index keys first, as JavaScript orders an object's keys.
- ``strict`` refuses null except for a REQUIRED field declared ``optional``: "always present, may be null"
  (ops-v1's SetGuardInput.until), exactly what ``to_wire`` writes for it.
- Value rules (``(common.wire.v1.field)``; gen_py.py resolves them into the field tables, ``Rules``) are checked on
  every message read or written, as proto/ts/wire-rules.ts checks them: the first rule broken raises
  ``WireJsonError`` with a path and the rule's name, never the value. A union (``UNIONS``: a message's
  discriminator) checks a field's cases only when the reader knows the discriminator's value; an enum value a
  lenient read did not know has a value but none to compare; ``open`` lets a lenient read accept a value
  outside ``allowed``.
"""

import datetime
import enum
import functools
import math
import re
import sys
from typing import Any, NamedTuple

FIELD_MASK_PATH = re.compile(r"[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*|\*")
RFC3339_UTC = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z")
INT32 = range(-(2**31), 2**31)
# Integral doubles below this are written as JSON integers, as JSON.stringify writes them.
EXACT_INTEGER = 2**53
DEFAULTS = {"string": "", "bool": False, "int32": 0, "double": 0.0}


class WireJsonError(ValueError):
    """The JSON is not a valid message of the requested type in this mode."""


class Format(NamedTuple):
    """A named string format of a .proto file (common.wire.v1.Format)."""

    name: str
    pattern: str
    max_length: int = 0


class Bounds(NamedTuple):
    """The rules a case adds to a field's own (common.wire.v1.Case.rules)."""

    allowed: frozenset[str] | None = None
    minimum: float | None = None
    maximum: float | None = None


class Case(NamedTuple):
    """A field's rules for some values of its message's discriminator (common.wire.v1.Case)."""

    when: frozenset[str]
    presence: str = ""  # "", "required", "absent", "optional"
    bounds: Bounds = Bounds()


class Rules(NamedTuple):
    """A field's value rules (common.wire.v1.Field), its formats resolved by gen_py.py."""

    format: Format | None = None
    allowed: frozenset[str] | None = None
    open: bool = False
    minimum: float | None = None
    maximum: float | None = None
    max_items: int = 0
    unique: bool = False
    key_format: Format | None = None
    required_keys: tuple[str, ...] = ()
    keep_order: bool = False
    cases: tuple[Case, ...] = ()
    otherwise: str = ""


NO_RULES = Rules()


class Field(NamedTuple):
    """One row of a generated module's ``FIELDS`` table."""

    name: str
    number: int
    kind: str  # string, bool, int32, double, enum, message, timestamp, fieldmask, map
    ref: Any  # the enum or message class (of a map: of its values), or None
    repeated: bool
    optional: bool  # explicit presence: unset is None
    required: bool  # google.api.field_behavior = REQUIRED
    value: str = ""  # a map's value kind (string, bool, int32, double, enum, message)
    declared_optional: bool = False  # declared `optional` in the .proto file (a strict read takes null if REQUIRED)
    rules: Rules = NO_RULES


def _fields(cls: type) -> tuple[Field, ...]:
    return sys.modules[cls.__module__].FIELDS[cls]


def _union(cls: type) -> str | None:
    """The name of a union message's discriminator field (the generated ``UNIONS`` table)."""
    return sys.modules[cls.__module__].UNIONS.get(cls)


def field_rules(cls: type, name: str) -> Rules:
    """The value rules of the field ``name`` of the generated message ``cls`` (e.g. a list's ``max_items``)."""
    for field in _fields(cls):
        if field.name == name:
            return field.rules
    raise KeyError(f"{cls.__name__} has no field {name}")


def _enum_out(value: enum.IntEnum) -> str | None:
    return None if value == 0 else value.name.lower()


@functools.cache
def _wire_table(cls: type[enum.IntEnum]) -> dict[str, enum.IntEnum]:
    """Wire name -> member for every member but the zero value (names are ASCII: buf lint enforces it)."""
    return {member.name.lower(): member for member in cls if member != 0}


def _enum_in(cls: type[enum.IntEnum], text: Any) -> enum.IntEnum | None:
    return _wire_table(cls).get(text) if isinstance(text, str) else None


def wire_name(member: enum.IntEnum) -> str | None:
    """The wire name of a generated enum member (``State.NOT_FOUND`` is ``"not_found"``); None for the zero value."""
    return _enum_out(member)


def wire_member[E: enum.IntEnum](cls: type[E], name: Any) -> E | None:
    """The member of ``cls`` with this wire name (exact match); None for anything else, the zero value's included."""
    return _enum_in(cls, name)  # type: ignore[return-value]


def _nullable(field: Field) -> bool:
    """Whether to_wire writes null for ``field`` when it has no value."""
    return field.required and not field.repeated and field.kind != "map" and (field.optional or field.kind == "enum")


def _timestamp_in(text: str) -> str | None:
    """The canonical form of a wire timestamp, or None when it is not a real UTC time."""
    match = RFC3339_UTC.fullmatch(text)
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    millis = int((match.group(7) or "").ljust(3, "0"))
    try:
        datetime.datetime(year, month, day, hour, minute, second)  # refuses 02-30, 24:00 and :60
    except ValueError:
        return None
    whole = text[:19]
    return f"{whole}Z" if millis == 0 else f"{whole}.{millis:03d}Z"


def _field_mask_in(text: str) -> tuple[str, ...] | None:
    """The paths of a wire field mask, or None when a path is malformed."""
    if text == "":
        return ()
    paths = tuple(text.split(","))
    return paths if all(FIELD_MASK_PATH.fullmatch(path) for path in paths) else None


def _int_in(item: Any) -> int | None:
    if isinstance(item, bool):
        return None
    if isinstance(item, float) and item.is_integer():
        item = int(item)
    return item if isinstance(item, int) and item in INT32 else None


def _double_in(item: Any) -> float | None:
    if isinstance(item, bool) or not isinstance(item, (int, float)):
        return None
    value = float(item)
    return value if math.isfinite(value) else None


def _double_out(value: float) -> int | float:
    if not math.isfinite(value):
        raise WireJsonError("not a finite number")
    # JSON.stringify writes 1.0 as 1 and -0.0 as 0.
    return int(value) if value.is_integer() and abs(value) < EXACT_INTEGER else value


ARRAY_INDEX_LIMIT = 2**32 - 1


def _map_key_order(key: str) -> tuple[int, int, list[int]]:
    """The order JSON.stringify gives a JavaScript object whose entries were set in code point order:
    array-index keys ("0", "7", "10"; canonical, below 2^32 - 1) first in numeric order, then the others in
    code point order (ECMAScript's OrdinaryOwnPropertyKeys)."""
    if key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < ARRAY_INDEX_LIMIT:
        return (0, int(key), [])
    return (1, 0, [ord(char) for char in key])


def _insertion_order(key: str) -> tuple[int, int]:
    """The order JavaScript gives an object's keys set in this order: array-index keys first, numerically, then
    the others as they were set (Python's sort is stable)."""
    if key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < ARRAY_INDEX_LIMIT:
        return (0, int(key))
    return (1, 0)


def to_wire(message: Any, *, lenient: bool = False) -> dict[str, Any]:
    """The wire JSON object of ``message`` (pass it to json.dumps). Checks its value rules first. ``lenient``: the
    message was read leniently and is passed on, so a value outside an ``open`` allowed list is written as read."""
    violation = _violation(message, "", lenient=lenient, unrecognized=frozenset())
    if violation is not None:
        raise WireJsonError(violation)
    return _write(message)


def _write(message: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field in _fields(type(message)):
        value = getattr(message, field.name)
        if field.repeated:
            items = [_value_out(field.kind, field, item) for item in value]
            if items or field.required:
                out[field.name] = items
            continue
        if field.kind == "map":
            order = _insertion_order if field.rules.keep_order else _map_key_order
            entries = {key: _value_out(field.value, field, value[key]) for key in sorted(value, key=order)}
            if None in entries.values():
                raise WireJsonError(f"{field.name}: a map value cannot be the zero enum value")
            if entries or field.required:
                out[field.name] = entries
            continue
        if field.kind == "enum":
            value = _enum_out(value)
        elif value is not None and not field.optional and not field.required and value == DEFAULTS.get(field.kind):
            # An implicit-presence scalar at its default is unset.
            value = None
        elif value is not None:
            value = _value_out(field.kind, field, value)
        if value is not None:
            out[field.name] = value
        elif field.required:
            # Only an unset optional scalar, enum, message or timestamp gets here: a REQUIRED implicit
            # scalar always has a value and was written above.
            out[field.name] = None
    return out


def _value_out(kind: str, field: Field, value: Any) -> Any:
    # The dataclasses do not check their values: the writer refuses what a reader would refuse, so a
    # producer bug never reaches the wire.
    match kind:
        case "message":
            return _write(value)
        case "enum":
            return _enum_out(value)
        case "double":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise WireJsonError(f"{field.name}: not a number")
            try:
                return _double_out(float(value))
            except WireJsonError:
                raise WireJsonError(f"{field.name}: not a finite number") from None
        case "int32" if isinstance(value, bool) or not isinstance(value, int) or value not in INT32:
            raise WireJsonError(f"{field.name}: not an int32")
        case "fieldmask":
            paths = tuple(value) if isinstance(value, (tuple, list)) else None
            if paths is None or not all(isinstance(path, str) for path in paths):
                raise WireJsonError(f"{field.name}: not a field mask")
            text = ",".join(paths)
            if any(path == "" for path in paths) or _field_mask_in(text) != paths:
                raise WireJsonError(f"{field.name}: a field mask path is malformed")
            return text
        case "string" if not isinstance(value, str):
            raise WireJsonError(f"{field.name}: not a string")
        case "bool" if not isinstance(value, bool):
            raise WireJsonError(f"{field.name}: not a boolean")
    return value


class ReadResult(NamedTuple):
    """A read message and the paths of what a lenient read skipped (unknown fields and enum names)."""

    message: Any
    unrecognized: list[str]


def from_wire(cls: type, value: Any, *, strict: bool = False) -> ReadResult:
    """Reads a parsed wire JSON value into a ``cls`` instance and checks its value rules."""
    unrecognized: list[str] = []
    message = _read(cls, value, "", strict, unrecognized)
    violation = _violation(message, "", lenient=not strict, unrecognized=frozenset(unrecognized))
    if violation is not None:
        raise WireJsonError(violation)
    return ReadResult(message, unrecognized)


def _read(cls: type, value: Any, path: str, strict: bool, unrecognized: list[str]) -> Any:
    if not isinstance(value, dict):
        raise WireJsonError(f"{path or '$'}: not an object")
    fields = {f.name: f for f in _fields(cls)}
    kwargs: dict[str, Any] = {}
    for key, item in value.items():
        at = key if path == "" else f"{path}.{key}"
        field = fields.get(key)
        if field is None:
            if strict:
                raise WireJsonError(f"{at}: unknown field")
            unrecognized.append(at)
            continue
        if item is None:
            # null is how outputs write "no value"; inputs omit the field instead, so a strict (input)
            # reader refuses it, except for a REQUIRED field declared `optional`, whose null is the value "none"
            # (to_wire writes it so); a lenient one takes it only where to_wire writes it.
            if strict and not (field.required and field.declared_optional):
                raise WireJsonError(f"{at}: null")
            if not _nullable(field):
                raise WireJsonError(f"{at}: wrong type")
            continue
        if field.repeated:
            if not isinstance(item, list):
                raise WireJsonError(f"{at}: not an array")
            values = []
            for i, element in enumerate(item):
                parsed = _value_in(field.kind, field.ref, element, f"{at}[{i}]", strict, unrecognized)
                if parsed is not None:
                    values.append(parsed)
            kwargs[key] = tuple(values)
        elif field.kind == "map":
            if not isinstance(item, dict):
                raise WireJsonError(f"{at}: not an object")
            # Paths never carry data, and a map key is data: an entry's path is the map's, with {}.
            entries = {}
            for entry_key, element in item.items():
                if element is None:
                    raise WireJsonError(f"{at}{{}}: wrong type")
                parsed = _value_in(field.value, field.ref, element, f"{at}{{}}", strict, unrecognized)
                if parsed is not None:
                    entries[entry_key] = parsed
            kwargs[key] = entries
        else:
            parsed = _value_in(field.kind, field.ref, item, at, strict, unrecognized)
            if parsed is not None:
                kwargs[key] = parsed
    for field in fields.values():
        if field.required and field.name not in value:
            raise WireJsonError(f"{field.name if path == '' else f'{path}.{field.name}'}: missing")
    return cls(**kwargs)


def _value_in(kind: str, ref: Any, item: Any, at: str, strict: bool, unrecognized: list[str]) -> Any:
    match kind:
        case "string" if isinstance(item, str):
            return item
        case "bool" if isinstance(item, bool):
            return item
        case "int32" if (number := _int_in(item)) is not None:
            return number
        case "double" if (number := _double_in(item)) is not None:
            return number
        case "timestamp" if isinstance(item, str) and (canonical := _timestamp_in(item)) is not None:
            return canonical
        case "fieldmask" if isinstance(item, str) and (paths := _field_mask_in(item)) is not None:
            return paths
        case "message":
            return _read(ref, item, at, strict, unrecognized)
        case "enum":
            if not isinstance(item, str):
                raise WireJsonError(f"{at}: wrong type")
            member = _enum_in(ref, item)
            if member is None:
                if strict:
                    raise WireJsonError(f"{at}: unknown enum value")
                unrecognized.append(at)
            return member
    raise WireJsonError(f"{at}: wrong type")


# ---- value rules (proto/ts/wire-rules.ts is the twin) ----------------------------------------------------


@functools.cache
def _regex(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


def format_matches(format: Format, value: str) -> bool:
    """Whether ``value`` matches a format of a generated module (its ``FORMATS``). A producer checks a name it did not
    choose before writing it (a metric key, a stored error code) with this, so the contract's pattern stays the one
    definition."""
    return _regex(format.pattern).fullmatch(value) is not None and (
        format.max_length == 0 or len(value) <= format.max_length
    )


def _join(path: str, name: str) -> str:
    return name if path == "" else f"{path}.{name}"


def _violation(message: Any, path: str, *, lenient: bool, unrecognized: frozenset[str]) -> str | None:
    """The first rule ``message`` (at ``path``) breaks, as ``<path>: <rule>``, or None."""
    variant = None
    union = _union(type(message))
    if union is not None and _join(path, union) not in unrecognized:
        variant = _enum_out(getattr(message, union))
    for field in _fields(type(message)):
        violation = _field_violation(message, field, _join(path, field.name), variant, lenient, unrecognized)
        if violation is not None:
            return violation
    return None


def _has_value(value: Any, field: Field, at: str, unrecognized: frozenset[str]) -> bool:
    """An enum other than its zero value (or one the read did not know), a set message or ``optional`` scalar, an
    implicit scalar other than its default unless it is REQUIRED (always written, so ``"version": ""`` is a value to
    check), and always a list or a map."""
    if field.repeated or field.kind == "map":
        return True
    if field.kind == "enum":
        return value != 0 or at in unrecognized
    if field.optional:
        return value is not None
    return field.required or value != DEFAULTS.get(field.kind)


def _field_violation(
    message: Any, field: Field, at: str, variant: str | None, lenient: bool, unrecognized: frozenset[str]
) -> str | None:
    rules = field.rules
    value = getattr(message, field.name)
    active = None if variant is None else next((case for case in rules.cases if variant in case.when), None)
    presence = "" if variant is None else (active.presence if active is not None else rules.otherwise)
    has = _has_value(value, field, at, unrecognized)
    if presence == "required" and not has:
        return f"{at}: required when the discriminator is {variant}"
    if presence == "absent" and has:
        return f"{at}: not allowed when the discriminator is {variant}"
    if not has:
        return None
    extra = () if active is None else (active.bounds,)
    if field.kind == "map":
        if rules.max_items and len(value) > rules.max_items:
            return f"{at}: more than {rules.max_items} entries"
        if any(key not in value for key in rules.required_keys):
            return f"{at}: lacks a required key"
        for key, item in value.items():
            if rules.key_format is not None and not format_matches(rules.key_format, key):
                return f"{at}{{}}: a key does not match {rules.key_format.name}"
            violation = _item_violation(
                field.value, item, f"{at}{{}}", rules._replace(format=None, allowed=None), extra, lenient, unrecognized
            )
            if violation is not None:
                return violation
        return None
    if field.repeated:
        if rules.max_items and len(value) > rules.max_items:
            return f"{at}: more than {rules.max_items} items"
        if rules.unique and len(set(value)) != len(value):
            return f"{at}: items are not unique"
        for i, item in enumerate(value):
            violation = _item_violation(field.kind, item, f"{at}[{i}]", rules, extra, lenient, unrecognized)
            if violation is not None:
                return violation
        return None
    return _item_violation(field.kind, value, at, rules, extra, lenient, unrecognized)


def _item_violation(
    kind: str, value: Any, at: str, rules: Rules, extra: tuple[Bounds, ...], lenient: bool, unrecognized: frozenset[str]
) -> str | None:
    """The rules of one value: a singular field's, a list item's or a map value's."""
    match kind:
        case "message":
            return _violation(value, at, lenient=lenient, unrecognized=unrecognized)
        case "enum":
            if at in unrecognized:
                return None  # a value this build does not know: nothing to compare
            name = _enum_out(value)
            return None if name is None else _allowed_violation(name, at, rules, extra, lenient)
        case "string":
            if rules.format is not None and not format_matches(rules.format, value):
                return f"{at}: does not match {rules.format.name}"
            return _allowed_violation(value, at, rules, extra, lenient)
        case "int32" | "double":
            for bounds in (rules, *extra):
                if bounds.minimum is not None and value < bounds.minimum:
                    return f"{at}: below the minimum"
                if bounds.maximum is not None and value > bounds.maximum:
                    return f"{at}: above the maximum"
    return None


def _allowed_violation(value: str, at: str, rules: Rules, extra: tuple[Bounds, ...], lenient: bool) -> str | None:
    if lenient and rules.open:
        return None
    for bounds in (rules, *extra):
        if bounds.allowed is not None and value not in bounds.allowed:
            return f"{at}: not an allowed value"
    return None
