"""Launch the bundled runtime without inherited service credentials or API keys."""

import os
import signal
import subprocess
import sys

RUNTIME_ENV_KEYS = frozenset(
    {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"}
)


def runtime_environment(environ: dict[str, str]) -> dict[str, str]:
    """The SDK overlays env, so remove unrelated keys at the final exec boundary."""
    return {key: value for key, value in environ.items() if key in RUNTIME_ENV_KEYS}


def main() -> None:
    # A dedicated process group makes SDK close terminate hosted-tool children too.
    # Linux parent-death notification also covers an abrupt service-worker restart.
    parent = os.getppid()
    arguments = sys.argv[1:]
    if arguments[:1] == ["--gateway-parent-pid"]:
        parent = int(arguments[1])
        arguments = arguments[2:]
    os.setsid()

    def terminate_group(_signum, _frame):
        os.killpg(os.getpgrp(), signal.SIGKILL)

    signal.signal(signal.SIGTERM, terminate_group)
    signal.signal(signal.SIGINT, terminate_group)
    if sys.platform == "linux":
        import ctypes

        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM) != 0:
            raise RuntimeError("Unable to supervise runtime")
    if os.getppid() != parent:
        terminate_group(None, None)

    import codex_cli_bin

    executable = str(codex_cli_bin.bundled_codex_path())
    environment = runtime_environment(dict(os.environ))
    bundled = codex_cli_bin.bundled_path_dir()
    if bundled is not None:
        environment["PATH"] = os.pathsep.join(
            [str(bundled), environment.get("PATH", "")]
        ).rstrip(os.pathsep)
    process = subprocess.Popen(
        [executable, *arguments], env=environment, close_fds=True
    )
    try:
        process.wait()
    finally:
        terminate_group(None, None)


if __name__ == "__main__":
    main()
