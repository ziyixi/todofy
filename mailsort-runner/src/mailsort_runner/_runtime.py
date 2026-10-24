"""Execute the pinned CLI with an exact environment, removing inherited secrets."""

import os
import sys
from collections.abc import Mapping

ENV_KEYS = frozenset({"PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"})


def runtime_environment(environ: Mapping[str, str]) -> dict[str, str]:
    return {key: value for key, value in environ.items() if key in ENV_KEYS or key == "CODEX_HOME"}


def main() -> None:
    import codex_cli_bin

    executable = str(codex_cli_bin.bundled_codex_path())
    environment = runtime_environment(os.environ)
    bundled = codex_cli_bin.bundled_path_dir()
    if bundled is not None:
        environment["PATH"] = os.pathsep.join([str(bundled), environment.get("PATH", "")])
    os.execve(executable, [executable, *sys.argv[1:]], environment)


if __name__ == "__main__":
    main()
