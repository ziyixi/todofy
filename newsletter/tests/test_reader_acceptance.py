"""Offline reader release checks, never real research, account access or mail.

The chart is explicitly fictional test data. Only local MIME artifacts are sent
through FakeMail; a separate render-only check exercises real-count formatting.
"""

import base64
import copy
import email.parser as parser
import email.policy as policy
import io

import httpx
import PIL.Image as Image
import pytest

import newsletter.adapters as adapters
import newsletter.rendering as newsletter_rendering
import newsletter.store as newsletter_store
import newsletter.todofy as todofy
import newsletter.usage as newsletter_usage
import newsletter.workflow.publication as newsletter_workflow_publication
import tests.support.publication as publication
import tests.support.rendering as rendering
import tests.support.story_editor as story_editor
import tests.support.usage as tests_support_usage

# Reuse the offline writer/reviewer harness, including observed-source receipts.


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Reader acceptance attempted real network access")

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", forbidden
    )


@pytest.mark.parametrize("chart_status", ["approved", "blocked", "not_present"])
async def test_degraded_mail_keeps_topic_identity_and_chart_audit(
    tmp_path, rig, chart_status
):
    science = story_editor.story(chart=chart_status != "not_present")
    science.update(kind="science", title="离线科学样题：两组观测意味着什么")
    proposed_chart = copy.deepcopy(science.get("chart"))
    rig.replies = [
        story_editor.reply(story_editor.writer(science)),
        story_editor.reply(story_editor.review(chart=chart_status)),
    ]
    science_result = await rig.run(mode="deep")
    assert (
        len(rig.calls) == 2
    )  # A rejected optional chart cannot trigger body repair.

    tasks = [
        publication.task(1),
        publication.task(2, id="story-a"),
        publication.task(3),
        publication.task(4),
    ]
    values = [
        publication.result(
            1,
            content=publication.story(
                1,
                kind="ai_ml",
                title="离线 AI 样题：已审简讯保留",
                limitations="AI 样题的独立边界。",
            ),
        ),
        publication.result(
            1, "deep", content=False, reason="editor_unavailable"
        ),
        science_result,
        publication.result(
            3,
            content=publication.story(
                3,
                kind="world",
                title="离线世界样题：独立公共事件",
                limitations="世界样题的独立边界。",
            ),
        ),
        publication.result(4, content=False),
    ]
    store = newsletter_store.Store(tmp_path / "reader.sqlite3", "mock")
    try:
        repository = newsletter_workflow_publication.PublicationRepository(
            store
        )
        repository.save_plan("reader-release", publication.DAY, tasks)
        tasks_by_id = {item["id"]: item for item in tasks}
        for value in values:
            repository.save(
                "reader-release",
                tasks_by_id[value["story_id"]],
                value["mode"],
                value,
                issue_date=publication.DAY,
            )
        built = newsletter_workflow_publication.assemble(
            "reader-release",
            publication.DAY,
            tasks,
            repository.results("reader-release"),
            reason="workflow_deadline",
        )
        repository.record_publication(
            "reader-release", publication.DAY, tasks, built
        )
    finally:
        store.close()

    # Diagnostics must survive the freeze and a process restart, not just exist
    # in an in-memory fixture. They are operator audit, not invented reader
    # copy.
    store = newsletter_store.Store(tmp_path / "reader.sqlite3", "mock")
    try:
        repository = newsletter_workflow_publication.PublicationRepository(
            store
        )
        assert repository.get_publication("reader-release") == built
        saved = next(
            value
            for value in repository.results("reader-release")
            if value["story_id"] == "story-a"
        )
        audit = next(
            item
            for item in saved["assessments"]
            if item["component"] == "chart"
        )
        assert audit["status"] == chart_status
        if chart_status == "blocked":
            assert audit["findings"] == ["fixture finding"]
        if chart_status == "not_present":
            assert audit["content_hash"] == ""
    finally:
        store.close()

    assert built["coverage"]["mode"] == "partial"
    assert [item["disposition"] for item in built["coverage"]["stories"]] == [
        "brief",
        "deep",
        "brief",
        "deferred",
    ]
    personal = await todofy.FakeTodofy().fetch(publication.DAY)
    rendered = newsletter_rendering.render_edition(
        built["draft"],
        built["packets"],
        publication.DAY,
        is_fixture=True,
        personal_digest=personal,
        usage=newsletter_usage.summarize_usage(
            tests_support_usage.record_one()
        ),
    )
    panels = rendered["html"].split('class="story-panel"')[1:]
    sections = built["draft"]["sections"]
    assert len(panels) == 3
    for panel, section, label in zip(
        panels, sections, ["AI / ML 进展", "科学进展", "世界简报"], strict=True
    ):
        assert label in panel
        assert f">{section['heading']}</h2>" in panel
        assert section["limitations"] in panel
        assert f"{label}｜{section['heading']}" in rendered["text"]
        for paragraph in section["paragraphs"]:
            assert paragraph["text"] in panel
        for other in sections:
            if other is not section:
                assert other["heading"] not in panel
                assert other["limitations"] not in panel
    assert "今日简讯" not in rendered["html"]
    assert "另有 1 个入选选题暂未刊出" in rendered["text"]
    for output in (rendered["html"], rendered["text"]):
        assert output.index("TODOFY / 与你有关") > output.index(
            sections[-1]["heading"]
        )
        assert output.index("TODOFY / 与你有关") > output.index(
            "https://example.org/research/3"
        )
        if chart_status == "approved":
            assert output.index("TODOFY / 与你有关") > output.index(
                proposed_chart["question"]
            )
        assert output.index(personal["items"][-1]["detail"]) < output.index(
            "MOCK · 用量"
        )
    public_html = rendered["html"].split("TODOFY / 与你有关", 1)[0]
    assert personal["items"][0]["detail"] not in public_html

    edition = {
        "id": "reader-fixture",
        "is_fixture": True,
        "state": "ready",
        "draft": built["draft"],
        "rendered": rendered,
    }
    mail = adapters.FakeMail(tmp_path / "mail")
    sent = await mail.send(edition, "reader-fixture")
    artifact = next((tmp_path / "mail").glob("*.eml"))
    frozen_bytes = artifact.read_bytes()
    message = parser.BytesParser(policy=policy.default).parsebytes(frozen_bytes)
    assert sent["delivery_state"] == "simulated"
    assert message["X-Newsletter-Simulated"] == "true"
    # MIME uses CRLF transport line endings; no text or inline styling may
    # change.
    for subtype, field in (("html", "html"), ("plain", "text")):
        decoded = message.get_body(preferencelist=(subtype,)).get_content()
        assert decoded.replace("\r\n", "\n").rstrip("\n") == rendered[
            field
        ].rstrip("\n")
    images = [
        part
        for part in message.walk()
        if part.get_content_type() == "image/png"
    ]
    parsed = rendering.ParsedEmail(rendered["html"])
    if chart_status == "approved":
        assert built["draft"]["chart"] == proposed_chart
        assert len(images) == len(parsed.images) == 1
        assert parsed.images[0]["src"] == newsletter_rendering.CHART_CID
        assert parsed.images[0]["alt"] == proposed_chart["alt_text"]
        assert images[0]["Content-ID"] == "<newsletter-chart>"
        png = base64.b64decode(rendered["chart_png"])
        assert images[0].get_payload(decode=True) == png
        image = Image.open(io.BytesIO(png))
        assert image.format == "PNG" and image.width == 1280
        assert (
            newsletter_rendering.CHART_CID
            not in newsletter_rendering.preview_html(rendered)
        )
        assert "data:image/png;base64," in newsletter_rendering.preview_html(
            rendered
        )
    else:
        assert "chart" not in built["draft"]
        assert not images and not parsed.images and rendered["chart_png"] == ""
        assert newsletter_rendering.CHART_CID not in rendered["html"]
        assert "一图看懂" not in rendered["html"]
    assert await mail.send(edition, "reader-fixture") == sent
    assert artifact.read_bytes() == frozen_bytes
    assert len(list((tmp_path / "mail").glob("*.eml"))) == 1


