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


def _fields(cls: type) -> tuple[Field, ...]:
    return sys.modules[cls.__module__].FIELDS[cls]


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


def to_wire(message: Any) -> dict[str, Any]:
    """The wire JSON object of ``message`` (pass it to json.dumps)."""
    out: dict[str, Any] = {}
    for field in _fields(type(message)):
        value = getattr(message, field.name)
        if field.repeated:
            items = [_value_out(field.kind, field, item) for item in value]
            if items or field.required:
                out[field.name] = items
            continue
        if field.kind == "map":
            entries = {key: _value_out(field.value, field, value[key]) for key in sorted(value, key=_map_key_order)}
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
            return to_wire(value)
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
    """Reads a parsed wire JSON value into a ``cls`` instance."""
    unrecognized: list[str] = []
    return ReadResult(_read(cls, value, "", strict, unrecognized), unrecognized)


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
            # reader refuses it, and a lenient one takes it only where to_wire writes it.
            if strict:
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
