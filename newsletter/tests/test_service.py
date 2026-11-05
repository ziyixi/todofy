import asyncio
import base64
import concurrent.futures as futures
import dataclasses
import importlib.resources as resources
import json
import pathlib
import threading
import time

import fastapi.testclient as testclient
import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.app as app
import newsletter.cli as cli
import newsletter.deployment_api as deployment_api
import newsletter.drain as drain
import newsletter.editor as editor
import newsletter.errors as errors
import newsletter.rendering as rendering
import newsletter.store as newsletter_store
import newsletter.worker as newsletter_worker

_RUN_ID = "00000000-0000-4000-8000-000000000000"
_OPERATIONS = {
    ("POST", "/v1/runs"): "StartRun",
    ("GET", "/v1/runs/{run_id}"): "GetRun",
    ("GET", "/v1/editions/{edition_id}"): "GetEdition",
    ("POST", "/v1/editions/{edition_id}/send"): "SendEdition",
}


@pytest.fixture
def packet_request():
    return json.loads(
        resources.files("newsletter")
        .joinpath("fixtures/packets.json")
        .read_text()
    )[0]


def headers(role="editor"):
    return {
        "Authorization": "Bearer "
        + {"editor": "e", "ingest": "i", "send": "s"}[role] * 32
    }


def create_issue(client, request, key="issue1"):
    packet = client.app.state.store.put_packet(request)
    return client.app.state.store.prepare(
        {
            "request_key": key,
            "issue_date": "2026-09-05",
            "packet_ids": [packet["id"]],
        },
    )


def run_worker(client):
    client.portal.call(client.app.state.worker.step)


def send_request(edition, key="send1"):
    return {
        "id": edition["id"],
        "request_key": key,
        "expected_render_hash": edition["rendered"]["render_hash"],
    }


def test_http_full_flow_and_simulation(settings, packet_request):
    with testclient.TestClient(
        app.create_app(settings, start_worker=False)
    ) as client:
        assert client.get("/healthz").status_code == 200
        assert client.post("/v1/runs", json={}).status_code == 401
        assert (
            client.post(
                "/v1/runs", json={}, headers=headers("send")
            ).status_code
            == 401
        )
        edition = create_issue(client, packet_request)
        assert edition["state"] == "queued"
        run_worker(client)
        edition = client.get(
            f"/v1/editions/{edition['id']}", headers=headers()
        ).json()
        assert edition["state"] == "ready", edition
        assert edition["is_fixture"] is True
        preview = client.get(
            f"/v1/editions/{edition['id']}/preview", headers=headers()
        )
        assert preview.status_code == 200
        assert "MOCK" in preview.text
        assert preview.headers["Cache-Control"] == "no-store"
        assert not list(settings.data_dir.glob("outbox/*.eml"))
        url = f"/v1/editions/{edition['id']}/send"
        request = send_request(edition)
        assert (
            client.post(url, json=request, headers=headers()).status_code == 401
        )
        wrong = {**request, "expected_render_hash": "0" * 64}
        assert (
            client.post(url, json=wrong, headers=headers("send")).status_code
            == 409
        )
        sent = client.post(url, json=request, headers=headers("send")).json()
        assert sent["delivery_state"] == "simulated"
        assert (
            client.post(url, json=request, headers=headers("send")).json()
            == sent
        )
        assert len(list(settings.data_dir.glob("outbox/*.eml"))) == 1


def test_ingress_strictness_and_idempotency(settings, packet_request):
    with testclient.TestClient(
        app.create_app(settings, start_worker=False)
    ) as client:
        request = {"request_key": "full-run", "issue_date": "2026-09-05"}
        response = client.post("/v1/runs", json=request, headers=headers())
        assert response.status_code == 202
        assert (
            client.post("/v1/runs", json=request, headers=headers()).json()
            == response.json()
        )
        changed = {**request, "issue_date": "2026-09-06"}
        assert (
            client.post("/v1/runs", json=changed, headers=headers()).status_code
            == 409
        )
        assert (
            client.post(
                "/v1/runs",
                json={**request, "producer_id": "admin"},
                headers=headers(),
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/v1/runs",
                content='{"request_key":"a","request_key":"b"}',
                headers={**headers(), "Content-Type": "application/json"},
            ).status_code
            == 400
        )
        assert (
            client.post("/v1/runs", content="{}", headers=headers()).status_code
            == 415
        )
        assert (
            client.post(
                "/v1/runs",
                content="x" * (settings.max_body_bytes + 1),
                headers={**headers(), "Content-Type": "application/json"},
            ).status_code
            == 413
        )


