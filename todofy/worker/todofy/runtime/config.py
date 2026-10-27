"""Typed access to Worker vars and secrets."""

from typing import Any

DEFAULT_SOURCE_ID = "mail-hero-personal"


def var(env: Any, name: str, default: str = "") -> str:
    value = getattr(env, name, None)
    return default if value is None else str(value).strip()


def flag(env: Any, name: str) -> bool:
    return var(env, name) == "true"


def integer(env: Any, name: str, default: int) -> int:
    """A non-negative integer var; anything unparsable falls back to the default."""
    value = var(env, name)
    return int(value) if value.isdigit() else default


def source_id(env: Any) -> str:
    return var(env, "MAIL_SOURCE_ID", DEFAULT_SOURCE_ID)


def report_default_top(env: Any) -> int:
    """REPORT_DEFAULT_TOP (1-10): the precomputed recommendation size; the newsletter asks for 10."""
    value = integer(env, "REPORT_DEFAULT_TOP", 10)
    return value if 1 <= value <= 10 else 10
