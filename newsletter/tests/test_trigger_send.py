"""Synthetic HTTP responses, without credentials, model calls or mail."""

import argparse
import ast
import io
import json
import pathlib
import signal
import subprocess
import sys
import urllib.error as urllib_error

import pytest

import newsletter.trigger as trigger


def run(state="ready", **fields):
    return {
        "id": "run-123",
        "issue_date": "2026-09-05",
        "state": state,
        "instructions_hash": "a" * 64,
        "edition_id": "edition-123",
        "is_fixture": False,
        **fields,
    }


def edition(delivery="not_requested", **fields):
    return {
        "id": "edition-123",
        "issue_date": "2026-09-05",
        "state": "ready",
        "is_fixture": False,
        "review": {"passed": True},
        "rendered": {"render_hash": "b" * 64, "html": "private-body-never-log"},
        "personal_digest": {"items": ["private-event-never-log"]},
        "delivery_state": delivery,
        **fields,
    }


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(
        trigger.os,
        "environ",
        {
            "NEWSLETTER_SERVICE_URL": "https://newsletter.example.org",
            "NEWSLETTER_EDITOR_TOKEN": "synthetic-editor-token-32-characters",
            "NEWSLETTER_SEND_TOKEN": "synthetic-sender-token-32-characters",
            "NEWSLETTER_ISSUE_DATE": "2026-09-05",
        },
    )
    monkeypatch.setattr(trigger.time, "sleep", lambda _: None)

    class Client:
        def __init__(self):
            self.responses = []
            self.requests = []
            self.built = 0

        def open(self, request, *, timeout):
            assert (
                0
                < timeout
                <= (45 if request.full_url.endswith("/send") else 30)
            )
            self.requests.append(request)
            response = self.responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return io.BytesIO(
                response
                if isinstance(response, bytes)
                else json.dumps(response).encode()
            )

        def build(self, *handlers):
            self.built += 1
            return self

    value = Client()
    monkeypatch.setattr(trigger.urllib_request, "build_opener", value.build)
    return value


def test_wait_only_observes_complete_run_and_returns_safe_receipt(
    client, capsys
):
    client.responses = [
        run("queued"),
        run("collecting"),
        run("editing"),
        run(),
        edition(),
    ]
    trigger.main(["--wait"])
    assert [request.get_method() for request in client.requests] == [
        "POST",
        "GET",
        "GET",
        "GET",
        "GET",
    ]
    assert all(
        not request.full_url.endswith("/send") for request in client.requests
    )
    output = capsys.readouterr().out
    assert "private" not in output
    assert json.loads(output)["render_hash"] == "b" * 64


def test_explicit_send_uses_distinct_role_and_frozen_approval(client, capsys):
    client.responses = [run(), edition(), edition("provider_accepted")]
    trigger.main(["--send"])
    assert len(client.requests) == 3
    first, read, send = client.requests
    assert first.get_header("Authorization") == read.get_header("Authorization")
    assert (
        send.get_header("Authorization")
        == "Bearer " + trigger.os.environ["NEWSLETTER_SEND_TOKEN"]
    )
    assert (
        send.full_url
        == "https://newsletter.example.org/v1/editions/edition-123/send"
    )
    payload = json.loads(send.data)
    assert payload["id"] == "edition-123"
    assert payload["expected_render_hash"] == "b" * 64
    assert (
        payload["request_key"].startswith("trigger-send-")
        and len(payload["request_key"]) <= 128
    )
    output = capsys.readouterr().out
    assert "private" not in output and "token" not in output
    assert json.loads(output)["delivery_state"] == "provider_accepted"


def test_repeat_accepted_run_observes_without_another_send(client):
    client.responses = [
        run(),
        edition(),
        edition("provider_accepted"),
        run(),
        edition("provider_accepted"),
    ]
    trigger.main(["--send"])
    trigger.main(["--send"])
    starts = [
        req for req in client.requests if req.full_url.endswith("/v1/runs")
    ]
    assert starts[0].data == starts[1].data
    assert sum(req.full_url.endswith("/send") for req in client.requests) == 1


@pytest.mark.parametrize(
    "state", ["unknown", "submitting", "rejected", "simulated"]
)
def test_prior_delivery_is_never_resent(client, capsys, state):
    client.responses = [run(), edition(state)]
    with pytest.raises(SystemExit, match="no further send attempted"):
        trigger.main(["--send"])
    assert len(client.requests) == 2
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize(
    "state", ["unknown", "submitting", "rejected", "simulated", "not_requested"]
)
def test_unsuccessful_send_response_is_not_success_or_retried(client, state):
    client.responses = [run(), edition(), edition(state)]
    with pytest.raises(SystemExit, match="no further send attempted"):
        trigger.main(["--send"])
    assert len(client.requests) == 3


