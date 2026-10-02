"""Notion V2 boundary tests: synthetic schemas and MockTransport only."""

import copy
import hashlib
import json
import uuid

import httpx
import pytest

import newsletter.adapters as adapters
import newsletter.notion_api as notion_api

MATERIAL = "11111111-1111-4111-8111-111111111111"
EDITION = "22222222-2222-4222-8222-222222222222"
PAGE = "33333333-3333-4333-8333-333333333333"
UPLOAD = "44444444-4444-4444-8444-444444444444"
TOKEN = "synthetic-test-token-not-a-real-secret"
PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-transport-payload"


def rich(text):
    return [{"type": "text", "text": {"content": text}}]


def paragraph(text="Offline content"):
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {"rich_text": rich(text)},
    }


def source(kind, *, complete=True):
    properties = {
        "My own title": {
            "id": "title",
            "name": "My own title",
            "type": "title",
            "title": {},
        }
    }
    if complete:
        for key, spec in notion_api.SCHEMAS[kind].items():
            if key == "title":
                continue
            detail = {}
            if spec.type in {"select", "multi_select"}:
                detail = {
                    "options": [
                        {"name": name, "id": str(index)}
                        for index, name in enumerate(spec.options)
                    ]
                }
            elif spec.type == "relation":
                detail = {
                    "data_source_id": EDITION
                    if kind == "material"
                    else MATERIAL,
                    "single_property": {},
                }
            properties[spec.name] = {
                "id": kind + "-" + key,
                "type": spec.type,
                "name": spec.name,
                spec.type: detail,
            }
    return {
        "object": "data_source",
        "id": MATERIAL if kind == "material" else EDITION,
        "in_trash": False,
        "properties": properties,
    }


class Rig:
    def __init__(self, complete=True):
        self.sources = {
            MATERIAL: source("material", complete=complete),
            EDITION: source("edition", complete=complete),
        }
        self.requests = []
        self.extra = None
        self.api = notion_api.NotionWorkspace(
            TOKEN, MATERIAL, EDITION, transport=httpx.MockTransport(self.handle)
        )

    def handle(self, request):
        self.requests.append(request)
        assert (
            request.url.scheme == "https"
            and request.url.host == "api.notion.com"
        )
        assert request.headers["Authorization"] == "Bearer " + TOKEN
        assert (
            request.headers["Notion-Version"]
            == notion_api.API_VERSION
            == "2026-03-11"
        )
        if request.url.path.startswith(
            "/v1/data_sources/"
        ) and not request.url.path.endswith("/query"):
            target = request.url.path.rsplit("/", 1)[1]
            if request.method == "PATCH":
                body = json.loads(request.content)
                assert set(body) == {"properties"}
                for name, value in body["properties"].items():
                    assert name not in self.sources[target]["properties"]
                    kind = next(iter(value))
                    self.sources[target]["properties"][name] = {
                        "id": "new-"
                        + str(len(self.sources[target]["properties"])),
                        "name": name,
                        "type": kind,
                        **value,
                    }
            return httpx.Response(200, json=self.sources[target])
        if self.extra:
            return self.extra(request)
        return httpx.Response(
            200, json={"object": "page", "id": PAGE, "properties": {}}
        )

    def mutations(self):
        return [
            r
            for r in self.requests
            if r.method == "PATCH"
            or (r.method == "POST" and not r.url.path.endswith("/query"))
        ]


@pytest.fixture(autouse=True)
def forbid_real_network(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Real network is forbidden in Notion adapter unit tests")

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", forbidden
    )


@pytest.mark.parametrize(
    "args",
    [
        ("short", MATERIAL, EDITION),
        (TOKEN + "\n", MATERIAL, EDITION),
        (TOKEN, "https://example.org", EDITION),
        (TOKEN, MATERIAL, MATERIAL),
    ],
)
def test_invalid_configuration_never_opens_network(args):
    with pytest.raises(
        adapters.AdapterError, match="INVALID_NOTION_CONFIGURATION"
    ):
        notion_api.NotionWorkspace(*args)


