"""A synthetic Access issuer: real RS256 signatures and an in-memory JWKS."""

from __future__ import annotations

import time
from typing import Any

import cryptography.hazmat.primitives.asymmetric.rsa as rsa
import jwt

import newsletter.console_access as console_access

ISSUER = "https://synthetic.cloudflareaccess.com"
AUDIENCE = "c" * 64
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = "synthetic-key"
JWK: dict[str, Any] = {
    **jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True),
    "kid": KID,
    "alg": "RS256",
    "use": "sig",
}


class LocalKeys:
    """The issuer's key set without a network; ``down`` fails as offline."""

    def __init__(self, *, down: bool = False) -> None:
        self.down = down

    def get_signing_key_from_jwt(self, token: str) -> jwt.PyJWK:
        """The signing key named by the token's key ID."""
        if self.down:
            raise jwt.PyJWKClientConnectionError("synthetic outage")
        if jwt.get_unverified_header(token).get("kid") != KID:
            raise jwt.PyJWKClientError("unknown key")
        return jwt.PyJWK(JWK)


def assertion(
    *,
    key: Any = KEY,
    headers: dict[str, Any] | None = None,
    algorithm: str = "RS256",
    drop: tuple[str, ...] = (),
    **changes: Any,
) -> str:
    """An owner's identity assertion for the console's application."""
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": [AUDIENCE],
        "iat": now,
        "nbf": now,
        "exp": now + 3600,
        "type": "app",
        "sub": "00000000-0000-4000-8000-0000000000aa",
        "email": "owner@example.invalid",
        **changes,
    }
    for name in drop:
        claims.pop(name)
    return jwt.encode(
        claims,
        key,
        algorithm=algorithm,
        headers={"kid": KID} if headers is None else headers,
    )


def verifier(*, down: bool = False) -> console_access.ConsoleAccessVerifier:
    """A verifier of the synthetic issuer and the console's audience."""
    return console_access.ConsoleAccessVerifier(
        ISSUER,
        AUDIENCE,
        jwks_client=LocalKeys(down=down),  # type: ignore[arg-type]
    )
