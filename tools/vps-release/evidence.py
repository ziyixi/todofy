"""Public deployment receipt, written only after independent runtime verification."""

import json
import os

from transport import ReleaseFailure


def write_evidence(path, release):
    if (
        release.phase != "ready"
        or len({target.source_sha for target in release.targets}) != 1
    ):
        raise ReleaseFailure("RELEASE_EVIDENCE_INVALID")
    value = {
        "source_sha": release.targets[0].source_sha,
        "release": release.name,
        "etag": release.etag,
        "phase": "ready",
        "targets": [
            {
                field: getattr(target, field)
                for field in (
                    "workload_key",
                    "image_digest",
                    "source_sha",
                    "request_id",
                )
            }
            for target in release.targets
        ],
    }
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
    except OSError:
        raise ReleaseFailure("RELEASE_EVIDENCE_WRITE_FAILED") from None
