"""Provider tests use MockTransport exclusively; fakes only write temp files."""

import base64
import copy
import email.parser as parser
import email.policy as policy
import json

import httpx
import pytest

import newsletter.adapters as adapters
import newsletter.contracts as contracts

# A complete 1x1 PNG; no image download or model call is used by these tests.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42m"
    "P8/x8AAwMCAO+aB9sAAAAASUVORK5CYII="
)
DATA_SOURCE = "12345678-1234-4234-8234-123456789abc"


@pytest.fixture
def edition():
    rendered = {
        "html": (
            '<html><p>冻结的正文</p><img src="cid:newsletter-chart"></html>'
        ),
        "text": "冻结的正文\n",
        "chart_png": base64.b64encode(PNG).decode("ascii"),
    }
    rendered["render_hash"] = contracts.content_hash(rendered)
    return {
        "id": "edition-1",
        "is_fixture": False,
        "state": "ready",
        "draft": {"subject": "今日通讯"},
        "rendered": rendered,
    }


@pytest.fixture
def packet():
    content = {
        "title": "材料一",
        "body": "一份尚未成为成稿的研究材料。",
        "tags": ["science"],
        "sources": [
            {
                "id": "paper",
                "title": "Primary source",
                "url": "https://example.org/a",
                "excerpt": "An abstract.",
                "access_scope": "abstract",
                "published_at": "",
            }
        ],
    }
    return {
        "id": "packet-1",
        "workflow_id": "science",
        "producer_id": "test",
        "is_fixture": True,
        "content": content,
        "content_hash": contracts.content_hash(content),
    }


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("An adapter test attempted real network access")

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", forbidden
    )


async def test_disabled_notion_does_nothing(packet):
    assert await adapters.DisabledNotion().project(packet) is None


async def test_fake_notion_is_complete_stable_and_local(tmp_path, packet):
    adapter = adapters.FakeNotion(tmp_path)
    await adapter.project(packet)
    await adapter.project(packet)
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1
    assert json.loads(files[0].read_text()) == {
        "simulated": True,
        "packet": packet,
    }
    assert not list(tmp_path.glob(".pending-*"))


async def test_fake_notion_cannot_overwrite_same_id(tmp_path, packet):
    adapter = adapters.FakeNotion(tmp_path)
    await adapter.project(packet)
    packet["content"]["body"] = "Changed."
    with pytest.raises(
        adapters.AdapterError, match="FAKE_IDEMPOTENCY_CONFLICT"
    ):
        await adapter.project(packet)


async def test_fake_mail_has_cid_png_and_exact_frozen_parts(tmp_path, edition):
    edition["is_fixture"] = True
    adapter = adapters.FakeMail(tmp_path)
    result = await adapter.send(edition, "same/key")
    files = list(tmp_path.glob("*.eml"))
    original = files[0].read_bytes()
    message = parser.BytesParser(policy=policy.default).parsebytes(original)
    assert len(files) == 1
    assert result["delivery_state"] == "simulated"
    assert message["Subject"] == edition["draft"]["subject"]
    assert message["X-Newsletter-Simulated"] == "true"
    assert (
        message.get_body(preferencelist=("plain",)).get_content().strip()
        == "冻结的正文"
    )
    html = message.get_body(preferencelist=("html",)).get_content().strip()
    assert html == edition["rendered"]["html"]
    images = [
        part
        for part in message.walk()
        if part.get_content_type() == "image/png"
    ]
    assert images[0]["Content-ID"] == "<newsletter-chart>"
    assert images[0].get_payload(decode=True) == PNG
    assert await adapter.send(edition, "same/key") == result
    assert files[0].read_bytes() == original
    assert len(list(tmp_path.glob("*.eml"))) == 1


async def test_fake_mail_key_conflict_does_not_overwrite(tmp_path, edition):
    adapter = adapters.FakeMail(tmp_path)
    await adapter.send(edition, "key")
    edition["id"] = "edition-2"
    with pytest.raises(
        adapters.AdapterError, match="FAKE_IDEMPOTENCY_CONFLICT"
    ):
        await adapter.send(edition, "key")


