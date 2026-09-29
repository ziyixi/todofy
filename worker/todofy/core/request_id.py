"""Deterministic Todoist ``X-Request-Id`` (todo/todo.go:169-178 @ 6c46ed4).

Todoist may deduplicate on it; safety never depends on that, it only makes a
retry of the same frozen request look identical.
"""

import hashlib

PREFIX = "todofy-"
HASH_CHARS = 28


def todoist_request_id(content: str, description: str, sender: str) -> str:
    """``content`` is the task title, ``description`` the full body with footer,
    ``sender`` the first From address (``"todofy"`` for reminders)."""
    digest = hashlib.sha256(f"{content}\0{description}\0{sender}".encode()).hexdigest()
    return PREFIX + digest[:HASH_CHARS]
