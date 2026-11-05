"""Test offline projection contracts with synthetic Notion content."""

import asyncio
import base64
import copy
import dataclasses
import hashlib
import json
import logging

import pytest

import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.editor as editor
import newsletter.files as files
import newsletter.notion_content as newsletter_notion_content
import newsletter.notion_intake as notion_intake
import newsletter.notion_journal as notion_journal
import newsletter.settings as newsletter_settings
import newsletter.store as store
import newsletter.worker as worker
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
        < text.index("模型已记录")
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


MATERIALS = "12345678-1234-1234-1234-123456789abc"
EDITIONS = "22345678-1234-1234-1234-123456789abc"


@pytest.fixture
def live(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        mode="live",
        editor_backend="codex",
        workflow_backend="dag",
        editor_token="e" * 32,
        send_token="s" * 32,
        model_router_url="https://models.example.test",
        model_router_token="synthetic-token",
        notion_backend="notion",
        notion_token="synthetic-provider-key",
    )


def test_dual_destinations_need_no_legacy_id(live):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    settings.validate()
    assert settings.notion_v2
    assert not settings.notion_archive_private
    assert "synthetic-provider-key" not in repr(settings)


def test_single_database_destination_was_removed(live, monkeypatch):
    # The old single-database variable is ignored, never a fallback.
    monkeypatch.setenv("NOTION_DATA_SOURCE_ID", MATERIALS)
    assert not hasattr(
        newsletter_settings.Settings.from_env(), "notion_data_source_id"
    )
    with pytest.raises(ValueError, match="NOTION_MATERIALS_DATA_SOURCE_ID"):
        live.validate()


def test_removed_legacy_workflow_backend_fails_visibly(live):
    settings = dataclasses.replace(
        live,
        workflow_backend="legacy",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="legacy backend was removed"):
        settings.validate()


@pytest.mark.parametrize(
    "field",
    ["notion_materials_data_source_id", "notion_editions_data_source_id"],
)
def test_half_configured_dual_mode_does_not_silently_fall_back(live, field):
    settings = dataclasses.replace(live, **{field: EDITIONS})
    with pytest.raises(
        ValueError, match="Set both NOTION_MATERIALS_DATA_SOURCE_ID"
    ):
        settings.validate()


@pytest.mark.parametrize(
    "editions", [MATERIALS, MATERIALS.replace("-", "").upper()]
)
def test_same_destination_is_rejected_in_all_uuid_formats(live, editions):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=editions,
    )
    with pytest.raises(ValueError, match="different data sources"):
        settings.validate()


def test_invalid_uuid_does_not_echo_configured_value(live):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id="misplaced-private-key",
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="valid data source IDs") as error:
        settings.validate()
    assert "misplaced-private-key" not in str(error.value)
    assert error.value.__suppress_context__


def test_missing_notion_token_remains_invalid(live):
    settings = dataclasses.replace(
        live,
        notion_token="",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="NOTION_TOKEN"):
        settings.validate()


def test_programmatic_privacy_configuration_rejects_truthy_strings(live):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
        notion_archive_private="false",
    )
    with pytest.raises(ValueError, match="must be a boolean"):
        settings.validate()


def test_mock_mode_cannot_enable_live_dual_database(live):
    settings = dataclasses.replace(
        live,
        mode="mock",
        editor_backend="mock",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="Mock mode forbids"):
        settings.validate()


def test_dual_settings_read_exact_environment_names(monkeypatch):
    monkeypatch.setenv("NOTION_MATERIALS_DATA_SOURCE_ID", MATERIALS)
    monkeypatch.setenv("NOTION_EDITIONS_DATA_SOURCE_ID", EDITIONS)
    monkeypatch.setenv("NEWSLETTER_NOTION_ARCHIVE_PRIVATE", "true")
    settings = newsletter_settings.Settings.from_env()
    assert settings.notion_v2
    assert settings.notion_materials_data_source_id == MATERIALS
    assert settings.notion_editions_data_source_id == EDITIONS
    assert settings.notion_archive_private is True


