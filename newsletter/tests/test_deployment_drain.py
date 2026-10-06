"""Deployment races and uncertainty use only synthetic local state."""

import argparse
import asyncio
import concurrent.futures as futures
import contextlib
import copy
import importlib.resources as resources
import importlib.util as util
import io
import json
import pathlib
import subprocess
import threading
import types
import urllib.error as url_error

import fastapi.testclient as testclient
import pytest

import newsletter.adapters as adapters
import newsletter.app as application
import newsletter.delivery as delivery
import newsletter.deployment_client as client
import newsletter.drain as drain
import newsletter.editor as editor
import newsletter.notion_journal as notion_journal
import newsletter.notion_sync as notion_sync
import newsletter.ownership as ownership
import newsletter.settings as settings
import newsletter.store as storage
import newsletter.worker as worker
import tests.support.editor as editor_support


@pytest.fixture
def store(tmp_path):
    database = storage.Store(tmp_path / "newsletter.sqlite3", "mock")
    yield database
    database.close()


def queued(database, key="edition"):
    request = json.loads(
        resources.files("newsletter")
        .joinpath("fixtures/packets.json")
        .read_text()
    )[0]
    packet = database.put_packet(request)
    return database.prepare(
        {
            "request_key": key,
            "issue_date": "2026-09-05",
            "packet_ids": [packet["id"]],
        }
    )


class ExecutingEditor:
    """Spend one real SDK request inside the worker's edition activity."""

    def __init__(self, live):
        self.live = live

    async def prepare(self, packets, issue_date, workspace):
        workspace.mkdir(parents=True, exist_ok=True)
        await self.live.execute("{}", {}, "Synthetic policy.", workspace)
        raise AssertionError("The synthetic turn must not complete")


def service_worker(database, tmp_path):
    return worker.Worker(
        database,
        editor.MockEditor(),
        adapters.DisabledNotion(),
        tmp_path / "jobs",
        30,
    )


def drain_history(database):
    return {
        table: [
            tuple(row)
            for row in database.db.execute(f"SELECT * FROM {table} ORDER BY id")
        ]
        for table in ("deployment_activities", "packets", "editions")
    }


def repair_gate_at(tmp_path, monkeypatch):
    path = pathlib.Path(__file__).resolve().parents[2]
    path /= "tools/vps-bootstrap/repair_gate.py"
    spec = util.spec_from_file_location("newsletter_test_repair_gate", path)
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(
        module,
        "Path",
        lambda value: (
            tmp_path if value == "/var/lib/newsletter" else pathlib.Path(value)
        ),
    )
    monkeypatch.setattr(module.sys, "argv", ["repair-gate", "a" * 40, "b" * 40])
    return module


def test_duplicate_begin_freeze_resume_and_stale_key(store):
    gate = store.deployment
    original = gate.begin("release-1")
    assert original["state"] == "draining"
    assert gate.begin("release-1") == original
    with pytest.raises(drain.DrainError, match="deployment_conflict"):
        gate.begin("release-2")
    frozen = gate.freeze("release-1")
    assert gate.freeze("release-1") == frozen
    assert frozen["state"] == "frozen"
    assert gate.resume("release-1")["state"] == "resumed"
    assert gate.resume("release-1")["state"] == "resumed"
    assert gate.begin("release-1")["state"] == "resumed"
    assert gate.status()["state"] == "active"
    gate.begin("release-2")
    with pytest.raises(drain.DrainError, match="deployment_conflict"):
        gate.resume("release-1")
    assert gate.status()["request_key"] == "release-2"


def test_admission_and_begin_are_atomic_under_concurrency(store):
    for index in range(12):
        ready = threading.Barrier(2)
        held = threading.Event()
        released = threading.Event()

        def admit(ready=ready, held=held, released=released):
            ready.wait(timeout=5)
            with store.deployment.activity("test", required=False) as allowed:
                held.set()
                released.wait(timeout=5)
                return allowed

        with futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(admit)
            ready.wait(timeout=5)
            store.deployment.begin(str(index))
            assert held.wait(timeout=5)
            with store.deployment.activity("later", required=False) as allowed:
                assert not allowed
            busy = store.deployment.status()["busy"]
            if busy:
                with pytest.raises(drain.DrainError, match="deployment_busy"):
                    store.deployment.freeze(str(index))
            released.set()
            admitted = pending.result(timeout=5)
            assert busy is admitted
            store.deployment.freeze(str(index))
            store.deployment.resume(str(index))


