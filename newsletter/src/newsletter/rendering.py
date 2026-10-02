"""Static, offline email rendering. No model HTML, browser, or remote assets."""

from __future__ import annotations

import base64
import datetime
import functools
import hashlib
import importlib.resources as resources
import json
from typing import cast

import jinja2
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.charts as charts
import newsletter.contracts as contracts
import newsletter.email_templates as email_templates
import newsletter.types as types
import newsletter.usage as newsletter_usage

RENDERER_VERSION = "python-editorial/6"
CHART_CID = "cid:newsletter-chart"
_KIND_LABELS = {
    "world": "世界简报",
    "ai_ml": "AI / ML 进展",
    "science": "科学进展",
    "economy": "经济与产业",
    "technology": "技术与工程",
    "health": "健康与公共卫生",
    "feature": "研究与进展",
    "context": "背景与观察",
}
_ACCESS_LABELS = {
    "metadata": "元数据",
    "abstract": "摘要",
    "full_text": "全文",
    "dataset": "数据集",
}


def _limitations(text: str) -> list[str]:
    return [text] if text else []


def _reading_paragraphs(text: str) -> list[str]:
    """Split plain text into paragraphs without interpreting markup."""
    paragraphs = []
    lines = []
    for line in text.splitlines():
        if line.strip():
            lines.append(line)
        elif lines:
            paragraphs.append("\n".join(lines))
            lines = []
    if lines:
        paragraphs.append("\n".join(lines))
    return paragraphs


@functools.lru_cache(maxsize=1)
def load_template() -> jinja2.Template:
    """Load the packaged email template for rendering and startup validation."""
    environment = jinja2.Environment(
        autoescape=jinja2.select_autoescape(
            default=True, default_for_string=True
        ),
        undefined=jinja2.StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
    )
    return environment.from_string(
        resources.files("newsletter")
        .joinpath("templates/edition.html.j2")
        .read_text(encoding="utf-8")
    )


def preview_html(rendered: types.RenderResult) -> str:
    """Embed a frozen chart in a browser copy without altering email output."""
    return rendered["html"].replace(
        'src="cid:newsletter-chart"',
        'src="data:image/png;base64,' + rendered.get("chart_png", "") + '"',
    )


def _render_text(context: types.Payload, draft: types.Payload) -> str:
    sections = context["sections"]
    references = context["references"]
    chart = context["chart"]
    reading = context["reading"]
    issue_date = context["issue_date"]
    personal = context["personal"]
    fixture = context["is_fixture"]
    footer = context["usage_footer"]
    text_lines = []
    if fixture:
        text_lines.extend(["【试刊样张 · 模拟材料，非真实新闻】", ""])
    text_lines.extend(
        [str(issue_date), draft["title"], "", draft.get("introduction", ""), ""]
    )
    for section in sections:
        text_lines.extend([f"{section['label']}｜{section['heading']}", ""])
        for paragraph in section["paragraphs"]:
            markers = "".join(
                f"[{ref['number']}]" for ref in paragraph["references"]
            )
            text_lines.extend([paragraph["text"] + markers, ""])
        for limitation in section["limitations"]:
            text_lines.append(f"边界：{limitation}")
        text_lines.append("")
    if chart:
        text_lines.extend(
            [
                f"数据视角｜{chart['question']}",
                chart["caption"],
                chart["metadata"],
                chart["source_note"],
            ]
        )
        text_lines.append(f"图表说明：{chart['alt_text']}")
        for row in chart["rows"]:
            value = (
                row["value"]
                if row["value"] is not None
                else f"缺失（{row['missing_reason']}）"
            )
            markers = "".join(f"[{ref['number']}]" for ref in row["references"])
            text_lines.append(f"{row['label']}：{value}{markers}")
        text_lines.extend(
            f"边界：{item}" for item in chart.get("limitations", [])
        )
        text_lines.append("")
    if reading:
        ref = reading["reference"]
        evidence = "".join(
            f"[{ref['number']}]" for ref in reading["supporting_references"]
        )
        text_lines.extend(
            [
                "研究介绍",
                f"{ref['title']} [{ref['number']}]",
                reading["reason"]
                + ("\n补充证据：" + evidence if evidence else ""),
                f"原文与方法 [{ref['number']}]：{ref['url']}",
                "",
            ]
        )
    if draft.get("limitations"):
        text_lines.append("本期边界")
        text_lines.extend(_limitations(draft["limitations"]))
        text_lines.append("")
    if references:
        text_lines.append("来源与核对")
        for ref in references:
            text_lines.extend([f"[{ref['number']}] {ref['title']}", ref["url"]])
        text_lines.append("")
    if personal:
        text_lines.extend(
            [
                "TODOFY / 与你有关",
                personal["title"],
                personal["meta"],
                personal["summary"],
                "",
            ]
        )
        for item in personal["items"]:
            text_lines.extend(
                [f"{item['rank']}. {item['title']}", item["detail"], ""]
            )
        text_lines.extend([personal["provenance"], personal["limitations"], ""])
    if footer:
        text_lines.extend([footer, ""])
    return "\n".join(text_lines).rstrip() + "\n"


