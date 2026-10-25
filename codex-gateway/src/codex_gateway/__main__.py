"""Keep CLI state private while sharing the existing login file."""

import os
import pathlib
import tempfile

import uvicorn

from codex_gateway.app import create_app


def main() -> None:
    shared_home = os.environ["CODEX_HOME"]
    shared_auth = pathlib.Path(shared_home) / "auth.json"
    if not shared_auth.is_absolute():
        raise ValueError("CODEX_HOME must be absolute")
    with tempfile.TemporaryDirectory(prefix="codex-gateway-home-") as directory:
        home = pathlib.Path(directory)
        (home / "auth.json").symlink_to(shared_auth)
        os.environ["CODEX_HOME"] = str(home)
        try:
            uvicorn.run(create_app(), host="0.0.0.0", port=8080, access_log=False)
        finally:
            os.environ["CODEX_HOME"] = shared_home


if __name__ == "__main__":
    main()
