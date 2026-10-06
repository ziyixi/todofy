"""Independent offline safety checks for the durable worker/store boundary."""

import asyncio
import concurrent.futures as futures
import json
import pathlib
import threading
import time

import fastapi.testclient as testclient
import pytest

import newsletter.adapters as adapters
import newsletter.app as app
import newsletter.editor as editor
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.worker as newsletter_worker


@pytest.fixture
def packet_request():
    return {
        "request_key": "edge-packet",
        "workflow_id": "edge-workflow",
        "content": {
            "title": "安全边界测试材料",
            "body": "这是一份离线模拟材料，不含真实新闻。",
            "sources": [
                {
                    "id": "source",
                    "title": "原始模拟来源",
                    "url": "https://example.org/original-fixture",
                    "excerpt": "仅用于离线测试。",
                    "access_scope": "full_text",
                }
            ],
            "tags": ["fixture"],
        },
    }


@pytest.fixture
def store(tmp_path):
    value = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        yield value
    finally:
        value.close()


def _queue(store, packet_request, key, issue_date="2026-09-05"):
    packet = store.put_packet(packet_request)
    edition = store.prepare(
        {
            "request_key": key,
            "issue_date": issue_date,
            "packet_ids": [packet["id"]],
        }
    )
    return edition, packet


def _approval(edition, key):
    return {
        "id": edition["id"],
        "request_key": key,
        "expected_render_hash": edition["rendered"]["render_hash"],
    }


@pytest.mark.asyncio
async def test_same_date_different_ready_edition_cannot_take_send_slot(
    store, packet_request, tmp_path
):
    first, _ = _queue(store, packet_request, "edition-one")
    second, _ = _queue(store, packet_request, "edition-two")
    worker = newsletter_worker.Worker(
        store,
        editor.MockEditor(),
        adapters.DisabledNotion(),
        tmp_path / "jobs",
        10,
    )
    assert await worker.step()
    assert await worker.step()
    first, second = store.get(first["id"]), store.get(second["id"])
    assert first["state"] == second["state"] == "ready"
    assert store.reserve_send(_approval(first, "send-one"))[1] is True

    with pytest.raises(newsletter_store.StoreError) as rejected:
        store.reserve_send(_approval(second, "send-two"))
    assert rejected.value.code == "conflict"
    assert store.get(first["id"])["delivery_state"] == "submitting"
    assert store.get(second["id"])["delivery_state"] == "not_requested"
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_cross_connection_send_reservation_has_one_winner(
    store, packet_request, tmp_path
):
    edition, _ = _queue(store, packet_request, "concurrent-edition")
    worker = newsletter_worker.Worker(
        store,
        editor.MockEditor(),
        adapters.DisabledNotion(),
        tmp_path / "jobs",
        10,
    )
    assert await worker.step()
    edition = store.get(edition["id"])
    workers = 6
    barrier = threading.Barrier(workers)

    def reserve(index):
        # Independent connections exercise SQLite transactions/constraints, not
        # merely the RLock around one Store object.
        peer = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
        try:
            barrier.wait(timeout=5)
            reserved, won = peer.reserve_send(
                _approval(edition, f"concurrent-send-{index}")
            )
            return reserved["id"], won
        finally:
            peer.close()

    def race():
        with futures.ThreadPoolExecutor(max_workers=workers) as executor:
            return list(executor.map(reserve, range(workers)))

    results = await asyncio.to_thread(race)
    assert all(identifier == edition["id"] for identifier, _ in results)
    assert sum(won for _, won in results) == 1
    assert store.db.execute("SELECT COUNT(*) FROM sends").fetchone()[0] == 1
    assert store.get(edition["id"])["delivery_state"] == "submitting"


