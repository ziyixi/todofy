"""Cloudflare bootstrap calls to explicit account/zone identities only."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from private_input import BootstrapError

API = "https://api.cloudflare.com/client/v4"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _document(token: str, path: str, method: str, body: dict | None, parameters: dict | None = None):
    if not path.startswith(("/accounts/", "/zones/")) or ".." in path or "?" in path:
        raise BootstrapError("CLOUDFLARE_PATH_INVALID")
    suffix = "?" + urllib.parse.urlencode(parameters) if parameters else ""
    call = urllib.request.Request(API + path + suffix, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token, "Accept": "application/json",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(call, timeout=30) as response:
            raw = response.read(1048577)
        if len(raw) > 1048576:
            raise BootstrapError("CLOUDFLARE_RESPONSE_TOO_LARGE")
        document = json.loads(raw)
    except urllib.error.HTTPError as error:
        raise BootstrapError("CLOUDFLARE_HTTP_" + str(error.code)) from None
    except (OSError, ValueError):
        raise BootstrapError("CLOUDFLARE_REQUEST_FAILED") from None
    if not isinstance(document, dict) or document.get("success") is not True:
        raise BootstrapError("CLOUDFLARE_OPERATION_FAILED")
    return document


def request(token: str, path: str, method: str = "GET", body: dict | None = None):
    return _document(token, path, method, body).get("result")


def list_page(token: str, path: str, parameters: dict | None = None) -> dict:
    """Read one page with its completion metadata; collision checks must prove the list is complete."""
    parameters = parameters or {}
    if set(parameters) - {"page", "per_page", "cursor", "is_deleted"} or any(
        not isinstance(value, (str, int)) or isinstance(value, bool) for value in parameters.values()
    ):
        raise BootstrapError("CLOUDFLARE_PAGINATION_INVALID")
    return _document(token, path, "GET", None, parameters)


def verify_target(token: str, account: str, zone: str, zone_name: str, fetch=request) -> None:
    if not all(re.fullmatch(r"[0-9a-f]{32}", key) for key in (account, zone)):
        raise BootstrapError("CLOUDFLARE_IDENTITY_INVALID")
    result = fetch(token, "/zones/" + zone)
    if (not isinstance(result, dict) or result.get("id") != zone or result.get("name") != zone_name
            or result.get("account", {}).get("id") != account):
        raise BootstrapError("CLOUDFLARE_TARGET_MISMATCH")


def create_state_bucket(token: str, account: str, fetch=request) -> None:
    if re.fullmatch(r"[0-9a-f]{32}", account) is None:
        raise BootstrapError("CLOUDFLARE_IDENTITY_INVALID")
    fetch(token, "/accounts/" + account + "/r2/buckets", "POST", {"name": "infra-state"})


def ensure_workers_subdomain(token: str, account: str, subdomain: str, fresh: bool, fetch=request) -> None:
    path = "/accounts/" + account + "/workers/subdomain"
    try:
        result = fetch(token, path)
    except BootstrapError as error:
        if str(error) != "CLOUDFLARE_HTTP_404" or not fresh:
            raise
        result = None
    actual = result.get("subdomain") if isinstance(result, dict) else None
    if actual == subdomain:
        return
    if actual or not fresh:
        raise BootstrapError("WORKERS_SUBDOMAIN_MISMATCH")
    result = fetch(token, path, "PUT", {"subdomain": subdomain})
    if not isinstance(result, dict) or result.get("subdomain") != subdomain:
        raise BootstrapError("WORKERS_SUBDOMAIN_NOT_VERIFIED")
