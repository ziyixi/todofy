"""Test offline projection contracts with synthetic Notion content."""

import base64
import copy
import json

import pytest

import newsletter.notion_content as newsletter_notion_content
import tests.support.notion_content as notion_content


def property_text(projection, name):
    prop = projection.properties[name]
    return "".join(
        item["text"]["content"]
        for item in prop.get("rich_text", prop.get("title", []))
    )


def test_material_properties_are_typed_and_metadata_is_not_repeated_in_prose():
    source = notion_content.candidate()
    result = notion_content.project_material(source)
    body = notion_content.block_text(result.blocks)
    assert result.properties["title"] == {
        "title": [{"type": "text", "text": {"content": source["title"]}}]
    }
    assert property_text(result, "authors") == source["authors"]
    assert property_text(result, "affiliations") == source["affiliations"]
    assert result.properties["category"] == {"select": {"name": "AI/ML"}}
    assert result.properties["direction"] == {
        "multi_select": [{"name": "01-ai-ml"}]
    }
    assert result.properties["first_seen"] == {
        "date": {"start": notion_content.DAY}
    }
    assert result.properties["access_scope"] == {"select": {"name": "摘要"}}
    assert result.properties["material_type"] == {"select": {"name": "论文"}}
    assert result.properties["sync_state"] == {"select": {"name": "同步中"}}
    assert "edition_ids" not in result.properties
    for value in (
        source["authors"],
        source["affiliations"],
        "run-fixture",
        result.digest,
        "Fixture:",
    ):
        assert value not in body
    for field in ("summary", "contribution", "why_now", "source_basis"):
        assert source[field] in body
    assert result.chart_png is None


def test_material_never_infers_authors_from_associated_multisource_research():
    source = notion_content.candidate(
        authors="", affiliations="", venue="", publication_status=""
    )
    research = notion_content.packet()
    research["content"]["body"] = (
        "An unrelated source mentions Famous Author from Famous Institute."
    )
    result = notion_content.project_material(
        source, evidence=[research, copy.deepcopy(research)]
    )
    assert (
        property_text(result, "authors")
        == property_text(result, "affiliations")
        == ""
    )
    assert result.properties["material_type"] == {"select": {"name": "未分类"}}
    text = notion_content.block_text(result.blocks)
    assert text.count(research["content"]["body"]) == 1
    assert "不代表该候选的全部主张都已独立核实" in text
    assert all(
        source["excerpt"] in text for source in research["content"]["sources"]
    )


def test_legacy_candidate_unknown_fields_stay_empty():
    old = notion_content.candidate()
    for field in (
        "authors",
        "affiliations",
        "venue",
        "publication_status",
        "contribution",
        "source_basis",
        "evidence_urls",
    ):
        old.pop(field)
    original = copy.deepcopy(old)
    result = notion_content.project_material(old)
    assert property_text(result, "authors") == ""
    assert property_text(result, "value") == old["why_now"]
    assert old == original


def test_conflicting_packet_identity_cannot_be_silently_overwritten():
    first = notion_content.packet()
    other = copy.deepcopy(first)
    other["content"]["body"] = "Different synthetic research."
    with pytest.raises(ValueError, match="Conflicting"):
        notion_content.project_material(evidence=[first, other])


def test_material_determinism_and_property_only_progress_updates():
    source, evidence = (
        notion_content.candidate(),
        [notion_content.packet("packet-b"), notion_content.packet("packet-a")],
    )
    before = copy.deepcopy((source, evidence))
    first = notion_content.project_material(source, evidence=evidence)
    second = notion_content.project_material(
        source, evidence=list(reversed(evidence)), progress="已刊出"
    )
    assert first.blocks == second.blocks and first.digest == second.digest
    assert first.properties["progress"] != second.properties["progress"]
    assert (source, evidence) == before
    changed = notion_content.project_material(
        notion_content.candidate(summary="A different synthetic finding."),
        evidence=evidence,
    )
    assert changed.digest != first.digest


@pytest.mark.parametrize(
    "scope,label",
    [
        ("metadata", "仅线索"),
        ("abstract", "摘要"),
        ("full_text", "全文"),
        ("dataset", "仅线索"),
    ],
)
def test_access_scope_does_not_upgrade_a_dataset_to_full_text(scope, label):
    result = notion_content.project_material(
        notion_content.candidate(access_scope=scope)
    )
    assert result.properties["access_scope"] == {"select": {"name": label}}
    if scope == "dataset":
        assert "访问范围：数据集" in notion_content.block_text(result.blocks)


