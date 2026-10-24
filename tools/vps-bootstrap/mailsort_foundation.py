"""One root-only extension of an existing cluster; never a routine deployment path."""

import argparse
import base64
import json
import os
import re
from pathlib import Path

import cluster
from host import directory, write_file

from config import BootstrapError, load_bundle, require


def private_file(path, limit):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "PRIVATE_FILE_INVALID")
    info = path.stat()
    require(info.st_mode & 0o077 == 0 and info.st_size <= limit, "PRIVATE_FILE_INVALID")
    return path.read_bytes()


def install(bundle, sha, token_file, auth_file):
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    bundle = Path(bundle)
    public = load_bundle(bundle)
    require(public["source_sha"] == sha, "BUNDLE_SHA_MISMATCH")
    profile = public["profile"]
    namespace = profile["namespace"]
    image = public["images"].get("mailsort-runner", "")
    require(
        re.fullmatch(
            r"ghcr\.io/"
            + re.escape(profile["repository"])
            + r"-mailsort-runner@sha256:[0-9a-f]{64}",
            image,
        )
        is not None,
        "RUNNER_IMAGE_MISSING",
    )
    token = private_file(token_file, 1024).decode().strip()
    require(re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) is not None, "TOKEN_INVALID")
    auth = private_file(auth_file, 65536)
    try:
        require(isinstance(json.loads(auth), dict), "CODEX_AUTH_INVALID")
    except ValueError:
        raise BootstrapError("CODEX_AUTH_INVALID") from None
    auth_dir = Path(profile["state_root"]) / "mailsort-runner" / "auth"
    directory(auth_dir.parent, uid=10001, gid=10001, mode=0o700)
    directory(auth_dir, uid=10001, gid=10001, mode=0o700)
    destination = auth_dir / "auth.json"
    if destination.exists():
        private_file(destination, 65536)
    else:
        write_file(destination, auth, uid=10001, gid=10001, mode=0o600)
    foundation = json.loads((bundle / "foundation.json").read_text())
    selected = [
        item
        for item in foundation["items"]
        if (
            item["kind"] == "PersistentVolume"
            and item["metadata"]["name"] == "personal-cloud-mailsort-runner-auth"
            or item["kind"] == "PersistentVolumeClaim"
            and item["metadata"]["name"] == "mailsort-runner-auth"
            or item["kind"] == "Role"
            and item["metadata"]["name"] == "platform-controller"
        )
    ]
    require(len(selected) == 3, "FOUNDATION_RESOURCES_INVALID")
    selected.append(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "mailsort-runner", "namespace": namespace},
            "type": "Opaque",
            "data": {"MAILSORT_TOKEN": base64.b64encode(token.encode()).decode()},
        }
    )
    cluster.apply({"apiVersion": "v1", "kind": "List", "items": selected})
    # The old daemon accepts only two targets. Install this CI-tested daemon once;
    # its existing ledger/PVC and Newsletter remain in place for the three-target release.
    runtime = json.loads((bundle / "runtime.json").read_text())
    platform = next(
        item
        for item in runtime["items"]
        if item["kind"] == "Deployment"
        and item["metadata"]["name"] == "platform-runtime"
    )
    require(
        platform["spec"]["template"]["spec"]["containers"][0]["image"]
        == public["images"]["platform"],
        "PLATFORM_IMAGE_MISMATCH",
    )
    cluster.apply(platform)
    cluster.kubectl(
        [
            "-n",
            namespace,
            "rollout",
            "status",
            "deployment/platform-runtime",
            "--timeout=300s",
        ],
        timeout=330,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--codex-auth-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        install(args.bundle, args.source_sha, args.token_file, args.codex_auth_file)
        print(json.dumps({"event": "mailsort_foundation", "status": "installed"}))
        return 0
    except (BootstrapError, OSError, ValueError, KeyError, StopIteration) as error:
        print(
            json.dumps(
                {
                    "event": "mailsort_foundation",
                    "status": "failed",
                    "error_code": str(error)
                    if isinstance(error, BootstrapError)
                    else "FOUNDATION_FAILED",
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
