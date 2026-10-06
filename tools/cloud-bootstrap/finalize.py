"""Capture first-release namespaces from verified GitHub deployments, then verify them live."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from private_input import BootstrapError

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools/cloud-release"))
from api import Api, ReleaseError  # noqa: E402
from cloudflare import DO_KEYS, observe  # noqa: E402
from control import release_inputs  # noqa: E402
from deployments import last_good  # noqa: E402

APPS = ("fleet", "dashboard", "mail-hero", "todofy", "watch", "mailsort")


class Github:
    def call(self, path: str):
        result = subprocess.run(["gh", "api", path], capture_output=True, timeout=60, check=False)
        if result.returncode or len(result.stdout) > 1_000_000:
            raise BootstrapError("GITHUB_DEPLOYMENT_METADATA_UNAVAILABLE")
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise BootstrapError("GITHUB_DEPLOYMENT_METADATA_INVALID") from None


def namespaces(private: dict, profile: dict, resources: dict, source: Path = REPO, *, github=None, cloud=None) -> dict:
    github = github or Github()
    cloud = cloud or Api("cloudflare", private["cloudflare_api_token"])
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, capture_output=True, check=False)
    sha = result.stdout.decode().strip()
    if result.returncode or re.fullmatch(r"[0-9a-f]{40}", sha) is None:
        raise BootstrapError("BOOTSTRAP_SOURCE_SHA_INVALID")
    identifiers = {}
    try:
        for app in APPS:
            record = last_good(github, profile["repository"], app)
            if record["sha"] != sha:
                raise BootstrapError("FIRST_FULL_RELEASE_NOT_VERIFIED")
            _, _, configs, desired = release_inputs(source, app)
            workers = {worker["script"]: worker for worker in record["payload"].get("workers", [])}
            for config in configs:
                expected = workers.get(config["name"])
                if expected is None:
                    raise BootstrapError("FIRST_RELEASE_WORKER_UNVERIFIED")
                actual = observe(cloud, config, desired[config["name"]], resources, sha, expected)
                if actual["changes"]:
                    raise BootstrapError("FIRST_RELEASE_CHANGED_DO_NOT_CAPTURE")
                for name, identifier in actual["namespaces"].items():
                    if name not in DO_KEYS.values() or not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{32}", identifier) is None:
                        raise BootstrapError("FIRST_RELEASE_NAMESPACE_INVALID")
                    if name in identifiers and identifiers[name] != identifier:
                        raise BootstrapError("FIRST_RELEASE_NAMESPACE_AMBIGUOUS")
                    identifiers[name] = identifier
        if set(identifiers) != set(DO_KEYS.values()):
            raise BootstrapError("FIRST_RELEASE_NAMESPACE_MISSING")
        baseline = resources.get("durable_objects", {})
        if baseline and baseline != identifiers:
            raise BootstrapError("EXISTING_NAMESPACE_BASELINE_CHANGED")
        return identifiers
    except ReleaseError:
        raise BootstrapError("FIRST_RELEASE_PROVIDER_METADATA_UNVERIFIED") from None
