"""Typed access to Worker vars and secrets."""

from typing import Any

COORDINATOR_NAME = "inbox-v1"


def var(env: Any, name: str, default: str = "") -> str:
    value = getattr(env, name, None)
    return default if value is None else str(value).strip()


def flag(env: Any, name: str) -> bool:
    return var(env, name) == "true"


def csv(env: Any, name: str) -> list[str]:
    return [item.strip().lower() for item in var(env, name).split(",") if item.strip()]


def local_dev(env: Any) -> bool:
    """Dev-only switches are ignored unless the public host is a *.localhost name."""
    return var(env, "TODOFY_PUBLIC_HOST").lower().endswith(".localhost")


def coordinator(env: Any) -> Any:
    return env.COORDINATOR.getByName(COORDINATOR_NAME)
