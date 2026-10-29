"""The console listener admits only the owner's Access login, verified here."""

import io
import json
import time
import unittest.mock as mock

import cryptography.hazmat.primitives.asymmetric.rsa as rsa
import fastapi.testclient as testclient
import jwt
import pytest

import newsletter.console_access as console_access
import newsletter.console_api as console_api
import newsletter.console_read as console_read
import newsletter.settings as newsletter_settings
import tests.support.console_auth as auth

OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def test_the_owner_identity_assertion_is_accepted():
    auth.verifier().verify(auth.assertion())


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(lambda: auth.assertion(aud=["d" * 64]), id="audience"),
        pytest.param(
            lambda: auth.assertion(iss="https://other.cloudflareaccess.com"),
            id="issuer",
        ),
        pytest.param(lambda: auth.assertion(key=OTHER), id="signature"),
        pytest.param(
            lambda: auth.assertion(key="s" * 32, algorithm="HS256"),
            id="algorithm",
        ),
        pytest.param(lambda: auth.assertion(headers={}), id="no key id"),
        pytest.param(
            lambda: auth.assertion(headers={"kid": ""}), id="empty key id"
        ),
        pytest.param(
            lambda: auth.assertion(headers={"kid": "rotated-away"}),
            id="unknown key id",
        ),
        pytest.param(
            lambda: auth.assertion(exp=int(time.time()) - 120), id="expired"
        ),
        pytest.param(
            lambda: auth.assertion(nbf=int(time.time()) + 600),
            id="not yet valid",
        ),
        pytest.param(
            lambda: auth.assertion(iat=int(time.time()) + 600),
            id="issued in the future",
        ),
        pytest.param(lambda: auth.assertion(type="org"), id="not an app"),
        # A service token's application assertion: no subject or email.
        pytest.param(
            lambda: auth.assertion(
                sub="", common_name="client.access", drop=("email",)
            ),
            id="service token",
        ),
        pytest.param(lambda: auth.assertion(email=""), id="empty email"),
        pytest.param(lambda: auth.assertion(sub=" "), id="blank subject"),
        pytest.param(
            lambda: auth.assertion(common_name="client.access"),
            id="identity with a client name",
        ),
        pytest.param(lambda: auth.assertion(drop=("exp",)), id="no expiry"),
        pytest.param(lambda: "not.a.jwt", id="malformed"),
        pytest.param(lambda: "", id="empty"),
        pytest.param(
            lambda: auth.assertion(padding="x" * 20_000), id="oversize"
        ),
    ],
)
def test_anything_else_is_refused(token):
    with pytest.raises(console_access.InvalidAccessTokenError):
        auth.verifier().verify(token())


def test_small_clock_skew_is_tolerated():
    now = int(time.time())
    auth.verifier().verify(auth.assertion(iat=now + 30, nbf=now + 30))
    auth.verifier().verify(auth.assertion(exp=now - 30))


def test_unreachable_keys_are_not_a_refusal():
    with pytest.raises(console_access.AccessKeysUnavailableError):
        auth.verifier(down=True).verify(auth.assertion())


def test_the_maintained_jwks_client_reads_the_team_certificates():
    requested = []

    def read(request, **_kwargs):
        requested.append(request.full_url)
        return io.BytesIO(json.dumps({"keys": [auth.JWK]}).encode())

    verifier = console_access.ConsoleAccessVerifier(auth.ISSUER, auth.AUDIENCE)
    with mock.patch(
        "jwt.jwks_client.urllib.request.OpenerDirector.open", side_effect=read
    ):
        verifier.verify(auth.assertion())
    assert requested == [auth.ISSUER + "/cdn-cgi/access/certs"]


@pytest.mark.parametrize(
    ("issuer", "audience"),
    [
        ("http://synthetic.cloudflareaccess.com", "c" * 64),
        ("https://synthetic.example.com", "c" * 64),
        (auth.ISSUER, "c" * 63),
        (auth.ISSUER, "C" * 64),
        (auth.ISSUER, ""),
    ],
)
def test_the_baked_policy_is_checked(issuer, audience):
    with pytest.raises(ValueError, match="Invalid Access"):
        console_access.ConsoleAccessVerifier(issuer, audience)


def _config(tmp_path, audiences):
    (tmp_path / "cloud.toml").write_text(
        f'version = 1\naccess_issuer = "{auth.ISSUER}"\n'
    )
    lines = "".join(f'"{k}" = "{v}"\n' for k, v in audiences.items())
    (tmp_path / "resources.toml").write_text(
        "version = 1\n[access_audiences]\n" + lines
    )
    return tmp_path