async def test_queue_stays_frozen_and_worker_resumes(store, tmp_path):
    edition = queued(store)
    background = service_worker(store, tmp_path)
    store.deployment.begin("release")
    assert not await background.step()
    assert store.get(edition["id"])["state"] == "queued"
    frozen = store.deployment.freeze("release")
    assert frozen["queued"]["editions"] == 1
    store.deployment.resume("release")
    assert await background.step()
    assert store.get(edition["id"])["state"] == "ready"


async def test_active_worker_finishes_before_freeze(
    store, tmp_path, monkeypatch
):
    edition = queued(store)
    background = service_worker(store, tmp_path)
    entered, finish = asyncio.Event(), asyncio.Event()

    async def prepare(value, packets):
        entered.set()
        await finish.wait()
        store.finish(value["id"], state="failed", error_code="synthetic")

    monkeypatch.setattr(background, "prepare", prepare)
    pending = asyncio.create_task(background.step())
    await entered.wait()
    store.deployment.begin("release")
    with pytest.raises(drain.DrainError, match="deployment_busy"):
        store.deployment.freeze("release")
    finish.set()
    assert await pending
    assert store.get(edition["id"])["state"] == "failed"
    assert store.deployment.freeze("release")["busy"] is False


async def test_send_finishes_then_unknown_is_preserved(store, tmp_path):
    edition = queued(store)
    assert await service_worker(store, tmp_path).step()
    edition = store.get(edition["id"])
    entered, finish = asyncio.Event(), asyncio.Event()

    class AmbiguousMail:
        async def send(self, value, key):
            entered.set()
            await finish.wait()
            raise adapters.AdapterError("synthetic_unknown", ambiguous=True)

    approval = {
        "id": edition["id"],
        "request_key": "send",
        "expected_render_hash": edition["rendered"]["render_hash"],
    }
    pending = asyncio.create_task(
        delivery.send_edition(
            store, AmbiguousMail(), approval, real_delivery=False
        )
    )
    await entered.wait()
    store.deployment.begin("release")
    with pytest.raises(drain.DrainError, match="deployment_busy"):
        store.deployment.freeze("release")
    finish.set()
    assert (await pending)["delivery_state"] == "unknown"
    frozen = store.deployment.freeze("release")
    assert frozen["unknown"]["delivery"] == 1
    store.deployment.resume("release")
    repeated = await delivery.send_edition(
        store, AmbiguousMail(), approval, real_delivery=False
    )
    assert repeated["delivery_state"] == "unknown"


def test_cancel_requires_exclusive_restart_recovery(store):
    def cancelled():
        with store.deployment.activity("model"):
            store.deployment.begin("release")
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        cancelled()
    with pytest.raises(drain.DrainError, match="deployment_busy"):
        store.deployment.freeze("release")
    # Production calls recover only while it owns the process lock at startup.
    store.deployment.recover()
    frozen = store.deployment.freeze("release")
    assert frozen["unknown"]["interrupted_activities"] == 1


