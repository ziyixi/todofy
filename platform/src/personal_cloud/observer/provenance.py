"""Only the image's immutable public build identity, never host paths or environment claims."""

import importlib.resources
import json
import re


def source_sha() -> str | None:
    try:
        metadata = (
            importlib.resources.files("personal_cloud")
            .joinpath("build-info.json")
            .read_text()
        )
        if len(metadata) > 4096:
            return None
        value = json.loads(metadata).get("source_sha")
        return (
            value
            if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value)
            else None
        )
    except (AttributeError, FileNotFoundError, OSError, ValueError, TypeError):
        return None