def test_the_image_bakes_the_console_audience(tmp_path):
    config = _config(tmp_path, {"newsletter-console": auth.AUDIENCE})
    output = tmp_path / "console-access.json"
    assert console_access.write_policy(config, output)
    assert json.loads(output.read_text()) == {
        "access_audience": auth.AUDIENCE,
        "access_issuer": auth.ISSUER,
    }
    loaded = console_access.load_policy(output)
    assert loaded is not None
    assert (loaded.issuer, loaded.audience) == (auth.ISSUER, auth.AUDIENCE)


def test_without_a_recorded_audience_nothing_is_baked(tmp_path):
    config = _config(tmp_path, {"codex-gateway": "a" * 64})
    output = tmp_path / "console-access.json"
    assert not console_access.write_policy(config, output)
    assert not output.exists()
    assert console_access.load_policy(output) is None


def test_a_recorded_audience_a_verifier_refuses_fails_the_build(tmp_path):
    config = _config(tmp_path, {"newsletter-console": "not-an-aud"})
    with pytest.raises(ValueError, match="Invalid Access audience"):
        console_access.write_policy(config, tmp_path / "out.json")


@pytest.mark.parametrize(
    "content",
    [b"", b"{}", b"[]", b'{"access_issuer": 1, "access_audience": 2}'],
)
def test_an_invalid_policy_file_is_no_policy(tmp_path, content):
    path = tmp_path / "console-access.json"
    path.write_bytes(content)
    assert console_access.load_policy(path) is None
    path.write_bytes(b" " * 2000)
    assert console_access.load_policy(path) is None


def _client(tmp_path, verifier):
    settings = newsletter_settings.Settings(data_dir=tmp_path / "data")
    reader = console_read.ConsoleReader(settings)
    app = console_api.create_console_app(reader, verifier, lambda: True)
    return testclient.TestClient(app)


def _reason(response):
    return response.json()["error"]["details"][0]["reason"]


def test_every_route_authenticates_before_it_reads(tmp_path):
    client = _client(tmp_path, auth.verifier())
    for path in (
        "/api/newsletter/v1/overview",
        "/api/newsletter/v1/runs?month=bad",
        "/api/newsletter/v1/editions/x/rendering",
    ):
        response = client.get(path)
        assert response.status_code == 401
        assert _reason(response) == "UNAUTHORIZED"
        assert response.headers["cache-control"] == "no-store"
    token = auth.assertion()
    duplicate = client.get(
        "/api/newsletter/v1/overview",
        headers=[
            ("cf-access-jwt-assertion", token),
            ("cf-access-jwt-assertion", token),
        ],
    )
    assert duplicate.status_code == 401
    # The engine's machine credential is no console credential.
    bearer = client.get(
        "/api/newsletter/v1/overview",
        headers={"authorization": "Bearer " + "e" * 32},
    )
    assert bearer.status_code == 401
    # Authenticated, the request reaches the reader: no database here.
    admitted = client.get(
        "/api/newsletter/v1/overview",
        headers={"cf-access-jwt-assertion": token},
    )
    assert admitted.status_code == 503
    assert _reason(admitted) == "UNAVAILABLE"


def test_unreachable_keys_answer_unavailable(tmp_path):
    client = _client(tmp_path, auth.verifier(down=True))
    response = client.get(
        "/api/newsletter/v1/overview",
        headers={"cf-access-jwt-assertion": auth.assertion()},
    )
    assert response.status_code == 503
    assert _reason(response) == "UNAVAILABLE"


def test_without_a_baked_policy_every_request_is_not_configured(tmp_path):
    client = _client(tmp_path, None)
    response = client.get(
        "/api/newsletter/v1/overview",
        headers={"cf-access-jwt-assertion": auth.assertion()},
    )
    assert response.status_code == 503
    assert _reason(response) == "NOT_CONFIGURED"


def test_the_assertion_is_never_echoed_or_logged(tmp_path, caplog):
    client = _client(tmp_path, auth.verifier())
    token = auth.assertion(aud=["d" * 64])
    response = client.get(
        "/api/newsletter/v1/overview",
        headers={"cf-access-jwt-assertion": token},
    )
    assert response.status_code == 401
    assert token not in response.text
    assert token not in caplog.text
    assert jwt.get_unverified_header(token)["kid"] not in response.text