async def test_read_only_setup_and_validation_never_create_columns():
    rig = Rig(complete=False)
    original = copy.deepcopy(rig.sources)
    result = await rig.api.setup()
    assert result["ready"] is False and result["applied"] is False
    assert "title" not in result["missing"]["material"]
    assert "sync_key" in result["missing"]["material"]
    assert result["bindings"]["edition"] == {"title": "title"}
    with pytest.raises(adapters.AdapterError, match="NOTION_SCHEMA_MISSING"):
        await rig.api.validate()
    assert rig.sources == original and not rig.mutations()


async def test_setup_inspects_both_and_adds_only_missing_columns():
    rig = Rig(complete=False)
    rig.sources[MATERIAL]["properties"]["My notes"] = {
        "id": "notes",
        "type": "rich_text",
        "rich_text": {},
    }
    result = await rig.api.setup(apply=True)
    assert result["ready"] is True and result["applied"] is True
    assert [(r.method, r.url.path) for r in rig.requests[:2]] == [
        ("GET", "/v1/data_sources/" + MATERIAL),
        ("GET", "/v1/data_sources/" + EDITION),
    ]
    assert len(rig.mutations()) == 2
    for kind, target, opposite, relation in (
        ("material", MATERIAL, EDITION, "见于简报"),
        ("edition", EDITION, MATERIAL, "收录材料"),
    ):
        props = rig.sources[target]["properties"]
        assert "My own title" in props and "名称" not in props
        assert props[relation]["relation"] == {
            "data_source_id": opposite,
            "type": "single_property",
            "single_property": {},
        }
        assert len(rig.api.property_ids(kind)) == len(notion_api.SCHEMAS[kind])
    assert rig.sources[MATERIAL]["properties"]["My notes"]["id"] == "notes"
    assert (await rig.api.setup(apply=True))["ready"] is True
    assert (
        len(rig.mutations()) == 2
    )  # An explicit second inspection is a no-op.


@pytest.mark.parametrize(
    "defect", ["type", "relation", "options", "title", "trash", "identity"]
)
async def test_wrong_second_schema_prevents_any_write_to_first(defect):
    rig = Rig()
    rig.sources[MATERIAL] = source("material", complete=False)
    second = rig.sources[EDITION]
    if defect == "type":
        second["properties"]["刊期"]["type"] = "rich_text"
    elif defect == "relation":
        second["properties"]["收录材料"]["relation"]["data_source_id"] = PAGE
    elif defect == "options":
        second["properties"]["发送状态"]["select"]["options"] = []
    elif defect == "title":
        second["properties"]["second title"] = {
            "id": "other-title",
            "type": "title",
        }
    elif defect == "trash":
        second["in_trash"] = True
    else:
        second["id"] = PAGE
    with pytest.raises(adapters.AdapterError, match="NOTION_SCHEMA_MISMATCH"):
        await rig.api.setup(apply=True)
    assert len(rig.requests) == 2 and not rig.mutations()


async def test_stable_ids_survive_user_renames_but_not_property_replacement():
    rig = Rig()
    await rig.api.validate()
    properties = rig.sources[MATERIAL]["properties"]
    properties["Renamed by reader"] = properties.pop("一句话价值")
    await rig.api.validate()
    assert rig.api.property_ids("material")["value"] == "material-value"
    changed_copy = rig.api.property_ids("material")
    changed_copy["value"] = "not-the-id"
    assert rig.api.property_ids("material")["value"] == "material-value"
    properties["Renamed by reader"]["id"] = "replacement"
    with pytest.raises(adapters.AdapterError, match="NOTION_SCHEMA_MISMATCH"):
        await rig.api.validate()


@pytest.mark.parametrize("managed", [False, True])
async def test_dual_relations_cannot_modify_unmanaged_reverse(
    managed,
):
    rig = Rig()
    rig.sources[MATERIAL]["properties"]["见于简报"]["relation"][
        "dual_property"
    ] = {
        "synced_property_id": "edition-material_ids"
        if managed
        else "personal-notes",
        "synced_property_name": "User may rename the paired managed column",
    }
    if managed:
        await rig.api.validate()
    else:
        with pytest.raises(
            adapters.AdapterError, match="NOTION_SCHEMA_MISMATCH"
        ):
            await rig.api.setup(apply=True)
    assert not rig.mutations()


