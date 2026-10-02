"""Bounded JSON decoding and durable file writes for configuration owners.

Callers own path trust, schema validation, locking and error-code translation.
These operations do not interpret configuration or open application storage.
"""

import json
import os
import pathlib
import tempfile
from typing import Any


def decode_json(raw: bytes) -> Any:
    """Decode JSON while rejecting duplicate keys at every object depth."""

    def unique_pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=unique_pairs)


def read_json(path: pathlib.Path, maximum: int) -> Any:
    """Decode a file with at most maximum bytes, without changing its state."""
    with path.open("rb") as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("JSON file exceeds byte limit")
    return decode_json(raw)


def sync_directory(directory: pathlib.Path) -> None:
    """Flush a directory after a committed rename or removal."""
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_text(path: pathlib.Path, value: str) -> None:
    """Replace one file with durable UTF-8 text using a private sibling file.

    A failure before replacement preserves the previous destination. A failure
    syncing the directory after replacement can leave the new file visible;
    callers must treat that result as uncertain rather than assume rollback.
    """
    descriptor, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)