def test_resume_preserves_interrupted_history_across_releases_and_restart(
    tmp_path,
):
    path = tmp_path / "newsletter.sqlite3"
    with contextlib.closing(storage.Store(path, "mock")) as database:
        edition = queued(database)
        database.finish(edition["id"], state="failed", delivery_state="unknown")
        database.db.execute("UPDATE packets SET projection='unknown'")
        database.db.executemany(
            "INSERT INTO deployment_activities VALUES (?,?,'interrupted')",
            [(f"historical-{index}", "model") for index in range(32)],
        )
        previous = drain_history(database)
        gate = database.deployment
        gate.begin("release-1")
        frozen = gate.freeze("release-1")
        assert frozen["busy"] is False
        assert frozen["inflight"]["activities"] == 0
        assert frozen["unknown"]["interrupted_activities"] == 32
        assert frozen["unknown"]["delivery"] == 1
        assert frozen["unknown"]["packets"] == 1

        resumed = gate.resume("release-1")
        assert resumed["state"] == "resumed"
        assert resumed["unknown"] == frozen["unknown"]
        assert drain_history(database) == previous
        assert gate.resume("release-1") == resumed
        assert gate.status()["state"] == "active"
        # Admission allows new local work; no Worker or provider is invoked.
        with gate.activity("new-local-work") as allowed:
            assert allowed
        assert drain_history(database) == previous

        gate.begin("release-2")
        following = gate.freeze("release-2")
        assert following["busy"] is False
        assert following["unknown"] == frozen["unknown"]
        assert drain_history(database) == previous

    with contextlib.closing(storage.Store(path, "mock")) as database:
        database.recover()
        database.deployment.recover()
        assert drain_history(database) == previous
        assert database.deployment.freeze("release-2") == following
        resumed = database.deployment.resume("release-2")
        assert resumed["unknown"] == frozen["unknown"]
        assert drain_history(database) == previous


def test_repair_gate_main_uses_real_store_without_replaying_history(
    tmp_path, monkeypatch, capsys
):
    path = tmp_path / "newsletter.sqlite3"
    with contextlib.closing(storage.Store(path, "live")) as database:
        edition = queued(database, "historical")
        database.finish(edition["id"], state="failed", delivery_state="unknown")
        queued(database, "new-work")
        database.db.execute("UPDATE packets SET projection='unknown'")
        database.db.executemany(
            "INSERT INTO deployment_activities VALUES (?,?,'interrupted')",
            [(f"historical-{index}", "model") for index in range(32)],
        )
        database.deployment.begin("release-" + "a" * 40)
        before = database.deployment.freeze("release-" + "a" * 40)
        previous = drain_history(database)
    repair = repair_gate_at(tmp_path, monkeypatch)

    def forbidden(*args, **kwargs):
        pytest.fail("Repair must not spawn a provider or background worker")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(asyncio, "create_task", forbidden)
    repair.main()
    receipt = json.loads(capsys.readouterr().out)
    assert receipt == {
        "version": 1,
        "state": "frozen",
        "request_key": "release-" + "b" * 40,
        "unknown": before["unknown"],
        "queued": before["queued"],
    }
    assert receipt["unknown"]["interrupted_activities"] == 32
    assert receipt["queued"]["editions"] == 1
    # The entry point closed its Store and released the actual service lock.
    with (
        ownership.exclusive_store(tmp_path),
        contextlib.closing(storage.Store(path, "live")) as database,
    ):
        assert drain_history(database) == previous
        assert database.deployment.status()["state"] == "frozen"
    repair.main()
    assert json.loads(capsys.readouterr().out) == receipt


def test_repair_gate_main_refuses_an_existing_real_owner(
    tmp_path, monkeypatch, capsys
):
    path = tmp_path / "newsletter.sqlite3"
    with contextlib.closing(storage.Store(path, "live")) as database:
        queued(database)
        database.deployment.begin("release-" + "a" * 40)
        before = database.deployment.freeze("release-" + "a" * 40)
        previous = drain_history(database)
    repair = repair_gate_at(tmp_path, monkeypatch)
    with ownership.exclusive_store(tmp_path):
        with pytest.raises(RuntimeError, match="Newsletter data is busy"):
            repair.main()
        assert capsys.readouterr().out == ""
    with contextlib.closing(storage.Store(path, "live")) as database:
        assert database.deployment.status() == before
        assert drain_history(database) == previous


