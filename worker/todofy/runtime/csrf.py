"""Signed double-submit CSRF tokens for owner POSTs (same rules as Mail Hero's security.ts).

A token is ``base64url(json claims) "." base64url(HMAC-SHA256)`` keyed by the
CSRF_SIGNING_KEY secret. The browser sends it twice: as the HttpOnly
``todofy_csrf`` cookie and in ``X-CSRF-Token``; both must match, carry a valid
signature, belong to the owner and be unexpired.
"""

import base64
import hashlib
import hmac
import json
import re
import secrets
from typing import Any
from urllib.parse import urlsplit

from workers import Response

from todofy.core.api_errors import ApiError
from todofy.runtime.access_jwt import AccessError
from todofy.runtime.config import local_dev, var
from todofy.runtime.http import json_response, with_headers
from todofy.runtime.interop import now_ms

COOKIE = "todofy_csrf"
HEADER = "x-csrf-token"
TTL_S = 12 * 3600
MAX_TOKEN_CHARS = 1024
SIGNING_KEY = re.compile(r"[0-9a-fA-F]{64}")


def _failed() -> AccessError:
    return AccessError(403, ApiError.CSRF_FAILED)


def _key(env: Any) -> bytes:
    key = var(env, "CSRF_SIGNING_KEY")
    if not SIGNING_KEY.fullmatch(key):
        raise AccessError(503, ApiError.NOT_CONFIGURED)
    return bytes.fromhex(key)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(key: bytes, payload: str) -> str:
    return _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest())


def _cookie(request: Any, name: str) -> str | None:
    for pair in (request.headers.get("cookie") or "").split(";"):
        key, _, value = pair.strip().partition("=")
        if key == name:
            return value
    return None


def _allowed_origins(request: Any, env: Any) -> set[str]:
    origins = {f"https://{var(env, 'TODOFY_PUBLIC_HOST').lower()}"}
    if local_dev(env):
        # wrangler dev serves plain HTTP, possibly on a port.
        url = urlsplit(request.url)
        origins.add(f"http://{url.netloc.lower()}")
    return origins


async def issue(request: Any, env: Any, owner: str) -> Response:
    """GET /api/v1/csrf: a fresh token in the body and in the matching cookie."""
    key = _key(env)
    claims = {"kind": "csrf", "owner": owner, "nonce": secrets.token_urlsafe(16), "exp": now_ms() // 1000 + TTL_S}
    payload = _b64(json.dumps(claims, separators=(",", ":")).encode())
    token = f"{payload}.{_sign(key, payload)}"
    secure = "; Secure" if urlsplit(request.url).scheme == "https" else ""
    cookie = f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={TTL_S}{secure}"
    return with_headers(json_response({"token": token}), {"set-cookie": cookie})


async def verify(request: Any, env: Any, owner: str) -> None:
    """Raise AccessError(403 csrf_failed) unless Origin, header, cookie and signature all agree."""
    key = _key(env)
    provided = request.headers.get(HEADER) or ""
    cookie = _cookie(request, COOKIE) or ""
    if (
        (request.headers.get("origin") or "").lower() not in _allowed_origins(request, env)
        or not provided
        or len(provided) > MAX_TOKEN_CHARS
        or not hmac.compare_digest(provided.encode(), cookie.encode())
    ):
        raise _failed()
    payload, _, signature = provided.partition(".")
    if not hmac.compare_digest(signature.encode(), _sign(key, payload).encode()):
        raise _failed()
    try:
        claims = json.loads(_unb64(payload))
    except ValueError:
        raise _failed() from None
    if not (
        isinstance(claims, dict)
        and claims.get("kind") == "csrf"
        and claims.get("owner") == owner
        and isinstance(claims.get("exp"), int)
        and claims["exp"] > now_ms() // 1000
    ):
        raise _failed()
