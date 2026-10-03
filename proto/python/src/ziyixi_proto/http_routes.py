"""Bounded HTTP request helpers for generated google.api.http route metadata.

No network, authentication, handler dispatch or provider access. The transport authorizes first;
applications implement only the capabilities they expose. Route sources are generated, never literals.
"""
from __future__ import annotations

import json
import re
import sys
from itertools import islice
from typing import Iterable, NamedTuple
from urllib.parse import unquote

from .wire_json import WireJsonError, from_wire


class HttpBinding(NamedTuple):
    """One generated binding to a typed RPC, including its original AIP path template."""
    service: str
    rpc: str
    method: str
    path_template: str
    request: type
    response: type
    body: str = ""


def match_path(binding: HttpBinding, path: str) -> dict[str, str] | None:
    """Match a bounded absolute path; reject encoded separators and unsupported templates."""
    if len(path) > 2048 or not path.startswith("/") or "?" in path or "#" in path:
        return None
    if re.search(r"%(?:2f|5c|00)", path, re.I) or "\\" in path:
        return None
    try:
        decoded = unquote(path, errors="strict")
    except UnicodeDecodeError:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in decoded):
        return None
    parts, names, cursor = [], [], 0
    for token in re.finditer(r"\{([a-z][a-z0-9_.]*)(?:=([^{}]+))?\}", binding.path_template):
        parts.append(re.escape(binding.path_template[cursor:token.start()]))
        name, template = token.group(1), token.group(2) or "*"
        if name in names or "**" in template or "{" in template or "}" in template:
            raise ValueError("unsupported HTTP path template")
        names.append(name)
        expression = "/".join("[^/]+" if segment == "*" else re.escape(segment) for segment in template.split("/"))
        parts.append("(" + expression + ")")
        cursor = token.end()
    parts.append(re.escape(binding.path_template[cursor:]))
    found = re.fullmatch("".join(parts), decoded)
    return dict(zip(names, found.groups())) if found else None


def decode_json_body(raw: bytes, *, max_bytes: int = 16384) -> dict:
    """Decode a bounded JSON object after transport authentication, rejecting duplicate keys at every depth."""
    if not isinstance(raw, bytes) or not 0 < max_bytes <= 65536 or not 0 < len(raw) <= max_bytes:
        raise WireJsonError("invalid body size")

    def unique(pairs: list[tuple[str, object]]) -> dict:
        value = {}
        for key, item in pairs:
            if key in value:
                raise WireJsonError("duplicate body field")
            value[key] = item
        return value

    def reject_constant(_: str) -> None:
        raise WireJsonError("invalid body number")

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise WireJsonError("invalid body JSON") from None
    if not isinstance(value, dict):
        raise WireJsonError("body must be an object")
    return value


def decode_request(binding: HttpBinding, path: str, query: Iterable[tuple[str, str]],
                   body: dict | None = None) -> object:
    """Decode generated HTTP bindings after authentication; no unknown, duplicate or overridden fields.

    The transport owns method selection, authentication and bounded byte reads. JSON bodies must be decoded
    with decode_json_body (or an equivalent duplicate-rejecting decoder) before passing the object here.
    Application-level semantics and output-only field checks remain the typed handler's responsibility.
    """
    if binding.method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        raise ValueError("unsupported HTTP method")
    values = match_path(binding, path)
    if values is None:
        raise WireJsonError("unmatched resource path")
    module = sys.modules[binding.request.__module__]
    fields = {field.name: field for field in module.FIELDS[binding.request]}
    if binding.body:
        if binding.method == "GET" or not isinstance(body, dict):
            raise WireJsonError("required body object is missing")
        if binding.body == "*":
            if set(body) & set(values):
                raise WireJsonError("body overrides resource path")
            values.update(body)
        else:
            if binding.body not in fields or "." in binding.body:
                raise ValueError("unsupported HTTP body field")
            if binding.body in values:
                raise WireJsonError("body overrides resource path")
            values[binding.body] = body
    elif body is not None:
        raise WireJsonError("unexpected request body")
    pairs = list(islice(query, 9))
    if len(pairs) > 8:
        raise WireJsonError("too many query fields")
    if binding.body == "*" and pairs:
        raise WireJsonError("query fields are forbidden with whole-request body")
    for key, value in pairs:
        if key in values or key not in fields or len(value) > 128:
            raise WireJsonError("invalid query field")
        field = fields[key]
        if field.kind == "int32":
            if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
                raise WireJsonError("invalid numeric query field")
            values[key] = int(value)
        elif field.kind == "string":
            values[key] = value
        else:
            raise WireJsonError("unsupported query field")
    return from_wire(binding.request, values, strict=True).message