async def test_fake_mail_without_chart(tmp_path, edition):
    edition["rendered"] = {"html": "<p>hi</p>", "text": "hi\n", "chart_png": ""}
    edition["rendered"]["render_hash"] = contracts.content_hash(
        edition["rendered"]
    )
    await adapters.FakeMail(tmp_path).send(edition, "no-chart")
    message = parser.BytesParser(policy=policy.default).parsebytes(
        next(tmp_path.glob("*.eml")).read_bytes()
    )
    assert not any(
        part.get_content_type() == "image/png" for part in message.walk()
    )


async def test_resend_request_is_frozen_with_configured_recipient(edition):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        assert str(request.url) == "https://api.resend.com/emails"
        assert request.headers["Idempotency-Key"] == "edition/1"
        assert request.headers["Authorization"] == "Bearer fake-key"
        body = json.loads(request.content)
        assert body["to"] == ["reader@example.org"]
        assert body["html"] == edition["rendered"]["html"]
        assert body["text"] == edition["rendered"]["text"]
        assert body["attachments"] == [
            {
                "filename": "newsletter-chart.png",
                "content_type": "image/png",
                "content_id": "newsletter-chart",
                "content": edition["rendered"]["chart_png"],
            }
        ]
        assert "path" not in body["attachments"][0]
        return httpx.Response(200, json={"id": "mail-123"})

    adapter = adapters.Resend(
        "fake-key",
        "Newsletter <sender@example.org>",
        "reader@example.org",
        transport=httpx.MockTransport(handler),
    )
    result = await adapter.send(edition, "edition/1")
    assert result == {
        "delivery_state": "provider_accepted",
        "provider_message_id": "mail-123",
    }
    assert len(calls) == 1


@pytest.mark.parametrize("fixture", [True, None, "false", 0])
async def test_resend_rejects_fixture_and_missing_provenance(edition, fixture):
    edition["is_fixture"] = fixture
    adapter = adapters.Resend(
        "fake-key", "sender@example.org", "reader@example.org"
    )
    with pytest.raises(
        adapters.AdapterError, match="FIXTURE_SEND_FORBIDDEN"
    ) as caught:
        await adapter.send(edition, "key")
    assert not caught.value.ambiguous


@pytest.mark.parametrize(
    "field,value",
    [
        ("html", "<p>mutated</p>"),
        ("text", "mutated"),
        ("chart_png", "bad base64!!"),
        ("render_hash", "0" * 64),
    ],
)
async def test_mutated_frozen_payload_never_dispatches(edition, field, value):
    edition["rendered"][field] = value
    adapter = adapters.Resend(
        "fake-key", "sender@example.org", "reader@example.org"
    )
    with pytest.raises(adapters.AdapterError, match="INVALID_FROZEN_EDITION"):
        await adapter.send(edition, "key")


@pytest.mark.parametrize(
    "status,ambiguous",
    [
        (400, False),
        (401, False),
        (403, False),
        (404, False),
        (422, False),
        (408, True),
        (409, True),
        (429, True),
        (500, True),
        (503, True),
        (302, True),
    ],
)
async def test_mail_http_outcomes_no_retry_or_secret_echo(
    edition, status, ambiguous
):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status,
            headers={"Location": "https://evil.example/"},
            json={"message": "secret-from-provider fake-key"},
        )

    adapter = adapters.Resend(
        "fake-key",
        "sender@example.org",
        "reader@example.org",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(adapters.AdapterError) as caught:
        await adapter.send(edition, "key")
    assert caught.value.ambiguous is ambiguous
    assert caught.value.code == (
        "MAIL_UNKNOWN" if ambiguous else "MAIL_REJECTED"
    )
    assert "secret" not in str(caught.value) and "fake-key" not in str(
        caught.value
    )
    assert len(calls) == 1


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={}),
        httpx.Response(200, json={"id": None}),
        httpx.Response(200, json=[]),
        httpx.Response(200, json={"id": "bad\nidentifier"}),
        httpx.Response(204),
    ],
)
async def test_invalid_mail_success_is_unknown(edition, response):
    adapter = adapters.Resend(
        "fake-key",
        "sender@example.org",
        "reader@example.org",
        transport=httpx.MockTransport(lambda request: response),
    )
    with pytest.raises(adapters.AdapterError, match="MAIL_UNKNOWN") as caught:
        await adapter.send(edition, "key")
    assert caught.value.ambiguous


