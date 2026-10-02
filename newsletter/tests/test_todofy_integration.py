"""Test private events bypassing research and freezing into approved email."""

import asyncio
import copy
import dataclasses
import datetime
import email.parser as parser
import email.policy as policy
import importlib.resources as resources
import json

import fastapi.testclient as testclient
import httpx
import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.app as app
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.rendering as rendering
import newsletter.settings as newsletter_settings
import newsletter.todofy as newsletter_todofy

TODAY = "2026-09-05"
PRIVATE = "PRIVATE-TODOFY-ONLY-87cd"


def test_personal_fetch_has_separate_budget_from_editor(settings):
    class SlowerTodofy:
        async def fetch(self, issue_date):
            await asyncio.sleep(0.08)
            return await newsletter_todofy.FakeTodofy().fetch(issue_date)

    with testclient.TestClient(
        app.create_app(
            dataclasses.replace(settings, job_timeout_seconds=0.04),
            todofy=SlowerTodofy(),
            start_worker=False,
        )
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        step(client)
        assert current(client, edition)["state"] == "ready"


@pytest.fixture
def settings(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "service",
        editor_token="e" * 32,
        send_token="s" * 32,
    )


def auth(role="editor"):
    return {
        "Authorization": "Bearer "
        + {"ingest": "i", "editor": "e", "send": "s"}[role] * 32
    }


def put_packet(client):
    request = json.loads(
        resources.files("newsletter")
        .joinpath("fixtures/packets.json")
        .read_text()
    )[0]
    # These tests exercise personal-event rendering, not PNG rasterization.
    request["content"]["tags"] = []
    return client.app.state.store.put_packet(request)


def prepare(client, packet, key="edition"):
    request = {
        "request_key": key,
        "issue_date": TODAY,
        "packet_ids": [packet["id"]],
    }
    return client.app.state.store.prepare(request)


def step(client):
    return client.portal.call(client.app.state.worker.step)


def current(client, edition):
    response = client.get(f"/v1/editions/{edition['id']}", headers=auth())
    assert response.status_code == 200
    return response.json()


class PrivateTodofy:
    def __init__(self):
        self.calls = []
        self.content_version = "original"

    async def fetch(self, issue_date):
        self.calls.append(issue_date)
        digest = await newsletter_todofy.FakeTodofy().fetch(issue_date)
        digest["summary"] = (
            PRIVATE + " · private personal overview · " + self.content_version
        )
        digest["items"][0]["detail"] = (
            PRIVATE + " · preserve this full event explanation"
        )
        return digest


class ObservingEditor:
    def __init__(self):
        self.inputs, self.history, self.workspaces = [], [], []

    async def prepare(self, packets, issue_date, workspace):
        self.inputs.append(copy.deepcopy(packets))
        self.history.append(
            json.loads((workspace / "recent-history.json").read_text())
        )
        self.workspaces.append(workspace)
        return await newsletter_editor.MockEditor().prepare(
            packets, issue_date, workspace
        )


class ObservingNotion:
    def __init__(self):
        self.packets = []

    async def project(self, packet):
        self.packets.append(copy.deepcopy(packet))


def test_private_events_never_reach_editor_history_inbox_or_notion(settings):
    editor, notion, todofy = (
        ObservingEditor(),
        ObservingNotion(),
        PrivateTodofy(),
    )
    with testclient.TestClient(
        app.create_app(
            settings,
            editor=editor,
            notion=notion,
            todofy=todofy,
            start_worker=False,
        )
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        assert step(client)
        first = current(client, edition)
        assert first["state"] == "ready"
        assert PRIVATE in first["personal_digest"]["summary"]
        assert PRIVATE in first["rendered"]["html"]
        assert PRIVATE in first["rendered"]["text"]
        assert PRIVATE not in json.dumps(first["draft"])

        # Simulate earlier accepted publication in this test DB only, so the
        # next editor receives historical metadata without the personal column.
        client.app.state.store.finish(
            edition["id"], delivery_state="provider_accepted"
        )
        prepare(client, packet, "next-edition")
        assert step(client)
        assert len(editor.history[1]) == 1
        assert set(editor.history[1][0]) == {
            "issue_date",
            "title",
            "delivery_state",
        }
        while step(client):
            pass
        inbox = client.app.state.store.read_inbox()
        assert len(inbox["packets"]) == 1
        assert len(notion.packets) == 1
        assert PRIVATE not in json.dumps(editor.inputs)
        assert PRIVATE not in json.dumps(editor.history)
        assert PRIVATE not in json.dumps(notion.packets)
        assert PRIVATE not in json.dumps(inbox)
        for workspace in editor.workspaces:
            for artifact in workspace.glob("*.json"):
                assert PRIVATE not in artifact.read_text()


def test_local_filter_stays_private_without_editor_or_notion(
    settings,
):
    editor, notion = ObservingEditor(), ObservingNotion()
    calls = []
    source = {
        "tasks": [
            {
                "rank": 1,
                "title": "信用卡账单已出",
                "reason": "例行电子账单可查看。",
            },
            {
                "rank": 2,
                "title": "待确认会议",
                "reason": PRIVATE + " 请回复具体时段。",
            },
            {
                "rank": 3,
                "title": "Autopay failed",
                "reason": PRIVATE + " Bank rejected the payment.",
            },
        ],
        "task_count": 18,
    }

    def handler(request):
        calls.append(request)
        assert request.url.params["top"] == "10"
        return httpx.Response(200, json=source)

    private_adapter = newsletter_todofy.Todofy(
        "https://todofy.example.org",
        "synthetic-user",
        "synthetic-password",
        top=2,
        transport=httpx.MockTransport(handler),
        clock=lambda: datetime.datetime(2026, 9, 5, 18, tzinfo=datetime.UTC),
    )
    with testclient.TestClient(
        app.create_app(
            settings,
            editor=editor,
            notion=notion,
            todofy=private_adapter,
            start_worker=False,
        )
    ) as client:
        edition = prepare(client, put_packet(client))
        assert step(client)
        final = current(client, edition)
        assert final["state"] == "ready"
        assert final["delivery_state"] == "not_requested"
        assert len(calls) == 1
        assert final["personal_digest"]["task_count"] == 18
        assert [i["title"] for i in final["personal_digest"]["items"]] == [
            "Autopay failed",
            "待确认会议",
        ]
        assert "信用卡账单已出" not in final["rendered"]["html"]
        assert (
            PRIVATE in final["rendered"]["html"]
            and PRIVATE in final["rendered"]["text"]
        )
        while step(client):
            pass
        inbox = client.app.state.store.read_inbox()
        for public in (
            editor.inputs,
            editor.history,
            notion.packets,
            inbox,
            final["draft"],
        ):
            assert PRIVATE not in json.dumps(public)
        for workspace in editor.workspaces:
            for artifact in workspace.glob("*.json"):
                assert PRIVATE not in artifact.read_text()


def test_fetched_once_frozen_in_json_preview_mime_and_idempotent_send(settings):
    todofy = PrivateTodofy()
    with testclient.TestClient(
        app.create_app(settings, todofy=todofy, start_worker=False)
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        assert step(client)
        frozen = current(client, edition)
        assert frozen["state"] == "ready"
        assert todofy.calls == [TODAY]
        assert frozen["personal_digest"]["items"][0]["detail"].endswith(
            "full event explanation"
        )
        assert "TODOFY / 与你有关" in frozen["rendered"]["text"]
        preview = client.get(
            f"/v1/editions/{edition['id']}/preview", headers=auth()
        )
        assert PRIVATE in preview.text

        todofy.content_version = "would change if fetched again"
        repeated = prepare(client, packet)
        assert repeated["rendered"] == frozen["rendered"]
        request = {
            "id": edition["id"],
            "request_key": "same-send",
            "expected_render_hash": frozen["rendered"]["render_hash"],
        }
        url = f"/v1/editions/{edition['id']}/send"
        sent = client.post(url, json=request, headers=auth("send"))
        assert sent.status_code == 200
        assert sent.json()["delivery_state"] == "simulated"
        assert (
            client.post(url, json=request, headers=auth("send")).json()
            == sent.json()
        )
        while step(client):
            pass
        assert todofy.calls == [TODAY]
        assert current(client, edition)["rendered"] == frozen["rendered"]
        outbox = list((settings.data_dir / "outbox").glob("*.eml"))
        assert len(outbox) == 1
        message = parser.BytesParser(policy=policy.default).parsebytes(
            outbox[0].read_bytes()
        )
        assert (
            PRIVATE in message.get_body(preferencelist=("plain",)).get_content()
        )
        assert (
            PRIVATE in message.get_body(preferencelist=("html",)).get_content()
        )

    # A restart must not re-fetch or replace the frozen personal snapshot.
    with testclient.TestClient(
        app.create_app(settings, todofy=todofy, start_worker=False)
    ) as client:
        assert not step(client)
        assert current(client, edition)["rendered"] == frozen["rendered"]
        assert todofy.calls == [TODAY]


@pytest.mark.parametrize("behavior", ["exception", "timeout", "invalid"])
def test_personal_failure_does_not_drop_or_fail_the_edition(settings, behavior):
    class FailingTodofy:
        async def fetch(self, issue_date):
            if behavior == "exception":
                raise RuntimeError(PRIVATE)
            if behavior == "timeout":
                raise TimeoutError(PRIVATE)
            return {
                "state": "current",
                "title": "invalid",
                "private_secret": PRIVATE,
            }

    with testclient.TestClient(
        app.create_app(settings, todofy=FailingTodofy(), start_worker=False)
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        step(client)
        final = current(client, edition)
        assert final["state"] == "ready"
        assert final["personal_digest"]["state"] == "unavailable"
        assert "task_count" not in final["personal_digest"]
        assert "TODOFY / 与你有关" in final["rendered"]["text"]
        assert PRIVATE not in json.dumps(final)


def test_no_personal_fetch_when_editorial_review_blocks(settings):
    class BlockedEditor:
        async def prepare(self, packets, issue_date, workspace):
            result = await newsletter_editor.MockEditor().prepare(
                packets, issue_date, workspace
            )
            return newsletter_editor.EditorResult(
                result.draft, {"passed": False, "findings": ["Not ready"]}
            )

    todofy = PrivateTodofy()
    with testclient.TestClient(
        app.create_app(
            settings, editor=BlockedEditor(), todofy=todofy, start_worker=False
        )
    ) as client:
        edition = prepare(client, put_packet(client))
        step(client)
        assert current(client, edition)["state"] == "blocked"
        assert todofy.calls == []


def test_live_issue_rejects_injected_fake_personal_content(settings):
    todofy = PrivateTodofy()
    with testclient.TestClient(
        app.create_app(settings, todofy=todofy, start_worker=False)
    ) as client:
        # Exercise the worker's live-issue guard without starting a real editor.
        result = client.portal.call(
            client.app.state.worker.personal_digest,
            {"issue_date": TODAY, "is_fixture": False},
        )
        assert result["state"] == "unavailable"
        assert not result["is_fixture"]
        assert PRIVATE not in json.dumps(result)


def test_mock_settings_cannot_enable_real_todofy(settings):
    with pytest.raises(ValueError, match="Mock mode forbids real Todofy"):
        app.create_app(
            dataclasses.replace(
                settings,
                todofy_backend="todofy",
                todofy_user="test",
                todofy_password="secret",
            )
        )


def test_live_settings_cannot_enable_fake_events(settings):
    with pytest.raises(
        ValueError, match="Live mode forbids fake personal events"
    ):
        app.create_app(
            dataclasses.replace(settings, mode="live", todofy_backend="fake")
        )


def render_body(client, edition, packet):
    return {
        "draft": edition["draft"],
        "packets": [packet],
        "issue_date": TODAY,
        "is_fixture": True,
        "personal_digest": edition["personal_digest"],
        "usage": edition["usage"],
    }


def test_render_utility_accepts_personal_digest_and_hash_covers_it(settings):

    todofy = PrivateTodofy()
    with testclient.TestClient(
        app.create_app(settings, todofy=todofy, start_worker=False)
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        step(client)
        edition = current(client, edition)
        body = render_body(client, edition, packet)
        original = rendering.render_edition(**body)
        assert original == edition["rendered"]
        body["personal_digest"]["items"][0]["detail"] += " The event changed."
        changed = rendering.render_edition(**body)
        assert changed["render_hash"] != original["render_hash"]
        assert "The event changed." in changed["html"]
        assert "The event changed." in changed["text"]
        assert todofy.calls == [TODAY]
        assert current(client, edition)["rendered"] == original


@pytest.mark.parametrize(
    "invalid",
    [
        {"unexpected": "undeclared field"},
        {"state": "made-up-state"},
        {"task_count": -1},
        {"fetched_at": "2026-09-05T12:00:00"},
        {"items": [{"rank": 1, "title": "Only title", "detail": ""}]},
        {
            "state": "unavailable"
        },  # Cannot preserve current event rows in a failed result.
    ],
)
def test_render_personal_shape_is_strict(settings, invalid):

    with testclient.TestClient(
        app.create_app(settings, todofy=PrivateTodofy(), start_worker=False)
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        step(client)
        body = render_body(client, current(client, edition), packet)
        body["personal_digest"].update(invalid)
        with pytest.raises(contracts.ContractError):
            contracts.validate_request(
                contracts.parse_message(
                    body, editorial_pb2.RenderEditionRequest
                )
            )


def test_personal_text_is_escaped_in_email_html(settings):

    with testclient.TestClient(
        app.create_app(settings, todofy=PrivateTodofy(), start_worker=False)
    ) as client:
        packet = put_packet(client)
        edition = prepare(client, packet)
        step(client)
        body = render_body(client, current(client, edition), packet)
        payload = (
            '<img src="https://tracker.example.org/private" onerror="steal()">'
        )
        body["personal_digest"]["items"][0]["detail"] = payload
        result = rendering.render_edition(**body)
        assert payload not in result["html"]
        assert "&lt;img" in result["html"]
        assert payload in result["text"]