def test_restart_keeps_gate_and_provider_ledgers_fail_closed(tmp_path):
    path = tmp_path / "newsletter.sqlite3"
    with contextlib.closing(storage.Store(path, "mock")) as database:
        edition = queued(database)
        database.finish(edition["id"], delivery_state="submitting")
        database.deployment.begin("release")
        with pytest.raises(drain.DrainError, match="deployment_busy"):
            database.deployment.freeze("release")
    with contextlib.closing(storage.Store(path, "mock")) as database:
        database.recover()
        database.deployment.recover()
        assert database.deployment.status()["state"] == "draining"
        frozen = database.deployment.freeze("release")
        assert frozen["unknown"]["delivery"] == 1
    with contextlib.closing(storage.Store(path, "mock")) as database:
        assert database.deployment.freeze("release") == frozen
        with database.deployment.activity("worker", required=False) as allowed:
            assert not allowed


def test_http_auth_strict_body_and_all_new_admission(tmp_path):
    configuration = settings.Settings(
        data_dir=tmp_path,
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    path = "/internal/deployment/drain"
    auth = {"Authorization": "Bearer " + "s" * 32}
    edit = {"Authorization": "Bearer " + "e" * 32}
    with testclient.TestClient(
        application.create_app(configuration, start_worker=False)
    ) as http:
        assert http.get(path).status_code == 401
        assert (
            http.post(path + "/begin", json={}, headers=edit).status_code == 401
        )
        assert (
            http.post(path + "/begin", content="{}", headers=auth).status_code
            == 415
        )
        for body in (
            {},
            {"request_key": 1},
            {"request_key": "a", "extra": True},
        ):
            assert (
                http.post(path + "/begin", json=body, headers=auth).status_code
                == 400
            )
        for body in (
            '{"request_key":"a","request_key":"b"}',
            '{"request_key":"é"}',
        ):
            assert (
                http.post(
                    path + "/begin",
                    content=body,
                    headers={**auth, "Content-Type": "application/json"},
                ).status_code
                == 400
            )
        assert (
            http.post(
                path + "/begin",
                content="x" * 1025,
                headers={**auth, "Content-Type": "application/json"},
            ).status_code
            == 413
        )
        assert (
            http.post(
                path + "/other", json={"request_key": "a"}, headers=auth
            ).status_code
            == 404
        )
        assert (
            http.post(
                path + "/begin", json={"request_key": "release"}, headers=auth
            ).json()["state"]
            == "draining"
        )
        new_run = http.post(
            "/v1/runs",
            json={"request_key": "run", "issue_date": "2026-09-05"},
            headers=edit,
        )
        assert new_run.status_code == 503
        assert new_run.json() == {"error": "deployment_draining"}
        assert new_run.headers["Retry-After"] == "30"
        assert http.get("/healthz").status_code == 200
        assert (
            http.get(path, headers=auth).headers["Cache-Control"] == "no-store"
        )
        assert (
            http.post(
                path + "/freeze", json={"request_key": "release"}, headers=auth
            ).json()["state"]
            == "frozen"
        )
        assert (
            http.post(
                path + "/resume", json={"request_key": "release"}, headers=auth
            ).json()["state"]
            == "resumed"
        )
        assert (
            http.post(
                "/v1/runs",
                json={"request_key": "run", "issue_date": "2026-09-05"},
                headers=edit,
            ).status_code
            == 202
        )


def test_cli_poll_timeout_does_not_resume(monkeypatch):
    invoked = []

    def busy(action, key):
        invoked.append((action, key))
        raise url_error.HTTPError(
            "https://synthetic.invalid",
            409,
            "busy",
            {},
            io.BytesIO(b'{"error":"deployment_busy"}'),
        )

    clock = iter((0, 1))
    monkeypatch.setattr(client, "call", busy)
    monkeypatch.setattr(client.time, "monotonic", lambda: next(clock))
    with pytest.raises(TimeoutError, match="remains held"):
        client.execute(
            argparse.Namespace(
                action="freeze", request_key="release", wait=True, timeout=0.5
            )
        )
    assert invoked == [("freeze", "release")]


def test_cli_poll_retries_only_busy(monkeypatch):
    calls = []

    def transient(action, key):
        calls.append(action)
        if len(calls) == 1:
            raise url_error.HTTPError(
                "https://synthetic.invalid",
                409,
                "busy",
                {},
                io.BytesIO(b'{"error":"deployment_busy"}'),
            )
        return {"version": 1, "state": "frozen"}

    monkeypatch.setattr(client, "call", transient)
    monkeypatch.setattr(client.time, "sleep", lambda _: None)
    assert (
        client.execute(
            argparse.Namespace(
                action="freeze", request_key="release", wait=True, timeout=1
            )
        )["state"]
        == "frozen"
    )
    assert calls == ["freeze", "freeze"]


@pytest.mark.parametrize(
    "field,bad",
    [
        ("version", True),
        ("version", 2),
        ("request_key", "another-release"),
        ("request_key", None),
        ("state", "draining"),
        ("state", "resumed"),
        ("state", []),
        ("busy", 0),
        ("busy", True),
        ("queued", {}),
        ("unknown", []),
        ("inflight", {}),
    ],
)
def test_wire_freeze_response_rejects_malformed_200(
    store, monkeypatch, field, bad
):
    store.deployment.begin("release")
    value = store.deployment.freeze("release")
    value[field] = bad
    monkeypatch.setenv("NEWSLETTER_SEND_TOKEN", "synthetic-private-token")
    opener = types.SimpleNamespace(
        open=lambda *args, **kwargs: io.BytesIO(json.dumps(value).encode())
    )
    monkeypatch.setattr(client.request, "build_opener", lambda *args: opener)
    with pytest.raises(ValueError, match=r"[Dd]eployment|operation|Frozen"):
        client.call("freeze", "release")


@pytest.mark.parametrize("section", ["inflight", "unknown", "queued"])
@pytest.mark.parametrize("count", [-1, True, 1.5, "0"])
def test_wire_response_requires_nonnegative_integer_counts(
    store, monkeypatch, section, count
):
    store.deployment.begin("release")
    value = store.deployment.freeze("release")
    first = next(iter(value[section]))
    value[section][first] = count
    monkeypatch.setenv("NEWSLETTER_SEND_TOKEN", "synthetic-private-token")
    opener = types.SimpleNamespace(
        open=lambda *args, **kwargs: io.BytesIO(json.dumps(value).encode())
    )
    monkeypatch.setattr(client.request, "build_opener", lambda *args: opener)
    with pytest.raises(ValueError, match="counts"):
        client.call("freeze", "release")


def test_response_rejects_extra_content_and_resumed_begin(store):
    assert client.validate_response(store.deployment.status(), "status", None)
    store.deployment.begin("release")
    frozen = store.deployment.freeze("release")
    assert client.validate_response(frozen, "freeze", "release") == frozen
    value = copy.deepcopy(frozen)
    value["content"] = "Synthetic private body must not be accepted"
    with pytest.raises(ValueError, match="response"):
        client.validate_response(value, "freeze", "release")
    store.deployment.resume("release")
    resumed = store.deployment.begin("release")
    with pytest.raises(ValueError, match="acknowledgement"):
        client.validate_response(resumed, "begin", "release")


@pytest.mark.parametrize(
    "table,predicate",
    [
        ("workflow_attempts", "state='running'"),
        ("notion_entities", "create_state='creating'"),
        ("notion_versions", "state='appending'"),
    ],
)
def test_freeze_checks_provider_ledgers_without_activity(
    store, table, predicate
):
    column, state = predicate.split("=")
    store.db.execute(f"CREATE TABLE {table} ({column} TEXT NOT NULL)")
    store.db.execute(f"INSERT INTO {table} VALUES ({state})")
    store.deployment.begin("release")
    with pytest.raises(drain.DrainError, match="deployment_busy"):
        store.deployment.freeze("release")


async def test_notion_patch_is_tracked_even_without_submitting_row(store):
    journal = notion_journal.NotionJournal(
        store, {"materials": "synthetic", "editions": "synthetic"}
    )
    journal.execute(
        "INSERT INTO notion_entities "
        "(key,kind,page_id,create_state,properties) "
        "VALUES ('synthetic','material','page','ready','{}')"
    )
    entered, finish = asyncio.Event(), asyncio.Event()
    calls = []

    class Workspace:
        async def patch(self, kind, page, properties):
            calls.append(page)
            entered.set()
            await finish.wait()

    consumer = notion_sync.NotionSync(
        journal, Workspace(), include_personal=False
    )
    pending = asyncio.create_task(consumer.step())
    await entered.wait()
    store.deployment.begin("release")
    assert store.deployment.status()["inflight"]["notion_entities"] == 0
    with pytest.raises(drain.DrainError, match="deployment_busy"):
        store.deployment.freeze("release")
    finish.set()
    assert await pending
    store.deployment.freeze("release")
    assert not await consumer.step()
    assert calls == ["page"]


def test_real_service_restart_keeps_frozen_gate(tmp_path):
    configuration = settings.Settings(
        data_dir=tmp_path,
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    auth = {"Authorization": "Bearer " + "s" * 32}
    path = "/internal/deployment/drain"
    body = {"request_key": "release"}
    with testclient.TestClient(application.create_app(configuration)) as http:
        assert (
            http.post(path + "/begin", json=body, headers=auth).status_code
            == 200
        )
        frozen = http.post(path + "/freeze", json=body, headers=auth).json()
        assert frozen["state"] == "frozen"
    with testclient.TestClient(application.create_app(configuration)) as http:
        assert http.get(path, headers=auth).json()["state"] == "frozen"
        assert (
            http.post(path + "/freeze", json=body, headers=auth).json()
            == frozen
        )
        assert (
            http.post(path + "/resume", json=body, headers=auth).json()["state"]
            == "resumed"
        )


@pytest.mark.parametrize("cleanup_error", [RuntimeError, TimeoutError])
async def test_sdk_timeout_and_failed_cleanup_hold_outer_worker_activity(
    tmp_path, fake_sdk, monkeypatch, cleanup_error
):
    path = tmp_path / "newsletter.sqlite3"
    with contextlib.closing(storage.Store(path, "live")) as database:
        edition = queued(database)
        fake_sdk.turn.hang = True
        fake_sdk.close_error = cleanup_error("synthetic cleanup failure")

        async def failed_interrupt():
            raise RuntimeError("synthetic interrupt failure")

        monkeypatch.setattr(fake_sdk.turn, "interrupt", failed_interrupt)
        background = worker.Worker(
            database,
            ExecutingEditor(
                editor_support.live_editor(tmp_path, timeout_seconds=0.03)
            ),
            adapters.DisabledNotion(),
            tmp_path / "jobs",
            30,
        )
        pending = asyncio.create_task(background.step())
        await fake_sdk.turn.started.wait()
        database.deployment.begin("release")
        assert await pending
        assert database.get(edition["id"])["state"] == "failed"
        assert not fake_sdk.closed
        assert database.deployment.status()["inflight"]["activities"] == 1
        with pytest.raises(drain.DrainError, match="deployment_busy"):
            database.deployment.freeze("release")
    # Old service ownership has ended; production also stops its child runtime.
    with contextlib.closing(storage.Store(path, "live")) as database:
        database.recover()
        database.deployment.recover()
        frozen = database.deployment.freeze("release")
        assert frozen["unknown"]["interrupted_activities"] == 1


async def test_outer_timeout_during_sdk_close_cannot_clear_uncertainty(
    tmp_path, fake_sdk
):
    with contextlib.closing(
        storage.Store(tmp_path / "newsletter.sqlite3", "live")
    ) as database:
        edition = queued(database)
        fake_sdk.turn.hang = True
        fake_sdk.close_hang = True
        background = worker.Worker(
            database,
            ExecutingEditor(
                editor_support.live_editor(tmp_path, timeout_seconds=0.03)
            ),
            adapters.DisabledNotion(),
            tmp_path / "jobs",
            0.1,
        )
        assert await background.step()
        assert database.get(edition["id"])["state"] == "failed"
        assert not fake_sdk.closed
        database.deployment.begin("release")
        with pytest.raises(drain.DrainError, match="deployment_busy"):
            database.deployment.freeze("release")
