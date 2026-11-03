"""Compare the private application's live source identities with the reconciled main's pinned gitlink.

The scheduled reconciliation runs this after generating the private catalogue from the same source. The probe
address comes only from that catalogue: its enabled anonymous `/healthz` checks on its own Worker domains. Each
must report `worker_sha` and `collector_sha`. They match when both equal the pinned gitlink, or, after a pinned
change that selected no private publication (documentation, for example), when both equal the source of the newest
verified private deployment record on this main's history and a successful main run of CI has settled the current
pin since that record. The public log receives one fixed code; addresses, response bodies and provider output stay
off it.
"""

import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import private_catalog

SHA = re.compile(r"[0-9a-f]{40}")
IDENTITIES = ("worker_sha", "collector_sha")
MAX_BODY_BYTES = 65536
ATTEMPTS = 3
RETRY_SECONDS = 10
# The workflow whose successful main push runs select private publications; see tools/bazel/ci/releases.py.
CI_WORKFLOW = "ci.yml"
SETTLING_RUNS = 5

MATCHES_PIN = "PRIVATE_REVISION_MATCHES_PIN"
MATCHES_RELEASE = "PRIVATE_REVISION_MATCHES_RELEASE"
SOURCE_INVALID = "PRIVATE_REVISION_SOURCE_INVALID"
CATALOG_INVALID = "PRIVATE_REVISION_CATALOG_INVALID"
PROBE_MISSING = "PRIVATE_REVISION_PROBE_MISSING"
UNAVAILABLE = "PRIVATE_REVISION_UNAVAILABLE"
RECORD_INVALID = "PRIVATE_REVISION_RECORD_INVALID"
RELEASE_UNVERIFIED = "PRIVATE_REVISION_RELEASE_UNVERIFIED"
RELEASE_PENDING = "PRIVATE_REVISION_RELEASE_PENDING"
MISMATCH = "PRIVATE_REVISION_MISMATCH"
CHECK_FAILED = "PRIVATE_REVISION_CHECK_FAILED"
TRANSPORT = (OSError, http.client.HTTPException)


class Refused(Exception):
    """A fixed public code; the only detail a failure carries."""


def probe_urls(catalogue):
    """The catalogue's enabled anonymous `/healthz` checks, each on one of its own Worker domains."""
    try:
        domains = {
            domain.lower()
            for worker in catalogue["desired"]["workers"].values()
            for domain in worker["custom_domains"]
        }
        urls = set()
        for entry in catalogue["registry"]["entries"]:
            status = entry.get("status")
            if (
                not isinstance(status, dict)
                or status.get("type") != "public_http"
                or status.get("enabled") is not True
            ):
                continue
            parts = urllib.parse.urlsplit(status["url"])
            if parts.path != "/healthz":
                continue
            if (
                parts.scheme != "https"
                or parts.netloc != parts.hostname
                or parts.query
                or parts.fragment
                or parts.hostname not in domains
            ):
                raise Refused(CATALOG_INVALID)
            urls.add("https://" + parts.hostname + "/healthz")
    except (KeyError, TypeError, AttributeError, ValueError):
        raise Refused(CATALOG_INVALID) from None
    if not urls:
        raise Refused(PROBE_MISSING)
    return sorted(urls)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        # An Access login redirect is not an identity answer.
        return None


def _document(headers, read):
    body = read(MAX_BODY_BYTES + 1)
    if (
        headers is None
        or headers.get_content_type() != "application/json"
        or len(body) > MAX_BODY_BYTES
    ):
        raise Refused(UNAVAILABLE)
    try:
        return json.loads(body)
    except (ValueError, RecursionError):
        raise Refused(UNAVAILABLE) from None


def _identities(document):
    values = [
        document.get(name) if isinstance(document, dict) else None
        for name in IDENTITIES
    ]
    if all(isinstance(value, str) and SHA.fullmatch(value) for value in values):
        return set(values)
    return None


def live_sources(url, opener=None, sleep=time.sleep):
    """Both source identities from one anonymous probe.

    A degraded 503 JSON answer still reports them; one without both (a briefly unreachable collector, for example)
    is retried like a gateway error.
    """
    opener = opener or urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "personal-cloud-reconcile"},
    )
    for attempt in range(ATTEMPTS):
        retry = attempt + 1 < ATTEMPTS
        try:
            with opener.open(request, timeout=10) as response:
                if response.status != 200:
                    raise Refused(UNAVAILABLE)
                sources = _identities(_document(response.headers, response.read))
            if sources is None:
                raise Refused(UNAVAILABLE)
            return sources
        except urllib.error.HTTPError as failure:
            sources = None
            try:
                if (
                    failure.code == 503
                    and failure.headers is not None
                    and failure.headers.get_content_type() == "application/json"
                ):
                    sources = _identities(_document(failure.headers, failure.read))
            finally:
                failure.close()
            if sources is not None:
                return sources
            if failure.code not in (502, 503, 504) or not retry:
                raise Refused(UNAVAILABLE) from None
        except TRANSPORT:
            if not retry:
                raise Refused(UNAVAILABLE) from None
        sleep(RETRY_SECONDS)
    raise Refused(UNAVAILABLE)


