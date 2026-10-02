"""Bundle validation with in-process GitHub transport and no live providers."""

from __future__ import annotations

import copy
import errno
import json
import pathlib
import sqlite3
import subprocess
import unittest.mock as mock

import httpx
import pytest

import newsletter.config_sync as config_sync
import newsletter.content_config as content_config
import newsletter.contracts as contracts

SHA = "a" * 40
SECRET = "synthetic-github-read-token-not-a-live-credential"


def bundle(revision: str = SHA) -> dict:
    value = copy.deepcopy(content_config.packaged_snapshot())
    value["revision"] = revision
    value["digest"] = contracts.content_hash(
        {
            "schema_version": value["schema_version"],
            "revision": revision,
            "files": value["files"],
        }
    )
    return content_config.validate_snapshot(value)


@pytest.fixture
def seeded(tmp_path: pathlib.Path) -> config_sync.ConfigSync:
    sync = config_sync.ConfigSync(config_sync.SyncSettings(tmp_path))
    sync.seed()
    return sync


def source_for(
    value: dict, requests: list | None = None
) -> config_sync.GitHubSource:
    def handle(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        assert "authorization" not in request.headers
        if request.url.path.endswith("/git/ref/heads/published"):
            return httpx.Response(
                200, json={"object": {"type": "commit", "sha": SHA}}
            )
        assert request.url.path.endswith("/contents/bundle.json")
        assert request.url.params["ref"] == SHA
        assert request.headers["accept"] == "application/vnd.github.raw+json"
        return httpx.Response(200, json=value)

    return config_sync.GitHubSource(
        "ziyixi/newsletter", httpx.MockTransport(handle)
    )


def test_pull_resolves_one_commit_then_fetches_entire_validated_bundle(
    seeded: config_sync.ConfigSync,
):
    requests: list[httpx.Request] = []
    expected = bundle()
    seeded.source = source_for(expected, requests)
    report = seeded.once()
    assert report["error"] is None
    assert report["wanted_commit"] == SHA
    assert report["active_revision"] == SHA
    assert report["active_digest"] == expected["digest"]
    assert content_config.load_active(seeded.root) == expected
    assert len(requests) == 2
    assert all(request.url.host == "api.github.com" for request in requests)
    assert SECRET not in json.dumps(report)


def test_identical_digest_does_not_reinstall(
    seeded: config_sync.ConfigSync, monkeypatch
):
    seeded.source = source_for(bundle())
    seeded.once()
    install = mock.Mock(
        side_effect=AssertionError("must not rewrite an identical release")
    )
    monkeypatch.setattr(content_config, "install_snapshot", install)
    assert seeded.once()["error"] is None
    install.assert_not_called()


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "CONFIG_GITHUB_ACCESS_OR_RATE_LIMIT"),
        (403, "CONFIG_GITHUB_ACCESS_OR_RATE_LIMIT"),
        (404, "CONFIG_GITHUB_REPOSITORY_OR_RELEASE_UNAVAILABLE"),
        (429, "CONFIG_GITHUB_UNAVAILABLE"),
        (500, "CONFIG_GITHUB_UNAVAILABLE"),
        (302, "CONFIG_GITHUB_UNAVAILABLE"),
    ],
)
def test_remote_errors_preserve_active_and_never_echo_response(
    seeded: config_sync.ConfigSync, status, code
):
    previous = content_config.load_active(seeded.root)
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(
            status,
            text=SECRET,
            headers={"Location": "https://evil.invalid/token"},
        )

    seeded.source = config_sync.GitHubSource(
        "ziyixi/newsletter", httpx.MockTransport(handle)
    )
    report = seeded.once()
    assert report["error"] == code
    assert content_config.load_active(seeded.root) == previous
    assert SECRET not in json.dumps(report)
    assert len(calls) == 1
    assert seeded.health()


def test_transport_failure_preserves_baseline(seeded: config_sync.ConfigSync):
    def handle(request):
        raise httpx.ConnectError(SECRET, request=request)

    seeded.source = config_sync.GitHubSource(
        "ziyixi/newsletter", httpx.MockTransport(handle)
    )
    assert seeded.once()["error"] == "CONFIG_GITHUB_NETWORK_ERROR"
    assert content_config.load_active(seeded.root)["revision"] == "packaged"


@pytest.mark.parametrize(
    "field,value",
    [
        ("schema_version", 999),
        ("digest", "0" * 64),
        ("revision", "../untrusted"),
    ],
)
def test_invalid_bundle_never_activates(
    seeded: config_sync.ConfigSync, field, value
):
    snapshot = bundle()
    snapshot[field] = value
    seeded.source = source_for(snapshot)
    report = seeded.once()
    assert report["error"] == "CONFIG_BUNDLE_INVALID"
    assert report["wanted_commit"] == SHA
    assert report["last_success"] is None
    assert content_config.load_active(seeded.root)["revision"] == "packaged"