@pytest.mark.parametrize(
    "value,expected", [(None, False), ("false", False), ("TRUE", True)]
)
def test_private_archive_requires_explicit_boolean(
    monkeypatch, value, expected
):
    monkeypatch.delenv("NEWSLETTER_NOTION_ARCHIVE_PRIVATE", raising=False)
    if value is not None:
        monkeypatch.setenv("NEWSLETTER_NOTION_ARCHIVE_PRIVATE", value)
    assert (
        newsletter_settings.Settings.from_env().notion_archive_private
        is expected
    )


def test_private_archive_invalid_boolean_is_safe_configuration_error(
    monkeypatch,
):
    monkeypatch.setenv(
        "NEWSLETTER_NOTION_ARCHIVE_PRIVATE", "misplaced-private-key"
    )
    with pytest.raises(
        ValueError, match="NEWSLETTER_NOTION_ARCHIVE_PRIVATE"
    ) as error:
        newsletter_settings.Settings.from_env()
    assert "misplaced-private-key" not in str(error.value)


@pytest.mark.parametrize("body", ["null", "[]", "42", '"private marker"', "{"])
def test_bad_edition_shape_does_not_block_later_import(tmp_path, body, caplog):
    database = store.Store(tmp_path / "newsletter.sqlite3", "live")
    try:
        journal = notion_journal.NotionJournal(database, {"target": "offline"})
        intake = notion_intake.NotionIntake(journal, include_personal=False)
        valid = notion_content.edition(
            created_at="2026-09-07T13:00:00+00:00",
            updated_at="2026-09-07T13:00:00+00:00",
        )
        for identifier, encoded in (
            ("broken-edition", body),
            (valid["id"], contracts.canonical_json(valid)),
        ):
            journal.execute(
                "INSERT INTO editions VALUES(?,?,?,?,?,?)",
                (
                    identifier,
                    identifier,
                    "unused",
                    "ready",
                    encoded,
                    contracts.canonical_json([notion_content.packet()]),
                ),
            )
        before = journal.rows("SELECT * FROM editions ORDER BY id")
        assert intake.scan() == 2
        assert journal.rows("SELECT * FROM editions ORDER BY id") == before
        assert journal.entity("edition:" + valid["id"])["kind"] == "edition"
        errors = journal.rows(
            "SELECT * FROM notion_imports WHERE source_id='broken-edition'"
        )
        assert errors[0]["error"] == "notion_edition_import_failed"
        assert errors[0]["digest"] == "invalid"
        assert intake.scan() == 0
        assert "private marker" not in caplog.text
        assert "phase=notion_edition_import" in caplog.text
    finally:
        database.close()


@pytest.mark.parametrize(
    "failure", [asyncio.CancelledError, KeyboardInterrupt, SystemExit]
)
async def test_projection_termination_is_durable_and_propagates(
    tmp_path, failure
):
    class InterruptedNotion:
        calls = 0

        async def project(self, packet):
            self.calls += 1
            raise failure("private provider message")

    path = tmp_path / "newsletter.sqlite3"
    database = store.Store(path, "live")
    notion = InterruptedNotion()
    try:
        packet = notion_content.packet()
        database.db.execute(
            "INSERT INTO packets(id,principal,request_key,digest,body) "
            "VALUES(?,'test','test','test',?)",
            (packet["id"], contracts.canonical_json(packet)),
        )
        consumer = worker.Worker(
            database, editor.MockEditor(), notion, tmp_path / "jobs", 30
        )
        with pytest.raises(failure):
            await consumer.step()
        assert (
            database.db.execute("SELECT projection FROM packets").fetchone()[0]
            == "unknown"
        )
    finally:
        database.close()
    reopened = store.Store(path, "live")
    try:
        reopened.recover()
        consumer = worker.Worker(
            reopened, editor.MockEditor(), notion, tmp_path / "jobs", 30
        )
        assert not await consumer.step()
        assert notion.calls == 1
    finally:
        reopened.close()