async def test_properties_and_patches_use_stable_ids_not_user_fields():
    rig = Rig()
    original = {
        "title": {"title": rich("Synthetic title")},
        "value": {"rich_text": rich("Synthetic value")},
        "category": {"select": {"name": "AI/ML"}},
    }
    before = copy.deepcopy(original)
    assert await rig.api.create("material", original) == PAGE
    create = json.loads(rig.mutations()[0].content)
    assert set(create) == {"parent", "properties"}
    assert create["parent"] == {
        "type": "data_source_id",
        "data_source_id": MATERIAL,
    }
    assert set(create["properties"]) == {
        "title",
        "material-value",
        "material-category",
    }
    assert "children" not in create and original == before
    await rig.api.patch(
        "material",
        PAGE,
        {
            "edition_ids": {"relation": [{"id": PAGE}]},
            "fixture": {"checkbox": False},
        },
    )
    patch = json.loads(rig.mutations()[-1].content)
    assert set(patch) == {"properties"}
    assert patch["properties"]["material-edition_ids"] == {
        "relation": [{"id": PAGE}]
    }


async def test_property_value_reads_stable_id_not_visible_column_name():
    rig = Rig()
    await rig.api.validate()
    page = {
        "properties": {
            "Human rename": {
                "id": "edition-render_hash",
                "type": "rich_text",
                "rich_text": rich("frozen"),
            }
        }
    }
    value = rig.api.property_value("edition", page, "render_hash")
    assert value["rich_text"] == rich("frozen")
    value["rich_text"].clear()
    assert page["properties"]["Human rename"]["rich_text"] == rich("frozen")
    with pytest.raises(adapters.AdapterError, match="NOTION_SCHEMA_MISMATCH"):
        rig.api.property_value("edition", page, "content_hash")


@pytest.mark.parametrize(
    "properties",
    [
        {"unknown": {"rich_text": []}},
        {"title": {"rich_text": rich("wrong")}},
        {"value": {"rich_text": rich("😀" * 1001)}},
        {"value": {"rich_text": [rich("x")[0]] * 101}},
        {"value": {"rich_text": ["not-an-object"]}},
        {"category": {"select": {"name": "Invented category"}}},
        {"topics": {"multi_select": [{"name": "a,b"}]}},
        {"fixture": {"checkbox": "false"}},
        {"url": {"url": "http://127.0.0.1/private"}},
        {"edition_ids": {"relation": [{"id": "../../etc"}]}},
        {"published_at": {"date": {"start": None}}},
        {"published_at": {"date": {"start": "not-a-date"}}},
    ],
)
async def test_invalid_properties_are_rejected_before_even_schema_reads(
    properties,
):
    rig = Rig()
    with pytest.raises(adapters.AdapterError, match="INVALID_NOTION_INPUT"):
        await rig.api.patch("material", PAGE, properties)
    assert not rig.requests


async def test_utf16_boundary_and_optional_empty_metadata_are_preserved():
    rig = Rig()
    await rig.api.patch(
        "material",
        PAGE,
        {
            "value": {"rich_text": rich("😀" * 1000)},
            "url": {"url": None},
            "published_at": {"date": None},
            "topics": {"multi_select": [{"name": "Information retrieval"}]},
        },
    )
    assert len(rig.mutations()) == 1


async def test_lookup_paginates_duplicates_without_following_urls():
    rig = Rig()
    key = "material:synthetic-key"
    page = {
        "object": "page",
        "id": PAGE,
        "url": "https://example.org/not-followed",
    }

    def response(request):
        data = json.loads(request.content)
        assert data["filter"] == {
            "property": "material-sync_key",
            "rich_text": {"equals": key},
        }
        assert data["page_size"] == 100
        more = "start_cursor" not in data
        if not more:
            assert data["start_cursor"] == "opaque/cursor?not=a-url"
        return httpx.Response(
            200,
            json={
                "object": "list",
                "results": [page],
                "has_more": more,
                "next_cursor": "opaque/cursor?not=a-url" if more else None,
            },
        )

    rig.extra = response
    assert await rig.api.lookup("material", key) == [page, page]
    assert not rig.mutations()
    assert len(rig.requests) == 4


