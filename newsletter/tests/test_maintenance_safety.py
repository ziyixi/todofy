"""Offline maintenance, delivery-ledger and structural-boundary regressions."""

import argparse
import asyncio
import sqlite3

import pytest

import newsletter.adapters as adapters
import newsletter.admin as admin
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.delivery as delivery
import newsletter.ownership as ownership
import newsletter.settings as settings
import newsletter.store as store
import newsletter.worker as worker
import scripts.check_python_structure as structure
import tests.support.workflow_state as workflow_state


@pytest.fixture
def database(tmp_path):
    value = store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        yield value
    finally:
        value.close()


def _ready(database, key):
    packet = workflow_state.packet(database, key)
    edition = database.prepare(workflow_state.request(key, [packet]))
    rendered = {"html": "synthetic", "text": "synthetic", "chart_png": ""}
    return database.finish(
        edition["id"],
        state="ready",
        review={"passed": True, "findings": []},
        rendered={**rendered, "render_hash": contracts.content_hash(rendered)},
    )


def test_pending_queue_is_idle_but_running_or_submitting_work_is_busy(
    database, tmp_path
):
    packet = workflow_state.packet(database, "queued")
    edition = database.prepare(workflow_state.request("queued", [packet]))
    runs = repository.RunRepository(database)
    run = runs.start({"request_key": "queued", "issue_date": "2026-09-06"}, [])
    before = tuple(database.db.iterdump())
    assert admin.status(tmp_path)["busy"] is False
    assert tuple(database.db.iterdump()) == before
    assert database.get(edition["id"])["state"] == "queued"
    assert runs.get(run["id"])["state"] == "queued"
    database.finish(edition["id"], state="running")
    assert admin.status(tmp_path)["counts"]["editions"] == 1
    database.finish(edition["id"], state="queued", delivery_state="submitting")
    assert admin.status(tmp_path)["counts"]["delivery"] == 1


def test_busy_maintenance_refuses_before_opening_store_or_recovery(
    database, tmp_path, monkeypatch
):
    edition = _ready(database, "active")
    database.finish(edition["id"], delivery_state="submitting")

    def forbidden(*args, **kwargs):
        pytest.fail("Busy maintenance opened or recovered mutable state")

    monkeypatch.setattr(store.Store, "__init__", forbidden)
    monkeypatch.setattr(store.Store, "recover", forbidden)
    configured = settings.Settings(
        data_dir=tmp_path, editor_token="e" * 32, send_token="s" * 32
    )
    with pytest.raises(RuntimeError, match="active work"):
        admin.execute(argparse.Namespace(operation="retry-stories"), configured)
    assert database.get(edition["id"])["delivery_state"] == "submitting"


def test_verification_cli_never_recovers_or_constructs_a_worker(
    database, tmp_path, monkeypatch
):
    original = _ready(database, "original")
    database.reserve_send(workflow_state.approval(original, "normal"))
    database.finish(original["id"], delivery_state="simulated")
    corrected = _ready(database, "corrected")
    queued_packet = workflow_state.packet(database, "pending")
    pending = database.prepare(
        workflow_state.request("pending", [queued_packet])
    )
    sent = []

    class Mail:
        def __init__(self, directory):
            assert directory == tmp_path / "outbox"

        async def send(self, edition, key):
            sent.append((edition["id"], key))
            return {"delivery_state": "simulated", "provider_message_id": ""}

    def forbidden(*args, **kwargs):
        pytest.fail("Maintenance recovered state or constructed a worker")

    monkeypatch.setattr(adapters, "FakeMail", Mail)
    monkeypatch.setattr(store.Store, "recover", forbidden)
    monkeypatch.setattr(worker.Worker, "__init__", forbidden)
    configured = settings.Settings(
        data_dir=tmp_path, editor_token="e" * 32, send_token="s" * 32
    )
    args = argparse.Namespace(
        operation="send-verification",
        edition_id=corrected["id"],
        expected_render_hash=corrected["rendered"]["render_hash"],
        request_key="explicit-check",
        after_verification=None,
    )
    assert admin.execute(args, configured)["delivery_state"] == "simulated"
    assert admin.execute(args, configured)["delivery_state"] == "simulated"
    assert len(sent) == 1
    assert database.get(pending["id"])["state"] == "queued"
    assert database.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 1


async def test_concurrent_same_key_observes_reservation_without_second_send(
    database,
):
    class DelayedMail:
        def __init__(self):
            self.calls = 0
            self.started = asyncio.Event()
            self.finish = asyncio.Event()

        async def send(self, edition, key):
            self.calls += 1
            self.started.set()
            await self.finish.wait()
            return {"delivery_state": "simulated", "provider_message_id": ""}

    mail = DelayedMail()
    edition = _ready(database, "concurrent")
    approval = workflow_state.approval(edition, "same-key")
    first = asyncio.create_task(
        delivery.send_edition(database, mail, approval, real_delivery=False)
    )
    try:
        await asyncio.wait_for(mail.started.wait(), timeout=2)
        second = await delivery.send_edition(
            database, mail, approval, real_delivery=False
        )
        assert second["delivery_state"] == "submitting"
        assert mail.calls == 1
    finally:
        mail.finish.set()
        completed = await first
    assert completed["delivery_state"] == "simulated"


