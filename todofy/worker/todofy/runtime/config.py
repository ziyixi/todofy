"""Typed access to Worker vars and secrets."""

from typing import Any

DEFAULT_SOURCE_ID = "mail-hero-personal"
DEFAULT_GEMINI_MODELS = ("gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite")


def var(env: Any, name: str, default: str = "") -> str:
    value = getattr(env, name, None)
    return default if value is None else str(value).strip()


def flag(env: Any, name: str) -> bool:
    return var(env, name) == "true"


def csv(env: Any, name: str) -> list[str]:
    return [item.strip().lower() for item in var(env, name).split(",") if item.strip()]


def integer(env: Any, name: str, default: int) -> int:
    """A non-negative integer var; anything unparsable falls back to the default."""
    value = var(env, name)
    return int(value) if value.isdigit() else default


def source_id(env: Any) -> str:
    return var(env, "MAIL_SOURCE_ID", DEFAULT_SOURCE_ID)


def gemini_models(env: Any) -> list[str]:
    """Fallback order; the first model is preferred."""
    return csv(env, "GEMINI_MODELS") or list(DEFAULT_GEMINI_MODELS)


def gemini_email_models(env: Any) -> list[str]:
    """Email summary order; older configurations inherit the shared chain."""
    return csv(env, "GEMINI_EMAIL_MODELS") or gemini_models(env)


def report_default_top(env: Any) -> int:
    """REPORT_DEFAULT_TOP (1-10): the precomputed recommendation size; the newsletter asks for 10."""
    value = integer(env, "REPORT_DEFAULT_TOP", 10)
    return value if 1 <= value <= 10 else 10