def test_diagnostics_only_include_phase_type_and_hashed_reference(caplog):
    reference = "private record identifier\nInjected log entry"
    diagnostics.record_failure(
        logging.getLogger(__name__),
        phase="editor_validation",
        error=TypeError("private body /home/private token"),
        reference=reference,
    )
    assert "phase=editor_validation type=TypeError" in caplog.text
    assert hashlib.sha256(reference.encode()).hexdigest()[:12] in caplog.text
    assert "private" not in caplog.text
    assert "Traceback" not in caplog.text


@pytest.mark.parametrize("payload", [b'{"a":1,"a":2}', b'{"a":{"b":1,"b":2}}'])
def test_shared_json_decoder_rejects_duplicate_fields(payload):
    with pytest.raises(ValueError, match="Duplicate JSON key"):
        files.decode_json(payload)


def test_shared_atomic_write_keeps_previous_file_before_replace(
    tmp_path, monkeypatch
):
    destination = tmp_path / "bundle.json"
    destination.write_text('{"previous":true}')

    def fail_replace(source, target):
        raise OSError("synthetic write interruption")

    monkeypatch.setattr(files.os, "replace", fail_replace)
    with pytest.raises(OSError, match="synthetic write interruption"):
        files.atomic_write_text(destination, '{"new":true}')
    assert json.loads(destination.read_text()) == {"previous": True}
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize("encoded", ["null", "[]", "42", '"private marker"'])
def test_corrupt_frozen_inputs_never_select_packaged_template(
    tmp_path, encoded
):
    database = store.Store(tmp_path / "newsletter.sqlite3", "live")
    try:
        consumer = worker.Worker(
            database, editor.MockEditor(), object(), tmp_path / "jobs", 30
        )
        binding = {"run_id": "run-frozen"}
        assert consumer.frozen_template(binding) is None
        database.db.execute(
            "CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, inputs TEXT)"
        )
        assert consumer.frozen_template(binding) is None
        database.db.execute(
            "INSERT INTO workflow_runs VALUES(?,?)", ("run-frozen", encoded)
        )
        with pytest.raises((ValueError, RuntimeError)):
            consumer.frozen_template(binding)
    finally:
        database.close()


