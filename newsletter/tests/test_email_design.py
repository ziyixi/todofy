"""Test offline email design without certifying Gmail or Outlook rendering.

These checks preserve the static, inline-styled fallback. Browser screenshots
and eventual authorized real-inbox tests are separate compatibility evidence.
"""

import base64
import copy
import email.parser as parser
import email.policy as policy
import html.parser as html_parser
import re

import pytest

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.rendering as newsletter_rendering
import newsletter.todofy as todofy
import tests.support.rendering as rendering

ISSUE_DATE = "2026-09-05"
_VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "wbr",
}


class EmailStructure(html_parser.HTMLParser):
    """Retain visible text ancestors to test inline fallback, not CSS layout."""

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.elements = []
        self.stack = []
        self.visible = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs)}
        self.elements.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if not data.strip():
            return
        for ancestor in self.stack:
            if ancestor["tag"] in {"head", "style", "script", "title"}:
                return
            style = ancestor["attrs"].get("style", "")
            if re.search(r"display\s*:\s*none(?:;|$)", style, re.I):
                return
        self.visible.append((data, tuple(self.stack)))

    @property
    def text(self):
        return "".join(data for data, _ in self.visible)

    @property
    def links(self):
        return [
            node["attrs"].get("href", "")
            for node in self.elements
            if node["tag"] == "a"
        ]


def render(personal_digest=None, *, chart=True):
    draft = copy.deepcopy(rendering.SAMPLE_DRAFT)
    if not chart:
        draft.pop("chart")
    return newsletter_rendering.render_edition(
        draft,
        rendering.SAMPLE_PACKETS,
        ISSUE_DATE,
        personal_digest=personal_digest,
    )


async def test_visible_copy_keeps_essential_typography_inline():
    result = render(await todofy.FakeTodofy().fetch(ISSUE_DATE))
    parsed = EmailStructure(result["html"])
    assert len(parsed.visible) > 30
    for text, ancestors in parsed.visible:
        assert ancestors, text
        node = ancestors[-1]
        assert node["tag"] in {"p", "h1", "h2", "h3", "sup", "a", "th", "td"}, (
            node
        )
        declarations = {
            item.split(":", 1)[0].strip().lower()
            for item in node["attrs"].get("style", "").split(";")
            if ":" in item
        }
        assert {
            "font-family",
            "font-size",
            "line-height",
            "color",
        } <= declarations, node


async def test_email_static_table_layout_without_remote_visual_dependencies():
    html = render(await todofy.FakeTodofy().fetch(ISSUE_DATE))["html"]
    parsed = EmailStructure(html)
    forbidden = {
        "script",
        "svg",
        "iframe",
        "details",
        "summary",
        "form",
        "input",
        "button",
        "video",
        "audio",
        "canvas",
        "object",
        "embed",
        "link",
    }
    assert not forbidden.intersection(node["tag"] for node in parsed.elements)
    assert not re.search(
        r"display\s*:\s*(?:inline-)?(?:flex|grid)\b", html, re.I
    )
    assert not re.search(r"@font-face|@import|url\s*\(|javascript:", html, re.I)
    for node in parsed.elements:
        attrs = node["attrs"]
        assert not any(name.lower().startswith("on") for name in attrs)
        assert not {"srcset", "poster", "background"}.intersection(attrs)
        if "src" in attrs:
            assert (
                node["tag"] == "img"
                and attrs["src"] == newsletter_rendering.CHART_CID
            )
    layout_tables = [
        node
        for node in parsed.elements
        if node["tag"] == "table"
        and node["attrs"].get("role") == "presentation"
    ]
    assert len(layout_tables) >= 4
    assert all(table["attrs"].get("width") == "100%" for table in layout_tables)
    assert '<!--[if mso]><table role="presentation" width="660"' in html


async def test_citations_do_not_depend_on_in_email_anchor_support():
    html = render(await todofy.FakeTodofy().fetch(ISSUE_DATE))["html"]
    parsed = EmailStructure(html)
    assert "[1]" in parsed.text and "[2]" in parsed.text
    assert not any(link.startswith("#") for link in parsed.links)
    assert all(link.startswith("https://") for link in parsed.links)
    assert {
        source["url"]
        for source in rendering.SAMPLE_PACKETS[0]["content"]["sources"]
    } <= set(parsed.links)
    assert parsed.text.count("研究介绍") == 1