@pytest.mark.parametrize(
    "status,url,kind",
    [
        ("", "https://arxiv.org/abs/2609.12345", "预印本"),
        ("已发表（合成刊会）", "https://arxiv.org/abs/2609.12345", "论文"),
        ("技术报告", "https://example.org/report", "技术报告"),
        ("尚未接收", "https://openreview.net/forum?id=synthetic", "未分类"),
    ],
)
def test_material_type_does_not_treat_doi_or_openreview_as_acceptance(
    status, url, kind
):
    result = notion_content.project_material(
        notion_content.candidate(publication_status=status, url=url)
    )
    assert result.properties["material_type"] == {"select": {"name": kind}}


def test_material_evidence_is_complete_above_old_6000_character_limit():
    research = notion_content.packet()
    research["content"]["body"] = "😀合成正文\n" * 8000
    result = notion_content.project_material(evidence=[research])
    assert research["content"]["body"] in notion_content.block_text(
        result.blocks
    )
    assert "已截断" not in notion_content.block_text(result.blocks)
    for block in result.blocks:
        rich = block[block["type"]]["rich_text"]
        assert len(rich) <= 100
        assert all(
            len(item["text"]["content"].encode("utf-16-le")) // 2 <= 2000
            for item in rich
        )


def test_text_chunking_preserves_astral_unicode_whitespace_and_literal_markup():
    value = " 😀 <script>not executable</script> **literal**\n" * 10_000
    chunks = newsletter_notion_content._chunks(value)
    assert "".join(chunks) == value
    blocks = newsletter_notion_content._blocks(value)
    assert len(blocks) > 1
    assert (
        "".join(
            item["text"]["content"]
            for block in blocks
            for item in block["paragraph"]["rich_text"]
        )
        == value
    )
    with pytest.raises(ValueError, match="surrogate"):
        newsletter_notion_content._chunks("bad\ud800")
    with pytest.raises(ValueError, match="capacity"):
        newsletter_notion_content._text_property(value)


def test_edition_keeps_sections_reading_chart_sources_and_topics():
    value = notion_content.edition()
    result = newsletter_notion_content.edition_projection(
        value, packets=[notion_content.packet()]
    )
    text = notion_content.block_text(result.blocks)
    for section in value["draft"]["sections"]:
        assert section["heading"] in text
        assert all(p["text"] in text for p in section["paragraphs"])
        assert section["limitations"] in text
    for field in (
        "question",
        "caption",
        "alt_text",
        "metric",
        "unit",
        "period",
        "limitations",
    ):
        assert value["draft"]["chart"][field] in text
    assert "另一组：缺失（尚未公布）" in text
    assert value["draft"]["recommended_reading"]["reason"] in text
    assert "来源与核对" in text and "[1]" in text and "[2]" in text
    assert "Synthetic pending topic｜暂缓刊出" in text
    links = [
        item["text"].get("link", {}).get("url")
        for b in result.blocks
        if b["type"] != newsletter_notion_content.CHART_PLACEHOLDER
        for item in b[b["type"]]["rich_text"]
    ]
    assert all(
        s["url"] in links for s in notion_content.packet()["content"]["sources"]
    )
    assert result.chart_png == notion_content.PNG
    assert (
        sum(
            b["type"] == newsletter_notion_content.CHART_PLACEHOLDER
            for b in result.blocks
        )
        == 1
    )
    assert result.key == "edition:edition-fixture"
    assert "material_ids" not in result.properties


def test_public_default_ignores_private_email_and_payload():
    value = notion_content.edition()
    result = newsletter_notion_content.edition_projection(
        value, packets=[notion_content.packet()]
    )
    assert "PRIVATE" not in json.dumps(result.blocks)
    assert result.properties["contains_personal"] == {"checkbox": False}
    value["personal_digest"] = {"invalid": "PRIVATE MALFORMED"}
    assert (
        newsletter_notion_content.edition_projection(
            value, packets=[notion_content.packet()]
        ).digest
        == result.digest
    )
    with pytest.raises(
        ValueError, match="Unknown or non-snake_case field in PersonalDigest"
    ):
        newsletter_notion_content.edition_projection(
            value, packets=[notion_content.packet()], include_personal=True
        )


def test_explicit_private_archive_is_complete_and_after_public_sources():
    result = newsletter_notion_content.edition_projection(
        notion_content.edition(),
        packets=[notion_content.packet()],
        include_personal=True,
    )
    text = notion_content.block_text(result.blocks)
    for value in (
        "PRIVATE SUMMARY",
        "PRIVATE TASK",
        "PRIVATE DETAIL",
        "PRIVATE SOURCE",
        "PRIVATE BOUNDARY",
        "7 条来源记录",
        "最近 24 小时",
        "2026-09-07T15:00:00Z",
    ):
        assert value in text
    assert (
        text.index("来源与核对")
        < text.index("TODOFY / 与你有关")
        < text.index("Codex 已记录")
    )
    assert "PRIVATE RENDERED BODY" not in text
    assert result.properties["contains_personal"] == {"checkbox": True}
    with pytest.raises(ValueError, match="explicit"):
        newsletter_notion_content.edition_projection(
            notion_content.edition(),
            packets=[notion_content.packet()],
            include_personal="true",
        )


