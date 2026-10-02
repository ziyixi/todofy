"""Maintenance owns the same lock and preserves normal delivery receipts."""

import argparse
import asyncio
import json
import subprocess
import sys

import pytest

import newsletter.adapters as adapters
import newsletter.admin as admin
import newsletter.delivery as delivery
import newsletter.editor as editor
import newsletter.ownership as ownership
import newsletter.settings as settings
import newsletter.store as store
import newsletter.worker as worker


@pytest.fixture
def configured(tmp_path):
    return settings.Settings(
        data_dir=tmp_path / "service",
        editor_token="e" * 32,
        send_token="s" * 32,
    )


def _ready(database, directory, key):
    packet = database.put_packet(
        {
            "request_key": "source",
            "workflow_id": "offline",
            "content": {
                "title": "Fixture",
                "body": "Offline only",
                "sources": [
                    {
                        "id": "source",
                        "title": "Synthetic",
                        "url": "https://example.org/source",
                        "excerpt": "Synthetic source",
                        "access_scope": "full_text",
                    }
                ],
            },
        }
    )
    queued = database.prepare(
        {
            "request_key": key,
            "issue_date": "2026-09-05",
            "packet_ids": [packet["id"]],
        }
    )
    service_worker = worker.Worker(
        database,
        editor.MockEditor(),
        adapters.DisabledNotion(),
        directory / "jobs",
        30,
    )
    asyncio.run(service_worker.step())
    result = database.get(queued["id"])
    assert result["state"] == "ready"
    return result


def _approval(edition, key):
    return {
        "id": edition["id"],
        "request_key": key,
        "expected_render_hash": edition["rendered"]["render_hash"],
    }


def _args(edition):
    return argparse.Namespace(
        operation="send-verification",
        edition_id=edition["id"],
        request_key="explicit-verification",
        expected_render_hash=edition["rendered"]["render_hash"],
        after_verification=None,
    )


def test_status_missing_database_does_not_initialize_it(tmp_path):
    with pytest.raises(Exception, match="unable to open"):
        admin.status(tmp_path)
    assert not list(tmp_path.iterdir())


def test_exclusive_maintenance_preserves_daily_send_and_rejects_active_service(
    configured,
):
    database = store.Store(configured.data_dir / "newsletter.sqlite3", "mock")
    database.bind_delivery_target({"backend": "fake", "from": "", "to": ""})
    mail = adapters.FakeMail(configured.data_dir / "outbox")
    original = _ready(database, configured.data_dir, "original")
    asyncio.run(
        delivery.send_edition(
            database,
            mail,
            _approval(original, "normal"),
            real_delivery=False,
        )
    )
    corrected = _ready(database, configured.data_dir, "corrected")
    old_receipt = tuple(database.db.execute("SELECT * FROM sends").fetchone())
    database.close()
    assert not admin.status(configured.data_dir)["busy"]
    with (
        ownership.exclusive_store(configured.data_dir),
        pytest.raises(RuntimeError, match="data is busy"),
    ):
        admin.execute(_args(corrected), configured)
    first = admin.execute(_args(corrected), configured)
    second = admin.execute(_args(corrected), configured)
    assert first == second
    assert first["delivery_state"] == "simulated"
    reopened = store.Store(configured.data_dir / "newsletter.sqlite3", "mock")
    try:
        assert (
            tuple(reopened.db.execute("SELECT * FROM sends").fetchone())
            == old_receipt
        )
        assert (
            reopened.db.execute(
                "SELECT COUNT(*) FROM verification_sends"
            ).fetchone()[0]
            == 1
        )
    finally:
        reopened.close()
    assert len(list((configured.data_dir / "outbox").glob("*.eml"))) == 2


@pytest.mark.parametrize(
    "fatal", [KeyboardInterrupt, SystemExit, asyncio.CancelledError]
)
def test_delivery_termination_records_unknown_and_propagates(configured, fatal):
    class InterruptedMail:
        calls = 0

        async def send(self, edition, key):
            self.calls += 1
            raise fatal()

    mail = InterruptedMail()
    database = store.Store(configured.data_dir / "newsletter.sqlite3", "mock")
    edition = _ready(database, configured.data_dir, "interrupted")
    request = _approval(edition, "send")
    with pytest.raises(fatal):
        asyncio.run(
            delivery.send_edition(database, mail, request, real_delivery=False)
        )
    assert database.get(edition["id"])["delivery_state"] == "unknown"
    database.close()
    reopened = store.Store(configured.data_dir / "newsletter.sqlite3", "mock")
    try:
        reopened.recover()
        result = asyncio.run(
            delivery.send_edition(reopened, mail, request, real_delivery=False)
        )
        assert result["delivery_state"] == "unknown"
        assert mail.calls == 1
    finally:
        reopened.close()


def test_cli_surface_and_read_only_status(configured):
    database = store.Store(configured.data_dir / "newsletter.sqlite3", "mock")
    database.close()
    env = {
        "NEWSLETTER_DATA_DIR": str(configured.data_dir),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    result = subprocess.run(
        [sys.executable, "-m", "newsletter.cli", "admin", "status"],
        env=env,
        text=True,
        capture_output=True,
        check=True,
        timeout=15,
    )
    assert json.loads(result.stdout)["busy"] is False
    for command in ("ingest", "inbox", "prepare", "render"):
        result = subprocess.run(
            [sys.executable, "-m", "newsletter.cli", "admin", command],
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
        )
        assert result.returncode == 2
