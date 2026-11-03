"""Compare the private application's live source identities with the reconciled main's pinned gitlink.

The scheduled reconciliation runs this after generating the private catalogue from the same source. The probe
address comes only from that catalogue: its enabled anonymous `/healthz` checks on its own Worker domains. Each
must report `worker_sha` and `collector_sha`. They match when both equal the pinned gitlink, or, after a pinned
change that selected no private publication (documentation, for example), when both equal the source of the newest
verified private deployment record on this main's history. The public log receives one fixed code; addresses,
response bodies and provider output stay off it.
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
RETRY_SECONDS = 5

MATCHES_PIN = "PRIVATE_REVISION_MATCHES_PIN"
MATCHES_RELEASE = "PRIVATE_REVISION_MATCHES_RELEASE"
SOURCE_INVALID = "PRIVATE_REVISION_SOURCE_INVALID"
CATALOG_INVALID = "PRIVATE_REVISION_CATALOG_INVALID"
PROBE_MISSING = "PRIVATE_REVISION_PROBE_MISSING"
UNAVAILABLE = "PRIVATE_REVISION_UNAVAILABLE"
RECORD_INVALID = "PRIVATE_REVISION_RECORD_INVALID"
RELEASE_UNVERIFIED = "PRIVATE_REVISION_RELEASE_UNVERIFIED"
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


def live_sources(url, opener=None, sleep=time.sleep):
    """Both source identities from one anonymous probe; a degraded 503 JSON answer still reports them."""
    opener = opener or urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "personal-cloud-reconcile"},
    )
    document = None
    for attempt in range(ATTEMPTS):
        try:
            with opener.open(request, timeout=10) as response:
                if response.status != 200:
                    raise Refused(UNAVAILABLE)
                document = _document(response.headers, response.read)
            break
        except urllib.error.HTTPError as failure:
            try:
                if (
                    failure.code == 503
                    and failure.headers is not None
                    and failure.headers.get_content_type() == "application/json"
                ):
                    document = _document(failure.headers, failure.read)
                    break
            finally:
                failure.close()
            if failure.code not in (502, 503, 504) or attempt + 1 == ATTEMPTS:
                raise Refused(UNAVAILABLE) from None
        except TRANSPORT:
            if attempt + 1 == ATTEMPTS:
                raise Refused(UNAVAILABLE) from None
        sleep(RETRY_SECONDS)
    values = [
        document.get(name) if isinstance(document, dict) else None
        for name in IDENTITIES
    ]
    if not all(isinstance(value, str) and SHA.fullmatch(value) for value in values):
        raise Refused(UNAVAILABLE)
    return set(values)


def github(path):
    request = urllib.request.Request(
        os.environ.get("GITHUB_API_URL", "https://api.github.com") + path,
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def released_source(api, repository, source_sha):
    """The private source of the newest private deployment record: verified, on this main and its gitlink."""
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
        comparison = api(f"{base}/compare/{parent_sha}...{source_sha}?per_page=1")
        if comparison["status"] not in ("ahead", "identical"):
            raise Refused(RECORD_INVALID)
        pinned = api(f"{base}/contents/private?ref={parent_sha}")
        if pinned["type"] != "submodule" or pinned["sha"] != private_sha:
            raise Refused(RECORD_INVALID)
    except (KeyError, TypeError, AttributeError, ValueError, *TRANSPORT):
        raise Refused(RECORD_INVALID) from None
    return private_sha


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
    if live == {released_source(api, repository, source_sha)}:
        return MATCHES_RELEASE
    raise Refused(MISMATCH)


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
