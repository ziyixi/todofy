"""Bounded Notion 2026-03-11 HTTP/schema calls with caller-journaled writes.

No retries, environment loading, database access or arbitrary URL following.
References: developers.notion.com/reference/{property-object,request-limits},
and /guides/get-started/upgrade-guide-2026-03-11. Schema setup is explicit and
additive, not an atomic migration: inspect both sources before the first PATCH.
"""

from __future__ import annotations

import copy
import dataclasses
import datetime
import hashlib
import json
import math
import re
from typing import Any, cast
import uuid

import httpx

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.types as types

API_VERSION = "2026-03-11"
MAX_JSON_BYTES = 500_000
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 20
MAX_PNG_BYTES = 5 * 1024 * 1024
_UUID = re.compile(
    "(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12"
    "})\\Z"
)
_CATEGORIES = ("AI/ML", "科学", "世界", "经济", "健康", "技术")
_BLOCK_TYPES = frozenset(
    {
        "paragraph",
        "heading_1",
        "heading_2",
        "heading_3",
        "bulleted_list_item",
        "numbered_list_item",
        "quote",
        "callout",
        "divider",
        "image",
        "table",
        "table_row",
        "toggle",
        "code",
        "equation",
        "bookmark",
    }
)


@dataclasses.dataclass(frozen=True)
class Property:
    """Required column name, Notion type, and allowed managed option names."""

    name: str
    type: str
    options: tuple[str, ...] = ()


COMMON = {
    "title": Property("名称", "title"),
    "sync_key": Property("同步键", "rich_text"),
    "content_hash": Property("内容Hash", "rich_text"),
    "sync_state": Property("同步状态", "select", ("同步中", "已同步")),
    "fixture": Property("测试数据", "checkbox"),
}
SCHEMAS = {
    "material": {
        **COMMON,
        "category": Property("领域", "select", _CATEGORIES),
        "topics": Property("主题", "multi_select"),
        "material_type": Property(
            "材料类型",
            "select",
            ("论文", "预印本", "技术报告", "新闻", "数据", "未分类"),
        ),
        "value": Property("一句话价值", "rich_text"),
        "url": Property("原始链接", "url"),
        "published_at": Property("发表日期", "date"),
        "first_seen": Property("首次发现", "date"),
        "progress": Property(
            "采编进度", "select", ("候选", "已研究", "继续跟进", "已刊出")
        ),
        "authors": Property("作者", "rich_text"),
        "affiliations": Property("机构", "rich_text"),
        "venue": Property("刊会／发布方", "rich_text"),
        "publication_status": Property("发表状态", "rich_text"),
        "access_scope": Property(
            "已读范围", "select", ("仅线索", "摘要", "全文")
        ),
        "direction": Property("采集方向", "multi_select"),
        "version": Property("来源版本", "rich_text"),
        "edition_ids": Property("见于简报", "relation"),
    },
    "edition": {
        **COMMON,
        "issue_date": Property("刊期", "date"),
        "edition_type": Property(
            "版本类型", "select", ("日常", "测试", "修订")
        ),
        "overview": Property("本期概览", "rich_text"),
        "categories": Property("涉及领域", "multi_select", _CATEGORIES),
        "material_ids": Property("收录材料", "relation"),
        "delivery": Property(
            "发送状态",
            "select",
            (
                "未发送",
                "发送中",
                "已提交",
                "已确认投递",
                "失败",
                "结果未知",
                "模拟",
            ),
        ),
        "tokens": Property("Token总量", "number"),
        "input_tokens": Property("输入Token", "number"),
        "cached_tokens": Property("缓存输入Token", "number"),
        "output_tokens": Property("输出Token", "number"),
        "usage_partial": Property("用量不完整", "checkbox"),
        "contains_personal": Property("包含私人事件", "checkbox"),
        "edition_id": Property("Edition ID", "rich_text"),
        "run_id": Property("Run ID", "rich_text"),
        "render_hash": Property("邮件Hash", "rich_text"),
    },
}


def _id(value: Any, code: str = "INVALID_NOTION_INPUT") -> str:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise adapters.AdapterError(code)
    return str(uuid.UUID(value))


