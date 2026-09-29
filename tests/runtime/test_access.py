from cryptography.hazmat.primitives.asymmetric import rsa

from tests.runtime.harness import OWNER, AccessIssuer, Worker

NAVIGATE = {"accept": "text/html", "sec-fetch-mode": "navigate"}


def _status(worker: Worker, token: str | None, **headers: str) -> int:
    if token is not None:
        headers["cf-access-jwt-assertion"] = token
    return worker.owner.get("/attention", headers=NAVIGATE | headers).status_code


def test_valid_rs256_token_is_accepted_from_header_or_cookie(auth_worker: Worker, access: AccessIssuer) -> None:
    assert _status(auth_worker, access.token()) == 200
    assert _status(auth_worker, None, cookie=f"theme=dark; CF_Authorization={access.token()}") == 200
    assert _status(auth_worker, access.token(email=OWNER.upper())) == 200


def test_invalid_tokens_are_rejected(auth_worker: Worker, access: AccessIssuer) -> None:
    foreign_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    rejected = {
        "missing": None,
        "garbage": "not-a-jwt",
        "foreign key": access.token(key=foreign_key),
        "wrong audience": access.token(aud=["someone-else"]),
        "wrong issuer": access.token(iss="https://evil.cloudflareaccess.com"),
        "expired": access.token(exp=1),
        "issued in the future": access.token(iat=4_102_444_800),
        "not the owner": access.token(email="intruder@example.com"),
        "service token without email": access.token(email=None),
        "wrong algorithm": access.token(alg="RS512"),
    }
    for case, token in rejected.items():
        assert _status(auth_worker, token) == 401, case


def test_signing_keys_are_fetched_once_per_isolate(auth_worker: Worker, access: AccessIssuer) -> None:
    for _ in range(3):
        assert _status(auth_worker, access.token()) == 200
    assert len(access.server.received("GET", "/cdn-cgi/access/certs")) == 1


def test_hooks_host_does_not_use_access(auth_worker: Worker) -> None:
    assert auth_worker.hooks.get("/health").status_code == 200
