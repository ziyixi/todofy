"""Offline regression coverage for schema/validator semantic enum agreement."""

import re

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.contracts as contracts
import newsletter.model_schema as model_schema


def draft_schema():
    return model_schema.message_schema(editorial_pb2.Draft.DESCRIPTOR)


@pytest.fixture
def enum_fields():
    draft = draft_schema()["properties"]
    source = model_schema.packet_body_schema()["properties"]["sources"][
        "items"
    ]["properties"]
    return {
        "section_kind": draft["sections"]["items"]["properties"]["kind"],
        "chart_kind": draft["chart"]["anyOf"][0]["properties"]["kind"],
        "source_access_scope": source["access_scope"],
    }


@pytest.fixture
def packet():
    return editorial_pb2.Packet(
        id="fixture-packet",
        content=editorial_pb2.PacketBody(
            title="Synthetic research fixture",
            body="A synthetic value used only for offline validation.",
            sources=[
                editorial_pb2.Source(
                    id="fixture-source",
                    title="Synthetic source",
                    url="https://example.org/fixture",
                    excerpt="Synthetic value: 12.",
                    access_scope="full_text",
                )
            ],
        ),
    )


@pytest.fixture
def draft():
    return editorial_pb2.Draft(
        subject="Synthetic subject",
        title="Synthetic title",
        sections=[
            editorial_pb2.Section(
                kind="feature",
                heading="Synthetic heading",
                paragraphs=[
                    editorial_pb2.Paragraph(
                        text="Synthetic statement.",
                        citations=["fixture-packet/fixture-source"],
                    )
                ],
            )
        ],
        chart=editorial_pb2.Chart(
            kind="bar",
            question="What is the synthetic value?",
            metric="Synthetic measurement",
            unit="fixture units",
            period="Synthetic period",
            caption="Synthetic data only.",
            alt_text="Synthetic value is 12.",
            points=[
                editorial_pb2.ChartPoint(
                    label="A",
                    decimal_value="12",
                    citations=["fixture-packet/fixture-source"],
                )
            ],
        ),
    )


def test_schema_enums_exactly_match_shared_contract_values(enum_fields):
    assert contracts.SECTION_KINDS == (
        "world",
        "feature",
        "context",
        "ai_ml",
        "science",
        "economy",
        "technology",
        "health",
    )
    assert contracts.CHART_KINDS == ("bar", "line")
    assert contracts.SOURCE_ACCESS_SCOPES == (
        "metadata",
        "abstract",
        "full_text",
        "dataset",
    )
    for field, values in (
        ("section_kind", contracts.SECTION_KINDS),
        ("chart_kind", contracts.CHART_KINDS),
        ("source_access_scope", contracts.SOURCE_ACCESS_SCOPES),
    ):
        assert enum_fields[field] == {"type": "string", "enum": list(values)}


@pytest.mark.parametrize("section_kind", contracts.SECTION_KINDS)
@pytest.mark.parametrize("chart_kind", contracts.CHART_KINDS)
@pytest.mark.parametrize("access_scope", contracts.SOURCE_ACCESS_SCOPES)
def test_every_schema_enum_combination_is_accepted_by_contracts(
    enum_fields, packet, draft, section_kind, chart_kind, access_scope
):
    draft.sections[0].kind = section_kind
    draft.chart.kind = chart_kind
    packet.content.sources[0].access_scope = access_scope
    assert section_kind in enum_fields["section_kind"]["enum"]
    assert chart_kind in enum_fields["chart_kind"]["enum"]
    assert access_scope in enum_fields["source_access_scope"]["enum"]
    contracts.validate_packet_body(packet.content)
    contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize(
    "kind", ["world_brief", "main_read", "innovation_radar"]
)
def test_real_run_section_aliases_are_rejected_by_schema_and_contracts(
    enum_fields, packet, draft, kind
):
    # Literal values observed in the failed live run, not an imported live
    # artifact.
    assert kind not in enum_fields["section_kind"]["enum"]
    draft.sections[0].kind = kind
    with pytest.raises(
        contracts.ContractError, match="Unsupported section kind"
    ):
        contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize("kind", ["pie", "BAR", ""])
def test_invalid_chart_kinds_are_rejected_by_schema_and_contracts(
    enum_fields, packet, draft, kind
):
    assert kind not in enum_fields["chart_kind"]["enum"]
    draft.chart.kind = kind
    with pytest.raises(contracts.ContractError, match="Unsupported chart kind"):
        contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize("scope", ["fulltext", "FULL_TEXT", ""])
def test_invalid_source_scopes_are_rejected_by_schema_and_contracts(
    enum_fields, packet, scope
):
    assert scope not in enum_fields["source_access_scope"]["enum"]
    packet.content.sources[0].access_scope = scope
    with pytest.raises(
        contracts.ContractError, match="Unsupported source access_scope"
    ):
        contracts.validate_packet_body(packet.content)


