"""Fixed argv subprocess calls: private inputs use stdin and raw output is never logged."""

import subprocess

from config import BootstrapError


def command(argv, *, data=None, timeout=60, check=True):
    try:
        result = subprocess.run(
            argv,
            input=data,
            capture_output=True,
            timeout=timeout,
            check=False,
            env={
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG": "C.UTF-8",
            },
        )
    except (OSError, subprocess.SubprocessError):
        raise BootstrapError("SYSTEM_COMMAND_UNAVAILABLE") from None
    if check and result.returncode:
        raise BootstrapError("SYSTEM_COMMAND_FAILED")
    if len(result.stdout) > 4 * 1024 * 1024:
        raise BootstrapError("SYSTEM_RESPONSE_TOO_LARGE")
    return result
