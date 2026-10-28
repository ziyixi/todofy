"""Verify Cloudflare Access machine JWTs with the maintained PyJWT library."""

import re
from typing import Any

import jwt


class InvalidAccessToken(Exception):
    """The assertion does not authorize this machine application."""


class AccessKeysUnavailable(Exception):
    """The trusted issuer's signing keys could not be fetched."""


class AccessServiceVerifier:
    """One fixed issuer/audience policy and PyJWT's cached, rotating JWKS client."""

    def __init__(
        self, issuer: str, audience: str, *, jwks_client: jwt.PyJWKClient | None = None
    ) -> None:
        if not re.fullmatch(
            r"https://[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com", issuer
        ):
            raise ValueError("Invalid Access issuer")
        if not audience or len(audience) > 256 or audience.strip() != audience:
            raise ValueError("Invalid Access audience")
        self.issuer, self.audience = issuer, audience
        self.jwks = jwks_client or jwt.PyJWKClient(
            issuer + "/cdn-cgi/access/certs",
            timeout=5,
        )

    def verify(self, assertion: str) -> None:
        """Validate signature, registered claims and the documented machine shape."""
        if not assertion or len(assertion) > 16384:
            raise InvalidAccessToken from None
        try:
            header = jwt.get_unverified_header(assertion)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
                raise InvalidAccessToken
            key = self.jwks.get_signing_key_from_jwt(assertion)
            claims: dict[str, Any] = jwt.decode(
                assertion,
                key.key,
                algorithms=["RS256"],
                issuer=self.issuer,
                audience=self.audience,
                # Tolerate small clock skew on exp/iat/nbf between Access and this host.
                leeway=60,
                options={
                    "require": [
                        "iss",
                        "aud",
                        "exp",
                        "iat",
                        "type",
                        "common_name",
                        "sub",
                    ]
                },
            )
            if (
                claims["type"] != "app"
                or claims["sub"] != ""
                or not isinstance(claims["common_name"], str)
                or not claims["common_name"].strip()
            ):
                raise InvalidAccessToken
        except jwt.PyJWKClientConnectionError:
            raise AccessKeysUnavailable from None
        except (jwt.PyJWTError, ValueError, TypeError):
            raise InvalidAccessToken from None
