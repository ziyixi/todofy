"""Synthetic Access issuer, real signatures and local JWKS transport for tests."""

import io
import json
import time
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from codex_gateway.access import AccessServiceVerifier

ISSUER = "https://synthetic.cloudflareaccess.com"
AUDIENCE = "a" * 64
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = {
    **jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True),
    "kid": "synthetic-key",
    "alg": "RS256",
    "use": "sig",
}


def assertion(*, signing_key=KEY, **changes):
    now = int(time.time())
    return jwt.encode(
        {
            "iss": ISSUER,
            "aud": [AUDIENCE],
            "iat": now,
            "exp": now + 3600,
            "type": "app",
            "common_name": "synthetic-client.access",
            "sub": "",
            **changes,
        },
        signing_key,
        algorithm="RS256",
        headers={"kid": JWK["kid"]},
    )


def access_headers(**changes):
    return {"cf-access-jwt-assertion": assertion(**changes)}


def local_jwks():
    def read(_request, **_kwargs):
        return io.BytesIO(json.dumps({"keys": [JWK]}).encode())

    return patch("jwt.jwks_client.urllib.request.OpenerDirector.open", side_effect=read)


def verifier():
    return AccessServiceVerifier(ISSUER, AUDIENCE)