async def test_children_pagination_keeps_top_level_and_image_urls():
    rig = Rig()
    image = {
        "object": "block",
        "id": PAGE,
        "type": "image",
        "image": {
            "type": "file",
            "file": {
                "url": "https://example.org/chart-deadbeef.png?signed=x",
                "expiry_time": "2026-09-07T01:00:00Z",
            },
        },
        "has_children": False,
    }

    def response(request):
        assert (
            request.method == "GET"
            and request.url.path == "/v1/blocks/" + PAGE + "/children"
        )
        more = "start_cursor" not in request.url.params
        return httpx.Response(
            200,
            json={
                "object": "list",
                "results": [image],
                "has_more": more,
                "next_cursor": "cursor" if more else None,
            },
        )

    rig.extra = response
    assert await rig.api.children(PAGE) == [image, image]
    assert len(rig.requests) == 2


@pytest.mark.parametrize("repeat", [False, True])
async def test_pagination_limit_repeated_cursor_never_return_partial_success(
    monkeypatch, repeat
):
    monkeypatch.setattr("newsletter.notion_api.MAX_PAGES", 2)
    rig = Rig()
    rig.extra = lambda request: httpx.Response(
        200,
        json={
            "object": "list",
            "results": [],
            "has_more": True,
            "next_cursor": "same" if repeat else str(len(rig.requests)),
        },
    )
    with pytest.raises(
        adapters.AdapterError,
        match="NOTION_INVALID_RESPONSE"
        if repeat
        else "NOTION_PAGINATION_LIMIT",
    ):
        await rig.api.children(PAGE)
    assert len(rig.requests) == 2


async def test_append_is_one_bounded_request_and_preserves_returned_ids():
    rig = Rig()
    blocks = [
        paragraph("Synthetic text"),
        {
            "object": "block",
            "type": "image",
            "image": {"type": "file_upload", "file_upload": {"id": UPLOAD}},
        },
    ]
    result = [
        {"object": "block", "id": str(uuid.UUID(int=i + 1)), **block}
        for i, block in enumerate(blocks)
    ]
    rig.extra = lambda request: httpx.Response(
        200, json={"object": "list", "results": result, "has_more": False}
    )
    assert await rig.api.append(PAGE, blocks) == result
    assert json.loads(rig.requests[0].content) == {"children": blocks}
    assert len(rig.requests) == 1


@pytest.mark.parametrize(
    "blocks",
    [
        [],
        [paragraph()] * 101,
        [paragraph("x" * 2001)],
        [paragraph("x" * 2000)] * 100 + [paragraph()],
        [None],
    ],
)
async def test_bad_or_oversized_blocks_fail_before_network(blocks):
    rig = Rig()
    with pytest.raises(adapters.AdapterError, match="INVALID_NOTION_INPUT"):
        await rig.api.append(PAGE, blocks)
    assert not rig.requests


async def test_json_byte_limit_checked_independently_of_text_array_limits():
    rig = Rig()
    with pytest.raises(adapters.AdapterError, match="INVALID_NOTION_INPUT"):
        await rig.api.append(PAGE, [paragraph("界" * 2000)] * 100)
    assert not rig.requests


async def test_total_nested_blocks_unresolved_chart_placeholders_rejected():
    rig = Rig()
    table = {
        "object": "block",
        "type": "table",
        "table": {
            "table_width": 1,
            "children": [
                {
                    "object": "block",
                    "type": "table_row",
                    "table_row": {"cells": [rich("x")]},
                }
            ]
            * 100,
        },
    }
    for blocks in (
        [table] * 10,
        [{"type": "_newsletter_chart", "_newsletter_chart": {}}],
        [{"type": [], "paragraph": {}}],
    ):
        with pytest.raises(adapters.AdapterError, match="INVALID_NOTION_INPUT"):
            await rig.api.append(PAGE, blocks)
    assert not rig.requests