@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("private timeout"),
        urllib_error.URLError("private transport"),
        b"private-invalid-json",
        urllib_error.HTTPError(
            "https://newsletter.example.org",
            503,
            "private",
            {},
            io.BytesIO(b"private"),
        ),
    ],
)
def test_ambiguous_send_never_retries_and_next_invocation_observes_unknown(
    client, capsys, failure
):
    client.responses = [run(), edition(), failure, run(), edition("unknown")]
    with pytest.raises(SystemExit) as error:
        trigger.main(["--send"])
    assert "private" not in str(error.value)
    with pytest.raises(SystemExit, match="no further send attempted"):
        trigger.main(["--send"])
    assert sum(req.full_url.endswith("/send") for req in client.requests) == 1
    assert capsys.readouterr().out == ""


def test_same_key_is_retained_when_prior_post_never_reached_server(client):
    client.responses = [
        run(),
        edition(),
        TimeoutError(),
        run(),
        edition(),
        edition("provider_accepted"),
    ]
    with pytest.raises(SystemExit):
        trigger.main(["--send"])
    trigger.main(["--send"])
    sends = [req for req in client.requests if req.full_url.endswith("/send")]
    assert sends[0].data == sends[1].data


@pytest.mark.parametrize(
    "value",
    [run("failed"), run("blocked"), run(is_fixture=True), run(is_fixture=None)],
)
def test_bad_run_cannot_fetch_or_send_edition(client, value):
    client.responses = [value]
    with pytest.raises(SystemExit, match="not sending"):
        trigger.main(["--send"])
    assert len(client.requests) == 1


@pytest.mark.parametrize(
    "value",
    [
        edition(state="running"),
        edition(state="blocked"),
        edition(state="failed"),
        edition(is_fixture=True),
        edition(is_fixture=None),
        edition(id="other"),
        edition(issue_date="2026-09-04"),
        edition(review={"passed": False}),
        edition(review={}),
        edition(rendered={"render_hash": "not-a-hash"}),
        edition(delivery="bogus"),
    ],
)
def test_bad_edition_is_not_sent(client, value):
    client.responses = [run(), value]
    with pytest.raises(SystemExit):
        trigger.main(["--send"])
    assert len(client.requests) == 2


@pytest.mark.parametrize(
    "fields",
    [
        {"id": "../other"},
        {"issue_date": "2026-09-04"},
        {"instructions_hash": "bad"},
        {"state": "bogus"},
        {"edition_id": "../send"},
    ],
)
def test_invalid_run_or_path_fields_never_become_urls(client, fields):
    client.responses = [run(**fields)]
    with pytest.raises(SystemExit):
        trigger.main(["--send"])
    assert len(client.requests) == 1


@pytest.mark.parametrize(
    "fields", [{"id": "other"}, {"instructions_hash": "c" * 64}]
)
def test_poll_must_refer_to_same_instruction_snapshot(client, fields):
    client.responses = [run("queued"), run(**fields)]
    with pytest.raises(SystemExit, match="Invalid run observation"):
        trigger.main(["--send"])
    assert len(client.requests) == 2


def test_send_reply_cannot_change_approved_hash(client):
    client.responses = [
        run(),
        edition(),
        edition("provider_accepted", rendered={"render_hash": "c" * 64}),
    ]
    with pytest.raises(SystemExit, match="changed the frozen hash"):
        trigger.main(["--send"])
    assert len(client.requests) == 3


@pytest.mark.parametrize(
    "origin",
    [
        "http://newsletter:8080.evil.org",
        "http://newsletter:8081",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://other:8080",
        "http://newsletter:8080/path",
        "http://newsletter:8080?",
        "http://newsletter:8080#",
        "http://newsletter:8080@evil.org",
        "http://NEWSLETTER:8080",
        "https://newsletter.example.org\\@evil.org",
        "https://newsletter.example.org:99999",
        "https://newsletter.example.org/%2e%2e",
    ],
)
def test_internal_http_opt_in_is_not_an_arbitrary_http_bypass(client, origin):
    trigger.os.environ.update(
        NEWSLETTER_SERVICE_URL=origin, NEWSLETTER_ALLOW_INTERNAL_HTTP="1"
    )
    with pytest.raises(SystemExit, match="fixed HTTPS origin"):
        trigger.main(["--check-config", "--send"])
    assert client.built == 0


def test_internal_origin_requires_opt_in_and_then_passes_offline(
    client, capsys
):
    trigger.os.environ["NEWSLETTER_SERVICE_URL"] = "http://newsletter:8080"
    with pytest.raises(SystemExit, match="fixed HTTPS origin"):
        trigger.main(["--check-config", "--send"])
    trigger.os.environ["NEWSLETTER_ALLOW_INTERNAL_HTTP"] = "1"
    trigger.main(["--check-config", "--send"])
    assert json.loads(capsys.readouterr().out) == {
        "configuration": "valid",
        "send_enabled": True,
    }
    assert client.built == 0