@pytest.mark.parametrize(
    "error_type", [httpx.ReadTimeout, httpx.ConnectError, httpx.WriteError]
)
async def test_mail_transport_error_is_unknown_no_retry(edition, error_type):
    calls = []

    def handler(request):
        calls.append(request)
        raise error_type("do not expose fake-key or content", request=request)

    adapter = adapters.Resend(
        "fake-key",
        "sender@example.org",
        "reader@example.org",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(adapters.AdapterError, match="MAIL_UNKNOWN") as caught:
        await adapter.send(edition, "key")
    assert caught.value.ambiguous and len(calls) == 1
    assert caught.value.__cause__ is None


@pytest.mark.parametrize(
    "recipient",
    [
        "a@example.org,b@example.org",
        "missing-at",
        "a@example.org\nBcc: b@example.org",
    ],
)
def test_mail_configuration_requires_one_safe_recipient(recipient):
    with pytest.raises(
        adapters.AdapterError, match="INVALID_MAIL_CONFIGURATION"
    ):
        adapters.Resend("fake-key", "sender@example.org", recipient)


async def test_notion_single_request_stable_property_id_and_bounded_projection(
    packet,
):
    packet["content"]["body"] = "研究😀" * 6000
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        assert str(request.url) == "https://api.notion.com/v1/pages"
        assert request.headers["Notion-Version"] == "2026-03-11"
        body = json.loads(request.content)
        assert body["parent"] == {
            "type": "data_source_id",
            "data_source_id": DATA_SOURCE,
        }
        assert list(body["properties"]) == ["title"]
        assert len(body["children"]) == 3
        projected = json.dumps(body, ensure_ascii=False)
        assert "投影已截断" in projected and "非已发布稿" in projected
        assert len(request.content) < 500_000
        for child in body["children"]:
            rich = child["paragraph"]["rich_text"]
            assert len(rich) <= 100
            assert all(
                len(item["text"]["content"].encode("utf-16-le")) // 2 <= 2000
                for item in rich
            )
        return httpx.Response(
            200, json={"object": "page", "id": "notion-page-1"}
        )

    await adapters.Notion(
        "fake-token", DATA_SOURCE, transport=httpx.MockTransport(handler)
    ).project(packet)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "status,ambiguous", [(400, False), (403, False), (429, True), (503, True)]
)
async def test_notion_failure_is_safe_and_single_attempt(
    packet, status, ambiguous
):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, json={"message": "fake-token private content"}
        )

    adapter = adapters.Notion(
        "fake-token", DATA_SOURCE, transport=httpx.MockTransport(handler)
    )
    with pytest.raises(adapters.AdapterError) as caught:
        await adapter.project(packet)
    assert caught.value.ambiguous is ambiguous
    assert "fake-token" not in str(caught.value)
    assert len(calls) == 1


async def test_notion_timeout_or_wrong_object_must_not_look_successful(packet):
    def timeout(request):
        raise httpx.ReadTimeout("secret", request=request)

    for handler in [
        timeout,
        lambda request: httpx.Response(
            200, json={"id": "1", "object": "other"}
        ),
    ]:
        with pytest.raises(
            adapters.AdapterError, match="NOTION_UNKNOWN"
        ) as caught:
            await adapters.Notion(
                "fake-token",
                DATA_SOURCE,
                transport=httpx.MockTransport(handler),
            ).project(packet)
        assert caught.value.ambiguous


def test_invalid_notion_configuration_is_local():
    with pytest.raises(
        adapters.AdapterError, match="INVALID_NOTION_CONFIGURATION"
    ):
        adapters.Notion("fake-token", "../not-an-id")


async def test_adapters_do_not_mutate_inputs(tmp_path, edition, packet):
    original_edition, original_packet = (
        copy.deepcopy(edition),
        copy.deepcopy(packet),
    )
    await adapters.FakeMail(tmp_path).send(edition, "immutable")
    await adapters.FakeNotion(tmp_path).project(packet)
    assert edition == original_edition
    assert packet == original_packet


async def test_cid_in_plain_prose_does_not_require_chart(tmp_path, edition):
    edition["rendered"] = {
        "html": "<p>The identifier is cid:newsletter-chart.</p>",
        "text": "The identifier is cid:newsletter-chart.\n",
        "chart_png": "",
    }
    edition["rendered"]["render_hash"] = contracts.content_hash(
        edition["rendered"]
    )
    assert (await adapters.FakeMail(tmp_path).send(edition, "prose"))[
        "delivery_state"
    ] == "simulated"