async def test_failed_receipt_persistence_cannot_resend_after_restart(
    tmp_path, monkeypatch, caplog
):
    class Mail:
        calls = 0

        async def send(self, edition, key):
            self.calls += 1
            return {"delivery_state": "simulated", "provider_message_id": ""}

    path = tmp_path / "newsletter.sqlite3"
    database = store.Store(path, "mock")
    mail = Mail()
    try:
        edition = _ready(database, "persist-failure")
        approval = workflow_state.approval(edition, "stable-key")

        def fail_finish(*args, **kwargs):
            raise sqlite3.OperationalError("private storage failure")

        monkeypatch.setattr(database, "finish", fail_finish)
        with pytest.raises(sqlite3.OperationalError, match="storage failure"):
            await delivery.send_edition(
                database, mail, approval, real_delivery=False
            )
        assert database.get(edition["id"])["delivery_state"] == "submitting"
        assert "private storage failure" not in caplog.text
    finally:
        database.close()
    reopened = store.Store(path, "mock")
    try:
        reopened.recover()
        result = await delivery.send_edition(
            reopened, mail, approval, real_delivery=False
        )
        assert result["delivery_state"] == "unknown"
        assert mail.calls == 1
    finally:
        reopened.close()


def test_ownership_rejects_symlink_without_reading_target(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    target = tmp_path / "unrelated-file"
    target.touch()
    before = target.stat()
    (data_dir / "service.lock").symlink_to(target)
    with (
        pytest.raises(OSError, match=r"symbolic links|Too many levels"),
        ownership.exclusive_store(data_dir),
    ):
        pytest.fail("Followed a symbolic service lock")
    after = target.stat()
    assert (before.st_ino, before.st_size, before.st_mtime_ns) == (
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    )


def test_ownership_retains_lock_inode_and_releases_after_exception(tmp_path):
    with ownership.exclusive_store(tmp_path):
        first = (tmp_path / "service.lock").stat().st_ino
        with (
            pytest.raises(RuntimeError, match="data is busy"),
            ownership.exclusive_store(tmp_path),
        ):
            pytest.fail("Accepted a second mutable owner")

    def interrupted_owner():
        with ownership.exclusive_store(tmp_path):
            raise ValueError("synthetic exit")

    with pytest.raises(ValueError, match="synthetic exit"):
        interrupted_owner()
    with ownership.exclusive_store(tmp_path):
        assert (tmp_path / "service.lock").stat().st_ino == first


@pytest.mark.parametrize(
    "source,filename,expected",
    [
        (
            "import newsletter._private as hidden",
            "src/newsletter/worker.py",
            {"PRIVATE_IMPORT"},
        ),
        (
            "import newsletter._codex_runtime",
            "src/newsletter/codex_runtime.py",
            set(),
        ),
        (
            "import newsletter._codex_runtime",
            "tests/test_codex_runtime.py",
            set(),
        ),
        (
            "import newsletter._other",
            "tests/test_codex_runtime.py",
            {"PRIVATE_IMPORT"},
        ),
        (
            "from newsletter.app import create_app",
            "src/newsletter/worker.py",
            {"MODULE_IMPORT", "LAYER"},
        ),
        (
            "from __future__ import annotations",
            "src/newsletter/worker.py",
            set(),
        ),
        (
            "import builtins\ntry:\n    f()\n"
            "except builtins.BaseException:\n    pass",
            "src/newsletter/worker.py",
            {"BASE_EXCEPTION"},
        ),
        (
            "import builtins as core\ntry:\n    f()\n"
            "except (ValueError, core.BaseException):\n    pass",
            "src/newsletter/worker.py",
            {"BASE_EXCEPTION"},
        ),
        (
            "import builtins as core\ntry:\n    f()\n"
            "except core.BaseException:\n    cleanup()\n    raise",
            "src/newsletter/worker.py",
            set(),
        ),
        (
            "from builtins import BaseException as Fatal\ntry:\n    f()\n"
            "except Fatal:\n    pass",
            "src/newsletter/worker.py",
            {"MODULE_IMPORT", "BASE_EXCEPTION"},
        ),
    ],
)
def test_structural_checker_closes_only_explicit_boundary_gaps(
    source, filename, expected
):
    findings = structure.inspect_source(
        source, filename=filename, modules={"newsletter.app"}
    )
    assert {finding.code for finding in findings} == expected
