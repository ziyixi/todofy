"""Guard explicit editorial requirements; not a model quality evaluation."""

import importlib.resources as resources

import pytest


@pytest.fixture
def editorial_policy():
    return (
        resources.files("newsletter")
        .joinpath("policy/editorial.md")
        .read_text(encoding="utf-8")
    )


@pytest.fixture
def reader_profile():
    return (
        resources.files("newsletter")
        .joinpath("policy/reader-profile.md")
        .read_text(encoding="utf-8")
    )


def test_news_profile_excludes_legacy_research_reservations(
    editorial_policy, reader_profile
):
    assert "高优先级" in reader_profile and "不排他" in reader_profile
    assert "研究没有固定保留席位" in reader_profile
    assert "默认全期最多一个以研究为主体" in reader_profile
    assert "候选继续采集和归档" in reader_profile
    assert "接受短刊" in reader_profile
    # Legacy non-topic recipes and already-frozen policies retain their original
    # two-feature contract. New topic runs freeze story-editorial.md instead.
    assert "不必二选一" in editorial_policy
    assert "可有两个 feature" in editorial_policy
    assert (
        "两条研究线都有足够证据和阅读价值时，优先同时入正文" in editorial_policy
    )
    assert "未选其中一条时，在 review.findings" in editorial_policy
    assert "不编造缺失材料，也不为覆盖面凑数" in editorial_policy
    assert "world/feature/context" in editorial_policy
    assert "公共健康" in reader_profile and "经济" in reader_profile


@pytest.mark.parametrize(
    "source",
    ["NeurIPS", "ICML", "ICLR", "ACL", "CVPR", "Nature", "Science", "arXiv"],
)
def test_research_discovery_accepts_multiple_venues_without_venue_as_proof(
    editorial_policy, reader_profile, source
):
    assert source in editorial_policy and source in reader_profile
    assert (
        "声誉不等于证据" in editorial_policy
        and "声誉不等于证据" in reader_profile
    )
    assert "公司技术报告" in editorial_policy and "顶级研究组" in reader_profile
    assert "未核实同行评议状态就明示未知" in editorial_policy
    assert "厂商自测不等于独立复现" in editorial_policy


def test_every_research_and_card_must_explain_the_evidence_without_a_click(
    editorial_policy,
):
    assert "研究问题、方法、结果、限制、意义" in editorial_policy
    assert "不点击链接，也能理解" in editorial_policy
    assert "reason 总长不超过 1000 字符" in editorial_policy
    assert "唯一 citation 必须支持卡片中的事实" in editorial_policy
    assert (
        "只能读到摘要" in editorial_policy
        and "不编造全文细节" in editorial_policy
    )
    assert "可省略卡片" in editorial_policy


def test_incompatible_population_counts_and_model_thresholds_are_not_conflated(
    editorial_policy,
):
    assert "WHO、OCHA" in editorial_policy
    assert "原文未明确的子集、包含、互斥或去重关系不得推断" in editorial_policy
    assert (
        "不同日期、区域" in editorial_policy
        and "不可混用分母" in editorial_policy
    )
    assert "报告数、核实数和估计数也不能互换" in editorial_policy
    assert "不得写成生理实测阈值" in editorial_policy
    assert "不等于实验测得的致死温度" in editorial_policy
    assert "不等于已发生的死亡率、灭绝率" in editorial_policy


def test_editor_recomputes_research_recency_instead_of_trusting_collection_note(
    editorial_policy,
):
    assert "以 issue_date 和原始来源的日期自行计算" in editorial_policy
    assert "不沿用采集 note" in editorial_policy
    assert "回看/非近期进展" in editorial_policy
    assert "不能把会议首日自动当成发表日" in editorial_policy


def test_editor_recomputes_numeric_claims_and_preserves_cost_assumptions(
    editorial_policy,
):
    assert "用同一口径的表格原值自行复算" in editorial_policy
    assert "分清百分比与百分点" in editorial_policy
    assert "增加到原值的几倍与增加了百分之几" in editorial_policy
    assert "矛盾时不照搬，优先列出原始值" in editorial_policy
    assert "注明口径冲突" in editorial_policy
    assert "四舍五入或近似差值加“约”" in editorial_policy
    assert "价格基期、币种、计量范围及缓存假设" in editorial_policy
    assert "不能把历史 API 报价当成当前价格" in editorial_policy
    assert "未计入训练成本的推理费用称为总成本" in editorial_policy


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
