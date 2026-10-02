"""CI-only configuration release; host orchestration uses only the stdlib.

Candidate Markdown/YAML/Jinja is never imported or executed on the host. A
tested, immutable service image owns all bundle parsing and template validation.
Publishing updates only the `published` Git branch, never production or email.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client as http_client
import json
import os
import pathlib
import re
import subprocess
import sys
from typing import Any, IO
import urllib.error as error
import urllib.request as urllib_request
import uuid

SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_RESPONSE = 2 * 1024 * 1024
MAX_BUNDLE = 768_000
PUBLISHED_BRANCH = "published"
CONTENT_PREFIX = "newsletter/content-config/"
SERVICE_IMAGE = "ghcr.io/ziyixi/todofy-newsletter"
PUBLISH_JOB = "Newsletter image publish"


class ReleaseError(RuntimeError):
    """A safe failure that excludes credentials and candidate content."""


class NoRedirect(urllib_request.HTTPRedirectHandler):
    """Keep repository-scoped credentials on the requested GitHub endpoint."""

    def redirect_request(
        self,
        req: urllib_request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: http_client.HTTPMessage,
        newurl: str,
    ) -> None:
        """Refuse all redirects instead of forwarding authorization headers."""
        return


def sha(value: object) -> str:
    """Require an exact full Git commit identity from an untrusted response."""
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ReleaseError("Invalid commit identity")
    return value


class GitHub:
    """Bound repository API requests without redirects or inherited proxies."""

    def __init__(self, repository: str, token: str) -> None:
        if (
            not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}",
                repository,
            )
            or not token
        ):
            raise ReleaseError(
                "GitHub release credentials or repository are unavailable"
            )
        self.prefix = "https://api.github.com/repos/" + repository
        self.token = token
        self.opener = urllib_request.build_opener(
            urllib_request.ProxyHandler({}), NoRedirect()
        )

    def request(
        self,
        method: str,
        path: str,
        value: object = None,
        *,
        missing: bool = False,
    ) -> Any:
        """Read bounded GitHub JSON or return None for an allowed missing ref.

        JSON shapes vary by endpoint and remain untrusted until callers check
        the required fields. HTTP errors never include response text or tokens.
        """
        if (
            method not in {"GET", "POST", "PATCH"}
            or not path.startswith("/")
            or path.startswith("//")
            or "#" in path
            or "\\" in path
            or ("?" in path and method != "GET")
        ):
            raise ReleaseError("Unsupported GitHub request")
        body = json.dumps(value).encode() if value is not None else None
        request = urllib_request.Request(
            self.prefix + path,
            data=body,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "newsletter-content-config-ci",
            },
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ReleaseError("GitHub response exceeds the release limit")
            return json.loads(raw)
        except error.HTTPError as exc:
            if missing and exc.code == 404:
                return None
            raise ReleaseError(
                f"GitHub release request failed (HTTP {exc.code})"
            ) from None
        except (error.URLError, TimeoutError, ValueError, RecursionError):
            raise ReleaseError("GitHub release request failed") from None

    def main(self) -> str:
        """Return the current full main-branch commit identity."""
        return sha(self.request("GET", "/git/ref/heads/main")["object"]["sha"])


def config_only_difference(
    api: GitHub, base: str, head: str, *, pull_request: bool = False
) -> bool:
    """Check that a complete comparison changes only authored configuration."""
    if base == head:
        return True
    compared = api.request("GET", f"/compare/{sha(base)}...{sha(head)}")
    # A PR may diverge because main advanced; its merge-base diff still tells
    # whether that PR changes only configuration. Engine reuse is stricter:
    # a tested engine must be the same commit or an ancestor of the revision.
    # GitHub caps a compare response at 300 changed files. Treat that boundary
    # conservatively; a truncated list cannot certify engine compatibility.
    files = compared.get("files")
    return bool(
        compared.get("status")
        in ({"ahead", "diverged"} if pull_request else {"ahead"})
        and isinstance(files, list)
        and len(files) < 300
        and all(
            isinstance(item, dict)
            and isinstance(item.get("filename"), str)
            and item["filename"].startswith(CONTENT_PREFIX)
            and (
                "previous_filename" not in item
                or (
                    isinstance(item["previous_filename"], str)
                    and item["previous_filename"].startswith(CONTENT_PREFIX)
                )
            )
            for item in files
        )
    )


def released_image(api: GitHub, run: dict[str, Any]) -> bool:
    """Require the actual image publication job, not a docs-only green run."""
    identity = run.get("id")
    if (
        not isinstance(identity, int)
        or isinstance(identity, bool)
        or identity < 1
    ):
        return False
    for page in range(1, 4):
        result = api.request(
            "GET",
            f"/actions/runs/{identity}/jobs?filter=latest&per_page=100&page={page}",
        )
        jobs = result.get("jobs", [])
        if not isinstance(jobs, list):
            raise ReleaseError("Invalid image publication job response")
        for job in jobs:
            if isinstance(job, dict) and job.get("name") == PUBLISH_JOB:
                return job.get("conclusion") == "success"
        if len(jobs) < 100:
            break
    return False


def compatible_engine(api: GitHub, revision: str) -> str | None:
    """Find a successful main-branch image compatible with the revision."""
    # No status=success filter: GitHub's filtered run listing can lag by
    # months and omit recent successes (on 2026-09-30 it began at February),
    # which left every config-only push unpublishable. The unfiltered listing
    # is newest-first; the loop below keeps only successful main pushes.
    for page in range(1, 4):
        result = api.request(
            "GET",
            f"/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&page={page}",
        )
        runs = result.get("workflow_runs", [])
        for run in runs:
            if (
                run.get("conclusion") != "success"
                or run.get("event") != "push"
                or run.get("head_branch") != "main"
            ):
                continue
            engine = sha(run.get("head_sha"))
            if released_image(api, run) and config_only_difference(
                api, engine, revision
            ):
                return engine
        if len(runs) < 100:
            break
    return None


def plan(api: GitHub, event_name: str, event: dict[str, Any]) -> dict[str, str]:
    """Choose a tested engine and reject untested mixed-code releases."""
    current = api.main()
    if event_name == "pull_request":
        revision = sha(event["pull_request"]["head"]["sha"])
        # Mixed PRs must first validate their new engine in Service CI, whose
        # image job includes this same offline config validation before release.
        if not config_only_difference(
            api,
            sha(event["pull_request"]["base"]["sha"]),
            revision,
            pull_request=True,
        ):
            return {"ready": "false", "reason": "candidate_engine_ci_required"}
        engine = compatible_engine(api, current)
    else:
        if event_name == "push" and (
            event.get("ref") != "refs/heads/main"
            or sha(event.get("after")) != current
        ):
            return {"ready": "false", "reason": "stale_push"}
        if event_name == "workflow_run":
            run = event.get("workflow_run", {})
            if (
                run.get("conclusion") != "success"
                or run.get("event") != "push"
                or run.get("head_branch") != "main"
            ):
                return {"ready": "false", "reason": "engine_ci_not_successful"}
        if event_name not in {"push", "workflow_run", "workflow_dispatch"}:
            raise ReleaseError("Unsupported configuration workflow event")
        # A late engine CI may publish a newer config-only main commit, but not
        # config accompanying another still-untested engine change.
        revision = current
        engine = compatible_engine(api, revision)
    if engine is None:
        return {"ready": "false", "reason": "candidate_engine_ci_required"}
    return {"ready": "true", "revision": revision, "engine_sha": engine}


def command(args: list[str], *, timeout: int = 180) -> str:
    """Run one bounded command without exposing tool output on failure."""
    try:
        return subprocess.run(
            args, check=True, capture_output=True, text=True, timeout=timeout
        ).stdout
    except (subprocess.SubprocessError, OSError):
        # Tool output could quote template content; exclude it from public CI.
        raise ReleaseError(
            "Configuration image validation command failed"
        ) from None


def docker_base(image_id: str) -> list[str]:
    """Build immutable, unprivileged, network-disabled container arguments."""
    if not DIGEST.fullmatch(image_id):
        raise ReleaseError("Validation requires an immutable local image ID")
    return [
        "docker",
        "run",
        "--rm",
        "--init",
        "--pull",
        "never",
        "--platform",
        "linux/amd64",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--memory",
        "256m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
        "--entrypoint",
        "python",
    ]


def run_container(arguments: list[str]) -> None:
    """Run a unique validator and remove it even if its client times out."""
    name = "newsletter-content-validation-" + uuid.uuid4().hex
    try:
        command(arguments[:2] + ["--name", name] + arguments[2:])
    finally:
        # Killing a timed-out docker client does not stop its daemon-side
        # container. Remove only this uniquely named, disposable validator.
        try:
            subprocess.run(
                ["docker", "rm", "--force", name],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError):
            pass


def validate(
    image: str,
    engine_sha: str,
    revision: str,
    source: pathlib.Path,
    output: pathlib.Path,
    *,
    pull: bool,
) -> None:
    """Validate twice in the tested image and write a bundle-hash receipt."""
    sha(engine_sha)
    sha(revision)
    if not source.is_dir() or source.is_symlink():
        raise ReleaseError("Authored configuration directory is unavailable")
    source = source.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    output = output.resolve(strict=True)
    if "," in str(source) or "," in str(output):
        raise ReleaseError("Docker mount paths cannot contain commas")
    if pull:
        if image != f"{SERVICE_IMAGE}:service-{engine_sha}":
            raise ReleaseError(
                "Release validation can only pull the tested repository image"
            )
        command(["docker", "pull", "--platform", "linux/amd64", "--", image])
    metadata = json.loads(
        command(
            [
                "docker",
                "image",
                "inspect",
                "--format",
                '{"id":{{json .Id}},"os":{{json .Os}},'
                '"architecture":{{json .Architecture}}}',
                "--",
                image,
            ]
        )
    )
    image_id = metadata["id"]
    if metadata.get("os") != "linux" or metadata.get("architecture") != "amd64":
        raise ReleaseError(
            "Configuration validation engine must be linux/amd64"
        )
    base = docker_base(image_id)
    run_container(
        base
        + [
            "--mount",
            f"type=bind,src={source},dst=/config,readonly",
            "--mount",
            f"type=bind,src={output},dst=/out",
            image_id,
            "-m",
            "newsletter.config_cli",
            "build",
            "--source",
            "/config",
            "--revision",
            revision,
            "--output",
            "/out/bundle.json",
        ]
    )
    run_container(
        base
        + [
            "--mount",
            f"type=bind,src={output},dst=/out,readonly",
            image_id,
            "-m",
            "newsletter.config_cli",
            "validate",
            "--bundle",
            "/out/bundle.json",
        ]
    )
    bundle = output / "bundle.json"
    if (
        bundle.is_symlink()
        or not bundle.is_file()
        or bundle.stat().st_size > MAX_BUNDLE
    ):
        raise ReleaseError("Image did not produce a bounded regular bundle")
    raw = bundle.read_bytes()
    if json.loads(raw).get("revision") != revision:
        raise ReleaseError(
            "Validated bundle revision does not match its source"
        )
    receipt = {
        "revision": revision,
        "engine_sha": engine_sha,
        "image_id": image_id,
        "bundle_sha256": hashlib.sha256(raw).hexdigest(),
    }
    (output / "validation.json").write_text(
        json.dumps(receipt, sort_keys=True) + "\n"
    )
    print(
        "Validated content bundle in a network-disabled, "
        "immutable linux/amd64 image."
    )


def publish(api: GitHub, revision: str, directory: pathlib.Path) -> bool:
    """Publish a receipted bundle using stale-main checks and non-force CAS."""
    sha(revision)
    receipt = json.loads((directory / "validation.json").read_bytes())
    bundle = directory / "bundle.json"
    if (
        bundle.is_symlink()
        or not bundle.is_file()
        or bundle.stat().st_size > MAX_BUNDLE
    ):
        raise ReleaseError("Validated bundle is unavailable")
    raw = bundle.read_bytes()
    if (
        receipt.get("revision") != revision
        or json.loads(raw).get("revision") != revision
        or receipt.get("bundle_sha256") != hashlib.sha256(raw).hexdigest()
        or not DIGEST.fullmatch(receipt.get("image_id", ""))
    ):
        raise ReleaseError("Validation receipt does not match the bundle")
    sha(receipt.get("engine_sha"))
    if api.main() != revision:
        print("Skipped stale configuration publication; main advanced.")
        return False
    previous = api.request(
        "GET", f"/git/ref/heads/{PUBLISHED_BRANCH}", missing=True
    )
    parent = sha(previous["object"]["sha"]) if previous else None
    blob = api.request(
        "POST",
        "/git/blobs",
        {"content": base64.b64encode(raw).decode(), "encoding": "base64"},
    )
    tree = api.request(
        "POST",
        "/git/trees",
        {
            "tree": [
                {
                    "path": "bundle.json",
                    "mode": "100644",
                    "type": "blob",
                    "sha": sha(blob["sha"]),
                }
            ]
        },
    )
    commit = api.request(
        "POST",
        "/git/commits",
        {
            "message": f"Publish newsletter content config {revision}",
            "tree": sha(tree["sha"]),
            "parents": [parent] if parent else [],
        },
    )
    # Check immediately before the only visible mutation. Non-force ref update
    # also rejects concurrent publication from the same old parent.
    if api.main() != revision:
        print(
            "Skipped stale configuration publication; "
            "main advanced during validation."
        )
        return False
    if parent:
        api.request(
            "PATCH",
            f"/git/refs/heads/{PUBLISHED_BRANCH}",
            {"sha": sha(commit["sha"]), "force": False},
        )
    else:
        api.request(
            "POST",
            "/git/refs",
            {
                "ref": f"refs/heads/{PUBLISHED_BRANCH}",
                "sha": sha(commit["sha"]),
            },
        )
    print(
        "Published validated bundle.json; "
        "no deployment, collection, or email triggered."
    )
    return True


def main() -> int:
    """Run one explicit CI phase and emit only safe release diagnostics."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="phase", required=True)
    sub.add_parser("plan")
    validation = sub.add_parser("validate")
    validation.add_argument("--image", required=True)
    validation.add_argument("--engine-sha", required=True)
    validation.add_argument("--revision", required=True)
    validation.add_argument("--source", required=True, type=pathlib.Path)
    validation.add_argument("--output", required=True, type=pathlib.Path)
    validation.add_argument("--pull", action="store_true")
    publication = sub.add_parser("publish")
    publication.add_argument("--revision", required=True)
    publication.add_argument("--directory", required=True, type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.phase == "validate":
            validate(
                args.image,
                args.engine_sha,
                args.revision,
                args.source,
                args.output,
                pull=args.pull,
            )
        else:
            api = GitHub(
                os.environ.get("GITHUB_REPOSITORY", ""),
                os.environ.get("GITHUB_TOKEN", ""),
            )
            if args.phase == "plan":
                event = json.loads(
                    pathlib.Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes()
                )
                result = plan(api, os.environ["GITHUB_EVENT_NAME"], event)
                with pathlib.Path(os.environ["GITHUB_OUTPUT"]).open(
                    "a"
                ) as output:
                    for key, value in result.items():
                        output.write(f"{key}={value}\n")
            else:
                publish(api, args.revision, args.directory)
    except (
        ReleaseError,
        KeyError,
        ValueError,
        TypeError,
        OSError,
        RecursionError,
    ):
        print(
            "Configuration release failed; "
            "inspect the configuration and CI engine status.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
