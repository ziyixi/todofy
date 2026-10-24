"""Exercise imports and pinned identity with networking disabled and no credentials."""

import argparse
import json
import subprocess

RUNTIME_SMOKE = """
import asyncio
from pathlib import Path
import subprocess
import tempfile
from mailsort_runner import runtime

async def main():
    sdk = runtime.load_sdk()
    with tempfile.TemporaryDirectory() as name:
        root = Path(name)
        home, workspace = root / 'auth', root / 'work'
        home.mkdir(); workspace.mkdir()
        configuration = runtime.config(sdk, home, workspace)
        result = subprocess.run(
            runtime.launch_args(configuration.config_overrides, 'features', 'list'),
            cwd=workspace, env=configuration.env, text=True, capture_output=True, check=True,
        )
        features = {row.split()[0]: row.split()[-1] for row in result.stdout.splitlines()}
        for name in ('shell_tool', 'apps', 'plugins', 'browser_use', 'code_mode_host'):
            assert features[name] == 'false'
        async with asyncio.timeout(30), sdk.AsyncCodex(configuration) as client:
            account = await client.account(refresh_token=False)
            assert account.account is None

asyncio.run(main())
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    flags = [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
    ]
    identity = json.loads(subprocess.check_output([*flags, args.image, "identity"], text=True))
    assert identity["application"] == "mailsort-runner"
    assert identity["model"] == "gpt-6.1-sol"
    assert identity["effort"] == "medium"
    assert identity["sdk_version"] == identity["runtime_version"] == "0.163.0"
    subprocess.run([*flags, args.image, "--help"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        [
            *flags,
            "--entrypoint",
            "python",
            args.image,
            "-c",
            "from mailsort_runner import api, classifier, runner; "
            "from ziyixi_proto.mailsort.runner.v1 import mailsort_runner_service_pb; "
            "assert len(mailsort_runner_service_pb.HTTP_BINDINGS) == 2",
        ],
        check=True,
    )
    subprocess.run(
        [
            *flags,
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
            "--entrypoint",
            "python",
            args.image,
            "-c",
            RUNTIME_SMOKE,
        ],
        check=True,
    )
    print("mailsort-runner offline image smoke passed")


if __name__ == "__main__":
    main()
