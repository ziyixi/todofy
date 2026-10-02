"""Offline scheduler client tests using synthetic config and no HTTP sockets."""

import io
import json
import sys
import urllib.error as urllib_error
import urllib.request as urllib_request

import pytest

import newsletter.trigger as newsletter_trigger


@pytest.fixture
def trigger(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["newsletter-trigger"])
    # Replacing the mapping prevents accidental reads of the real environment.
    monkeypatch.setattr(
        newsletter_trigger.os,
        "environ",
        {
            "NEWSLETTER_SERVICE_URL": "https://newsletter.example.org/",
            "NEWSLETTER_EDITOR_TOKEN": "synthetic-editor-token-32-characters",
            "NEWSLETTER_ISSUE_DATE": "2026-09-05",
        },
    )
    return newsletter_trigger


@pytest.fixture
def transport(trigger, monkeypatch):
    class FakeClient:
        def __init__(self):
            self.requests = []
            self.handlers = ()
            self.failure = None
            self.raw = json.dumps(
                {
                    "id": "synthetic-run",
                    "state": "queued",
                    "issue_date": "2026-09-05",
                    "instructions_hash": "a" * 64,
                    "ignored_private_field": "do-not-echo-response-extras",
                }
            ).encode()

        def open(self, request, *, timeout):
            assert timeout == 30
            self.requests.append(request)
            if self.failure is not None:
                raise self.failure
            return io.BytesIO(self.raw)

    client = FakeClient()

    def build(*handlers):
        client.handlers = handlers
        return client

    monkeypatch.setattr(trigger.urllib_request, "build_opener", build)
    return client


def test_only_authenticated_https_run_endpoint_is_called(
    trigger, transport, capsys
):
    trigger.main()
    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert request.full_url == "https://newsletter.example.org/v1/runs"
    assert request.get_method() == "POST"
    assert (
        request.get_header("Authorization")
        == "Bearer " + trigger.os.environ["NEWSLETTER_EDITOR_TOKEN"]
    )
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data) == {
        "request_key": "daily-2026-09-05",
        "issue_date": "2026-09-05",
    }
    assert all("send" not in item.full_url for item in transport.requests)
    printed = json.loads(capsys.readouterr().out)
    assert set(printed) == {"id", "state", "issue_date", "instructions_hash"}
    assert "do-not-echo" not in json.dumps(printed)


def test_redirect_and_ambient_proxy_handlers_are_explicitly_disabled(
    trigger, transport
):
    trigger.main()
    redirects = [
        handler
        for handler in transport.handlers
        if isinstance(handler, trigger.NoRedirect)
    ]
    proxies = [
        handler
        for handler in transport.handlers
        if isinstance(handler, urllib_request.ProxyHandler)
    ]
    assert len(redirects) == 1
    assert (
        redirects[0].redirect_request(
            None, None, 302, "redirect", {}, "https://elsewhere.example.org"
        )
        is None
    )
    assert len(proxies) == 1 and proxies[0].proxies == {}


@pytest.mark.parametrize(
    "origin",
    [
        "",
        "http://newsletter.example.org",
        "ftp://newsletter.example.org",
        "/relative",
        "https://user:password@newsletter.example.org",
        "https://user@newsletter.example.org",
        "https://newsletter.example.org/path",
        "https://newsletter.example.org?target=other",
        "https://newsletter.example.org#section",
    ],
)
def test_invalid_origin_fails_before_constructing_any_network_client(
    trigger, transport, origin
):
    trigger.os.environ["NEWSLETTER_SERVICE_URL"] = origin
    with pytest.raises(SystemExit, match="fixed HTTPS origin"):
        trigger.main()
    assert not transport.requests and not transport.handlers


@pytest.mark.parametrize(
    "token", ["", "short", "a" * 23, "a" * 24 + " ", "a" * 24 + "\n"]
)
def test_missing_short_or_whitespace_auth_fails_without_request(
    trigger, transport, token
):
    trigger.os.environ["NEWSLETTER_EDITOR_TOKEN"] = token
    with pytest.raises(SystemExit, match="valid NEWSLETTER_EDITOR_TOKEN"):
        trigger.main()
    assert not transport.requests and not transport.handlers


@pytest.mark.parametrize("explicit_key", [None, "routine-A-20260905-revision1"])
def test_repeated_invocations_preserve_idempotent_request_bytes(
    trigger, transport, explicit_key
):
    if explicit_key is not None:
        trigger.os.environ["NEWSLETTER_REQUEST_KEY"] = explicit_key
    trigger.main()
    trigger.main()
    first, second = transport.requests
    assert first.data == second.data
    assert json.loads(first.data)["request_key"] == (
        explicit_key or "daily-2026-09-05"
    )


@pytest.mark.parametrize(
    "status", [301, 302, 307, 308, 401, 403, 409, 429, 500, 503]
)
def test_http_failure_is_not_retried_and_never_echoes_vendor_response(
    trigger, transport, capsys, status
):
    transport.failure = urllib_error.HTTPError(
        "https://newsletter.example.org/v1/runs",
        status,
        "private-provider-error",
        {},
        io.BytesIO(b"private-provider-response"),
    )
    with pytest.raises(SystemExit) as error:
        trigger.main()
    assert (
        str(error.value)
        == f"Trigger rejected (HTTP {status}); no automatic retry"
    )
    assert len(transport.requests) == 1
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("private-timeout"),
        urllib_error.URLError("private-network-error"),
        RuntimeError("private-unexpected-transport-error"),
    ],
)
def test_ambiguous_transport_outcome_is_safe_and_requires_same_key(
    trigger, transport, capsys, failure
):
    transport.failure = failure
    with pytest.raises(SystemExit) as error:
        trigger.main()
    assert (
        str(error.value)
        == "Trigger outcome unknown; retry only with the same request key"
    )
    assert len(transport.requests) == 1
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("raw", [b"not-json-private-content", b"{}", b"[]"])
def test_unusable_success_response_is_unknown_not_a_success_or_automatic_retry(
    trigger, transport, capsys, raw
):
    transport.raw = raw
    with pytest.raises(
        SystemExit,
        match="outcome unknown; retry only with the same request key",
    ):
        trigger.main()
    assert len(transport.requests) == 1
    assert capsys.readouterr().out == ""
