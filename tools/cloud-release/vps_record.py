"""Record the daemon's independently verified public release receipt in GitHub."""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from uuid import UUID

from api import Api, ReleaseError
from deployments import identity, record_success


def receipt(path):
    if path.stat().st_size > 16_384:
        raise ReleaseError("RELEASE_EVIDENCE_INVALID")
    value = json.loads(path.read_text())
    fields = {"source_sha", "release", "etag", "phase", "targets"}
    if not isinstance(value, dict) or set(value) != fields or value["phase"] != "ready":
        raise ReleaseError("RELEASE_EVIDENCE_INVALID")
    identity(os.environ["GITHUB_REPOSITORY"], "platform", value["source_sha"])
    if not re.fullmatch(r"releases/[0-9a-f-]{36}", value["release"]):
        raise ReleaseError("RELEASE_EVIDENCE_INVALID")
    UUID(value["release"].split("/", 1)[1])
    if (
        not isinstance(value["etag"], str)
        or not value["etag"]
        or len(value["etag"]) > 128
    ):
        raise ReleaseError("RELEASE_EVIDENCE_INVALID")
    targets = value["targets"]
    if not isinstance(targets, list) or len(targets) != 2:
        raise ReleaseError("RELEASE_EVIDENCE_INVALID")
    if {
        target.get("workload_key") for target in targets if isinstance(target, dict)
    } != {"newsletter", "platform-runtime"}:
        raise ReleaseError("RELEASE_EVIDENCE_INVALID")
    for target in targets:
        if set(target) != {"workload_key", "image_digest", "source_sha", "request_id"}:
            raise ReleaseError("RELEASE_EVIDENCE_INVALID")
        if target["source_sha"] != value["source_sha"] or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", target["image_digest"]
        ):
            raise ReleaseError("RELEASE_EVIDENCE_INVALID")
        UUID(target["request_id"])
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-file", type=Path, required=True)
    args = parser.parse_args()
    try:
        if os.environ.get("GITHUB_REF") != "refs/heads/main":
            raise ReleaseError("MAIN_REQUIRED")
        value = receipt(args.evidence_file)
        repository = os.environ["GITHUB_REPOSITORY"]
        run_url = (
            "https://github.com/"
            + repository
            + "/actions/runs/"
            + os.environ["GITHUB_RUN_ID"]
        )
        identifier = record_success(
            Api("github", os.environ.get("GH_TOKEN", "")),
            repository,
            "platform",
            value["source_sha"],
            {"runtime": value},
            run_url,
        )
        print(
            json.dumps(
                {
                    "deployment_id": identifier,
                    "app": "platform",
                    "source_sha": value["source_sha"],
                    "verified": True,
                }
            )
        )
        return 0
    except (ReleaseError, OSError, KeyError, ValueError, TypeError):
        print(json.dumps({"error_code": "VPS_DEPLOYMENT_RECORD_FAILED"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