@pytest.mark.parametrize("method", ["patch", "append"])
async def test_malformed_mutation_success_receipt_is_unknown_not_retryable(
    method,
):
    rig = Rig()
    rig.extra = lambda request: httpx.Response(
        200,
        json={
            "object": "list",
            "results": [{"id": "bad", "object": "block"}],
            "has_more": False,
        },
    )
    if method == "patch":
        operation = rig.api.patch(
            "edition", PAGE, {"delivery": {"select": {"name": "未发送"}}}
        )
    else:
        operation = rig.api.append(PAGE, [paragraph()])
    with pytest.raises(adapters.AdapterError) as exc:
        await operation
    assert exc.value.code == "NOTION_UNKNOWN" and exc.value.ambiguous
    assert len(rig.mutations()) == 1


@pytest.mark.parametrize(
    "bad_reply", ["invalid-schema", "missing-added-column"]
)
async def test_bad_schema_patch_success_stops_before_second_write(
    bad_reply,
):
    rig = Rig(complete=False)
    original = rig.api._transport.handler

    def response(request):
        if request.method == "PATCH":
            rig.requests.append(request)
            value = (
                {}
                if bad_reply == "invalid-schema"
                else source("material", complete=False)
            )
            return httpx.Response(200, json=value)
        return original(request)

    rig.api._transport = httpx.MockTransport(response)
    with pytest.raises(adapters.AdapterError) as exc:
        await rig.api.setup(apply=True)
    assert exc.value.code == "NOTION_UNKNOWN" and exc.value.ambiguous
    assert len(rig.mutations()) == 1


@pytest.mark.parametrize(
    "status,headers,content,code",
    [
        (302, {"location": "https://example.org"}, b"", "NOTION_REJECTED"),
        (200, {"content-type": "text/html"}, b"{}", "NOTION_INVALID_RESPONSE"),
        (
            200,
            {"content-type": "application/json"},
            b'{"id":1,"id":2}',
            "NOTION_INVALID_RESPONSE",
        ),
    ],
)
async def test_read_redirect_content_type_and_duplicate_json_are_hard_errors(
    status, headers, content, code
):
    rig = Rig()
    rig.extra = lambda request: httpx.Response(
        status, headers=headers, content=content
    )
    with pytest.raises(adapters.AdapterError) as exc:
        await rig.api.get_page(PAGE)
    assert exc.value.code == code and not exc.value.ambiguous
    assert len(rig.requests) == 1


@pytest.mark.parametrize(
    "status,code,ambiguous",
    [
        (401, "NOTION_AUTH_REJECTED", False),
        (403, "NOTION_AUTH_REJECTED", False),
        (400, "NOTION_REJECTED", False),
        (404, "NOTION_REJECTED", False),
        (429, "NOTION_RATE_LIMITED", False),
        (408, "NOTION_UNKNOWN", True),
        (409, "NOTION_UNKNOWN", True),
        (500, "NOTION_UNKNOWN", True),
        (503, "NOTION_UNKNOWN", True),
        (307, "NOTION_UNKNOWN", True),
    ],
)
async def test_mutation_failure_never_retries_or_leaks_diagnostics(
    status, code, ambiguous
):
    rig = Rig()
    rig.extra = lambda request: httpx.Response(
        status,
        headers={"Location": "https://example.org/leak", "Retry-After": "1"},
        json={"message": TOKEN + " private provider diagnostic"},
    )
    with pytest.raises(adapters.AdapterError) as exc:
        await rig.api.append(PAGE, [paragraph()])
    assert exc.value.code == code and exc.value.ambiguous is ambiguous
    assert TOKEN not in str(exc.value) and "diagnostic" not in str(exc.value)
    assert len(rig.requests) == 1