def _received_id(value: Any) -> str:
    try:
        return _id(value)
    except adapters.AdapterError:
        raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True) from None


def _text(value: Any, limit: int = 2000, *, nonempty: bool = False) -> str:
    try:
        if not isinstance(value, str) or (nonempty and not value.strip()):
            raise ValueError
        if len(value.encode("utf-16-le")) // 2 > limit or "\x00" in value:
            raise ValueError
    except (ValueError, UnicodeError):
        raise adapters.AdapterError("INVALID_NOTION_INPUT") from None
    return value


def _scan(value: Any, *, depth: int = 0) -> None:
    """Check JSON depth and Notion text/list limits before dispatch."""
    if depth > 20:
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    if isinstance(value, dict):
        for key, item in value.items():
            _text(key, 100, nonempty=True)
            if key == "url" and isinstance(item, str):
                try:
                    contracts.validate_public_url(_text(item))
                except contracts.ContractError:
                    raise adapters.AdapterError(
                        "INVALID_NOTION_INPUT"
                    ) from None
            if key == "expression":
                _text(item, 1000)
            _scan(item, depth=depth + 1)
    elif isinstance(value, list):
        if len(value) > 100:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        for item in value:
            _scan(item, depth=depth + 1)
    elif isinstance(value, str):
        _text(value)
    elif value is not None:
        if type(value) not in {bool, int, float}:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        if isinstance(value, float) and not math.isfinite(value):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        if isinstance(value, int) and value.bit_length() > 1024:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")


