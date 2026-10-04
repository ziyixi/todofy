"""Bounded provider requests; private response bodies never become diagnostics."""

import json
import urllib.error
import urllib.request

MAX_BYTES = 1_000_000


class ReleaseError(ValueError):
    """A fixed diagnostic safe for public Actions logs."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


class Api:
    def __init__(self, provider, token, opener=None):
        if provider not in {"cloudflare", "github"} or not token:
            raise ReleaseError("PROVIDER_CREDENTIAL_MISSING")
        self.provider, self.token = provider, token
        self.base = (
            "https://api.cloudflare.com/client/v4"
            if provider == "cloudflare"
            else "https://api.github.com"
        )
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def call(self, path, *, method="GET", body=None, include_metadata=False):
        if not path.startswith("/") or ".." in path or "\n" in path:
            raise ReleaseError("PROVIDER_PATH_INVALID")
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "TodofyPersonalCloud/1.0",
                **(
                    {"X-GitHub-Api-Version": "2022-11-28"}
                    if self.provider == "github"
                    else {}
                ),
            },
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ReleaseError("PROVIDER_RESPONSE_TOO_LARGE")
            result = json.loads(raw)
        except urllib.error.HTTPError as error:
            raise ReleaseError("PROVIDER_HTTP_" + str(error.code)) from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            if isinstance(error, ReleaseError):
                raise
            raise ReleaseError("PROVIDER_REQUEST_FAILED") from None
        if self.provider == "cloudflare":
            if not isinstance(result, dict) or result.get("success") is not True:
                raise ReleaseError("CLOUDFLARE_RESPONSE_INVALID")
            return result if include_metadata else result.get("result")
        return result
