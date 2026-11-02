"""Finish the Worker stage after the checked collector is already running."""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).absolute().parents[2]
GITHUB = "https://api.github.com/repos/ziyixi/todofy"


def complete(release, cluster_session, owned):
    parent_sha, private_sha = release.checked_source()
    token, actor = os.environ["GITHUB_TOKEN"], os.environ["GITHUB_ACTOR"]
    current = release.request(GITHUB + "/git/ref/heads/main", token=token)
    if current.get("object", {}).get("sha") != parent_sha:
        raise ValueError("private_finish_worker_main_changed")
    release.require_private_package(token)
    digest = release.registry_digest(private_sha, token, actor)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("private_image_digest_mismatch")
    config = release.configuration()
    with cluster_session(release.ROOT) as cluster:
        result = cluster.run(
            [
                "get",
                "Deployment",
                "quant-collector",
                "--namespace",
                "quant",
                "-o",
                "json",
                "--request-timeout=15s",
            ],
            timeout=30,
        )
        deployment = json.loads(result.stdout)
        install_id = (
            deployment.get("metadata", {})
            .get("annotations", {})
            .get("quant.ziyixi.science/install-id", "")
        )
        if not re.fullmatch(r"[0-9a-f]{64}", install_id):
            raise ValueError("private_finish_worker_ownership_invalid")
        owned(deployment, install_id)
    release_id = hashlib.sha256((private_sha + digest).encode()).hexdigest()
    # The existing runtime status checks actual ready Pod imageID, source and generation.
    release.observe_collector_release(config, private_sha, digest, release_id)

    with tempfile.TemporaryDirectory(prefix="private-finish-worker-") as directory:
        work = Path(directory)
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("ACTIONS_ID_TOKEN_REQUEST_", "KUBE", "K3S_"))
            and key
            not in {"PLATFORM_ACCESS_CLIENT_ID", "PLATFORM_ACCESS_CLIENT_SECRET"}
        }
        environment.update(WRANGLER_SEND_METRICS="false", CI="true")

        def run(arguments, *, data=None, capture=False):
            result = subprocess.run(
                arguments,
                cwd=release.ROOT,
                env=environment,
                input=data,
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode:
                raise ValueError("private_finish_worker_command_failed")
            return result.stdout.strip() if capture else None

        options = [
            "--embed_label=" + parent_sha,
            "--define=PRIVATE_SOURCE_SHA=" + private_sha,
            "--platforms=@personal_cloud//tools/bazel/images:linux_amd64",
        ]
        run(["bazel", "build", "@private//quant:worker_artifact", *options])

        def output(target):
            files = run(
                ["bazel", "cquery", target, "--output=files", *options], capture=True
            ).splitlines()
            if len(files) != 1:
                raise ValueError("private_release_output_invalid")
            return release.ROOT / files[0]

        prepared = release.prepare_worker(run, output, work, config)
        deployment = release.request(
            GITHUB + "/deployments",
            token=token,
            method="POST",
            body={
                "ref": parent_sha,
                "environment": "private",
                "auto_merge": False,
                "required_contexts": [],
                "production_environment": True,
                "payload": {
                    "fingerprint": os.environ.get("PRIVATE_BUILD_FINGERPRINT", ""),
                    "private_sha": private_sha,
                    "parent_sha": parent_sha,
                },
            },
        )
        statuses = deployment["statuses_url"]
        if not isinstance(statuses, str) or not re.fullmatch(
            re.escape(GITHUB) + r"/deployments/[1-9][0-9]*/statuses", statuses
        ):
            raise ValueError("private_finish_worker_receipt_invalid")
        release.request(
            statuses, token=token, method="POST", body={"state": "in_progress"}
        )
        try:
            release.deploy_worker(run, options, prepared, private_sha)
        except Exception:
            release.request(
                statuses,
                token=token,
                method="POST",
                body={
                    "state": "failure",
                    "description": "Private Worker completion failed verification.",
                },
            )
            raise
        release.request(
            statuses,
            token=token,
            method="POST",
            body={
                "state": "success",
                "description": "Existing collector and checked Worker passed identity and health verification.",
            },
        )
    print(
        json.dumps(
            {
                "event": "private_worker_finished",
                "source_sha": private_sha,
                "image_digest": digest,
            }
        ),
        flush=True,
    )


def main():
    sys.path[:0] = [str(ROOT / "private"), str(ROOT / "private/quant/deploy")]
    try:
        import release
        from k3s.session import cluster_session
        from k3s_install import _owned

        complete(release, cluster_session, _owned)
    except Exception as failure:  # noqa: BLE001 - Dependency details must not enter public logs.
        message = str(failure)
        code = (
            message
            if isinstance(failure, ValueError)
            and re.fullmatch(
                r"(?:private_[a-z_]+|quant_[a-z_]{1,64}|release_dependency_http_[0-9]{3}|K3S_[A-Z0-9_]{1,64})",
                message,
            )
            else "PRIVATE_FINISH_WORKER_FAILED"
        )
        print(json.dumps({"error_code": code}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
