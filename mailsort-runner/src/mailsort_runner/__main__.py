"""One-shot entrypoint, non-model preflight, and official device login."""

import argparse
import asyncio
import json
import os
import tempfile
from importlib import metadata
from pathlib import Path

from mailsort_runner import runtime
from mailsort_runner.settings import EFFORT, MODEL, SDK_VERSION, RunnerError, Settings, codex_home


async def preflight() -> None:
    sdk = runtime.load_sdk()
    home = codex_home()
    with tempfile.TemporaryDirectory(prefix="mailsort-preflight-") as directory:
        async with (
            asyncio.timeout(60),
            sdk.AsyncCodex(runtime.config(sdk, home, Path(directory))) as client,
        ):
            account = await client.account(refresh_token=True)
            if account.account is None or account.account.root.type != "chatgpt":
                raise RunnerError("codex_not_logged_in")
            models = await client.models(include_hidden=True)
            if not any(model.model == MODEL for model in models.data):
                raise RunnerError("codex_model_unavailable")
    print(json.dumps({"status": "ready", "model": MODEL, "effort": EFFORT}))


def login() -> None:
    sdk = runtime.load_sdk()
    home = codex_home()
    with tempfile.TemporaryDirectory(prefix="mailsort-login-") as directory:
        configuration = runtime.config(sdk, home, Path(directory))
        args = runtime.launch_args(configuration.config_overrides, "login", "--device-auth")
        os.execve(args[0], list(args), configuration.env)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one private Mailsort batch; no HTTP server.")
    parser.add_argument(
        "command", nargs="?", choices=("run", "preflight", "login", "identity"), default="run"
    )
    command = parser.parse_args().command
    if command == "identity":
        print(
            json.dumps(
                {
                    "application": "mailsort-runner",
                    "model": MODEL,
                    "effort": EFFORT,
                    "sdk_version": metadata.version("openai-codex"),
                    "runtime_version": metadata.version("openai-codex-cli-bin"),
                    "expected_version": SDK_VERSION,
                }
            )
        )
        return 0
    try:
        if command == "preflight":
            asyncio.run(preflight())
            return 0
        if command == "login":
            login()
            return 0
        from mailsort_runner.api import Client
        from mailsort_runner.runner import run

        settings = Settings.from_environment()
        client = Client(settings)
        try:
            return asyncio.run(run(client, settings))
        finally:
            client.close()
    except Exception as error:
        code = error.code if isinstance(error, RunnerError) else "runner_failed"
        print(json.dumps({"status": "failed", "error_code": code}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