@pytest.mark.asyncio
async def test_draft_cannot_cite_packets_outside_the_frozen_snapshot(
    store, packet_request, tmp_path
):
    # No shipped editor adds research packets at this boundary any more, so a
    # citation to anything outside the edition snapshot is a dangling one.
    class OutsideCitationEditor:
        async def prepare(self, packets, issue_date, workspace):
            return editor.EditorResult(
                draft={
                    "subject": "悬空引用测试",
                    "title": "快照外的引用不会被接受",
                    "introduction": "这是离线 fixture。",
                    "sections": [
                        {
                            "kind": "feature",
                            "heading": "两项模拟来源",
                            "paragraphs": [
                                {
                                    "text": "这一段引用了快照外的材料。",
                                    "citations": [
                                        f"{packets[0]['id']}/source",
                                        "outside-packet/extra",
                                    ],
                                }
                            ],
                            "limitations": "不代表事实核验。",
                        }
                    ],
                    "limitations": "模拟材料。",
                },
                review={"passed": True, "findings": []},
            )

    edition, original = _queue(store, packet_request, "outside-citation")
    worker = newsletter_worker.Worker(
        store,
        OutsideCitationEditor(),
        adapters.DisabledNotion(),
        tmp_path / "jobs",
        10,
    )
    assert await worker.step()
    finished = store.get(edition["id"])
    assert finished["state"] == "failed", finished
    assert finished["error_code"] == "editor_invalid_result"
    assert finished["packet_ids"] == [original["id"]]
    assert [p["id"] for p in store.read_inbox()["packets"]] == [original["id"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("crash_before_result_saved", [False, True])
async def test_ambiguous_notion_projection_not_retried_after_reopen_recovery(
    packet_request, tmp_path, crash_before_result_saved
):
    class AmbiguousNotion:
        calls = 0

        async def project(self, packet):
            self.calls += 1
            raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)

    notion = AmbiguousNotion()
    database = tmp_path / "recovery.sqlite3"
    first = newsletter_store.Store(database, "mock")
    packet = first.put_packet(packet_request)
    try:
        if crash_before_result_saved:
            claimed = first.claim_projection()
            with pytest.raises(adapters.AdapterError):
                await notion.project(claimed)
            # Simulate termination before projection_result writes UNKNOWN.
        else:
            worker = newsletter_worker.Worker(
                first, editor.MockEditor(), notion, tmp_path / "jobs", 10
            )
            assert await worker.step()
    finally:
        first.close()

    reopened = newsletter_store.Store(database, "mock")
    try:
        reopened.recover()
        state = reopened.db.execute(
            "SELECT projection FROM packets WHERE id=?", (packet["id"],)
        ).fetchone()[0]
        assert state == "unknown"
        worker = newsletter_worker.Worker(
            reopened, editor.MockEditor(), notion, tmp_path / "jobs", 10
        )
        assert await worker.step() is False
        reopened.recover()
        assert await worker.step() is False
        assert notion.calls == 1
        assert len(reopened.read_inbox()["packets"]) == 1
    finally:
        reopened.close()


def test_background_worker_finishes_without_manual_steps(
    packet_request, tmp_path
):
    settings = newsletter_settings.Settings(
        data_dir=tmp_path / "background",
        editor_token="e" * 32,
        send_token="s" * 32,
    )
    with testclient.TestClient(app.create_app(settings)) as client:
        assert client.get("/healthz").status_code == 200
        headers = {"Authorization": "Bearer " + settings.editor_token}
        started = client.post(
            "/v1/runs",
            json={
                "request_key": "background-run",
                "issue_date": "2026-09-05",
            },
            headers=headers,
        )
        assert started.status_code == 202, started.text
        deadline = time.monotonic() + 5
        while True:
            receipt = client.get(
                "/v1/runs/" + started.json()["id"], headers=headers
            ).json()
            if receipt["state"] in {"ready", "blocked", "failed"}:
                break
            assert time.monotonic() < deadline, receipt
            time.sleep(0.01)
        assert receipt["state"] == "ready", receipt
        edition = client.get(
            "/v1/editions/" + receipt["edition_id"], headers=headers
        ).json()
        assert edition["state"] == "ready"
        assert edition["delivery_state"] == "not_requested"
        assert not list(settings.data_dir.glob("outbox/*.eml"))
        assert client.get("/healthz").status_code == 200
        assert not client.app.state.worker_task.done()


@pytest.mark.asyncio
async def test_workspace_failure_isolated_to_one_edition(
    store, packet_request, tmp_path, monkeypatch
):
    edition, _ = _queue(store, packet_request, "disk-error-edition")
    worker = newsletter_worker.Worker(
        store,
        editor.MockEditor(),
        adapters.DisabledNotion(),
        tmp_path / "jobs",
        10,
    )
    original_write = pathlib.Path.write_text

    def fail_history(path, *args, **kwargs):
        if path.name == "recent-history.json":
            raise OSError("private filesystem details must not leak")
        return original_write(path, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "write_text", fail_history)
    assert await worker.step() is True
    failed = store.get(edition["id"])
    assert failed["state"] == "failed"
    assert failed["error_code"] == "editor_workspace_error"
    assert failed["delivery_state"] == "not_requested"
    assert "private filesystem" not in json.dumps(failed)

    monkeypatch.setattr(pathlib.Path, "write_text", original_write)
    next_edition, _ = _queue(
        store, packet_request, "after-disk-error", "2026-09-06"
    )
    assert await worker.step() is True
    assert store.get(next_edition["id"])["state"] == "ready"
    assert store.get(edition["id"])["state"] == "failed"