def test_inbox_pagination_is_pinned(settings, packet_request):
    store = newsletter_store.Store(settings.data_dir / "db", "mock")
    try:
        ids = [
            store.put_packet({**packet_request, "request_key": str(i)})["id"]
            for i in range(4)
        ]
        page1 = store.read_inbox(2)
        new = store.put_packet({**packet_request, "request_key": "late"})
        page2 = store.read_inbox(2, page1["next_cursor"])
        assert [p["id"] for p in page1["packets"] + page2["packets"]] == ids[
            ::-1
        ]
        assert new["id"] not in ids
        with pytest.raises(newsletter_store.StoreError):
            store.read_inbox(2, "bad-cursor")
        for bad in ([2**64, 0], [False, 1], [-1, 3]):
            with pytest.raises(newsletter_store.StoreError):
                store.read_inbox(
                    2,
                    base64.urlsafe_b64encode(json.dumps(bad).encode()).decode(),
                )
    finally:
        store.close()


def test_crash_recovery_and_no_repeat_send(settings, packet_request):
    class UncertainMail:
        calls = 0

        async def send(self, edition, idempotency_key):
            self.calls += 1
            raise TimeoutError("vendor secret must not leak")

    mail = UncertainMail()
    with testclient.TestClient(
        app.create_app(settings, mail=mail, start_worker=False)
    ) as client:
        edition = create_issue(client, packet_request)
        run_worker(client)
        edition = client.app.state.store.get(edition["id"])
        request = send_request(edition)
        response = client.post(
            f"/v1/editions/{edition['id']}/send",
            json=request,
            headers=headers("send"),
        )
        assert response.json()["delivery_state"] == "unknown"
        assert "vendor secret" not in response.text
        second = create_issue(
            client, {**packet_request, "request_key": "other"}, "issue2"
        )
        # Simulate an interrupted editor claim before shutdown.
        client.app.state.store.claim()
    with testclient.TestClient(
        app.create_app(settings, mail=mail, start_worker=False)
    ) as client:
        assert (
            client.app.state.store.get(second["id"])["error_code"]
            == "interrupted"
        )
        response = client.post(
            f"/v1/editions/{edition['id']}/send",
            json=request,
            headers=headers("send"),
        )
        assert response.json()["delivery_state"] == "unknown"
        assert mail.calls == 1


def test_one_process_and_immutable_target(settings):
    with (
        testclient.TestClient(app.create_app(settings, start_worker=False)),
        pytest.raises(RuntimeError, match="data is busy"),
        testclient.TestClient(app.create_app(settings, start_worker=False)),
    ):
        pass
    with (
        pytest.raises(ValueError, match="Delivery target changed"),
        testclient.TestClient(
            app.create_app(
                dataclasses.replace(
                    settings, recipient_email="different@example.org"
                ),
                start_worker=False,
            )
        ),
    ):
        pass


@pytest.mark.parametrize("backend", ["codex", "resend", "notion"])
def test_mock_never_enables_real_adapters(settings, backend):
    changes = {
        "codex": {"editor_backend": "codex"},
        "resend": {"mail_backend": "resend"},
        "notion": {"notion_backend": "notion"},
    }[backend]
    with pytest.raises(ValueError, match="Mock mode forbids"):
        app.create_app(dataclasses.replace(settings, **changes))


def test_queue_bound_and_prepare_idempotency(settings, packet_request):
    with testclient.TestClient(
        app.create_app(
            dataclasses.replace(settings, max_pending_jobs=1),
            start_worker=False,
        )
    ) as client:
        edition = create_issue(client, packet_request)
        assert create_issue(client, packet_request)["id"] == edition["id"]
        with pytest.raises(newsletter_store.StoreError, match="queue is full"):
            client.app.state.store.prepare(
                {
                    "request_key": "new",
                    "issue_date": "2026-09-05",
                    "packet_ids": edition["packet_ids"],
                }
            )


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), 0, -1, 3601])
def test_unbounded_timeouts_rejected(settings, timeout):
    with pytest.raises(ValueError, match="Job timeout"):
        dataclasses.replace(settings, job_timeout_seconds=timeout).validate()