def _json(value: types.Payload) -> bytes:
    _scan(value)
    try:
        encoded = json.dumps(
            value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode()
    except (ValueError, TypeError, UnicodeError):
        raise adapters.AdapterError("INVALID_NOTION_INPUT") from None
    if len(encoded) > MAX_JSON_BYTES:
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    return encoded


def _unique(pairs: list[tuple[str, Any]]) -> types.Payload:
    result: types.Payload = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _blocks(values: list[types.Payload], *, depth: int = 0) -> int:
    if depth > 1 or not 1 <= len(values) <= 100:
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    count = len(values)
    for block in values:
        if (
            not isinstance(block, dict)
            or not isinstance(block.get("type"), str)
            or block["type"] not in _BLOCK_TYPES
        ):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        body = block.get(block["type"])
        if not isinstance(body, dict):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        children = body.get("children")
        if children is not None:
            if not isinstance(children, list):
                raise adapters.AdapterError("INVALID_NOTION_INPUT")
            count += _blocks(children, depth=depth + 1)
    if count > 1000:
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    return count


def _missing_property(spec: Property, target: str) -> types.Payload:
    detail: types.Payload = {}
    if spec.type in {"select", "multi_select"}:
        detail = {"options": [{"name": name} for name in spec.options]}
    elif spec.type == "relation":
        detail = {
            "data_source_id": target,
            "type": "single_property",
            "single_property": {},
        }
    elif spec.type == "number":
        detail = {"format": "number"}
    return {spec.type: detail}


def _schema_property_id(
    prop: types.Payload, spec: Property, target: str
) -> str:
    if (
        prop.get("type") != spec.type
        or not isinstance(prop.get("id"), str)
        or not prop["id"]
    ):
        raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
    if spec.type == "relation":
        relation = prop.get("relation", {})
        if (
            not isinstance(relation, dict)
            or _id(relation.get("data_source_id"), "NOTION_SCHEMA_MISMATCH")
            != target
        ):
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
    if spec.options:
        detail = prop.get(spec.type, {})
        options = detail.get("options", []) if isinstance(detail, dict) else []
        if (
            not isinstance(options, list)
            or any(
                not isinstance(o, dict) or not isinstance(o.get("name"), str)
                for o in options
            )
            or not set(spec.options).issubset({o.get("name") for o in options})
        ):
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
    return cast(str, prop["id"])


def _validate_text_property(inner: Any) -> None:
    for fragment in inner:
        if (
            not isinstance(fragment, dict)
            or fragment.get("type", "text") != "text"
            or not isinstance(fragment.get("text"), dict)
        ):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        _text(fragment["text"].get("content"))


def _validate_relation_property(inner: Any) -> None:
    for ref in inner:
        if not isinstance(ref, dict) or set(ref) != {"id"}:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        _id(ref["id"])


def _validate_options_property(spec: Property, inner: Any) -> None:
    if spec.type == "multi_select":
        options = inner
    elif inner is None:
        options = []
    else:
        options = [inner]
    for option in options:
        if not isinstance(option, dict) or set(option) != {"name"}:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        name = _text(option["name"], 100, nonempty=True)
        if "," in name or (spec.options and name not in spec.options):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")


def _validate_date_property(inner: Any) -> None:
    try:
        if not isinstance(inner, dict) or not {"start"} <= inner.keys() <= {
            "start",
            "end",
            "time_zone",
        }:
            raise ValueError
        if not isinstance(inner.get("start"), str):
            raise ValueError
        for name in ("start", "end"):
            if name in inner and inner[name] is not None:
                datetime.datetime.fromisoformat(
                    inner[name].replace("Z", "+00:00")
                )
    except (ValueError, TypeError, AttributeError):
        raise adapters.AdapterError("INVALID_NOTION_INPUT") from None


def _validate_property(spec: Property, value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {spec.type}:
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    inner = value[spec.type]
    if spec.type in {
        "title",
        "rich_text",
        "relation",
        "multi_select",
    } and not isinstance(inner, list):
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    if spec.type in {"title", "rich_text"}:
        _validate_text_property(inner)
    if spec.type == "checkbox" and type(inner) is not bool:
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    if spec.type == "url" and inner is not None and not isinstance(inner, str):
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    if (
        spec.type == "number"
        and inner is not None
        and (type(inner) not in {int, float} or not math.isfinite(inner))
    ):
        raise adapters.AdapterError("INVALID_NOTION_INPUT")
    if spec.type == "relation":
        _validate_relation_property(inner)
    if spec.type in {"select", "multi_select"}:
        _validate_options_property(spec, inner)
    if spec.type == "date" and inner is not None:
        _validate_date_property(inner)


class NotionWorkspace:
    """Bind two managed data sources and perform bounded, one-attempt calls.

    Readers validate stable property IDs without changing user-owned fields.
    Callers must journal write intent before dispatch and retain unknown
    outcomes; this adapter does not retry or persist external write receipts.
    """

    def __init__(
        self,
        token: str,
        materials_id: str,
        editions_id: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if (
            not isinstance(token, str)
            or not 24 <= len(token) <= 512
            or any(not 33 <= ord(c) <= 126 for c in token)
        ):
            raise adapters.AdapterError("INVALID_NOTION_CONFIGURATION")
        self._token = token
        self._sources = {
            "material": _id(materials_id, "INVALID_NOTION_CONFIGURATION"),
            "edition": _id(editions_id, "INVALID_NOTION_CONFIGURATION"),
        }
        if self._sources["material"] == self._sources["edition"]:
            raise adapters.AdapterError("INVALID_NOTION_CONFIGURATION")
        self._transport = transport
        self._bindings: dict[str, dict[str, str]] = {}

    async def _request(
        self,
        method: str,
        path: str,
        *,
        payload: types.Payload | None = None,
        params: dict[str, str | int] | None = None,
        mutation: bool = False,
        file: tuple[str, bytes, str] | None = None,
    ) -> types.Payload:
        body = _json(payload) if payload is not None else None
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Notion-Version": API_VERSION,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        unknown = "NOTION_UNKNOWN" if mutation else "NOTION_UNAVAILABLE"
        invalid = "NOTION_UNKNOWN" if mutation else "NOTION_INVALID_RESPONSE"
        try:
            async with (
                httpx.AsyncClient(
                    transport=self._transport,
                    timeout=30,
                    follow_redirects=False,
                    trust_env=False,
                ) as client,
                client.stream(
                    method,
                    "https://api.notion.com/v1/" + path,
                    headers=headers,
                    content=body,
                    params=params,
                    files={"file": file} if file else None,
                ) as response,
            ):
                status = response.status_code
                if status == 429:
                    raise adapters.AdapterError("NOTION_RATE_LIMITED")
                if status in {401, 403}:
                    raise adapters.AdapterError("NOTION_AUTH_REJECTED")
                if 400 <= status < 500 and status not in {408, 409}:
                    raise adapters.AdapterError("NOTION_REJECTED")
                if 300 <= status < 400 and not mutation:
                    raise adapters.AdapterError("NOTION_REJECTED")
                if not 200 <= status < 300:
                    raise adapters.AdapterError(unknown, ambiguous=mutation)
                if (
                    response.headers.get("content-type", "")
                    .split(";", 1)[0]
                    .strip()
                    .lower()
                    != "application/json"
                ):
                    raise adapters.AdapterError(invalid, ambiguous=mutation)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise adapters.AdapterError(invalid, ambiguous=mutation)
        except (httpx.RequestError, TimeoutError):
            raise adapters.AdapterError(unknown, ambiguous=mutation) from None
        try:
            value = json.loads(data, object_pairs_hook=_unique)
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (ValueError, UnicodeError):
            raise adapters.AdapterError(invalid, ambiguous=mutation) from None

    def _kind(self, kind: str) -> dict[str, Property]:
        if not isinstance(kind, str) or kind not in SCHEMAS:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        return SCHEMAS[kind]

    def property_ids(self, kind: str) -> dict[str, str]:
        """Return a copy of the currently validated logical-key ID bindings."""
        self._kind(kind)
        return dict(self._bindings.get(kind, {}))

    def property_value(
        self, kind: str, page: types.Payload, key: str
    ) -> types.Payload:
        """Read one bound property by stable ID, allowing visible renames.

        The returned property is a copy. Missing or duplicated IDs raise a
        schema mismatch instead of selecting a similarly named user field.
        """
        identifier = self.property_ids(kind).get(key)
        props = page.get("properties") if isinstance(page, dict) else None
        if not isinstance(props, dict) or any(
            not isinstance(p, dict) for p in props.values()
        ):
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        matches = [p for p in props.values() if p.get("id") == identifier]
        if identifier is None or len(matches) != 1:
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        return copy.deepcopy(matches[0])

    def _schema(
        self, kind: str, source: types.Payload
    ) -> tuple[dict[str, str], types.Payload]:
        if (
            source.get("object") != "data_source"
            or _id(source.get("id"), "NOTION_SCHEMA_MISMATCH")
            != self._sources[kind]
            or source.get("in_trash") is True
        ):
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        props = source.get("properties")
        if not isinstance(props, dict) or any(
            not isinstance(p, dict) for p in props.values()
        ):
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        titles = [p for p in props.values() if p.get("type") == "title"]
        if len(titles) != 1:
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        bound, missing = {}, {}
        for key, spec in self._kind(kind).items():
            cached = self._bindings.get(kind, {}).get(key)
            if cached:
                matches = [p for p in props.values() if p.get("id") == cached]
                if len(matches) != 1:
                    raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
                prop = matches[0]
            else:
                prop = titles[0] if key == "title" else props.get(spec.name)
            target = self._sources[
                "edition" if kind == "material" else "material"
            ]
            if prop is None:
                missing[key] = _missing_property(spec, target)
                continue
            bound[key] = _schema_property_id(prop, spec, target)
        if len(set(bound.values())) != len(bound):
            raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        return bound, missing

    async def setup(self, apply: bool = False) -> types.Payload:
        """Inspect both schemas and optionally add their missing columns.

        Both sources must pass validation before the first write. Application
        is additive but not atomic across sources; an ambiguous PATCH stops
        further writes. The result reports readiness, bindings, and columns
        found missing during inspection.
        """
        if type(apply) is not bool:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        # Read AND validate both complete schemas before allowing either write.
        sources = {
            kind: await self._request("GET", "data_sources/" + identifier)
            for kind, identifier in self._sources.items()
        }
        checked = {
            kind: self._schema(kind, source) for kind, source in sources.items()
        }
        # A two-way relation must pair our two managed columns, not implicitly
        # change a different user-owned column when the outbox sets relations.
        for kind, relation_key, opposite, opposite_key in (
            ("material", "edition_ids", "edition", "material_ids"),
            ("edition", "material_ids", "material", "edition_ids"),
        ):
            relation_id = checked[kind][0].get(relation_key)
            if relation_id:
                prop = next(
                    p
                    for p in sources[kind]["properties"].values()
                    if p.get("id") == relation_id
                )
                dual = prop["relation"].get("dual_property")
                if dual is not None and (
                    not isinstance(dual, dict)
                    or not checked[opposite][0].get(opposite_key)
                    or dual.get("synced_property_id")
                    != checked[opposite][0][opposite_key]
                ):
                    raise adapters.AdapterError("NOTION_SCHEMA_MISMATCH")
        self._bindings = {kind: bound for kind, (bound, _) in checked.items()}
        missing = {
            kind: list(changes) for kind, (_, changes) in checked.items()
        }
        if apply:
            for kind, (_, changes) in checked.items():
                if changes:
                    response = await self._request(
                        "PATCH",
                        "data_sources/" + self._sources[kind],
                        mutation=True,
                        payload={
                            "properties": {
                                SCHEMAS[kind][key].name: value
                                for key, value in changes.items()
                            }
                        },
                    )
                    try:
                        bound, remaining = self._schema(kind, response)
                    except adapters.AdapterError:
                        raise adapters.AdapterError(
                            "NOTION_UNKNOWN", ambiguous=True
                        ) from None
                    if remaining:
                        raise adapters.AdapterError(
                            "NOTION_UNKNOWN", ambiguous=True
                        )
                    self._bindings[kind] = bound
        ready = all(
            len(self._bindings[kind]) == len(SCHEMAS[kind]) for kind in SCHEMAS
        )
        return {
            "ready": ready,
            "applied": apply,
            "missing": missing,
            "bindings": copy.deepcopy(self._bindings),
        }

    async def validate(self) -> None:
        """Require complete schemas without creating or changing columns."""
        if not (await self.setup())["ready"]:
            raise adapters.AdapterError("NOTION_SCHEMA_MISSING")

    async def _bound(self, kind: str) -> dict[str, str]:
        schema = self._kind(kind)
        if len(self._bindings.get(kind, {})) != len(schema):
            await self.validate()
        return self._bindings[kind]

    async def _pages(
        self, method: str, path: str, payload: types.Payload | None = None
    ) -> list[types.Payload]:
        results: list[types.Payload] = []
        seen: set[str] = set()
        cursor = None
        for _ in range(MAX_PAGES):
            page_params: types.Payload = {
                "page_size": 100,
                **({"start_cursor": cursor} if cursor else {}),
            }
            page = await self._request(
                method,
                path,
                payload={**(payload or {}), **page_params}
                if method == "POST"
                else None,
                params=page_params if method == "GET" else None,
            )
            values = page.get("results")
            if (
                page.get("object") != "list"
                or not isinstance(values, list)
                or len(values) > 100
                or any(not isinstance(v, dict) for v in values)
                or type(page.get("has_more")) is not bool
            ):
                raise adapters.AdapterError("NOTION_INVALID_RESPONSE")
            results.extend(values)
            if not page["has_more"]:
                return results
            cursor = page.get("next_cursor")
            if (
                not isinstance(cursor, str)
                or not 1 <= len(cursor) <= 2000
                or cursor in seen
            ):
                raise adapters.AdapterError("NOTION_INVALID_RESPONSE")
            seen.add(cursor)
        raise adapters.AdapterError("NOTION_PAGINATION_LIMIT")

    async def lookup(self, kind: str, key: str) -> list[types.Payload]:
        """Return every exact sync-key match, preserving duplicate pages."""
        key = _text(key, nonempty=True)
        bindings = await self._bound(kind)
        return await self._pages(
            "POST",
            "data_sources/" + self._sources[kind] + "/query",
            {
                "filter": {
                    "property": bindings["sync_key"],
                    "rich_text": {"equals": key},
                }
            },
        )

    async def get_page(self, page_id: str) -> types.Payload:
        """Read one page and reject a response with a different identity."""
        identifier = _id(page_id)
        page = await self._request("GET", "pages/" + identifier)
        if (
            page.get("object") != "page"
            or _id(page.get("id"), "NOTION_INVALID_RESPONSE") != identifier
        ):
            raise adapters.AdapterError("NOTION_INVALID_RESPONSE")
        return page

    async def _properties(
        self, kind: str, properties: types.Payload
    ) -> types.Payload:
        schema = self._kind(kind)
        if (
            not isinstance(properties, dict)
            or not properties
            or not properties.keys() <= schema.keys()
        ):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        _json(properties)
        for key, value in properties.items():
            spec = schema[key]
            _validate_property(spec, value)
        bindings = await self._bound(kind)
        return {bindings[key]: value for key, value in properties.items()}

    async def create(self, kind: str, properties: types.Payload) -> str:
        """Create one property-only page and return its confirmed UUID.

        The caller must reserve durable intent first. An unconfirmed response
        raises an ambiguous AdapterError and must not trigger a blind retry.
        """
        if not isinstance(properties, dict) or "title" not in properties:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        props = await self._properties(kind, properties)
        page = await self._request(
            "POST",
            "pages",
            mutation=True,
            payload={
                "parent": {
                    "type": "data_source_id",
                    "data_source_id": self._sources[kind],
                },
                "properties": props,
            },
        )
        if page.get("object") != "page":
            raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)
        return _received_id(page.get("id"))

    async def patch(
        self, kind: str, page_id: str, properties: types.Payload
    ) -> None:
        """Update only the selected, stable-ID-bound managed properties."""
        identifier = _id(page_id)
        props = await self._properties(kind, properties)
        page = await self._request(
            "PATCH",
            "pages/" + identifier,
            mutation=True,
            payload={"properties": props},
        )
        if (
            page.get("object") != "page"
            or _received_id(page.get("id")) != identifier
        ):
            raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)

    async def append(
        self, page_id: str, blocks: list[types.Payload]
    ) -> list[types.Payload]:
        """Append one bounded block batch and return its confirmed receipts.

        The caller owns chunk journaling and ambiguity recovery. A partial or
        malformed success response is unknown, not permission to append again.
        """
        identifier = _id(page_id)
        if not isinstance(blocks, list) or not 1 <= len(blocks) <= 100:
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        _json({"children": blocks})
        _blocks(blocks)
        result = await self._request(
            "PATCH",
            "blocks/" + identifier + "/children",
            mutation=True,
            payload={"children": blocks},
        )
        values = result.get("results")
        if (
            result.get("object") != "list"
            or not isinstance(values, list)
            or len(values) != len(blocks)
            or any(not isinstance(v, dict) for v in values)
            or result.get("has_more") is True
        ):
            raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)
        for value in values:
            if value.get("object") != "block":
                raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)
            _received_id(value.get("id"))
        return values

    async def children(self, page_id: str) -> list[types.Payload]:
        """Read bounded top-level children without following nested blocks."""
        return await self._pages("GET", "blocks/" + _id(page_id) + "/children")

    async def upload_png(self, png: bytes) -> str:
        """Create and fill one PNG upload using fixed Notion endpoints.

        Return the upload ID only after the filename and uploaded state are
        confirmed. Either unconfirmed write remains an ambiguous outcome.
        """
        if (
            not isinstance(png, bytes)
            or not png.startswith(b"\x89PNG\r\n\x1a\n")
            or len(png) > MAX_PNG_BYTES
        ):
            raise adapters.AdapterError("INVALID_NOTION_INPUT")
        filename = "chart-" + hashlib.sha256(png).hexdigest() + ".png"
        upload = await self._request(
            "POST",
            "file_uploads",
            mutation=True,
            payload={
                "mode": "single_part",
                "filename": filename,
                "content_type": "image/png",
            },
        )
        if (
            upload.get("object") != "file_upload"
            or upload.get("status") != "pending"
        ):
            raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)
        identifier = _received_id(upload.get("id"))
        # Never use upload_url/complete_url returned by an upstream response.
        result = await self._request(
            "POST",
            "file_uploads/" + identifier + "/send",
            mutation=True,
            file=(filename, png, "image/png"),
        )
        if (
            result.get("object") != "file_upload"
            or result.get("status") != "uploaded"
            or result.get("id") != identifier
            or result.get("filename") != filename
        ):
            raise adapters.AdapterError("NOTION_UNKNOWN", ambiguous=True)
        return identifier
