"""Exec the SDK's pinned runtime with an exact environment, not an env overlay.

Invoked as an isolated Python script (-I). The SDK merges config.env with the
service environment, so omission cannot unset a variable and empty values can
change runtime behavior. This final exec boundary actually removes those keys.
No credentials are opened, copied, or passed as command-line arguments.
"""

from collections.abc import Mapping
import os
import sys

RUNTIME_ENV_KEYS = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "SYSTEMROOT",
        "WINDIR",
    }
)


def runtime_environment(environ: Mapping[str, str]) -> dict[str, str]:
    """Retain only the runtime allowlist and the dedicated login path."""
    return {
        key: value
        for key, value in environ.items()
        if key in RUNTIME_ENV_KEYS or key == "CODEX_HOME"
    }


def main() -> None:
    """Replace this helper with the pinned executable and sanitized env."""
    # This optional dependency is needed only when executing the helper.
    import codex_cli_bin  # type: ignore[import-untyped]  # noqa: PLC0415

    executable = str(codex_cli_bin.bundled_codex_path())
    environment = runtime_environment(os.environ)
    # Preserve the SDK's bundled tool path, without resolving arbitrary
    # binaries.
    bundled = codex_cli_bin.bundled_path_dir()
    if bundled is not None:
        environment["PATH"] = os.pathsep.join(
            [str(bundled), environment.get("PATH", "")]
        ).rstrip(os.pathsep)
    os.execve(executable, [executable, *sys.argv[1:]], environment)


if __name__ == "__main__":
    main()