@pytest.mark.parametrize("chart", [True, False])
async def test_personal_overview_is_last_content_in_html_and_plain_text(chart):
    digest = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    result = render(digest, chart=chart)
    html_text = EmailStructure(result["html"]).text
    plain_text = result["text"]
    marker = "TODOFY / 与你有关"
    for text in (html_text, plain_text):
        assert text.count(marker) == 1
        personal_start = text.index(marker)
        assert text.index("研究介绍") < personal_start
        assert text.index("来源与核对") < personal_start
        assert (
            text.index(rendering.SAMPLE_DRAFT["limitations"]) < personal_start
        )
        for source in rendering.SAMPLE_PACKETS[0]["content"]["sources"]:
            assert text.rindex(source["title"]) < personal_start
        if chart:
            assert (
                text.index(rendering.SAMPLE_DRAFT["chart"]["caption"])
                < personal_start
            )
        for item in digest["items"]:
            assert text.index(item["title"]) > personal_start
            assert text.index(item["detail"]) > personal_start
    assert html_text.index(digest["limitations"]) < html_text.index(
        "少一点信息，多一点理解。"
    )
    assert html_text.index(marker) < html_text.index("少一点信息，多一点理解。")
    assert plain_text.rstrip().endswith(digest["limitations"])


async def test_removing_head_styles_retains_all_readable_content_source_links():
    result = render(await todofy.FakeTodofy().fetch(ISSUE_DATE))
    original = EmailStructure(result["html"])
    stripped = re.sub(
        r"<head\b[^>]*>.*?</head>", "", result["html"], flags=re.S | re.I
    )
    stripped = re.sub(
        r"<style\b[^>]*>.*?</style>", "", stripped, flags=re.S | re.I
    )
    fallback = EmailStructure(stripped)
    assert fallback.text == original.text
    assert fallback.links == original.links
    assert "TODOFY / 与你有关" in fallback.text
    assert rendering.SAMPLE_DRAFT["chart"]["caption"] in fallback.text
    assert "另一组" in fallback.text and "缺失（尚未公布）" in fallback.text


def test_research_card_explains_before_its_optional_link():
    result = render(chart=False)
    parsed = EmailStructure(result["html"])
    visible = [
        (text, ancestors)
        for text, ancestors in parsed.visible
        if any(
            "reading-panel" in n["attrs"].get("class", "").split()
            for n in ancestors
        )
    ]
    card_text = "".join(text for text, _ in visible)
    title = rendering.SAMPLE_PACKETS[0]["content"]["sources"][1]["title"]
    assert "如果今天只读一篇" not in card_text
    title_ancestors = next(
        ancestors for text, ancestors in visible if text == title
    )
    assert title_ancestors[-1]["tag"] == "h2"
    assert not any(node["tag"] == "a" for node in title_ancestors)
    paragraphs = rendering.SAMPLE_DRAFT["recommended_reading"]["reason"].split(
        "\n\n"
    )
    for paragraph in paragraphs:
        assert paragraph in card_text and paragraph in result["text"]
        assert card_text.index(paragraph) < card_text.index("原文与方法")
    card_links = [
        ancestors[-1] for _, ancestors in visible if ancestors[-1]["tag"] == "a"
    ]
    assert len(card_links) == 1
    assert (
        card_links[0]["attrs"]["href"]
        == rendering.SAMPLE_PACKETS[0]["content"]["sources"][1]["url"]
    )
    assert "overflow-wrap:anywhere" in card_links[0]["attrs"]["style"]


@pytest.mark.parametrize(
    "state", ["current", "empty", "unavailable", "disabled"]
)
async def test_all_personal_states_have_explicit_readable_content(state):
    digest = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    if state == "empty":
        digest.update(
            state="empty",
            items=[],
            task_count=0,
            summary="最近 24 小时没有新的入库事件；这不代表没有未完成任务。",
        )
    elif state == "unavailable":
        digest = todofy.unavailable_digest("todofy_timeout")
    elif state == "disabled":
        digest = await todofy.DisabledTodofy().fetch(ISSUE_DATE)
    result = render(digest)
    parsed = EmailStructure(result["html"])
    assert "TODOFY / 与你有关" in parsed.text
    for field in ("title", "summary", "limitations"):
        assert digest[field] in parsed.text
        assert digest[field] in result["text"]
    for item in digest["items"]:
        assert item["title"] in parsed.text and item["detail"] in parsed.text
        assert (
            item["title"] in result["text"] and item["detail"] in result["text"]
        )
    if state != "current":
        assert "研究讨论时间待确认" not in parsed.text
    if state in {"unavailable", "disabled"}:
        assert "0 条来源记录" not in parsed.text
        assert "没有新的入库事件" not in parsed.text


