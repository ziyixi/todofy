"""Allowlisted fields from OpenTofu's JSON UI; never return provider text or values."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping

MAX_CAPTURE_BYTES = 2 * 1024 * 1024
MAX_LINE = 64 * 1024
MAX_DETAIL = 16 * 1024
MAX_DIAGNOSTICS = 5
MAX_API_CODES = 8
_HTTP = re.compile(
    r"^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) "
    r'"https://api\.cloudflare\.com/client/v4/[^"\r\n]{1,4096}": '
    r"([1-5][0-9]{2})(?=\s|$)"
)


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError("non_finite_json_number")


def _json(text):
    return json.loads(text, object_pairs_hook=_unique, parse_constant=_reject_constant)


def _numbers(detail):
    if not isinstance(detail, str) or len(detail) > MAX_DETAIL:
        return None, []
    match = _HTTP.match(detail)
    if match is None:
        return None, []
    status = int(match.group(1))
    start = detail.find("{", match.end())
    if start < 0:
        return status, []
    try:
        response = _json(detail[start:])
    except (ValueError, RecursionError):
        return status, []
    errors = response.get("errors") if isinstance(response, dict) else None
    if not isinstance(errors, list):
        return status, []
    codes = {
        error["code"]
        for error in errors
        if isinstance(error, dict)
        and type(error.get("code")) is int
        and 0 <= error["code"] <= 99_999_999
    }
    return status, sorted(codes)[:MAX_API_CODES]


def diagnostics(lines: Iterable[str], addresses: Mapping[str, str]) -> list[dict]:
    """Only diagnostics from supported UI v1; address mapping comes from the gated plan."""
    supported = False
    result = []
    for line in lines:
        if len(line) > MAX_LINE:
            continue
        try:
            record = _json(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(record, dict) or record.get("@module") != "tofu.ui":
            continue
        if record.get("type") == "version":
            version = record.get("ui")
            if not isinstance(version, str) or not re.fullmatch(
                r"1(?:\.[0-9]+){1,2}", version
            ):
                return []
            supported = True
            continue
        if not supported or record.get("type") != "diagnostic":
            continue
        diagnostic = record.get("diagnostic")
        if not isinstance(diagnostic, dict) or diagnostic.get("severity") != "error":
            continue
        address = diagnostic.get("address")
        resource = addresses.get(address) if isinstance(address, str) else None
        status, codes = _numbers(diagnostic.get("detail"))
        row = {"resource": resource, "http_status": status, "api_codes": codes}
        if row not in result:
            result.append(row)
        if len(result) == MAX_DIAGNOSTICS:
            break
    return result
