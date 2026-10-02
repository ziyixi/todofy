"""Owner API behind real Access JWT checks: the 401 matrix, owner aliases and CSRF.

POSTs that fail before the body is read are sent without a body (see the local
proxy quirk in docs/dev-notes.md §3).
"""

from collections.abc import Iterator

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from ziyixi_proto.todofy.ui.v1 import status_pb

from tests.runtime.harness import GATEWAY_AUTH_CONFIG, OWNER, AccessIssuer, Worker, start_gateway
from tests.runtime.owner_support import (
    CSRF_KEY,
    ORIGIN,
    assert_message,
    assert_private,
    assert_status,
    csrf_headers,
    issue_csrf,
    mint_csrf,
    token_claims,
)

ALIAS = "owner.alias@example.org"
EVENT_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"
READS = [
    "/api/csrf",
    "/api/v1/serviceStatus",
    "/api/v1/mailEvents",
    f"/api/v1/mailEvents/{EVENT_ID}",
    "/api/v1/dailyReminders",
    "/api/v1/latestReports",
    "/api/v1/metricDays",
    "/api/v1/gtdDays",
    "/api/v1/gtdReviews",
    f"/api/v1/legacyTexts/{EVENT_ID}",
    "/api/v1/integration",
]
RECONCILE = f"/api/v1/mailEvents/{EVENT_ID}:reconcile"


@pytest.fixture(scope="module")
def jwt_worker(tmp_path_factory: pytest.TempPathFactory, access: AccessIssuer) -> Iterator[Worker]:
    yield from start_gateway(
        tmp_path_factory.mktemp("owner-jwt-worker"),
        {
            "ACCESS_ISSUER": access.url,
            # Mixed case and spaces: matching is on the trimmed, lowercased address.
            "ACCESS_OWNER_ALIASES": f" {ALIAS.upper()} , second@example.net",
            "CSRF_SIGNING_KEY": CSRF_KEY,
        },
        GATEWAY_AUTH_CONFIG,
    )


def _login(access: AccessIssuer, **claims: object) -> dict[str, str]:
    return {"cf-access-jwt-assertion": access.token(**claims)}


@pytest.mark.reaches("UNAUTHORIZED")
def test_every_owner_read_needs_a_valid_access_login(jwt_worker: Worker, access: AccessIssuer) -> None:
    rejected = {
        "missing": {},
        "wrong audience": _login(access, aud=["someone-else"]),
        "expired": _login(access, exp=1),
        "not the owner": _login(access, email="intruder@example.com"),
        "service token without email": _login(access, email=None),
        "foreign key": {
            "cf-access-jwt-assertion": access.token(key=rsa.generate_private_key(public_exponent=65537, key_size=2048))
        },
    }
    for path in READS:
        for case, headers in rejected.items():
            response = jwt_worker.owner.get(path, headers=headers)
            assert response.status_code == 401, (path, case)
            assert_status(response, 401, "UNAUTHORIZED")
            assert_private(response)


def test_writes_check_access_before_csrf(jwt_worker: Worker) -> None:
    response = jwt_worker.owner.post(RECONCILE, headers=csrf_headers(mint_csrf()))
    assert_status(response, 401, "UNAUTHORIZED")
    assert_private(response)


def test_an_alias_login_acts_as_the_owner(jwt_worker: Worker, access: AccessIssuer) -> None:
    alias = _login(access, email=ALIAS)
    integration = jwt_worker.owner.get("/api/v1/integration", headers=alias)
    assert assert_message(integration, status_pb.Integration)["access_owner"] == OWNER
    second = jwt_worker.owner.get("/api/v1/integration", headers=_login(access, email="Second@Example.NET"))
    assert second.status_code == 200

    # The CSRF token belongs to ACCESS_OWNER, so it works for any of the owner's logins.
    headers = issue_csrf(jwt_worker.owner, alias)
    assert token_claims(headers["x-csrf-token"])["owner"] == OWNER
    owner_post = headers | _login(access)
    response = jwt_worker.owner.post(
        RECONCILE, headers=owner_post | {"content-type": "application/json"}, content=b"{}"
    )
    # Past Access and CSRF: the empty object lacks the REQUIRED action and etag.
    assert_status(response, 400, "BAD_REQUEST")


def test_csrf_token_is_issued_with_a_strict_cookie(jwt_worker: Worker, access: AccessIssuer) -> None:
    response = jwt_worker.owner.get("/api/csrf", headers=_login(access))
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"todofy_csrf={token};")
    for attribute in ("Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=43200"):
        assert attribute in cookie
    # Plain HTTP under wrangler dev; production is always HTTPS and gets Secure.
    assert "Secure" not in cookie
    assert_private(response)
    claims = token_claims(token)
    assert claims["kind"] == "csrf" and claims["owner"] == OWNER


def test_cross_site_and_forged_writes_get_403(jwt_worker: Worker, access: AccessIssuer) -> None:
    login = _login(access)
    good = issue_csrf(jwt_worker.owner, login)
    token = good["x-csrf-token"]
    other = mint_csrf()
    rejected = {
        "cross-origin": good | {"origin": "https://evil.example"},
        "https origin on a plain-HTTP dev host": good | {"origin": "https://attacker.localhost"},
        "no origin": {name: value for name, value in good.items() if name != "origin"},
        "no header": {name: value for name, value in good.items() if name != "x-csrf-token"},
        "no cookie": {name: value for name, value in good.items() if name != "cookie"},
        "header differs from cookie": good | {"x-csrf-token": other},
        "tampered signature": csrf_headers(token[:-2] + ("AA" if not token.endswith("AA") else "BB")) | login,
        "signed with another key": csrf_headers(mint_csrf(key="11" * 32)) | login,
        "expired": csrf_headers(mint_csrf(exp=1)) | login,
        "another owner": csrf_headers(mint_csrf(owner=ALIAS)) | login,
        "not a csrf token": csrf_headers(mint_csrf(kind="confirm")) | login,
    }
    for case, headers in rejected.items():
        response = jwt_worker.owner.post(RECONCILE, headers=headers)
        assert response.status_code == 403, case
        assert_status(response, 403, "CSRF_FAILED")
        assert_private(response)

    accepted = jwt_worker.owner.post(
        RECONCILE, headers=good | {"origin": ORIGIN.upper(), "content-type": "application/json"}, content=b"[]"
    )
    assert_status(accepted, 400, "BAD_REQUEST")