def test_schema_enum_arrays_are_fresh_and_do_not_mutate_contract_constants(
    enum_fields,
):
    enum_fields["section_kind"]["enum"].append("world_brief")
    fresh = draft_schema()["properties"]["sections"]["items"]["properties"]
    assert fresh["kind"]["enum"] == list(contracts.SECTION_KINDS)
    assert "world_brief" not in contracts.SECTION_KINDS


@pytest.mark.parametrize("changed_index", range(2))
def test_material_schema_consumers_own_independent_mutable_trees(changed_index):
    expected = model_schema.packet_body_schema()
    materials = [
        model_schema.packet_body_schema(),
        model_schema.packet_body_schema(),
    ]
    changed = materials[changed_index]
    changed["required"].append("fixture-only")
    changed["properties"]["sources"]["items"]["properties"]["access_scope"][
        "enum"
    ].clear()
    assert materials[1 - changed_index] == expected
    assert model_schema.packet_body_schema() == expected


@pytest.fixture
def identifier_fields():
    return [
        model_schema.packet_body_schema()["properties"]["sources"]["items"][
            "properties"
        ]["id"]
    ]


def test_source_schema_explains_the_shared_local_id_grammar(identifier_fields):
    assert contracts.IDENTIFIER_PATTERN == r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}"
    for field in identifier_fields:
        assert field["type"] == "string"
        assert field["pattern"] == "^" + contracts.IDENTIFIER_PATTERN + "$"
        assert (
            isinstance(field["description"], str)
            and field["description"].strip()
        )


@pytest.mark.parametrize(
    "identifier", ["s1", "paper-1", "A.b_c:2026", "0", "A" * 128]
)
def test_safe_ids_match_schema_and_are_accepted_by_strict_contracts(
    identifier_fields, packet, draft, identifier
):
    assert all(
        re.search(field["pattern"], identifier) is not None
        for field in identifier_fields
    )
    packet.id = identifier
    packet.content.sources[0].id = identifier
    citation = identifier + "/" + identifier
    draft.sections[0].paragraphs[0].citations[:] = [citation]
    draft.chart.points[0].citations[:] = [citation]
    contracts.validate_packet_body(packet.content)
    contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize(
    "identifier",
    [
        "",
        "fixture/source",
        "10.0000/synthetic-doi",
        "https://example.org/synthetic",
        "A" * 129,
        "来源一",
        "évidence",
        "_source",
        "source label",
    ],
)
def test_invalid_ids_do_not_satisfy_schema_or_backend(
    identifier_fields, packet, draft, identifier
):
    assert all(
        re.search(field["pattern"], identifier) is None
        for field in identifier_fields
    )
    packet.content.sources[0].id = identifier
    with pytest.raises(
        contracts.ContractError, match=r"source\.id is not a valid identifier"
    ):
        contracts.validate_packet_body(packet.content)
    packet.content.sources[0].id = "fixture-source"
    packet.id = identifier
    with pytest.raises(
        contracts.ContractError, match=r"packet\.id is not a valid identifier"
    ):
        contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_backend_identifier_validation_still_rejects_trailing_newlines(
    packet, draft, ending
):
    # JSON Schema's ^/$ anchors may accept a final newline in some regex
    # engines.
    # They guide model output; backend fullmatch remains the strict authority.
    packet.content.sources[0].id = "fixture-source" + ending
    with pytest.raises(
        contracts.ContractError, match=r"source\.id is not a valid identifier"
    ):
        contracts.validate_packet_body(packet.content)
    packet.content.sources[0].id = "fixture-source"
    packet.id += ending
    with pytest.raises(
        contracts.ContractError, match=r"packet\.id is not a valid identifier"
    ):
        contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize("location", ["paragraph", "chart", "reading"])
@pytest.mark.parametrize(
    "citation", ["supplement-1/missing-source", "supplement-2/fixture-source"]
)
def test_supplement_citations_require_real_packet_sources(
    packet, draft, location, citation
):
    packet.id = "supplement-1"
    existing = "supplement-1/fixture-source"
    draft.sections[0].paragraphs[0].citations[:] = [existing]
    draft.chart.points[0].citations[:] = [existing]
    if location == "paragraph":
        draft.sections[0].paragraphs[0].citations[:] = [citation]
    elif location == "chart":
        draft.chart.points[0].citations[:] = [citation]
    else:
        draft.recommended_reading.CopyFrom(
            editorial_pb2.RecommendedReading(
                citation=citation, reason="Fixture"
            )
        )
    with pytest.raises(
        contracts.ContractError,
        match="Citation does not identify an available packet/source",
    ):
        contracts.validate_draft(draft, [packet])


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_backend_citation_existence_remains_strict_about_trailing_newlines(
    packet, draft, ending
):
    draft.sections[0].paragraphs[0].citations[:] = [
        "fixture-packet/fixture-source" + ending
    ]
    with pytest.raises(
        contracts.ContractError,
        match="Citation does not identify an available packet/source",
    ):
        contracts.validate_draft(draft, [packet])
