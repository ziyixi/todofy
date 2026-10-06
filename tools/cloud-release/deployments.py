"""GitHub deployment evidence, independent of the cumulative CI diff base."""

import re

from api import ReleaseError

SHA = re.compile(r"[0-9a-f]{40}")
APPS = {
    "todofy",
    "mail-hero",
    "dashboard",
    "flowday",
    "links",
    "watch",
    "fleet",
    "mailsort",
    "website-relay",
    "platform",
    "website",
}


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
        statuses = api.call(base + "/" + str(record["id"]) + "/statuses?per_page=1")
        if (
            isinstance(statuses, list)
            and statuses
            and statuses[0].get("state") == "success"
        ):
            identity(repository, app, record.get("sha"))
            return record
    raise ReleaseError("VERIFIED_DEPLOYMENT_MISSING")


def record_success(api, repository, app, sha, evidence, run_url):
    identity(repository, app, sha)
    if not run_url.startswith("https://github.com/" + repository + "/actions/runs/"):
        raise ReleaseError("DEPLOYMENT_RUN_INVALID")
    record = api.call(
        "/repos/" + repository + "/deployments",
        method="POST",
        body={
            "ref": sha,
            "auto_merge": False,
            "required_contexts": [],
            "environment": "production",
            "production_environment": True,
            "task": "deploy:" + app,
            "payload": {"format": "personal-cloud-release-v1", **evidence},
            "description": "Actual release verified",
        },
    )
    if (
        not isinstance(record, dict)
        or type(record.get("id")) is not int
        or record.get("sha") != sha
    ):
        raise ReleaseError("DEPLOYMENT_RECORD_INVALID")
    api.call(
        "/repos/" + repository + "/deployments/" + str(record["id"]) + "/statuses",
        method="POST",
        body={
            "state": "success",
            "log_url": run_url,
            "auto_inactive": False,
            "description": "Running identity and configuration verified",
        },
    )
    return record["id"]
