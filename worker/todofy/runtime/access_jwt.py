"""Cloudflare Access JWT verification (RS256 via WebCrypto)."""

import base64
import json
import re
from typing import Any

import js

from todofy.core.api_errors import ApiError
from todofy.runtime.config import flag, local_dev, var
from todofy.runtime.interop import fetch_with_timeout, now_ms, to_js

ACCESS_ISSUER = re.compile(r"^https://[a-z0-9-]+\.cloudflareaccess\.com$")
LOOPBACK_ISSUER = re.compile(r"^http://127\.0\.0\.1:\d{1,5}$")
MAX_TOKEN_CHARS = 16_000
JWKS_TTL_MS = 3_600_000
JWKS_TIMEOUT_MS = 5_000
CLOCK_SKEW_S = 60
RS256 = {"name": "RSASSA-PKCS1-v1_5", "hash": "SHA-256"}

# Per-isolate cache: issuer -> (expires_at_ms, {kid: CryptoKey}).
_keys: dict[str, tuple[int, dict[str, Any]]] = {}


class AccessError(Exception):
    def __init__(self, status: int, code: ApiError) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _unauthorized() -> AccessError:
    return AccessError(401, ApiError.UNAUTHORIZED)


def _b64url(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _issuer(env: Any) -> str:
    issuer = var(env, "ACCESS_ISSUER").rstrip("/")
    if ACCESS_ISSUER.fullmatch(issuer):
        return issuer
    if local_dev(env) and flag(env, "DEV_ACCESS_LOOPBACK_ISSUER") and LOOPBACK_ISSUER.fullmatch(issuer):
        return issuer
    raise AccessError(503, ApiError.ACCESS_NOT_CONFIGURED)


def _token(request: Any) -> str:
    token = request.headers.get("cf-access-jwt-assertion")
    if not token:
        for pair in (request.headers.get("cookie") or "").split(";"):
            name, _, value = pair.strip().partition("=")
            if name == "CF_Authorization":
                token = value
    if not token or len(token) > MAX_TOKEN_CHARS:
        raise _unauthorized()
    return token


async def _signing_keys(issuer: str) -> dict[str, Any]:
    cached = _keys.get(issuer)
    if cached and cached[0] > now_ms():
        return cached[1]
    result = await fetch_with_timeout(f"{issuer}/cdn-cgi/access/certs", timeout_ms=JWKS_TIMEOUT_MS)
    if result.status != 200:
        raise AccessError(503, ApiError.UNAVAILABLE)
    keys = {}
    for jwk in json.loads(result.body).get("keys", []):
        if jwk.get("kty") == "RSA" and jwk.get("kid"):
            keys[jwk["kid"]] = await js.crypto.subtle.importKey(
                "jwk", to_js(jwk), to_js(RS256), False, to_js(["verify"])
            )
    _keys[issuer] = (now_ms() + JWKS_TTL_MS, keys)
    return keys


async def authenticate(request: Any, env: Any) -> str:
    """Return the owner email for a valid Access login, otherwise raise AccessError."""
    owner = var(env, "ACCESS_OWNER").lower()
    if local_dev(env) and flag(env, "DEV_AUTH_BYPASS"):
        return owner
    issuer = _issuer(env)
    audience = var(env, "ACCESS_AUDIENCE")
    if not audience or not owner:
        raise AccessError(503, ApiError.ACCESS_NOT_CONFIGURED)

    try:
        header_b64, payload_b64, signature_b64 = _token(request).split(".")
        header = json.loads(_b64url(header_b64))
        claims = json.loads(_b64url(payload_b64))
        signature = _b64url(signature_b64)
    except ValueError:
        raise _unauthorized() from None
    if header.get("alg") != "RS256" or not isinstance(claims, dict):
        raise _unauthorized()

    key = (await _signing_keys(issuer)).get(header.get("kid"))
    signed = f"{header_b64}.{payload_b64}".encode()
    if key is None or not await js.crypto.subtle.verify(RS256["name"], key, to_js(signature), to_js(signed)):
        raise _unauthorized()

    now_s = now_ms() // 1000
    audiences = claims.get("aud")
    audiences = audiences if isinstance(audiences, list) else [audiences]
    valid = (
        claims.get("iss") == issuer
        and audience in audiences
        and isinstance(claims.get("exp"), int | float)
        and claims["exp"] > now_s
        and isinstance(claims.get("iat"), int | float)
        and claims["iat"] < now_s + CLOCK_SKEW_S
        and isinstance(claims.get("email"), str)
        and claims["email"].lower() == owner
    )
    if not valid:
        raise _unauthorized()
    return owner