def test_material_aliases_and_notion_journal_methods(store):
    # 1. material_aliases edge cases
    landing = notion_content.candidate(
        url="https://example.org/news",
        doi="",
        event_key="thread-abcdef012345",
        published_at="2026-09-07",
    )
    aliases = notion_journal.material_aliases(landing)
    assert aliases == ["url:https://example.org/news#event:2026-09-07"]
    with pytest.raises(ValueError, match="notion_material_identity_missing"):
        notion_journal.material_aliases(
            {
                "title": "Valid long title without URL or event",
                "url": "",
                "doi": "",
                "event_key": "",
            }
        )

    # 2. NotionJournal lifecycle & methods
    dest = {"materials": "m-1", "editions": "e-1", "private": False}
    journal = notion_journal.NotionJournal(store, dest, clock=lambda: 123.5)
    with pytest.raises(ValueError, match="destination/privacy changed"):
        notion_journal.NotionJournal(store, {"materials": "m-2"})

    assert journal.exists("notion_entities") is True
    assert journal.exists("nonexistent_table") is False
    boot = journal.bootstrap_time()
    assert boot and journal.bootstrap_time() == boot
    assert journal.pending_candidates() == []
    assert journal.pending_research() == []
    assert journal.is_daily_run("r1", "2026-09-07") is True

    # Candidate & identity methods
    cand = notion_content.candidate()
    key, cand_aliases = journal.identity(cand)
    assert key.startswith("material:v1:")
    proj = notion_content.project_material(cand)
    proj = newsletter_notion_content.Projection(
        key, proj.properties, proj.blocks, proj.digest, proj.chart_png
    )
    journal.enqueue("material", proj, cand_aliases)
    assert journal.identity(cand)[0] == key

    # Conflict on different DOI for existing URL alias
    conflicting = notion_content.candidate(doi="10.9999/other")
    with pytest.raises(ValueError, match="notion_material_identity_conflict"):
        journal.identity(conflicting)

    # Conflict on kind mismatch
    with pytest.raises(ValueError, match="notion_entity_kind_conflict"):
        journal.enqueue("edition", proj)

    journal.remember_candidate("run-1", cand["id"], key, "{}", "2026-09-07")
    assert journal.candidate("run-1", cand["id"]) is not None
    assert len(journal.candidates("run-1")) == 1
    assert journal.first_seen(key, "2026-09-08") == "2026-09-07"
    assert journal.first_seen("unknown-key", "2026-09-08") == "2026-09-08"

    # Create / append / upload / conflict / retry / summary transitions
    assert len(journal.due_entities(200.0)) == 1
    journal.begin_create(key)
    assert journal.entity(key)["create_state"] == "creating"
    journal.fail_create(key, ambiguous=True)
    assert journal.entity(key)["create_state"] == "unknown"
    journal.fail_create(key, ambiguous=False)
    assert journal.entity(key)["create_state"] == "new"
    journal.quarantine(key)
    assert journal.entity(key)["create_state"] == "conflict"
    journal.resolve_conflict(key)
    assert journal.entity(key)["create_state"] == "ready"
    journal.confirm_page(key, "page-mat-1", "hash-1")
    assert journal.entity(key)["page_id"] == "page-mat-1"

    seq = journal.versions(key)[0]["seq"]
    journal.record_upload(seq, "upload-1", 100.0)
    journal.begin_append(seq, [{"type": "paragraph"}])
    journal.fail_append(seq, ambiguous=True)
    assert journal.versions(key)[0]["state"] == "unknown"
    journal.fail_append(seq, ambiguous=False)
    assert journal.versions(key)[0]["state"] == "pending"
    journal.acknowledge_append(seq, 1, complete=False)
    assert journal.versions(key)[0]["offset"] == 1
    journal.finish_version(seq)
    assert journal.versions(key)[0]["state"] == "done"
    journal.acknowledge_properties(key, "hash-2")
    assert journal.entity(key)["applied_hash"] == "hash-2"

    # Imports, links, desired, retry, clear_error, summary
    journal.mark_import("candidates", "src-1", "dig-1", "err-1")
    assert journal.imported("candidates", "src-1", "dig-1") is True
    journal.retry(key, "NOTION_TIMEOUT")
    assert journal.entity(key)["error"] == "NOTION_TIMEOUT"
    summary = journal.summary()
    assert summary["errors"] and summary["import_errors"]
    journal.clear_error(key)
    assert journal.entity(key)["error"] == ""
    assert journal.entity(key)["progress_at"] == 123.5

    ed_proj = newsletter_notion_content.edition_projection(
        notion_content.edition(), packets=[notion_content.packet()]
    )
    journal.enqueue("edition", ed_proj)
    journal.confirm_page(ed_proj.key, "page-ed-1")
    journal.link(ed_proj.key, key)
    desired_mat = journal.desired(journal.entity(key))
    assert desired_mat["edition_ids"] == {"relation": [{"id": "page-ed-1"}]}
    assert desired_mat["progress"] == {"select": {"name": "已刊出"}}
    desired_ed = journal.desired(journal.entity(ed_proj.key))
    assert desired_ed["material_ids"] == {"relation": [{"id": "page-mat-1"}]}
    assert journal.editions_for_links() == []
    assert journal.pending_editions() == []
    assert journal.is_verification("edition-fixture") is False
