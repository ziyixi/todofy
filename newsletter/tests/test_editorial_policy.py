"""Guard explicit editorial requirements; not a model quality evaluation.

The legacy whole-edition policy (policy/editorial.md) was removed with its
editor. Topic runs freeze story-editorial.md or the content-config policy.
"""

import importlib.resources as resources

import pytest


@pytest.fixture
def reader_profile():
    return (
        resources.files("newsletter")
        .joinpath("policy/reader-profile.md")
        .read_text(encoding="utf-8")
    )


def test_news_profile_excludes_legacy_research_reservations(reader_profile):
    assert "高优先级" in reader_profile and "不排他" in reader_profile
    assert "研究没有固定保留席位" in reader_profile
    assert "默认全期最多一个以研究为主体" in reader_profile
    assert "候选继续采集和归档" in reader_profile
    assert "接受短刊" in reader_profile
    assert "公共健康" in reader_profile and "经济" in reader_profile


@pytest.mark.parametrize(
    "source",
    ["NeurIPS", "ICML", "ICLR", "ACL", "CVPR", "Nature", "Science", "arXiv"],
)
def test_research_discovery_accepts_multiple_venues_without_venue_as_proof(
    reader_profile, source
):
    assert source in reader_profile
    assert "声誉不等于证据" in reader_profile
    assert "顶级研究组" in reader_profile


def test_legacy_whole_edition_policy_is_not_packaged():
    assert not (
        resources.files("newsletter").joinpath("policy/editorial.md").is_file()
    )


@pytest.mark.parametrize("direction", ["01-ai-ml.md", "02-science.md"])
def test_research_guides_require_read_scope_and_clear_overview(
    direction,
):
    instruction = (
        resources.files("newsletter")
        .joinpath(f"instructions/{direction}")
        .read_text(encoding="utf-8")
    )
    assert "摘要页或落地页不等于 PDF 正文" in instruction
    assert "full_text 只用于实际读到全文的来源" in instruction
    assert "同步调整 URL、access_scope、excerpt 和 body" in instruction
    assert "删除未读方法与数字，不能仅替换 URL" in instruction
    assert "缺少支撑核心结论的证据时返回 no_findings" in instruction
    assert "2–3 句自足概览" in instruction
    assert "不点击链接也应知道研究做了什么" in instruction