@pytest.mark.parametrize(
    "payload",
    [{}, {"object": "page", "id": "bad-id"}, {"object": "error", "id": PAGE}],
)
async def test_bad_create_success_response_is_ambiguous(payload):
    rig = Rig()
    rig.extra = lambda request: httpx.Response(200, json=payload)
    with pytest.raises(adapters.AdapterError) as exc:
        await rig.api.create("material", {"title": {"title": rich("fixture")}})
    assert exc.value.code == "NOTION_UNKNOWN" and exc.value.ambiguous
    assert len(rig.mutations()) == 1


@pytest.mark.parametrize("mutation", [False, True])
@pytest.mark.parametrize(
    "failure", ["network", "bad-json", "duplicate-json", "large-json", "server"]
)
async def test_unknown_read_vs_write_classification(
    monkeypatch, mutation, failure
):
    monkeypatch.setattr("newsletter.notion_api.MAX_RESPONSE_BYTES", 100)
    rig = Rig()

    def response(request):
        if failure == "network":
            raise httpx.ReadTimeout(TOKEN, request=request)
        if failure == "bad-json":
            return httpx.Response(200, text=TOKEN)
        if failure == "duplicate-json":
            return httpx.Response(
                200, text='{"object":"page","object":"error"}'
            )
        if failure == "large-json":
            return httpx.Response(200, json={"value": "x" * 101})
        return httpx.Response(503, text=TOKEN)

    rig.extra = response
    operation = (
        rig.api.append(PAGE, [paragraph()])
        if mutation
        else rig.api.get_page(PAGE)
    )
    with pytest.raises(adapters.AdapterError) as exc:
        await operation
    read_code = (
        "NOTION_UNAVAILABLE"
        if failure in {"network", "server"}
        else "NOTION_INVALID_RESPONSE"
    )
    assert exc.value.code == ("NOTION_UNKNOWN" if mutation else read_code)
    assert exc.value.ambiguous is mutation and TOKEN not in str(exc.value)
    assert len(rig.requests) == 1


async def test_upload_png_uses_two_fixed_endpoints_sha_filename_and_multipart():
    rig = Rig()
    filename = "chart-" + hashlib.sha256(PNG).hexdigest() + ".png"

    def response(request):
        if request.url.path == "/v1/file_uploads":
            assert json.loads(request.content) == {
                "mode": "single_part",
                "filename": filename,
                "content_type": "image/png",
            }
            return httpx.Response(
                200,
                json={
                    "object": "file_upload",
                    "id": UPLOAD,
                    "status": "pending",
                    "upload_url": "https://example.org/must-not-follow",
                },
            )
        assert request.url.path == "/v1/file_uploads/" + UPLOAD + "/send"
        assert request.headers["content-type"].startswith(
            "multipart/form-data; boundary="
        )
        assert PNG in request.content and filename.encode() in request.content
        return httpx.Response(
            200,
            json={
                "object": "file_upload",
                "id": UPLOAD,
                "status": "uploaded",
                "filename": filename,
            },
        )

    rig.extra = response
    assert await rig.api.upload_png(PNG) == UPLOAD
    assert len(rig.requests) == 2


@pytest.mark.parametrize(
    "png", [b"not-png", b"", PNG + b"x" * notion_api.MAX_PNG_BYTES]
)
async def test_invalid_or_too_large_png_does_not_create_a_file_upload(png):
    rig = Rig()
    with pytest.raises(adapters.AdapterError, match="INVALID_NOTION_INPUT"):
        await rig.api.upload_png(png)
    assert not rig.requests


async def test_upload_send_timeout_ambiguous_never_repeat_either_phase():
    rig = Rig()

    def response(request):
        if request.url.path == "/v1/file_uploads":
            return httpx.Response(
                200,
                json={
                    "object": "file_upload",
                    "id": UPLOAD,
                    "status": "pending",
                },
            )
        raise httpx.ReadTimeout("private", request=request)

    rig.extra = response
    with pytest.raises(adapters.AdapterError) as exc:
        await rig.api.upload_png(PNG)
    assert exc.value.code == "NOTION_UNKNOWN" and exc.value.ambiguous
    assert len(rig.requests) == 2
