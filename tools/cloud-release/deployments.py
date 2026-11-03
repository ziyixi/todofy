"""GitHub deployment evidence, independent of the cumulative CI diff base."""

import json
import re
import tomllib
from pathlib import Path

from api import ReleaseError, http_status

ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"[0-9a-f]{40}")


def release_units(root=ROOT):
    """Release unit -> its Wrangler configs, read from the app manifests that tools/service-catalog validates.

    An application's Workers release together under its ID, its root config first; a Worker that declares
    `release = "<unit>"` releases on its own.
    """
    units = {}
    for manifest in sorted(root.glob("*/app.toml")):
        app = tomllib.loads(manifest.read_text())
        for worker in app.get("workers", []):
            units.setdefault(worker.get("release", app["id"]), []).append(worker["config"])
    return {unit: sorted(paths, key=lambda path: (path.count("/"), path)) for unit, paths in units.items()}


# Every Cloudflare release unit, and the VPS receipts vps_record.py writes (platform's covers the Newsletter image).
APPS = set(release_units()) | {"platform", "codex-gateway"}


def identity(repository, app, sha=None):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or app not in APPS:
        raise ReleaseError("DEPLOYMENT_IDENTITY_INVALID")
    if sha is not None and not SHA.fullmatch(sha):
        raise ReleaseError("DEPLOYMENT_SOURCE_INVALID")


def last_good(api, repository, app):
    identity(repository, app)
    base = "/repos/" + repository + "/deployments"
    records = api.call(
        base + "?environment=production&task=deploy:" + app + "&per_page=100"
    )
    if not isinstance(records, list):
        raise ReleaseError("DEPLOYMENT_RECORD_INVALID")
    for record in records:
        if not isinstance(record, dict) or type(record.get("id")) is not int:
            raise ReleaseError("DEPLOYMENT_RECORD_INVALID")
        payload = record.get("payload")
        if (
            not isinstance(payload, dict)
            or payload.get("format") != "personal-cloud-release-v1"
        ):
            continue
        # An inactive status can follow the release's recorded verification success.
        statuses = api.call(base + "/" + str(record["id"]) + "/statuses?per_page=10")
        if (
            isinstance(statuses, list)
            and statuses
            and (
                statuses[0].get("state") == "success"
                or (
                    statuses[0].get("state") == "inactive"
                    and any(status.get("state") == "success" for status in statuses[1:10])
                )
            )
        ):
            identity(repository, app, record.get("sha"))
            return record
    raise ReleaseError("VERIFIED_DEPLOYMENT_MISSING")


def _receipt_call(api, path, phase, *, method="GET", body=None):
    try:
        return api.call(
            path, **({"method": method, "body": body} if method != "GET" else {})
        )
    except ReleaseError as error:
        print(
            json.dumps(
                {
                    "event": "release_receipt_failure",
                    "phase": phase,
                    "provider": "github",
                    "method": method,
                    "http_status": http_status(error),
                }
            ),
            flush=True,
        )
        raise


def receipt(api, repository, app, deployment_id):
    identity(repository, app)
    if not re.fullmatch(r"[1-9][0-9]{0,19}", str(deployment_id)):
        raise ReleaseError("DEPLOYMENT_RECORD_INVALID")
    value = _receipt_call(
        api, "/repos/" + repository + "/deployments/" + str(deployment_id), "readback"
    )
    if (
        not isinstance(value, dict)
        or type(value.get("id")) is not int
        or value["id"] != int(deployment_id)
        or not isinstance(value.get("sha"), str)
        or not SHA.fullmatch(value["sha"])
        or value.get("task") != "deploy:" + app
        or value.get("environment") != "production"
        or not isinstance(value.get("payload"), dict)
        or value["payload"].get("format") != "personal-cloud-release-v1"
    ):
        raise ReleaseError("DEPLOYMENT_RECORD_INVALID")
    return value


def _statuses(api, base):
    values = _receipt_call(api, base + "/statuses?per_page=10", "readback")
    if not isinstance(values, list) or any(
        not isinstance(value, dict)
        or not isinstance(value.get("state"), str)
        or value.get("state")
        not in {
            "pending",
            "queued",
            "in_progress",
            "success",
            "inactive",
            "failure",
            "error",
        }
        for value in values
    ):
        raise ReleaseError("DEPLOYMENT_STATUS_INVALID")
    return values[:10]


def _succeeded(statuses):
    return bool(statuses) and (
        statuses[0]["state"] == "success"
        or (
            statuses[0]["state"] == "inactive"
            and any(item["state"] == "success" for item in statuses[1:])
        )
    )


def record_success(api, repository, app, sha, evidence, run_url, *, resume_id=None):
    identity(repository, app, sha)
    if not run_url.startswith("https://github.com/" + repository + "/actions/runs/"):
        raise ReleaseError("DEPLOYMENT_RUN_INVALID")
    base = "/repos/" + repository + "/deployments"
    payload = {"format": "personal-cloud-release-v1", **evidence}
    if resume_id is not None:
        record = receipt(api, repository, app, resume_id)
        if record["sha"] != sha or record["payload"] != payload:
            raise ReleaseError("DEPLOYMENT_EVIDENCE_MISMATCH")
    else:
        try:
            record = _receipt_call(
                api,
                base,
                "create",
                method="POST",
                body={
                    "ref": sha,
                    "auto_merge": False,
                    "required_contexts": [],
                    "environment": "production",
                    "production_environment": True,
                    "task": "deploy:" + app,
                    "payload": payload,
                    "description": "Actual release verified",
                },
            )
        except ReleaseError as error:
            if (http_status(error) or 0) < 500:
                raise
            values = _receipt_call(
                api,
                base
                + "?environment=production&task=deploy:"
                + app
                + "&sha="
                + sha
                + "&per_page=100",
                "readback",
            )
            if not isinstance(values, list):
                raise ReleaseError("DEPLOYMENT_RECORD_INVALID") from None
            matches = [
                value
                for value in values
                if isinstance(value, dict)
                and type(value.get("id")) is int
                and value["id"] > 0
                and value.get("sha") == sha
                and value.get("task") == "deploy:" + app
                and value.get("environment") == "production"
                and value.get("payload") == payload
            ]
            if len(matches) != 1:
                raise ReleaseError("DEPLOYMENT_CREATE_UNCONFIRMED") from None
            record = matches[0]
            resume_id = record["id"]
    if (
        not isinstance(record, dict)
        or type(record.get("id")) is not int
        or record["id"] <= 0
        or record.get("sha") != sha
    ):
        raise ReleaseError("DEPLOYMENT_RECORD_INVALID")
    target = base + "/" + str(record["id"])
    if resume_id is not None:
        statuses = _statuses(api, target)
        if _succeeded(statuses):
            return record["id"]
        if statuses and statuses[0]["state"] in {"failure", "error", "inactive"}:
            raise ReleaseError("DEPLOYMENT_STATUS_REJECTED")
    try:
        _receipt_call(
            api,
            target + "/statuses",
            "status",
            method="POST",
            body={
                "state": "success",
                "log_url": run_url,
                "auto_inactive": False,
                "description": "Running identity and configuration verified",
            },
        )
    except ReleaseError as error:
        if (http_status(error) or 0) < 500:
            raise
        if not _succeeded(_statuses(api, target)):
            raise ReleaseError("DEPLOYMENT_STATUS_UNCONFIRMED") from None
    return record["id"]