@pytest.mark.parametrize(
    "key,value",
    [
        ("NEWSLETTER_SEND_TOKEN", ""),
        ("NEWSLETTER_SEND_TOKEN", "a" * 24 + "\n"),
        ("NEWSLETTER_SEND_TOKEN", "synthetic-editor-token-32-characters"),
        ("NEWSLETTER_EDITOR_TOKEN", "汉" * 24),
        ("NEWSLETTER_TIME_ZONE", "not-a-zone"),
        ("NEWSLETTER_ISSUE_DATE", "2026-02-30"),
        ("NEWSLETTER_ISSUE_DATE", "20260905"),
        ("NEWSLETTER_REQUEST_KEY", "a" * 129),
        ("NEWSLETTER_REQUEST_KEY", " leading"),
        ("NEWSLETTER_REQUEST_KEY", "a\nb"),
        ("NEWSLETTER_ALLOW_INTERNAL_HTTP", "yes"),
    ],
)
def test_check_config_validates_every_send_setting_before_io(
    client, key, value
):
    trigger.os.environ[key] = value
    with pytest.raises(SystemExit):
        trigger.main(["--check-config", "--send"])
    assert client.built == 0


@pytest.mark.parametrize(
    "args",
    [["--timeout", "0"], ["--timeout", "86401"], ["--poll-interval", "0"]],
)
def test_invalid_time_bounds_rejected(client, args):
    with pytest.raises(SystemExit):
        trigger.main(["--check-config", *args])
    assert client.built == 0


def test_timeout_stops_polling_without_send(client, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(trigger.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        trigger.time,
        "sleep",
        lambda seconds: clock.__setitem__(0, clock[0] + seconds),
    )
    client.responses = [run("queued")]
    with pytest.raises(SystemExit, match="deadline exceeded"):
        trigger.main(["--send", "--timeout", "1"])
    assert len(client.requests) == 1


def test_posix_deadline_interrupts_network_and_restores_handler(
    client, monkeypatch
):
    previous = signal.getsignal(signal.SIGALRM)

    def blocked(request, *, timeout):
        signal.raise_signal(signal.SIGALRM)

    monkeypatch.setattr(client, "open", blocked)
    with pytest.raises(SystemExit, match="deadline exceeded"):
        trigger.main(["--send"])
    assert signal.getsignal(signal.SIGALRM) == previous
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)


def test_standalone_module_is_stdlib_only_and_help_needs_no_dependencies():
    path = pathlib.Path(trigger.__file__)
    tree = ast.parse(path.read_text())
    imported = {
        (node.module or "").split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
    } | {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    assert imported <= sys.stdlib_module_names | {"__future__"}
    result = subprocess.run(
        [sys.executable, "-I", "-S", str(path), "--help"],
        env={},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0 and "--send" in result.stdout


def test_checkout_wrapper_needs_no_install_pythonpath_or_repo_working_directory(
    tmp_path,
):
    script = (
        pathlib.Path(__file__).resolve().parents[1]
        / "scripts"
        / "trigger_run.py"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-S", str(script), "--check-config", "--send"],
        cwd=tmp_path,
        env={
            "NEWSLETTER_SERVICE_URL": "https://newsletter.example.org",
            "NEWSLETTER_EDITOR_TOKEN": "synthetic-editor-token-32-characters",
            "NEWSLETTER_SEND_TOKEN": "synthetic-sender-token-32-characters",
            "NEWSLETTER_ISSUE_DATE": "2026-09-05",
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "configuration": "valid",
        "send_enabled": True,
    }


def test_only_declared_configuration_is_read_and_never_mutated(client):
    class Restricted(dict):
        def get(self, name, default=None):
            assert name in {
                "NEWSLETTER_SERVICE_URL",
                "NEWSLETTER_ALLOW_INTERNAL_HTTP",
                "NEWSLETTER_EDITOR_TOKEN",
                "NEWSLETTER_SEND_TOKEN",
                "NEWSLETTER_TIME_ZONE",
                "NEWSLETTER_ISSUE_DATE",
                "NEWSLETTER_REQUEST_KEY",
            }
            return super().get(name, default)

    values = Restricted(trigger.os.environ)
    trigger.os.environ = values
    before = dict(values)
    config = trigger.Config.from_args(
        argparse.Namespace(
            send=True,
            wait=False,
            timeout=3600,
            poll_interval=10,
        )
    )
    assert config.send and "token" not in repr(config)
    assert values == before