def render_edition(
    draft: types.Payload,
    packets: list[types.Payload],
    issue_date: str,
    is_fixture: bool = False,
    personal_digest: types.Payload | None = None,
    usage: newsletter_usage.UsageSummary | types.Payload | None = None,
    *,
    template_source: str | None = None,
) -> types.RenderResult:
    """Return frozen HTML/plain text/base64 PNG and a hash of those exact bytes.

    Public URL validation is syntactic here: rendering makes no network calls.
    Unknown citations or unsafe source links fail the shared contract checks.
    """
    draft_message = contracts.parse_message(draft, editorial_pb2.Draft)
    packet_messages = [
        contracts.parse_message(packet, editorial_pb2.Packet)
        for packet in packets
    ]
    contracts.validate_draft(draft_message, packet_messages)
    contracts.validate_issue_date(issue_date)
    personal = None
    if personal_digest is not None:
        contracts.validate_personal_digest(personal_digest)
        personal = contracts.to_dict(
            contracts.parse_message(
                personal_digest, editorial_pb2.PersonalDigest
            )
        )
        meta = []
        if personal["time_window_hours"]:
            meta.append(f"最近 {personal['time_window_hours']} 小时")
        if "task_count" in personal:
            meta.append(f"{personal['task_count']} 条来源记录")
        provenance = (
            [personal["source_label"]] if personal["source_label"] else []
        )
        if personal["fetched_at"]:
            at = datetime.datetime.fromisoformat(
                personal["fetched_at"].replace("Z", "+00:00")
            )
            # validate_personal_digest already requires an aware timestamp.
            zone = (
                "UTC"
                if cast(datetime.timedelta, at.utcoffset()).total_seconds() == 0
                else at.strftime("%z")
            )
            provenance.append(at.strftime("%m-%d %H:%M ") + zone + " 获取")
        personal["meta"] = " · ".join(meta)
        personal["provenance"] = " · ".join(provenance)
    # Render the same normalized ProtoJSON shape that was validated, including
    # optional scalar defaults and oneof presence, never the unchecked original.
    draft = contracts.to_dict(draft_message)
    packets = [contracts.to_dict(packet) for packet in packet_messages]
    sources = {}
    for packet in packets:
        for source in packet["content"].get("sources", []):
            sources[f"{packet['id']}/{source['id']}"] = source
    references: list[types.Payload] = []
    numbers: dict[str, int] = {}

    def cite(citation: str) -> types.Payload:
        if citation not in sources:
            raise ValueError(f"UNKNOWN_CITATION: {citation}")
        if citation not in numbers:
            source = sources[citation]
            contracts.validate_public_url(source["url"])
            numbers[citation] = len(references) + 1
            references.append(
                {
                    "number": numbers[citation],
                    "citation": citation,
                    "title": source["title"],
                    "url": source["url"],
                    "published_at": source.get("published_at", ""),
                    "access_scope": _ACCESS_LABELS[source["access_scope"]],
                }
            )
        return references[numbers[citation] - 1]

    sections = [
        {
            "kind": section["kind"],
            "label": _KIND_LABELS[section["kind"]],
            "heading": section["heading"],
            "limitations": _limitations(section.get("limitations", "")),
            "paragraphs": [
                {
                    "text": p["text"],
                    "references": [cite(c) for c in p.get("citations", [])],
                }
                for p in section["paragraphs"]
            ],
        }
        for section in draft["sections"]
    ]
    fixture = bool(
        is_fixture
        or any(packet.get("is_fixture", False) for packet in packets)
        or (personal and personal["is_fixture"])
    )
    chart = None
    chart_bytes = b""
    if draft.get("chart"):
        chart = {
            **draft["chart"],
            "limitations": _limitations(draft["chart"].get("limitations", "")),
            "rows": [
                {
                    "label": p["label"],
                    "value": p.get("decimal_value"),
                    "missing_reason": p.get("missing_reason", ""),
                    "references": [cite(c) for c in p.get("citations", [])],
                }
                for p in draft["chart"]["points"]
            ],
        }
        chart["metadata"] = charts.chart_metadata(chart)
        chart_references = {
            ref["number"]: ref
            for row in chart["rows"]
            for ref in row["references"]
        }
        chart["source_note"] = "来源：" + "；".join(
            f"[{ref['number']}] {ref['title']}"
            + (f" · {ref['published_at']}" if ref["published_at"] else "")
            for ref in chart_references.values()
        )
        chart_bytes = charts.render_chart_png(chart, fixture)
    reading = None
    if draft.get("recommended_reading"):
        recommendation = draft["recommended_reading"]
        reading = {
            "reference": cite(recommendation["citation"]),
            "supporting_references": [
                cite(citation)
                for citation in recommendation["supporting_citations"]
            ],
            "reason": recommendation["reason"],
            "paragraphs": _reading_paragraphs(recommendation["reason"]),
        }
    footer = newsletter_usage.usage_footer(
        newsletter_usage.normalize_usage_summary(usage)
        if usage is not None
        else None,
        is_fixture=fixture,
    )
    context = {
        "draft": {
            **draft,
            "introduction": draft.get("introduction", ""),
            "limitations": _limitations(draft.get("limitations", "")),
        },
        "sections": sections,
        "references": references,
        "chart": chart,
        "chart_cid": CHART_CID,
        "reading": reading,
        "issue_date": str(issue_date),
        "date_label": datetime.date.fromisoformat(issue_date).strftime(
            "%Y / %m / %d"
        ),
        "weekday_label": "星期"
        + "一二三四五六日"[datetime.date.fromisoformat(issue_date).weekday()],
        "is_fixture": fixture,
        "personal": personal,
        "usage_footer": footer,
    }
    # None deliberately preserves the packaged renderer for legacy runs. New
    # runs supply source bytes from their frozen workflow inputs, never a path.
    html = (
        load_template().render(**context)
        if template_source is None
        else email_templates.render_template(template_source, context)
    )
    text = _render_text(context, draft)
    result = {
        "html": html,
        "text": text,
        "chart_png": base64.b64encode(chart_bytes).decode("ascii"),
    }
    payload = json.dumps(
        result, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return {
        "html": html,
        "text": text,
        "chart_png": result["chart_png"],
        "render_hash": hashlib.sha256(payload).hexdigest(),
    }
