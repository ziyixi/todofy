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
"""

import datetime
import enum
import functools
import re
import sys
from typing import Any, NamedTuple

RFC3339_UTC = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z")
INT32 = range(-(2**31), 2**31)


class WireJsonError(ValueError):
    """The JSON is not a valid message of the requested type in this mode."""


class Field(NamedTuple):
    """One row of a generated module's ``FIELDS`` table."""

    name: str
    number: int
    kind: str  # string, bool, int32, enum, message, timestamp
    ref: Any  # the enum or message class, or None
    repeated: bool
    optional: bool  # explicit presence: unset is None
    required: bool  # google.api.field_behavior = REQUIRED


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
    return field.required and not field.repeated and (field.optional or field.kind == "enum")


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


def _int_in(item: Any) -> int | None:
    if isinstance(item, bool):
        return None
    if isinstance(item, float) and item.is_integer():
        item = int(item)
    return item if isinstance(item, int) and item in INT32 else None


def to_wire(message: Any) -> dict[str, Any]:
    """The wire JSON object of ``message`` (pass it to json.dumps)."""
    out: dict[str, Any] = {}
    for field in _fields(type(message)):
        value = getattr(message, field.name)
        if field.repeated:
            items = [_value_out(field, item) for item in value]
            if items or field.required:
                out[field.name] = items
            continue
        if field.kind == "enum":
            value = _enum_out(value)
        elif value is not None:
            value = _value_out(field, value)
        if value is not None:
            out[field.name] = value
        elif field.required:
            out[field.name] = None
    return out


def _value_out(field: Field, value: Any) -> Any:
    if field.kind == "message":
        return to_wire(value)
    if field.kind == "enum":
        return _enum_out(value)
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
                parsed = _value_in(field, element, f"{at}[{i}]", strict, unrecognized)
                if parsed is not None:
                    values.append(parsed)
            kwargs[key] = tuple(values)
        else:
            parsed = _value_in(field, item, at, strict, unrecognized)
            if parsed is not None:
                kwargs[key] = parsed
    for field in fields.values():
        if field.required and field.name not in value:
            raise WireJsonError(f"{field.name if path == '' else f'{path}.{field.name}'}: missing")
    return cls(**kwargs)


def _value_in(field: Field, item: Any, at: str, strict: bool, unrecognized: list[str]) -> Any:
    match field.kind:
        case "string" if isinstance(item, str):
            return item
        case "bool" if isinstance(item, bool):
            return item
        case "int32" if (number := _int_in(item)) is not None:
            return number
        case "timestamp" if isinstance(item, str) and (canonical := _timestamp_in(item)) is not None:
            return canonical
        case "message":
            return _read(field.ref, item, at, strict, unrecognized)
        case "enum":
            member = _enum_in(field.ref, item)
            if member is None:
                if strict or not isinstance(item, str):
                    raise WireJsonError(f"{at}: unknown enum value")
                unrecognized.append(at)
            return member
    raise WireJsonError(f"{at}: wrong type")