def test_property_only_delivery_updates_never_change_frozen_body_digest():
    first = newsletter_notion_content.edition_projection(
        notion_content.edition(),
        packets=[notion_content.packet()],
        include_personal=True,
    )
    second = newsletter_notion_content.edition_projection(
        notion_content.edition(
            delivery_state="provider_accepted",
            provider_message_id="provider-id",
            updated_at="later",
        ),
        packets=[notion_content.packet()],
        include_personal=True,
    )
    assert first.digest == second.digest and first.blocks == second.blocks
    assert second.properties["delivery"] == {"select": {"name": "已提交"}}
    assert "已确认投递" not in json.dumps(second.properties, ensure_ascii=False)
    assert first.properties["tokens"] == {"number": 1000}
    assert first.properties["input_tokens"] == {"number": 900}
    assert first.properties["cached_tokens"] == {"number": 700}
    assert first.properties["output_tokens"] == {"number": 100}


def test_partial_and_absent_usage_are_not_fabricated_zeroes():
    partial = notion_content.edition(
        usage={
            "usage": None,
            "partial": True,
            "invocations": 2,
            "missing_invocations": 2,
        }
    )
    for value in (partial, notion_content.edition(usage=None)):
        result = newsletter_notion_content.edition_projection(
            value, packets=[notion_content.packet()]
        )
        assert result.properties["tokens"] == {"number": None}
        assert result.properties["usage_partial"] == {"checkbox": True}
        assert "模型用量未取得" in notion_content.block_text(result.blocks)


def test_missing_chart_png_keeps_every_chart_explanation_without_fake_image():
    value = notion_content.edition()
    value["rendered"]["chart_png"] = ""
    result = newsletter_notion_content.edition_projection(
        value, packets=[notion_content.packet()]
    )
    assert result.chart_png is None
    assert all(
        b["type"] != newsletter_notion_content.CHART_PLACEHOLDER
        for b in result.blocks
    )
    assert value["draft"]["chart"]["alt_text"] in notion_content.block_text(
        result.blocks
    )


@pytest.mark.parametrize(
    "encoded", ["not base64", base64.b64encode(b"not PNG").decode()]
)
def test_corrupt_frozen_png_is_rejected_not_silently_replaced(encoded):
    value = notion_content.edition()
    value["rendered"]["chart_png"] = encoded
    with pytest.raises(ValueError, match="chart"):
        newsletter_notion_content.edition_projection(
            value, packets=[notion_content.packet()]
        )


def test_unresolved_sources_fail_without_broken_archives():
    with pytest.raises(ValueError, match=r"Draft requires 1\.\.32 packets"):
        newsletter_notion_content.edition_projection(notion_content.edition())
    value = notion_content.edition()
    value["draft"]["sections"][0]["paragraphs"][0]["citations"] = [
        "missing/source"
    ]
    with pytest.raises(
        ValueError,
        match="Citation does not identify an available packet/source",
    ):
        newsletter_notion_content.edition_projection(
            value, packets=[notion_content.packet()]
        )


def test_more_than_one_hundred_blocks_remain_available_for_transport_batching():
    value = notion_content.edition()
    value["draft"]["sections"] = [
        {
            "kind": "science",
            "heading": f"Synthetic section {i}",
            "paragraphs": [
                {
                    "text": f"Synthetic paragraph {i}-{j}",
                    "citations": ["sample-packet/survey"],
                }
                for j in range(16)
            ],
            "limitations": "Synthetic boundary",
        }
        for i in range(12)
    ]
    result = newsletter_notion_content.edition_projection(
        value, packets=[notion_content.packet()]
    )
    assert len(result.blocks) > 200
    assert "Synthetic paragraph 11-15" in notion_content.block_text(
        result.blocks
    )


def test_projection_is_deterministic_and_never_mutates_frozen_inputs():
    value, evidence = notion_content.edition(), [notion_content.packet()]
    before = copy.deepcopy((value, evidence))
    first = newsletter_notion_content.edition_projection(
        value, packets=evidence, run_id="run-test", include_personal=True
    )
    assert first == newsletter_notion_content.edition_projection(
        value, packets=evidence, run_id="run-test", include_personal=True
    )
    assert (value, evidence) == before
    assert property_text(first, "content_hash") == first.digest
    revised = copy.deepcopy(value)
    revised["draft"]["introduction"] += " A corrected synthetic introduction."
    assert (
        newsletter_notion_content.edition_projection(
            revised, packets=evidence, include_personal=True
        ).digest
        != first.digest
    )