def github(path):
    """One GitHub API answer; a redirect is refused so that the token never reaches another host."""
    request = urllib.request.Request(
        os.environ.get("GITHUB_API_URL", "https://api.github.com") + path,
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.build_opener(_NoRedirect).open(request, timeout=20) as response:
        return json.load(response)


def _on_history(api, base, older, newer):
    """Whether `older` is `newer` or one of its ancestors."""
    status = api(f"{base}/compare/{older}...{newer}?per_page=1")["status"]
    return status in ("ahead", "identical")


def _gitlink(api, base, ref):
    pinned = api(f"{base}/contents/private?ref={ref}")
    if pinned["type"] != "submodule" or not SHA.fullmatch(pinned["sha"]):
        raise Refused(RECORD_INVALID)
    return pinned["sha"]


def released_source(api, repository, source_sha):
    """The newest private deployment record: verified, on this main and its parent's gitlink.

    Returns its private source and its parent commit."""
    base = "/repos/" + repository
    try:
        records = api(base + "/deployments?environment=private&per_page=1")
        if not isinstance(records, list) or len(records) != 1:
            raise Refused(RECORD_INVALID)
        record = records[0]
        payload = record["payload"]
        private_sha, parent_sha = payload["private_sha"], payload["parent_sha"]
        if (
            type(record["id"]) is not int
            or not isinstance(private_sha, str)
            or not SHA.fullmatch(private_sha)
            or not isinstance(parent_sha, str)
            or not SHA.fullmatch(parent_sha)
            or record["sha"] != parent_sha
        ):
            raise Refused(RECORD_INVALID)
        states = [
            status["state"]
            for status in api(f"{base}/deployments/{record['id']}/statuses?per_page=10")
        ]
        # A later success marks an earlier one inactive; the newest record is only verified by its own success.
        if not states or not (
            states[0] == "success"
            or (states[0] == "inactive" and "success" in states[1:])
        ):
            raise Refused(RELEASE_UNVERIFIED)
        if not _on_history(api, base, parent_sha, source_sha):
            raise Refused(RECORD_INVALID)
        if _gitlink(api, base, parent_sha) != private_sha:
            raise Refused(RECORD_INVALID)
    except (KeyError, TypeError, AttributeError, ValueError, *TRANSPORT):
        raise Refused(RECORD_INVALID) from None
    return private_sha, parent_sha


def settled_pin(api, repository, source_sha, release_parent):
    """The gitlink of the newest successful main push run of CI on this main's history.

    A successful run's release selection covers every change since the previous successful run, so a successful run
    at the current pin shows that whatever publication the pin required succeeded. The newest release must be on
    that run's history; otherwise a later failed run published a source no successful run has settled.
    """
    base = "/repos/" + repository
    query = urllib.parse.urlencode(
        {"branch": "main", "event": "push", "status": "success", "per_page": SETTLING_RUNS}
    )
    try:
        runs = api(f"{base}/actions/workflows/{CI_WORKFLOW}/runs?{query}")["workflow_runs"]
        for run in runs[:SETTLING_RUNS]:
            head = run["head_sha"]
            if (
                not SHA.fullmatch(head)
                or run["head_branch"] != "main"
                or run["event"] != "push"
                or run["conclusion"] != "success"
            ):
                raise Refused(RECORD_INVALID)
            # A run for a main newer than this reconciliation's source does not describe it.
            if not _on_history(api, base, head, source_sha):
                continue
            if not _on_history(api, base, release_parent, head):
                raise Refused(RELEASE_PENDING)
            return _gitlink(api, base, head)
    except (KeyError, TypeError, AttributeError, ValueError, *TRANSPORT):
        raise Refused(RECORD_INVALID) from None
    raise Refused(RELEASE_PENDING)


def check(source_root, catalogue_file, *, repository, api=github, probe=live_sources):
    try:
        pinned = private_catalog.revision(source_root)
        source_sha = private_catalog.git(source_root, "rev-parse", "HEAD")
    except ValueError:
        raise Refused(SOURCE_INVALID) from None
    if not SHA.fullmatch(source_sha) or not re.fullmatch(
        r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository or ""
    ):
        raise Refused(SOURCE_INVALID)
    try:
        catalogue = json.loads(Path(catalogue_file).read_text())
    except (OSError, ValueError):
        raise Refused(CATALOG_INVALID) from None
    live = set()
    for url in probe_urls(catalogue):
        live |= probe(url)
    if live == {pinned}:
        return MATCHES_PIN
    released, release_parent = released_source(api, repository, source_sha)
    if live != {released}:
        raise Refused(MISMATCH)
    # A pin that advanced past the release counts only once a successful run has settled it.
    if settled_pin(api, repository, source_sha, release_parent) != pinned:
        raise Refused(RELEASE_PENDING)
    return MATCHES_RELEASE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--catalog-file", required=True)
    args = parser.parse_args()
    try:
        code = check(
            args.source_root,
            args.catalog_file,
            repository=os.environ.get("GITHUB_REPOSITORY", ""),
        )
    except Refused as refused:
        code = str(refused)
    except Exception:  # noqa: BLE001 - Unexpected details may name private addresses.
        code = CHECK_FAILED
    if code in (MATCHES_PIN, MATCHES_RELEASE):
        print("::notice::" + code)
        return 0
    print("::error::" + code)
    return 1


if __name__ == "__main__":
    sys.exit(main())
