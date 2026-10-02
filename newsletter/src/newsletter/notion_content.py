"""Pure, lossless Notion projections of already frozen application content.

Property names are logical schema keys, not database-specific IDs. Relations
(`edition_ids`, `material_ids`) are deliberately left to the persistence layer.
The digest covers body blocks and the frozen chart bytes, not mutable delivery,
progress, relation or sync properties. A property-only update must not append a
second copy of the body. There are no HTTP, database, model or rendering calls.

``_newsletter_chart`` is an INTERNAL block type, never a Notion API payload.
When present, ``Projection.chart_png`` holds the original frozen PNG bytes. The
transport must replace that block with an uploaded image and its caption before
submission. It must not drop the placeholder or send it directly to Notion.
Top-level blocks may exceed 100; the transport owns durable batched submission.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Callable
import dataclasses
import datetime
import hashlib
import urllib.parse as parse

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.charts as charts
import newsletter.contracts as contracts
import newsletter.types as types
import newsletter.usage as newsletter_usage
import newsletter.workflow.sources as newsletter_workflow_sources

CHART_PLACEHOLDER = "_newsletter_chart"
_CONTENT_VERSION = "notion-content/1"
_RICH_TEXT_UNITS = 1800  # Below Notion's 2000 UTF-16-unit text/link boundary.
_RICH_TEXT_ITEMS = 100
_KINDS = {
    "world": "世界简报",
    "ai_ml": "AI / ML 进展",
    "science": "科学进展",
    "economy": "经济与产业",
    "technology": "技术与工程",
    "health": "健康与公共卫生",
    "feature": "研究与进展",
    "context": "背景与观察",
}
_CATEGORIES = {
    "world": "世界",
    "ai_ml": "AI/ML",
    "science": "科学",
    "economy": "经济",
    "technology": "技术",
    "health": "健康",
}
_DIRECTIONS = {
    "01-ai-ml": "AI/ML",
    "02-science": "科学",
    "03-world": "世界",
    "04-economy": "经济",
    "05-health": "健康",
    "06-technology": "技术",
    "07-search-ads-recs": "技术",
    "08-llm-architectures": "AI/ML",
}
_ACCESS = {
    "metadata": "元数据",
    "abstract": "摘要",
    "full_text": "全文",
    "dataset": "数据集",
}
_PROGRESS = {"候选", "已研究", "继续跟进", "已刊出"}
_EDITION_TYPES = {"日常", "测试", "修订"}
_DISPOSITIONS = {
    "deep": "深读",
    "brief": "简讯",
    "watch": "继续观察",
    "deferred": "暂缓刊出",
}
_DELIVERY = {
    "not_requested": "未发送",
    "submitting": "发送中",
    "provider_accepted": "已提交",
    "rejected": "失败",
    "unknown": "结果未知",
    "simulated": "模拟",
}


@dataclasses.dataclass(frozen=True)
class Projection:
    """Reader content and frozen chart bytes with an independent body digest.

    Properties use logical schema keys. Mutable delivery/progress properties
    are excluded from the digest so their updates do not duplicate the body.
    """

    key: str
    properties: types.Payload
    blocks: list[types.Payload]
    digest: str
    chart_png: bytes | None = None


def _chunks(value: str) -> list[str]:
    """Keep Unicode scalars intact without dropping characters or spaces."""
    if not isinstance(value, str):
        raise ValueError("Notion content must be text")
    chunks: list[str] = []
    part: list[str] = []
    size = 0
    for character in value:
        code = ord(character)
        if 0xD800 <= code <= 0xDFFF:
            raise ValueError("Notion content contains an unpaired surrogate")
        units = 2 if code > 0xFFFF else 1
        if size + units > _RICH_TEXT_UNITS:
            chunks.append("".join(part))
            part, size = [], 0
        part.append(character)
        size += units
    if part:
        chunks.append("".join(part))
    return chunks


def _rich(value: str, *, url: str | None = None) -> list[types.Payload]:
    result = []
    for part in _chunks(value):
        text: types.Payload = {"content": part}
        if url is not None:
            text["link"] = {"url": url}
        result.append({"type": "text", "text": text})
    return result


def _text_property(value: str, kind: str = "rich_text") -> types.Payload:
    rich = _rich(value)
    if len(rich) > _RICH_TEXT_ITEMS:
        # Upstream fields are bounded well below this; do not silently trim if
        # a new caller bypasses the public contract.
        raise ValueError("Notion property exceeds its rich-text capacity")
    return {kind: rich}


def _select(value: str) -> types.Payload:
    return {"select": {"name": value} if value else None}


def _multi(values: list[str]) -> types.Payload:
    return {
        "multi_select": [
            {"name": value} for value in dict.fromkeys(values) if value
        ]
    }


def _date(value: str) -> types.Payload:
    if value:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return {"date": {"start": value} if value else None}


def _blocks(value: str, kind: str = "paragraph") -> list[types.Payload]:
    rich = _rich(value)
    return [
        {
            "object": "block",
            "type": kind,
            kind: {"rich_text": rich[offset : offset + 100]},
        }
        for offset in range(0, len(rich), _RICH_TEXT_ITEMS)
    ]


def _linked_blocks(
    label: str, url: str, suffix: str = ""
) -> list[types.Payload]:
    contracts.validate_public_url(url)
    if len(url.encode("utf-16-le")) // 2 > 2000:
        # Preserve a contract-valid long URL as text if Notion cannot link it.
        return _blocks(f"{label}\n{url}{suffix}")
    rich = _rich(label, url=url) + _rich(suffix)
    return [
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {"rich_text": rich[i : i + 100]},
        }
        for i in range(0, len(rich), _RICH_TEXT_ITEMS)
    ]


def _projection(
    key: str,
    properties: types.Payload,
    blocks: list[types.Payload],
    chart_png: bytes | None = None,
) -> Projection:
    if not key or not isinstance(key, str):
        raise ValueError("Notion projection requires a stable key")
    digest = contracts.content_hash(
        {
            "format": _CONTENT_VERSION,
            "blocks": blocks,
            "chart_sha256": hashlib.sha256(chart_png).hexdigest()
            if chart_png
            else "",
        }
    )
    properties.update(
        sync_key=_text_property(key),
        content_hash=_text_property(digest),
        sync_state=_select("同步中"),
    )
    return Projection(key, properties, blocks, digest, chart_png)


def _material_type(candidate: types.Payload) -> str:
    """Use explicit publication status, never reputation or a DOI alone."""
    status = candidate.get("publication_status", "").strip().lower()
    if status.startswith(("已发表", "正式发表", "published")):
        return "论文"
    if "预印本" in status or "preprint" in status:
        return "预印本"
    if "技术报告" in status or "technical report" in status:
        return "技术报告"
    if parse.urlsplit(candidate["url"]).hostname in {
        "arxiv.org",
        "www.arxiv.org",
        "export.arxiv.org",
    }:
        return "预印本"
    return "未分类"


def _source_identities(value: types.Payload) -> set[str]:
    """Identify exact sources, not similarly titled events or landing pages."""
    return {
        key
        for key in newsletter_workflow_sources.identity_keys(value)
        if key.startswith(("doi:", "arxiv:"))
        or (
            key.startswith("url:")
            and parse.urlsplit(key[4:]).path.rstrip("/")
            not in {
                "",
                "/news",
                "/research",
                "/publications",
                "/papers",
                "/blog",
                "/index.html",
            }
        )
    }


def _research_access(
    candidate: types.Payload, packets: list[types.Payload]
) -> str:
    # Access is reported by the frozen source, not inferred from the strength of
    # its claims or from having a packet. Datasets are not full-text articles.
    ranks = {"metadata": 0, "dataset": 0, "abstract": 1, "full_text": 2}
    rank = ranks.get(candidate["access_scope"], 0)
    candidate_keys = _source_identities(candidate)
    for packet in packets:
        for source in packet["content"]["sources"]:
            if candidate_keys & _source_identities(source):
                rank = max(rank, ranks.get(source["access_scope"], 0))
    return ("仅线索", "摘要", "全文")[rank]


def material_projection(
    candidate: types.Payload,
    *,
    key: str,
    first_seen: str,
    run_id: str,
    evidence: list[types.Payload] | None = None,
    progress: str = "候选",
    fixture: bool = False,
) -> Projection:
    """Project one candidate without inferring authors from public packets.

    ``run_id`` is accepted for ledger binding, not copied into reader
    prose. ``evidence`` consists of complete public Packets associated by that
    caller with the candidate's task, not arbitrary private edition data.
    """
    candidate = contracts.to_dict(
        contracts.parse_message(candidate, editorial_pb2.Candidate)
    )
    contracts.validate_issue_date(first_seen)
    contracts.validate_public_url(candidate["url"])
    if (
        progress not in _PROGRESS
        or type(fixture) is not bool
        or not isinstance(run_id, str)
    ):
        raise ValueError("Invalid material projection metadata")
    direction = candidate["direction"]
    scope = candidate["access_scope"]
    properties = {
        "title": _text_property(candidate["title"], "title"),
        "fixture": {"checkbox": fixture},
        "category": _select(_DIRECTIONS.get(direction, "")),
        "topics": _multi([]),  # There is no Candidate topic taxonomy to infer.
        "material_type": _select(_material_type(candidate)),
        "value": _text_property(
            candidate["contribution"] or candidate["why_now"]
        ),
        "url": {
            "url": candidate["url"]
            if len(candidate["url"].encode("utf-16-le")) // 2 <= 2000
            else None
        },
        "published_at": _date(candidate["published_at"]),
        "first_seen": _date(first_seen),
        "progress": _select(progress),
        "authors": _text_property(candidate["authors"]),
        "affiliations": _text_property(candidate["affiliations"]),
        "venue": _text_property(candidate["venue"]),
        "publication_status": _text_property(candidate["publication_status"]),
        "access_scope": _select(
            {"abstract": "摘要", "full_text": "全文"}.get(scope, "仅线索")
        ),
        "direction": _multi([direction]),
        "version": _text_property(candidate["version"]),
    }
    blocks = _blocks("发现线索", "heading_2") + _blocks(candidate["summary"])
    for field, heading in (
        ("contribution", "具体贡献"),
        ("why_now", "为什么现在关注"),
        ("source_basis", "来源选择依据"),
    ):
        if candidate[field]:
            blocks += _blocks(heading, "heading_3") + _blocks(candidate[field])
    blocks += _blocks("发现来源", "heading_3")
    blocks += _linked_blocks(candidate["title"], candidate["url"])
    blocks += _blocks(
        "发现记录的访问范围："
        + _ACCESS.get(scope, "未知")
        + "；发现线索不等于独立事实核验。"
    )
    for url in dict.fromkeys(candidate["evidence_urls"]):
        if url != candidate["url"]:
            blocks += _linked_blocks(url, url)
    packets: dict[str, types.Payload] = {}
    for original in evidence or []:
        packet = contracts.to_dict(
            contracts.parse_message(original, editorial_pb2.Packet)
        )
        contracts.validate_packet_body(packet["content"])
        if packet["id"] in packets and packet != packets[packet["id"]]:
            raise ValueError("Conflicting public evidence identity")
        packets[packet["id"]] = packet
    if packets:
        blocks += _blocks("关联研究记录", "heading_2")
        blocks += _blocks(
            "以下记录可能综合多个来源，不代表该候选的全部主张都已独立核实。"
        )
    for packet in sorted(packets.values(), key=lambda value: value["id"]):
        content = packet["content"]
        blocks += _blocks(content["title"], "heading_3") + _blocks(
            content["body"]
        )
        for source in content["sources"]:
            blocks += _source_blocks(source)
            blocks += _blocks(source["excerpt"])
    properties["fixture"] = {
        "checkbox": fixture or any(p["is_fixture"] for p in packets.values())
    }
    properties["access_scope"] = _select(
        _research_access(candidate, list(packets.values()))
    )
    return _projection(key, properties, blocks)


def _source_blocks(
    source: types.Payload, prefix: str = ""
) -> list[types.Payload]:
    context = " · " + _ACCESS.get(source.get("access_scope", ""), "未知")
    if source.get("published_at"):
        context += " · " + source["published_at"]
    return _linked_blocks(prefix + source["title"], source["url"], context)


def _chart_bytes(
    edition: types.Payload, chart: types.Payload | None
) -> bytes | None:
    encoded = edition.get("rendered", {}).get("chart_png", "")
    if not encoded:
        return None
    if not chart:
        raise ValueError("Frozen chart has no structured chart content")
    try:
        data = (
            base64.b64decode(encoded, validate=True)
            if isinstance(encoded, str)
            else bytes(encoded)
        )
    except (ValueError, TypeError, binascii.Error):
        raise ValueError("Invalid frozen chart encoding") from None
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Frozen chart is not a PNG")
    return data


def _edition_sections(
    sections: list[types.Payload], cite: Callable[[list[str]], str]
) -> list[types.Payload]:
    blocks: list[types.Payload] = []
    for section in sections:
        blocks += _blocks(
            _KINDS[section["kind"]] + "｜" + section["heading"], "heading_2"
        )
        for paragraph in section["paragraphs"]:
            blocks += _blocks(paragraph["text"] + cite(paragraph["citations"]))
        if section["limitations"]:
            blocks += _blocks("阅读边界：" + section["limitations"])
    return blocks


def _edition_chart(
    chart: types.Payload,
    chart_png: bytes | None,
    cite: Callable[[list[str]], str],
) -> list[types.Payload]:
    blocks: list[types.Payload] = []
    blocks += _blocks("一图看懂 / 数据视角｜" + chart["question"], "heading_2")
    blocks += _blocks(chart["caption"])
    if chart_png:
        blocks.append(
            {
                "object": "block",
                "type": CHART_PLACEHOLDER,
                CHART_PLACEHOLDER: {"caption": _rich(chart["alt_text"])},
            }
        )
    blocks += _blocks(charts.chart_metadata(chart)) + _blocks(
        "图表说明：" + chart["alt_text"]
    )
    blocks += _blocks(
        "缺失值断线，不作零值处理。"
        if chart["kind"] == "line"
        else "条形以零为基线；缺失不代表零。"
    )
    for point in chart["points"]:
        value = point.get(
            "decimal_value",
            "缺失（" + point.get("missing_reason", "") + "）",
        )
        blocks += _blocks(
            f"{point['label']}：{value}" + cite(point["citations"])
        )
    if chart["limitations"]:
        blocks += _blocks("阅读边界：" + chart["limitations"])
    return blocks


def _edition_personal(personal: types.Payload) -> list[types.Payload]:
    blocks: list[types.Payload] = []
    blocks += _blocks("TODOFY / 与你有关｜" + personal["title"], "heading_2")
    blocks += _blocks(personal["summary"])
    meta = []
    if personal["time_window_hours"]:
        meta.append(f"最近 {personal['time_window_hours']} 小时")
    if "task_count" in personal:
        meta.append(f"{personal['task_count']} 条来源记录")
    blocks += _blocks(" · ".join(meta))
    for item in personal["items"]:
        blocks += _blocks(f"{item['rank']}. {item['title']}", "heading_3")
        blocks += _blocks(item["detail"])
    blocks += _blocks(personal["limitations"])
    blocks += _blocks(
        " · ".join(
            filter(None, [personal["source_label"], personal["fetched_at"]])
        )
    )
    return blocks


def _edition_references(
    sources: dict[str, types.Payload], references: dict[str, int]
) -> list[types.Payload]:
    blocks: list[types.Payload] = []
    if references:
        blocks += _blocks("来源与核对", "heading_2")
        for citation, number in references.items():
            blocks += _source_blocks(sources[citation], f"[{number}] ")
    return blocks


def edition_projection(
    edition: types.Payload,
    *,
    run_id: str = "",
    include_personal: bool = False,
    edition_type: str | None = None,
    packets: list[types.Payload] | None = None,
) -> Projection:
    """Archive frozen structured copy without parsing email or rerendering.

    The caller supplies the frozen ``packets`` snapshot to resolve exact
    citations. Private data is excluded by default; render HTML/text is never
    copied as it can contain Todofy even when ``include_personal`` is false.
    """
    if type(include_personal) is not bool:
        raise ValueError("Private archive consent must be explicit")
    contracts.validate_issue_date(edition["issue_date"])
    draft = contracts.to_dict(
        contracts.parse_message(edition["draft"], editorial_pb2.Draft)
    )
    frozen_packets = [
        contracts.to_dict(contracts.parse_message(packet, editorial_pb2.Packet))
        for packet in packets or []
    ]
    contracts.validate_draft(draft, frozen_packets)
    fixture = bool(
        edition.get("is_fixture", False)
        or any(packet["is_fixture"] for packet in frozen_packets)
        or (
            include_personal
            and edition.get("personal_digest", {}).get("is_fixture", False)
        )
    )
    edition_type = edition_type or ("测试" if fixture else "日常")
    if edition_type not in _EDITION_TYPES:
        raise ValueError("Invalid edition type")
    sources = {
        f"{packet['id']}/{source['id']}": source
        for packet in frozen_packets
        for source in packet["content"]["sources"]
    }
    references: dict[str, int] = {}

    def cite(values: list[str]) -> str:
        marks = []
        for value in values:
            if value not in sources:
                raise ValueError("Unresolved frozen citation")
            references.setdefault(value, len(references) + 1)
            marks.append(f"[{references[value]}]")
        return "".join(marks)

    blocks = _blocks(draft["title"], "heading_1") + _blocks(
        draft["introduction"]
    )
    if draft["subject"] != draft["title"]:
        blocks[1:1] = _blocks("邮件主题：" + draft["subject"])
    if fixture:
        blocks = _blocks("试刊样张 · 模拟材料，非真实新闻。") + blocks
    blocks += _edition_sections(draft["sections"], cite)
    chart = draft.get("chart")
    chart_png = _chart_bytes(edition, chart)
    if chart:
        blocks += _edition_chart(chart, chart_png, cite)
    if reading := draft.get("recommended_reading"):
        source = sources[reading["citation"]]
        blocks += _blocks("研究介绍｜" + source["title"], "heading_2")
        blocks += _blocks(reading["reason"])
        blocks += _source_blocks(
            source, "原文与方法 " + cite([reading["citation"]]) + " "
        )
        if reading["supporting_citations"]:
            blocks += _blocks(
                "补充证据：" + cite(reading["supporting_citations"])
            )
    if draft["limitations"]:
        blocks += _blocks("本期说明：" + draft["limitations"])
    blocks += _edition_references(sources, references)
    publication = edition.get("publication", {})
    if publication.get("stories"):
        blocks += _blocks("本期选题记录", "heading_2")
        for story in publication["stories"]:
            blocks += _blocks(
                story["title"] + "｜" + _DISPOSITIONS[story["disposition"]],
                "heading_3",
            )
            blocks += _blocks(story["reason"])
    personal = edition.get("personal_digest") if include_personal else None
    if personal is not None:
        contracts.validate_personal_digest(personal)
        personal = contracts.to_dict(
            contracts.parse_message(personal, editorial_pb2.PersonalDigest)
        )
        blocks += _edition_personal(personal)
    usage = newsletter_usage.normalize_usage_summary(edition.get("usage") or {})
    blocks += _blocks(newsletter_usage.usage_footer(usage, is_fixture=fixture))
    counts = usage["usage"]
    properties = {
        "title": _text_property(
            edition["issue_date"] + "｜" + draft["title"], "title"
        ),
        "fixture": {"checkbox": fixture},
        "issue_date": _date(edition["issue_date"]),
        "edition_type": _select(edition_type),
        "overview": _text_property(draft["introduction"]),
        "categories": _multi(
            [_CATEGORIES.get(s["kind"], "") for s in draft["sections"]]
        ),
        "delivery": _select(
            _DELIVERY[edition.get("delivery_state", "not_requested")]
        ),
        "usage_partial": {"checkbox": usage["partial"]},
        "contains_personal": {"checkbox": personal is not None},
        "edition_id": _text_property(edition["id"]),
        "run_id": _text_property(run_id),
        "render_hash": _text_property(
            edition.get("rendered", {}).get("render_hash", "")
        ),
    }
    properties.update(
        tokens={"number": counts["total_tokens"] if counts else None},
        input_tokens={"number": counts["input_tokens"] if counts else None},
        cached_tokens={
            "number": counts["cached_input_tokens"] if counts else None
        },
        output_tokens={"number": counts["output_tokens"] if counts else None},
    )
    return _projection(
        "edition:" + edition["id"], properties, blocks, chart_png
    )
