"""Test static usage footers with frozen hashes and no remote assets."""

import copy

import newsletter.rendering as newsletter_rendering
import newsletter.todofy as todofy
import newsletter.usage as newsletter_usage
import tests.support.rendering as rendering
import tests.support.usage as tests_support_usage


def render(usage=None, *, fixture=False):
    packets = copy.deepcopy(rendering.SAMPLE_PACKETS)
    packets[0]["is_fixture"] = fixture
    return newsletter_rendering.render_edition(
        rendering.SAMPLE_DRAFT, packets, "2026-09-05", usage=usage
    )


def test_footer_below_branding_also_ends_plain_text_and_changes_frozen_hash():
    summary = newsletter_usage.summarize_usage(tests_support_usage.record_one())
    without = render()
    with_usage = render(summary)
    assert "Codex 已记录 120 tokens" in with_usage["html"]
    assert "非缓存输入 40 · 缓存输入 60 · 输出 20" in with_usage["html"]
    assert "非缓存输入 40 · 缓存输入 60 · 输出 20" in with_usage["text"]
    assert "不重复相加" not in with_usage["text"]
    assert with_usage["html"].index("Codex 已记录") > with_usage["html"].index(
        "THE DAILY BRIEF"
    )
    assert "text-align:right" in with_usage["html"]
    assert with_usage["text"].rstrip().endswith("Todofy/Gemini 用量未计入。")
    assert without["render_hash"] != with_usage["render_hash"]
    assert without["chart_png"] == with_usage["chart_png"]
    assert render(summary) == with_usage


def test_uint64_wire_shape_does_not_change_html_or_text():
    summary = newsletter_usage.summarize_usage(tests_support_usage.record_one())
    wire = {
        **summary,
        "usage": {key: str(value) for key, value in summary["usage"].items()},
    }
    assert render(wire) == render(summary)


def test_existing_call_without_usage_keeps_footer_absent():
    assert "tokens" not in render()["html"]


def test_partial_footer_does_not_claim_complete_consumption():
    summary = newsletter_usage.summarize_usage(tests_support_usage.record_one())
    summary["partial"] = True
    assert "部分用量，未含未返回用量的调用" in render(summary)["html"]


def test_mock_footer_cannot_look_like_real_billable_usage():
    result = render(
        newsletter_usage.summarize_usage(tests_support_usage.record_one()),
        fixture=True,
    )
    assert "MOCK · 用量统计仅为流程演示" in result["html"]
    assert "120 tokens" not in result["html"]


def test_cached_usage_parts_are_disjoint_not_plan_percent():
    summary = newsletter_usage.summarize_usage(
        tests_support_usage.record_one(
            tests_support_usage.notification(
                6_000_000, 90_000, cached=5_000_000
            )
        )
    )
    result = render(summary)
    for output in (result["html"], result["text"]):
        assert "6,090,000 tokens" in output
        assert (
            "非缓存输入 1,000,000 · 缓存输入 5,000,000 · 输出 90,000" in output
        )
        assert "11,090,000" not in output
        assert "plan" not in output.lower()


def test_bad_counts_produce_no_negative_or_silent_zero_usage():
    summary = newsletter_usage.summarize_usage(
        tests_support_usage.record_one(
            tests_support_usage.notification(100, 20, cached=101)
        )
    )
    result = render(summary)
    assert "输入/输出拆分不可确定" in result["text"]
    assert "非缓存输入 -1" not in result["text"]
    assert "非缓存输入 0" not in result["text"]
    assert "部分用量" in result["text"]


def test_chart_and_missing_digest_keep_partial_footer_last():
    packets = copy.deepcopy(rendering.SAMPLE_PACKETS)
    packets[0]["is_fixture"] = False
    summary = newsletter_usage.summarize_usage(
        tests_support_usage.record_one(
            tests_support_usage.notification(
                6_000_000, 90_000, cached=5_000_000
            )
        )
    )
    summary["partial"] = True
    rendered = newsletter_rendering.render_edition(
        rendering.SAMPLE_DRAFT,
        packets,
        "2026-09-05",
        personal_digest=todofy.unavailable_digest(),
        usage=summary,
    )
    html_text = "".join(rendering.ParsedEmail(rendered["html"]).text)
    for output in (html_text, rendered["text"]):
        chart = rendering.SAMPLE_DRAFT["chart"]
        assert output.index(chart["caption"]) < output.index(
            chart["limitations"]
        )
        assert output.index(chart["limitations"]) < output.index(
            "TODOFY / 与你有关"
        )
        assert output.index("TODOFY / 与你有关") < output.index("Codex 已记录")
        assert "6,090,000 tokens" in output
        assert (
            "非缓存输入 1,000,000 · 缓存输入 5,000,000 · 输出 90,000" in output
        )
        assert "部分用量，未含未返回用量的调用" in output
        assert "11,090,000" not in output
        assert output.rstrip().endswith("Todofy/Gemini 用量未计入。")
    assert len(rendered["html"].encode("utf-8")) <= 92_160