async def test_unknown_personal_record_count_differs_from_zero():
    unknown = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    unknown.pop("task_count")
    result = render(unknown)
    assert not re.search(r"\d+ 条来源记录", EmailStructure(result["html"]).text)
    assert not re.search(r"\d+ 条来源记录", result["text"])
    empty = copy.deepcopy(unknown)
    empty.update(
        state="empty", items=[], summary="没有新的入库事件。", task_count=0
    )
    known_zero = render(empty)
    assert "0 条来源记录" in EmailStructure(known_zero["html"]).text
    assert "0 条来源记录" in known_zero["text"]


async def test_private_text_is_escaped_without_truncation():
    digest = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    attack = (
        '<img src="https://evil.example/tracker" '
        'onerror="alert(1)"><script>x</script>&'
    )
    long_url = "https://example.org/" + "long-path-" * 80
    detail = (
        ("中文长段落用于检验完整保留。" * 120) + "\n" + attack + "\n" + long_url
    )
    digest.update(
        title=attack, summary=attack + "\n第二段事件概述。", source_label=attack
    )
    digest["items"][0].update(title=attack, detail=detail)
    digest["limitations"] = attack
    result = render(digest, chart=False)
    parsed = EmailStructure(result["html"])
    assert not {"script", "img"}.intersection(
        node["tag"] for node in parsed.elements
    )
    assert all("evil.example" not in link for link in parsed.links)
    assert "&lt;script&gt;" in result["html"]
    assert detail in result["text"]
    assert detail.replace("\n", "") in parsed.text
    assert attack in parsed.text and long_url in parsed.text
    assert any(node["tag"] == "br" for node in parsed.elements)


async def test_representative_issue_has_a_deliberate_html_size_budget():
    # A project budget, not a claim that every client clips at the same
    # threshold.
    result = render(await todofy.FakeTodofy().fetch(ISSUE_DATE))
    assert len(result["html"].encode("utf-8")) < 80 * 1024
    assert (
        "data:image" not in result["html"]
    )  # Base64 belongs to MIME, not email HTML.


async def test_no_chart_no_personal_modules_never_leave_broken_placeholders():
    digest = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    no_chart = render(digest, chart=False)
    parsed = EmailStructure(no_chart["html"])
    assert no_chart["chart_png"] == ""
    assert not any(node["tag"] == "img" for node in parsed.elements)
    assert "一图看懂 / 数据视角" not in parsed.text
    assert "图表原始数据" not in no_chart["html"]
    assert digest["items"][0]["title"] in parsed.text
    without_personal = render(chart=False)
    assert (
        "TODOFY / 与你有关" not in EmailStructure(without_personal["html"]).text
    )
    assert "None" not in without_personal["html"]


async def test_complete_personal_issue_round_trips_as_frozen_cid_mime(tmp_path):
    digest = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    rendered = render(digest)
    edition = {
        "id": "email-design-fixture",
        "state": "ready",
        "is_fixture": True,
        "draft": rendering.SAMPLE_DRAFT,
        "personal_digest": digest,
        "rendered": rendered,
    }
    outcome = await adapters.FakeMail(tmp_path).send(
        edition, "email-design/frozen-cid"
    )
    message = parser.BytesParser(policy=policy.default).parsebytes(
        next(tmp_path.glob("*.eml")).read_bytes()
    )
    assert outcome["delivery_state"] == "simulated"
    assert message.get_content_type() == "multipart/alternative"
    assert message["X-Newsletter-Render-Hash"] == rendered["render_hash"]
    plain = message.get_body(preferencelist=("plain",)).get_content()
    html = message.get_body(preferencelist=("html",)).get_content()
    assert plain.replace("\r\n", "\n").rstrip() == rendered["text"].rstrip()
    assert html.replace("\r\n", "\n").rstrip() == rendered["html"].rstrip()
    image_parts = [
        part
        for part in message.walk()
        if part.get_content_type() == "image/png"
    ]
    assert len(image_parts) == 1
    assert image_parts[0]["Content-ID"] == "<newsletter-chart>"
    assert image_parts[0].get_payload(decode=True) == base64.b64decode(
        rendered["chart_png"]
    )
    assert (
        newsletter_rendering.CHART_CID in html
        and digest["items"][0]["detail"] in plain
    )
    assert rendered["render_hash"] == contracts.content_hash(
        {key: rendered[key] for key in ("html", "text", "chart_png")}
    )


async def test_personal_change_changes_approval_hash_without_mutating_inputs():
    digest = await todofy.FakeTodofy().fetch(ISSUE_DATE)
    original = copy.deepcopy(digest)
    before = render(digest)
    assert digest == original
    changed = copy.deepcopy(digest)
    changed["items"][0]["detail"] += "\n新信息：仍需你确认。"
    after = render(changed)
    assert before["html"] != after["html"]
    assert before["text"] != after["text"]
    assert before["render_hash"] != after["render_hash"]
    assert before["chart_png"] == after["chart_png"]