@pytest.mark.parametrize(
    "payload",
    [
        [],
        None,
        {"object": None},
        {"object": {"sha": "main", "type": "commit"}},
        {"object": {"sha": SHA, "type": "tag"}},
    ],
)
def test_untrusted_ref_must_resolve_to_exact_commit(payload):
    source = config_sync.GitHubSource(
        "ziyixi/newsletter",
        httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
    )
    with pytest.raises(
        config_sync.SyncError, match="CONFIG_PUBLISHED_REF_INVALID"
    ):
        source.resolve()


def test_oversized_download_rejected_before_parsing(
    seeded: config_sync.ConfigSync, monkeypatch
):
    seeded.source = source_for(bundle())
    monkeypatch.setattr(config_sync, "MAX_BUNDLE_BYTES", 50)
    # _get's default is bound at definition time; exercise the explicit limit.
    with pytest.raises(
        config_sync.SyncError, match="CONFIG_DOWNLOAD_TOO_LARGE"
    ):
        seeded.source._get(
            "contents/bundle.json?ref=" + SHA, raw=True, limit=50
        )


@pytest.mark.parametrize(
    "raw",
    [
        '{"object":{"sha":"' + SHA + '","type":"commit","type":"commit"}}',
        "[" * 2000 + "]" * 2000,
    ],
)
def test_ambiguous_or_deep_json_is_a_safe_failure(raw):
    source = config_sync.GitHubSource(
        "ziyixi/newsletter",
        httpx.MockTransport(lambda _: httpx.Response(200, text=raw)),
    )
    with pytest.raises(
        config_sync.SyncError, match="CONFIG_PUBLISHED_REF_INVALID"
    ):
        source.resolve()
    with pytest.raises(config_sync.SyncError, match="CONFIG_BUNDLE_INVALID"):
        source.fetch(SHA)


def test_duplicate_bundle_fields_cannot_bypass_validation():
    value = json.dumps(bundle())
    ambiguous = value[:-1] + ',"schema_version":1}'
    source = config_sync.GitHubSource(
        "ziyixi/newsletter",
        httpx.MockTransport(lambda _: httpx.Response(200, text=ambiguous)),
    )
    with pytest.raises(config_sync.SyncError, match="CONFIG_BUNDLE_INVALID"):
        source.fetch(SHA)


def test_pin_rolls_back_and_survives_restart_without_any_github_request(
    seeded: config_sync.ConfigSync,
):
    old_digest = content_config.load_active(seeded.root)["digest"]
    seeded.source = source_for(bundle())
    seeded.once()
    assert seeded.pin(old_digest)["active_revision"] == "packaged"
    restarted = config_sync.ConfigSync(
        config_sync.SyncSettings(seeded.root),
        mock.Mock(side_effect=AssertionError("no network")),
    )
    report = restarted.once()
    assert report["pinned_digest"] == old_digest
    assert report["active_digest"] == old_digest
    assert report["error"] is None


def test_unpin_keeps_current_release_until_next_valid_pull(
    seeded: config_sync.ConfigSync,
):
    old_digest = content_config.load_active(seeded.root)["digest"]
    seeded.pin()
    seeded.source = source_for(bundle())
    report = seeded.unpin()
    assert report["pinned_digest"] is None
    assert report["active_digest"] == old_digest
    assert seeded.once()["active_revision"] == SHA


def test_crash_after_pin_intent_is_completed_locally(
    seeded: config_sync.ConfigSync,
):
    old_digest = content_config.load_active(seeded.root)["digest"]
    seeded.source = source_for(bundle())
    seeded.once()
    config_sync._atomic_json(seeded.root / "pin.json", {"digest": old_digest})
    seeded.source = mock.Mock()
    assert seeded.once()["active_digest"] == old_digest
    seeded.source.resolve.assert_not_called()


@pytest.mark.parametrize("digest", ["../bundle", "a" * 40, "f" * 64])
def test_pin_requires_existing_validated_local_release(
    seeded: config_sync.ConfigSync, digest
):
    old = content_config.load_active(seeded.root)
    with pytest.raises(config_sync.SyncError):
        seeded.pin(digest)
    assert content_config.load_active(seeded.root) == old
    assert not (seeded.root / "pin.json").exists()


def test_missing_baseline_requires_explicit_seed(tmp_path: pathlib.Path):
    sync = config_sync.ConfigSync(
        config_sync.SyncSettings(tmp_path), mock.Mock()
    )
    with pytest.raises(
        config_sync.SyncError, match="CONFIG_BASELINE_MISSING_OR_INVALID"
    ):
        sync.once()
    sync.source.resolve.assert_not_called()
    assert not (tmp_path / "active.json").exists()
    sync.seed()
    with pytest.raises(
        config_sync.SyncError, match="CONFIG_ALREADY_INITIALIZED"
    ):
        sync.seed()