def test_data_directory_is_dedicated(settings):

    for directory in [
        pathlib.Path.cwd(),
        pathlib.Path.home(),
        pathlib.Path("/"),
    ]:
        with pytest.raises(ValueError, match="dedicated child"):
            dataclasses.replace(settings, data_dir=directory).validate()


def test_system_style_parent_symlink_uses_canonical_workspace(
    settings, packet_request, tmp_path
):
    real = tmp_path / "real-parent"
    real.mkdir()
    alias = tmp_path / "alias-parent"
    alias.symlink_to(real, target_is_directory=True)
    configured = dataclasses.replace(settings, data_dir=alias / "data")
    with testclient.TestClient(
        app.create_app(configured, start_worker=False)
    ) as client:
        edition = create_issue(client, packet_request)
        run_worker(client)
        assert client.app.state.store.get(edition["id"])["state"] == "ready"


def test_preview_only_replaces_image_source():

    value = {
        "html": '<p>cid:newsletter-chart</p><img src="cid:newsletter-chart">',
        "chart_png": "abc",
    }
    assert (
        rendering.preview_html(value)
        == '<p>cid:newsletter-chart</p><img src="data:image/png;base64,abc">'
    )


@pytest.mark.asyncio
async def test_demo_is_offline_and_exclusive(tmp_path):
    path = await cli.demo(tmp_path / "sample")
    assert path.is_file() and "MOCK" in path.read_text()
    assert len(list((path.parent / "outbox").glob("*.eml"))) == 1
    assert (
        json.loads((path.parent / "edition.json").read_text())["delivery_state"]
        == "simulated"
    )
    with pytest.raises(FileExistsError):
        await cli.demo(path.parent)


@pytest.mark.parametrize(
    "behavior,expected",
    [
        ("auth", "authentication"),
        ("timeout", "editor_timeout"),
        ("invalid", "editor_invalid_result"),
        ("review", "editorial_review_failed"),
    ],
)
def test_failed_editor_cannot_publish(
    settings, packet_request, behavior, expected
):
    class ProblemEditor:
        async def prepare(self, packets, issue_date, workspace):
            if behavior == "auth":
                raise errors.EditorError("authentication")
            if behavior == "timeout":
                await asyncio.sleep(2)
            result = await editor.MockEditor().prepare(
                packets, issue_date, workspace
            )
            if behavior == "invalid":
                result.draft["sections"][0]["paragraphs"][0]["citations"] = [
                    "made-up/source"
                ]
            return editor.EditorResult(
                result.draft,
                {"passed": False, "findings": ["Insufficient evidence"]},
            )

    with testclient.TestClient(
        app.create_app(
            dataclasses.replace(settings, job_timeout_seconds=0.1),
            editor=ProblemEditor(),
            start_worker=False,
        )
    ) as client:
        edition = create_issue(client, packet_request)
        run_worker(client)
        final = client.app.state.store.get(edition["id"])
        assert final["error_code"] == expected
        assert final["state"] in {"failed", "blocked"}
        request = {
            "id": final["id"],
            "request_key": "attempt",
            "expected_render_hash": "0" * 64,
        }
        assert (
            client.post(
                f"/v1/editions/{final['id']}/send",
                json=request,
                headers=headers("send"),
            ).status_code
            == 409
        )


def test_http_surface_matches_shared_proto(settings):
    application = app.create_app(settings, start_worker=False)
    paths = application.openapi()["paths"]
    methods = {
        (method.upper(), path)
        for path, operations in paths.items()
        for method in operations
    }
    assert methods == set(_OPERATIONS) | {
        ("GET", "/healthz"),
        ("GET", "/v1/editions/{edition_id}/preview"),
        ("GET", "/internal/deployment/drain"),
        ("POST", "/internal/deployment/drain/{action}"),
        ("GET", "/internal/monitoring/status"),
    }
    service = editorial_pb2.DESCRIPTOR.services_by_name["NewsletterService"]
    assert {method.name for method in service.methods} == set(
        _OPERATIONS.values()
    )


