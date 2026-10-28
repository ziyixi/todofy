"""Owner API behind real Access JWT checks: the 401 matrix, owner aliases and keyless write intent.

POSTs that fail before the body is read are sent without a body (see the local
proxy quirk in docs/dev-notes.md §3).
"""

from collections.abc import Iterator

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from ziyixi_proto.todofy.ui.v1 import status_pb

from tests.runtime.harness import GATEWAY_AUTH_CONFIG, OWNER, AccessIssuer, Worker, start_gateway
from tests.runtime.owner_support import (
    ORIGIN,
    assert_message,
    assert_private,
    assert_status,
    csrf_headers,
)

ALIAS = "owner.alias@example.org"
EVENT_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"
READS = [
    "/api/v1/serviceStatus",
    "/api/v1/mailEvents",
    f"/api/v1/mailEvents/{EVENT_ID}",
    "/api/v1/latestReports",
    "/api/v1/metricDays",
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
    response = jwt_worker.owner.post(
        RECONCILE, headers={"origin": ORIGIN, "x-csrf-token": "1", "content-type": "application/json"}
    )
    assert_status(response, 401, "UNAUTHORIZED")
    assert_private(response)


def test_an_alias_login_acts_as_the_owner(jwt_worker: Worker, access: AccessIssuer) -> None:
    alias = _login(access, email=ALIAS)
    integration = jwt_worker.owner.get("/api/v1/integration", headers=alias)
    assert assert_message(integration, status_pb.Integration)["access_owner"] == OWNER
    second = jwt_worker.owner.get("/api/v1/integration", headers=_login(access, email="Second@Example.NET"))
    assert second.status_code == 200

    # The write header is not identity-bound; both verified logins pass the write gate.
    headers = csrf_headers()
    for login in (alias, _login(access)):
        response = jwt_worker.owner.post(
            RECONCILE, headers=headers | login | {"content-type": "application/json"}, content=b"{}"
        )
        # Past Access and write intent: the empty object lacks the REQUIRED action and etag.
        assert_status(response, 400, "BAD_REQUEST")


def test_cross_site_and_missing_write_intent_get_403(jwt_worker: Worker, access: AccessIssuer) -> None:
    login = _login(access)
    good = login | {"origin": ORIGIN, "x-csrf-token": "1", "content-type": "application/json"}
    rejected = {
        "cross-origin": good | {"origin": "https://evil.example"},
        "https origin on a plain-HTTP dev host": good | {"origin": "https://attacker.localhost"},
        "no origin": {name: value for name, value in good.items() if name != "origin"},
        "noncanonical origin": good | {"origin": ORIGIN.upper()},
        "no header": {name: value for name, value in good.items() if name != "x-csrf-token"},
        "empty header": good | {"x-csrf-token": ""},
        "no JSON media type": {name: value for name, value in good.items() if name != "content-type"},
        "form media type": good | {"content-type": "application/x-www-form-urlencoded"},
        "text media type": good | {"content-type": "text/plain"},
    }
    for case, headers in rejected.items():
        response = jwt_worker.owner.post(RECONCILE, headers=headers)
        assert response.status_code == 403, case
        assert_status(response, 403, "CSRF_FAILED")
        assert_private(response)

    accepted = jwt_worker.owner.post(RECONCILE, headers=good, content=b"[]")
    assert_status(accepted, 400, "BAD_REQUEST")
