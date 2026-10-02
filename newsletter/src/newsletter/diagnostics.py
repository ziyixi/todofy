"""Failure diagnostics without exception messages, payloads or local paths."""

import hashlib
import logging
import re

_LABEL = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,79}\Z")


def record_failure(
    logger: logging.Logger,
    *,
    phase: str,
    error: BaseException,
    reference: str = "",
) -> None:
    """Log a stage, exception class and hashed correlation reference.

    Args:
        logger: The caller's module logger.
        phase: A fixed label chosen by application code.
        error: The failure; its message and traceback are never inspected.
        reference: An optional record identity, hashed before logging.
    """
    exception_type = type(error).__name__
    correlation = hashlib.sha256(reference.encode()).hexdigest()[:12]
    logger.warning(
        "Operation failed: phase=%s type=%s id=%s",
        phase if _LABEL.fullmatch(phase) else "unspecified",
        exception_type if _LABEL.fullmatch(exception_type) else "Exception",
        correlation if reference else "none",
    )
