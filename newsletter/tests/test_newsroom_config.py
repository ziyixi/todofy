"""Exercise authored newsroom configuration without model or provider calls.

These checks cover policy delivery, publication and email rendering. Simulated
writer replies do not establish that a real model produces readable reporting.
"""

import copy
import html
import pathlib

import pytest

import newsletter.content_config as content_config
import newsletter.rendering as newsletter_rendering
import newsletter.todofy as todofy
import newsletter.usage as newsletter_usage
import newsletter.workflow.publication as newsletter_workflow_publication
import tests.support.publication as publication
import tests.support.rendering as rendering
import tests.support.story_editor as story_editor
import tests.support.usage as tests_support_usage


@pytest.fixture
def newsroom_config(tmp_path):
    authored = pathlib.Path(__file__).resolve().parents[1] / "content-config"
    snapshot = content_config.build_directory(authored, "a" * 40)
    root = tmp_path / "configuration"
    content_config.install_snapshot(root, snapshot)
    loaded = content_config.load_active(root)
    assert loaded == snapshot
    return loaded


@pytest.mark.parametrize("mode", ["brief", "deep"])
@pytest.mark.parametrize(
    "limitation", ["", "该虚构服务仅向已登记的测试用户开放。"]
)
async def test_authored_policy_allows_empty_or_specific_context(
    rig, newsroom_config, mode, limitation
):
    """Keep both paths publishable without adding model rounds or text gates."""
    policy = {
        name: newsroom_config["files"]["policy/" + name]
        for name in ("editorial.md", "reader-profile.md")
    }
    content = story_editor.story("虚构机构开放了一个离线测试服务。")
    content.update(kind="technology", limitations=limitation)
    original = copy.deepcopy(content)
    rig.replies = [
        story_editor.reply(story_editor.writer(content)),
        story_editor.reply(story_editor.review()),
    ]
    result = await rig.run(mode=mode, policy=policy)
    assert result["content"] == original
    assert result["issues"] == []
    assert len(rig.calls) == 2 and not rig.replies
    writer, reviewer = rig.calls
    assert writer["instructions"] == policy["editorial.md"]
    assert reviewer["instructions"] == policy["editorial.md"]
    assert writer["prompt"]["reader_profile"] == policy["reader-profile.md"]
    assert reviewer["prompt"]["content_untrusted"] == original
    assert writer["path"] != reviewer["path"]
    newsletter_workflow_publication.validate_result(result)
    assembled = newsletter_workflow_publication.assemble(
        "newsroom-test",
        "2026-09-06",
        [publication.task(id="story-a")],
        [result],
    )
    section = assembled["draft"]["sections"][0]
    assert section["heading"] == original["title"]
    assert section["paragraphs"] == original["paragraphs"]
    assert section["limitations"] == limitation
    assert assembled["review"]["passed"] is True


@pytest.mark.parametrize(
    "limitation",
    [
        "",
        "仅适用于虚构测试组 A & B。\n<b>这里是原文，不是 HTML。</b>",
        "此虚构测试没有对照组，现有证据无法证明改善由这项措施造成。",
    ],
)
def test_authored_email_preserves_context_and_optional_sections(
    newsroom_config, limitation
):
    draft = copy.deepcopy(rendering.SAMPLE_DRAFT)
    draft["sections"][0]["limitations"] = ""
    draft["sections"][1]["limitations"] = limitation
    original = copy.deepcopy(draft)
    summary = newsletter_usage.summarize_usage(tests_support_usage.record_one())
    rendered = newsletter_rendering.render_edition(
        draft,
        rendering.SAMPLE_PACKETS,
        "2026-09-06",
        is_fixture=True,
        personal_digest=todofy.unavailable_digest(),
        usage=summary,
        template_source=newsroom_config["files"]["templates/edition.html.j2"],
    )
    parsed = rendering.ParsedEmail(rendered["html"])
    visible = "".join(parsed.text)
    assert draft == original
    assert 'class="story-note"' not in rendered["html"]
    assert rendered["html"].count('class="story-context ink"') == bool(
        limitation
    )
    if limitation:
        assert limitation in rendered["text"]
        for line in limitation.splitlines():
            assert html.escape(line) in rendered["html"]
            assert line in visible
        assert "<b>这里是原文，不是 HTML。</b>" not in rendered["html"]
    for section in draft["sections"]:
        for paragraph in section["paragraphs"]:
            assert paragraph["text"] in visible
            assert paragraph["text"] in rendered["text"]
    assert rendered["chart_png"]
    assert any(
        image["src"] == newsletter_rendering.CHART_CID
        for image in parsed.images
    )
    assert "图表说明：" + draft["chart"]["limitations"] in visible
    for source in rendering.SAMPLE_PACKETS[0]["content"]["sources"]:
        assert source["url"] in parsed.links
        assert source["url"] in rendered["text"]
    footer = newsletter_usage.usage_footer(summary, is_fixture=True)
    for output in (visible, rendered["text"]):
        for paragraph in draft["recommended_reading"]["reason"].split("\n\n"):
            assert paragraph in output
        assert output.index(draft["chart"]["limitations"]) < output.index(
            "TODOFY / 与你有关"
        )
        assert output.index("来源与核对") < output.index("TODOFY / 与你有关")
        assert output.index("TODOFY / 与你有关") < output.index(footer)
        assert output.rstrip().endswith(footer)
