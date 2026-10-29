"""Verify the owner's Cloudflare Access assertion on the console listener.

The console Worker forwards the owner's own Access assertion; Access admits
the read path only with an assertion of the console's application, and the
tunnel's rule requires that application's audience too. This module checks the
assertion once more in the process before anything is read: RS256 with a key
ID, the team's Access certificates, the exact issuer and audience (both public,
baked into the image at build time), the lifetime claims with a small leeway,
a size cap, and the identity shape (an email and a subject; a service token's
assertion has neither and is refused).

Why here and not in packages/edge-auth: that package is the Workers' owner
check in TypeScript. In Python this only configures the maintained PyJWT
library, exactly as the Codex gateway does (codex_gateway/access.py).

Why no email comparison: the image is public and the host keeps no personal
value, so the owner's address is not here to compare. Access's owner policy
decides who may log in, and only the owner can; the signature, issuer and
audience checks are defence in depth against a request that did not come
through Access.
"""

import json
import pathlib
import re
import tomllib
from typing import Any

import jwt

# The policy file the image build writes (Dockerfile) from config/.
POLICY_FILE = pathlib.Path("/opt/newsletter/console-access.json")
# The console's Access application in config/resources.toml access_audiences.
AUDIENCE_KEY = "newsletter-console"
MAX_ASSERTION_BYTES = 16384
# Seconds of clock skew tolerated on exp, iat and nbf.
LEEWAY_SECONDS = 60
_ISSUER = re.compile(r"https://[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com\Z")
_AUDIENCE = re.compile(r"[0-9a-f]{64}\Z")


class InvalidAccessTokenError(Exception):
    """The assertion does not authorize an owner read."""


class AccessKeysUnavailableError(Exception):
    """The trusted issuer's signing keys could not be fetched."""


class ConsoleAccessVerifier:
    """One fixed issuer and audience and PyJWT's cached, rotating JWKS."""

    def __init__(
        self,
        issuer: str,
        audience: str,
        *,
        jwks_client: jwt.PyJWKClient | None = None,
    ) -> None:
        if not isinstance(issuer, str) or not _ISSUER.fullmatch(issuer):
            raise ValueError("Invalid Access issuer")
        if not isinstance(audience, str) or not _AUDIENCE.fullmatch(audience):
            raise ValueError("Invalid Access audience")
        self.issuer, self.audience = issuer, audience
        self.jwks = jwks_client or jwt.PyJWKClient(
            issuer + "/cdn-cgi/access/certs", timeout=5
        )

    def verify(self, assertion: str) -> None:
        """Validate the signature, registered claims and identity shape.

        Raises:
            InvalidAccessTokenError: Not the console's owner login.
            AccessKeysUnavailableError: The issuer's keys are unreachable.
        """
        if not assertion or len(assertion.encode()) > MAX_ASSERTION_BYTES:
            raise InvalidAccessTokenError from None
        try:
            header = jwt.get_unverified_header(assertion)
            kid = header.get("kid")
            if header.get("alg") != "RS256" or not (
                isinstance(kid, str) and kid
            ):
                raise InvalidAccessTokenError
            key = self.jwks.get_signing_key_from_jwt(assertion)
            claims: dict[str, Any] = jwt.decode(
                assertion,
                key.key,
                algorithms=["RS256"],
                issuer=self.issuer,
                audience=self.audience,
                leeway=LEEWAY_SECONDS,
                options={
                    "require": [
                        "iss",
                        "aud",
                        "exp",
                        "iat",
                        "type",
                        "sub",
                        "email",
                    ]
                },
            )
            # An identity login of an application has a subject and an
            # email; a service token's assertion has neither (codex_gateway's
            # machine shape is the opposite check).
            if claims["type"] != "app" or not all(
                isinstance(claims[name], str) and claims[name].strip()
                for name in ("sub", "email")
            ):
                raise InvalidAccessTokenError
            if claims.get("common_name"):
                raise InvalidAccessTokenError
        except jwt.PyJWKClientConnectionError:
            raise AccessKeysUnavailableError from None
        except (jwt.PyJWTError, ValueError, TypeError, KeyError):
            raise InvalidAccessTokenError from None


def bake_policy(config_dir: pathlib.Path) -> dict[str, str] | None:
    """The public issuer and audience for the image, from config/.

    None while the console's Access application has no recorded audience
    (infra/README.md "Adding an app"): the listener then answers every request
    NOT_CONFIGURED, and the engine is unaffected. Raises ValueError for a
    recorded value that a verifier would refuse, so the build fails instead.
    """
    profile = tomllib.loads((config_dir / "cloud.toml").read_text())
    resources = tomllib.loads((config_dir / "resources.toml").read_text())
    audience = resources.get("access_audiences", {}).get(AUDIENCE_KEY)
    if audience is None:
        return None
    policy = {
        "access_issuer": profile["access_issuer"],
        "access_audience": audience,
    }
    ConsoleAccessVerifier(policy["access_issuer"], policy["access_audience"])
    return policy


def write_policy(config_dir: pathlib.Path, output: pathlib.Path) -> bool:
    """Write the baked policy file; False (and no file) without an audience."""
    policy = bake_policy(config_dir)
    if policy is None:
        return False
    output.write_text(json.dumps(policy, sort_keys=True), encoding="utf-8")
    return True


def load_policy(
    path: pathlib.Path | None = None,
) -> ConsoleAccessVerifier | None:
    """The baked policy's verifier; None when it is absent or invalid."""
    try:
        with (path or POLICY_FILE).open("rb") as stream:
            body = stream.read(1025)
        if len(body) > 1024:
            return None
        value = json.loads(body)
        return ConsoleAccessVerifier(
            value["access_issuer"], value["access_audience"]
        )
    except (OSError, ValueError, TypeError, KeyError):
        return None
