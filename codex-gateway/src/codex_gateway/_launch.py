"""Launch the bundled runtime without inherited service credentials or API keys."""

import os
import sys

RUNTIME_ENV_KEYS = frozenset(
    {"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"}
)


def runtime_environment(environ: dict[str, str]) -> dict[str, str]:
    """The SDK overlays env, so remove unrelated keys at the final exec boundary."""
    return {key: value for key, value in environ.items() if key in RUNTIME_ENV_KEYS}


def main() -> None:
    import codex_cli_bin

    executable = str(codex_cli_bin.bundled_codex_path())
    environment = runtime_environment(dict(os.environ))
    bundled = codex_cli_bin.bundled_path_dir()
    if bundled is not None:
        environment["PATH"] = os.pathsep.join(
            [str(bundled), environment.get("PATH", "")]
        ).rstrip(os.pathsep)
    os.execve(executable, [executable, *sys.argv[1:]], environment)


if __name__ == "__main__":
    main()
