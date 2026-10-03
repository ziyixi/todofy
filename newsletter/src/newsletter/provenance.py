"""Read immutable image identity and this process's release request."""

import json
import os
from pathlib import Path
import re
from uuid import UUID


def build_sha() -> str | None:
    """A missing development build has no production provenance."""
    try:
        with Path("/opt/newsletter/build-info.json").open("rb") as stream:
            body = stream.read(257)
        if len(body) > 256:
            return None
        value = json.loads(body)
    except (OSError, ValueError):
        return None
    sha = value.get("source_sha") if isinstance(value, dict) else None
    return (
        sha
        if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)
        else None
    )


def release_request_id() -> str | None:
    """A process reports only the canonical UUID supplied when it started."""
    value = os.getenv("NEWSLETTER_RELEASE_REQUEST_ID", "")
    try:
        identifier = UUID(value)
    except ValueError:
        return None
    if identifier.version == 4 and str(identifier) == value:
        return value
    return None
