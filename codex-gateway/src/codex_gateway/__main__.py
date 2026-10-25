"""Start the private HTTP service; model credentials stay in CODEX_HOME."""

import uvicorn

from codex_gateway.app import create_app


def main() -> None:
    uvicorn.run(create_app(), host="0.0.0.0", port=8080, access_log=False)


if __name__ == "__main__":
    main()