@pytest.mark.parametrize("role", ["editor", "send"])
def test_retired_routes_have_no_authenticated_alias(settings, role):
    with testclient.TestClient(
        app.create_app(settings, start_worker=False)
    ) as client:
        for method, path in (
            ("POST", "/v1/packets"),
            ("POST", "/v1/inbox/query"),
            ("POST", "/v1/editions"),
            ("POST", "/v1/render"),
            ("POST", f"/v1/runs/{_RUN_ID}/retry-stories"),
            ("POST", f"/v1/editions/{_RUN_ID}/send-verification"),
        ):
            response = client.request(method, path, headers=headers(role))
            assert response.status_code == 404
        assert not list((settings.data_dir / "outbox").glob("*.eml"))


@pytest.mark.parametrize("role", ["editor", "send"])
@pytest.mark.parametrize(
    "method,path,allowed,validated_status",
    [
        ("POST", "/v1/runs", {"editor"}, 400),
        ("GET", f"/v1/runs/{_RUN_ID}", {"editor"}, 404),
        ("GET", f"/v1/editions/{_RUN_ID}", {"editor", "send"}, 404),
        ("POST", f"/v1/editions/{_RUN_ID}/send", {"send"}, 400),
    ],
)
def test_editor_and_send_permissions(
    settings, role, method, path, allowed, validated_status
):
    with testclient.TestClient(
        app.create_app(settings, start_worker=False)
    ) as client:
        response = client.request(method, path, headers=headers(role), json={})
    assert response.status_code == (
        validated_status if role in allowed else 401
    )


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
    class OutsideCitationEditor:
        async def prepare(self, packets, issue_date, workspace):
            source_id = packets[0]["sources"][0]["id"]
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
                                        f"{packets[0]['id']}/{source_id}",
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


def test_background_worker_finishes_without_manual_steps(settings):
    with testclient.TestClient(app.create_app(settings)) as client:
        assert client.get("/healthz").status_code == 200
        started = client.post(
            "/v1/runs",
            json={
                "request_key": "background-run",
                "issue_date": "2026-09-05",
            },
            headers=headers(),
        )
        assert started.status_code == 202, started.text
        deadline = time.monotonic() + 5
        while True:
            receipt = client.get(
                "/v1/runs/" + started.json()["id"], headers=headers()
            ).json()
            if receipt["state"] in {"ready", "blocked", "failed"}:
                break
            assert time.monotonic() < deadline, receipt
            time.sleep(0.01)
        assert receipt["state"] == "ready", receipt
        edition = client.get(
            "/v1/editions/" + receipt["edition_id"], headers=headers()
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


@pytest.mark.asyncio
async def test_deployment_api_object_and_known_error_mappings():
    assert deployment_api._object([("request_key", "k1")]) == {
        "request_key": "k1"
    }
    with pytest.raises(ValueError, match="Duplicate deployment field"):
        deployment_api._object([("request_key", "k1"), ("request_key", "k2")])

    draining = await deployment_api.known_error(
        None, drain.DrainError("deployment_draining")
    )
    assert draining.status_code == 503
    assert draining.headers["Retry-After"] == "30"
    assert json.loads(draining.body) == {"error": "deployment_draining"}

    invalid = await deployment_api.known_error(
        None, drain.DrainError("deployment_invalid_key")
    )
    assert invalid.status_code == 400
    assert "Retry-After" not in invalid.headers

    conflict = await deployment_api.known_error(
        None, drain.DrainError("deployment_key_conflict")
    )
    assert conflict.status_code == 409


def test_task_healthy_detects_terminated_worker_and_rejects_runs(settings):
    application = app.create_app(settings)
    with testclient.TestClient(application) as client:
        assert app.task_healthy(application) is True
        client.portal.call(application.state.worker_task.cancel)
        with pytest.raises((asyncio.CancelledError, futures.CancelledError)):
            client.portal.call(lambda: application.state.worker_task)
        assert app.task_healthy(application) is False
        health = client.get("/healthz")
        assert health.status_code == 503
        assert health.json()["status"] == "degraded"
        rejected = client.post(
            "/v1/runs",
            json={"request_key": "dead-worker", "issue_date": "2026-09-05"},
            headers=headers(),
        )
        assert rejected.status_code == 503