def test_same_date_editions_and_revisions_keep_identity():
    first = newsletter_notion_content.edition_projection(
        notion_content.edition(), packets=[notion_content.packet()]
    )
    second = newsletter_notion_content.edition_projection(
        notion_content.edition(id="second-edition"),
        packets=[notion_content.packet()],
        edition_type="修订",
    )
    assert first.key != second.key
    assert second.properties["edition_type"] == {"select": {"name": "修订"}}
    assert first.properties["issue_date"] == second.properties["issue_date"]
    with pytest.raises(ValueError, match="edition type"):
        newsletter_notion_content.edition_projection(
            notion_content.edition(),
            packets=[notion_content.packet()],
            edition_type="unknown",
        )


def test_fixture_material_cannot_be_hidden_by_a_false_caller_flag():
    evidence = notion_content.packet()
    evidence["is_fixture"] = True
    assert notion_content.project_material(evidence=[evidence]).properties[
        "fixture"
    ] == {"checkbox": True}
    result = newsletter_notion_content.edition_projection(
        notion_content.edition(), packets=[evidence]
    )
    assert result.properties["fixture"] == {"checkbox": True}
    assert result.properties["edition_type"] == {"select": {"name": "测试"}}


def test_long_source_url_remains_exact_plain_text():
    url = "https://example.org/" + "a" * 1990
    result = notion_content.project_material(
        notion_content.candidate(url=url, evidence_urls=[url])
    )
    assert result.properties["url"] == {"url": None}
    assert url in notion_content.block_text(result.blocks)


def test_invalid_property_date_fails_before_transport_would_create_a_page():
    with pytest.raises(ValueError, match="Invalid isoformat string"):
        notion_content.project_material(
            notion_content.candidate(published_at="unknown")
        )


@pytest.mark.parametrize(
    "candidate_url,doi,source_url",
    [
        (
            "https://example.org/paper",
            "10.1234/synthetic",
            "https://doi.org/10.1234/synthetic",
        ),
        (
            "https://arxiv.org/abs/2609.12345",
            "",
            "https://arxiv.org/pdf/2609.12345v2",
        ),
        ("https://example.org/paper", "", "https://example.org/paper"),
    ],
)
def test_read_scope_upgrade_preserves_discovery_metadata(
    candidate_url, doi, source_url
):
    lead = notion_content.candidate(
        url=candidate_url, doi=doi, access_scope="abstract"
    )
    research = notion_content.packet()
    research["content"]["sources"][0].update(
        url=source_url, access_scope="full_text"
    )
    result = notion_content.project_material(lead, evidence=[research])
    assert result.properties["access_scope"] == {"select": {"name": "全文"}}
    assert "发现记录的访问范围：摘要" in notion_content.block_text(
        result.blocks
    )
    assert property_text(result, "authors") == lead["authors"]
    assert property_text(result, "affiliations") == lead["affiliations"]
    assert lead["access_scope"] == "abstract"


@pytest.mark.parametrize(
    "source_url",
    ["https://example.org/unrelated-paper", "https://example.org/news"],
)
def test_unrelated_full_text_or_shared_landing_page_cannot_upgrade_candidate(
    source_url,
):
    lead = notion_content.candidate(
        url="https://example.org/news", doi="", access_scope="metadata"
    )
    research = notion_content.packet()
    research["content"]["sources"] = [
        {
            **research["content"]["sources"][0],
            "title": lead["title"],
            "url": source_url,
            "access_scope": "full_text",
        }
    ]
    result = notion_content.project_material(lead, evidence=[research])
    assert result.properties["access_scope"] == {"select": {"name": "仅线索"}}


@pytest.mark.parametrize(
    "discovered_scope,read_scope,expected",
    [
        ("metadata", "dataset", "仅线索"),
        ("metadata", "abstract", "摘要"),
        ("full_text", "abstract", "全文"),
    ],
)
def test_best_read_scope_keeps_dataset_boundaries(
    discovered_scope, read_scope, expected
):
    lead = notion_content.candidate(access_scope=discovered_scope)
    research = notion_content.packet()
    research["content"]["sources"][0].update(
        url=lead["url"], access_scope=read_scope
    )
    # The other source is full_text, but concerns a different work.
    result = notion_content.project_material(lead, evidence=[research])
    assert result.properties["access_scope"] == {"select": {"name": expected}}
