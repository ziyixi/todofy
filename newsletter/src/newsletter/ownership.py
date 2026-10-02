"""One process owns mutable Newsletter state, including maintenance commands."""

from collections.abc import Iterator
import contextlib
import fcntl
import os
import pathlib
import stat


@contextlib.contextmanager
def exclusive_store(data_dir: pathlib.Path) -> Iterator[None]:
    """Hold the same nonblocking data-directory lock for service or maintenance.

    This only owns the lock: it never opens/recovers the database or starts
    workers. The caller closes its database before leaving the context.

    Args:
        data_dir: Validated dedicated application directory.

    Yields:
        Ownership of the directory for the lifetime of this context.

    Raises:
        RuntimeError: Another service/maintenance process already holds it.
        OSError: The lock is inaccessible or is a symbolic link.
    """
    data_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    data_dir.chmod(0o700)
    descriptor = os.open(
        data_dir / "service.lock",
        os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
        0o600,
    )
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError("Newsletter service lock must be a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                "Newsletter data is busy; stop its service before maintenance"
            ) from None
        yield
    finally:
        os.close(descriptor)