def test_wide_reader_layout_has_utf8_headroom_and_disjoint_partial_usage():
    """Guard representative HTML size, not every Gmail client's behavior."""
    draft = copy.deepcopy(rendering.SAMPLE_DRAFT)
    draft["title"] = draft["subject"] = "八题离线验收样张，不是真实新闻"
    kinds = [
        "ai_ml",
        "science",
        "economy",
        "technology",
        "health",
        "world",
        "feature",
        "context",
    ]
    draft["sections"] = [
        {
            "kind": kind,
            "heading": f"第{number}题：离线长标题说明已知变化与仍需核验的边界",
            "paragraphs": [
                {
                    "text": (
                        f"第{number}题第{part}段。"
                        + "这是离线中文材料，比较方法与结果并保留不确定性。" * 8
                    ),
                    "citations": ["sample-packet/methods"],
                }
                for part in range(1, 5 if number <= 2 else 3)
            ],
            "limitations": (
                f"第{number}题仅为离线样张，不能当作事实或推断因果。"
            ),
        }
        for number, kind in enumerate(kinds, 1)
    ]
    packets = copy.deepcopy(rendering.SAMPLE_PACKETS)
    # Exercise production footer formatting without sending or claiming these
    # synthetic source/usage values came from a real account.
    packets[0]["is_fixture"] = False
    usage = newsletter_usage.summarize_usage(
        tests_support_usage.record_one(
            tests_support_usage.notification(
                6_000_000, 90_000, cached=5_000_000
            )
        )
    )
    usage["partial"] = True
    rendered = newsletter_rendering.render_edition(
        draft,
        packets,
        publication.DAY,
        personal_digest=todofy.unavailable_digest(),
        usage=usage,
    )
    html_bytes = len(rendered["html"].encode("utf-8"))
    assert html_bytes < 90 * 1024, (
        f"Representative email HTML grew to {html_bytes} UTF-8 bytes"
    )
    assert html_bytes > len(
        rendered["html"]
    )  # Count bytes, not Chinese characters.
    assert (
        "data:image/png;base64," not in rendered["html"]
    )  # CID data isn't inlined into HTML.
    assert rendered["html"].count('class="story-panel"') == 8
    for output in (rendered["html"], rendered["text"]):
        assert (
            "非缓存输入 1,000,000 · 缓存输入 5,000,000 · 输出 90,000" in output
        )
        assert "6,090,000 tokens" in output and "11,090,000" not in output
        assert "部分用量，未含未返回用量的调用" in output
        assert "Todofy/Gemini 用量未计入" in output
        assert output.index("TODOFY / 与你有关") < output.index("Codex 已记录")
        assert "plan" not in output.lower()