def test_status_is_read_only_and_does_not_call_providers(
    seeded: config_sync.ConfigSync, monkeypatch
):
    before = {
        str(path): path.stat().st_mtime_ns for path in seeded.root.rglob("*")
    }
    monkeypatch.setattr(
        config_sync,
        "_writer_lock",
        mock.Mock(side_effect=AssertionError("no writes")),
    )
    seeded.source = mock.Mock()
    assert seeded.status()["active_revision"] == "packaged"
    after = {
        str(path): path.stat().st_mtime_ns for path in seeded.root.rglob("*")
    }
    assert after == before
    seeded.source.resolve.assert_not_called()


def test_seed_does_not_open_sqlite_launch_models_or_call_http(
    tmp_path: pathlib.Path, monkeypatch
):
    denied = mock.Mock(
        side_effect=AssertionError(
            "configuration must not run service operations"
        )
    )
    monkeypatch.setattr(sqlite3, "connect", denied)
    monkeypatch.setattr(subprocess, "Popen", denied)
    monkeypatch.setattr(httpx.Client, "send", denied)
    sync = config_sync.ConfigSync(config_sync.SyncSettings(tmp_path))
    assert sync.seed()["active_revision"] == "packaged"
    assert sync.status()["active_revision"] == "packaged"
    assert not list(tmp_path.rglob("*.sqlite3"))
    denied.assert_not_called()


def test_concurrent_writer_does_not_race_pin_or_activation(
    seeded: config_sync.ConfigSync,
):
    with config_sync._writer_lock(seeded.root):
        for operation in (seeded.once, seeded.pin, seeded.unpin):
            with pytest.raises(
                config_sync.SyncError, match="CONFIG_WRITER_BUSY"
            ):
                operation()


def test_health_requires_initialized_store_and_recent_poll(
    seeded: config_sync.ConfigSync, monkeypatch
):
    assert not seeded.health()
    seeded.source = source_for(bundle())
    monkeypatch.setattr(config_sync.time, "time", lambda: 1000.0)
    seeded.once()
    assert seeded.health()
    monkeypatch.setattr(config_sync.time, "time", lambda: 2200.0)
    assert not seeded.health()


def test_anonymous_client_does_not_inherit_credentials_or_proxy_environment(
    seeded: config_sync.ConfigSync, monkeypatch
):
    monkeypatch.setenv("GITHUB_TOKEN", SECRET)
    monkeypatch.setenv("NEWSLETTER_CONFIG_GITHUB_TOKEN", SECRET)
    monkeypatch.setenv("HTTPS_PROXY", "http://untrusted.invalid:8080")
    requests = []
    seeded.source = source_for(bundle(), requests)
    assert seeded.once()["error"] is None
    assert all("authorization" not in request.headers for request in requests)


@pytest.mark.parametrize(
    "name,value,code",
    [
        (
            "NEWSLETTER_CONTENT_CONFIG_DIR",
            "relative/path",
            "CONFIG_DIRECTORY_REQUIRED",
        ),
        (
            "NEWSLETTER_CONFIG_REPOSITORY",
            "https://evil.invalid/private",
            "CONFIG_REPOSITORY_INVALID",
        ),
        ("NEWSLETTER_CONFIG_POLL_SECONDS", SECRET, "CONFIG_INTERVAL_INVALID"),
        ("NEWSLETTER_CONFIG_POLL_SECONDS", "0", "CONFIG_INTERVAL_INVALID"),
        ("NEWSLETTER_CONFIG_POLL_SECONDS", "86401", "CONFIG_INTERVAL_INVALID"),
    ],
)
def test_invalid_settings_never_echo_raw_values(
    tmp_path: pathlib.Path, monkeypatch, name, value, code
):
    monkeypatch.setenv("NEWSLETTER_CONTENT_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv(name, value)
    with pytest.raises(config_sync.SyncError, match=code) as caught:
        config_sync.SyncSettings.from_env()
    assert value not in str(caught.value)


def test_symlinked_store_and_journal_are_rejected(tmp_path: pathlib.Path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(
        config_sync.SyncError, match="CONFIG_DIRECTORY_REQUIRED"
    ):
        config_sync.ConfigSync(config_sync.SyncSettings(link)).seed()
    (real / ".sync.lock").symlink_to(tmp_path / "outside")
    with pytest.raises(OSError, match=r"\.sync\.lock") as failure:
        config_sync.ConfigSync(config_sync.SyncSettings(real)).seed()
    assert failure.value.errno == errno.ELOOP
    assert not (tmp_path / "outside").exists()


def test_cli_error_does_not_dump_arbitrary_exception(
    tmp_path: pathlib.Path, monkeypatch, capsys
):
    monkeypatch.setenv("NEWSLETTER_CONTENT_CONFIG_DIR", str(tmp_path))
    monkeypatch.setattr(config_sync.sys, "argv", ["config-sync", "seed"])
    monkeypatch.setattr(
        content_config,
        "install_snapshot",
        mock.Mock(side_effect=ValueError(SECRET)),
    )
    with pytest.raises(SystemExit) as caught:
        config_sync.main()
    assert caught.value.code == 1
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err
    assert "CONFIG_LOCAL_STATE_INVALID" in captured.err
