"""Offline regression coverage for schema/validator semantic enum agreement."""

import re

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.collector as collector
import newsletter.contracts as contracts
import newsletter.model_schema as model_schema


@pytest.fixture
def enum_fields():
    schema = model_schema.editor_schema()
    draft = schema["properties"]["draft"]["properties"]
    supplement = schema["properties"]["supplemental_packets"]["items"][
        "properties"
    ]
    source = supplement["content"]["properties"]["sources"]["items"][
        "properties"
    ]
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
    fresh = model_schema.editor_schema()["properties"]["draft"]["properties"][
        "sections"
    ]["items"]["properties"]
    assert fresh["kind"]["enum"] == list(contracts.SECTION_KINDS)
    assert "world_brief" not in contracts.SECTION_KINDS


def test_material_schema_is_shared_without_depending_on_editor_envelope(
    monkeypatch,
):
    material = model_schema.packet_body_schema()
    editorial = model_schema.editor_schema()["properties"][
        "supplemental_packets"
    ]["items"]["properties"]["content"]
    research = model_schema.research_schema()["properties"]["packets"]["items"]
    assert material == editorial == research
    assert collector.model_schema is model_schema

    def unrelated_editor_schema():
        pytest.fail(
            "Research must not construct or inspect the editor envelope"
        )

    monkeypatch.setattr(model_schema, "editor_schema", unrelated_editor_schema)
    assert (
        model_schema.research_schema()["properties"]["packets"]["items"]
        == material
    )


@pytest.mark.parametrize("changed_index", range(3))
def test_material_schema_consumers_own_independent_mutable_trees(changed_index):
    expected = model_schema.packet_body_schema()
    materials = [
        model_schema.packet_body_schema(),
        model_schema.editor_schema()["properties"]["supplemental_packets"][
            "items"
        ]["properties"]["content"],
        model_schema.research_schema()["properties"]["packets"]["items"],
    ]
    changed = materials[changed_index]
    changed["required"].append("fixture-only")
    changed["properties"]["sources"]["items"]["properties"]["access_scope"][
        "enum"
    ].clear()
    assert all(
        value == expected
        for index, value in enumerate(materials)
        if index != changed_index
    )
    assert model_schema.packet_body_schema() == expected
    assert (
        model_schema.editor_schema()["properties"]["supplemental_packets"][
            "items"
        ]["properties"]["content"]
        == expected
    )
    assert (
        model_schema.research_schema()["properties"]["packets"]["items"]
        == expected
    )


@pytest.fixture
def identifier_fields():
    supplement = model_schema.editor_schema()["properties"][
        "supplemental_packets"
    ]["items"]["properties"]
    return [
        supplement["content"]["properties"]["sources"]["items"]["properties"][
            "id"
        ],
        model_schema.research_schema()["properties"]["packets"]["items"][
            "properties"
        ]["sources"]["items"]["properties"]["id"],
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


def citation_fields(schema):
    draft = schema["properties"]["draft"]["properties"]
    points = draft["chart"]["anyOf"][0]["properties"]["points"]["items"][
        "anyOf"
    ]
    return [
        draft["sections"]["items"]["properties"]["paragraphs"]["items"][
            "properties"
        ]["citations"]["items"],
        *(point["properties"]["citations"]["items"] for point in points),
        draft["recommended_reading"]["anyOf"][0]["properties"]["citation"],
    ]


@pytest.fixture
def citation_schema():
    # Only local synthetic identifiers: neither real packets nor live UUIDs.
    return model_schema.editor_schema(
        [
            {
                "id": "fixture.packet-1",
                "content": {
                    "sources": [{"id": "source.1"}, {"id": "source:2"}]
                },
            },
            {
                "id": "fixture-packet:2",
                "content": {"sources": [{"id": "source_3"}]},
            },
        ]
    )


def test_all_citation_locations_share_one_bounded_dynamic_pattern(
    citation_schema,
):
    fields = citation_fields(citation_schema)
    assert (
        len(fields) == 4
    )  # Paragraph, both chart oneofs, recommended reading.
    assert all(field["type"] == "string" for field in fields)
    assert len({field["pattern"] for field in fields}) == 1


@pytest.mark.parametrize(
    "citation",
    [
        "fixture.packet-1/source.1",
        "fixture.packet-1/source:2",
        "fixture-packet:2/source_3",
        "supplement-1/source-1",
        "supplement-6/A.b_c:2026",
        "supplement-2/" + "A" * 128,
    ],
)
def test_citation_schema_accepts_exact_inputs_and_bounded_new_supplements(
    citation_schema, citation
):
    assert all(
        re.search(field["pattern"], citation)
        for field in citation_fields(citation_schema)
    )


@pytest.mark.parametrize(
    "citation",
    [
        "wrong-packet/source.1",
        "fixtureXpacket-1/source.1",
        "fixture.packet-1/sourceX1",
        "fixture.packet-1/source_3",
        "fixture-packet:2/source.1",
        "fixture.packet-1/invented-source",
        "supplement-0/source-1",
        "supplement-7/source-1",
        "supplement-01/source-1",
        "supplement-1/source/extra",
        "supplement-1/来源",
        "supplement-1/" + "A" * 129,
        "supplement-1/_invalid-start",
    ],
)
def test_citation_schema_rejects_unknown_pairs_and_regex_near_matches(
    citation_schema, citation
):
    assert all(
        re.search(field["pattern"], citation) is None
        for field in citation_fields(citation_schema)
    )


def test_empty_input_citation_schema_does_not_allow_arbitrary_packet_ids():
    for field in citation_fields(model_schema.editor_schema()):
        assert re.search(field["pattern"], "supplement-1/source-1")
        assert (
            re.search(field["pattern"], "unavailable-packet/source-1") is None
        )


def test_request_specific_citation_schema_does_not_leak_into_other_requests(
    citation_schema,
):
    field = citation_fields(citation_schema)[0]
    field["pattern"] = ".*"
    fresh = model_schema.editor_schema(
        [{"id": "another-packet", "content": {"sources": [{"id": "s1"}]}}]
    )
    for fresh_field in citation_fields(fresh):
        assert re.search(fresh_field["pattern"], "another-packet/s1")
        assert (
            re.search(fresh_field["pattern"], "fixture.packet-1/source.1")
            is None
        )


def test_supplement_ids_six_explicit_local_labels_have_independent_enums():
    field = model_schema.editor_schema()["properties"]["supplemental_packets"][
        "items"
    ]["properties"]["id"]
    expected = [f"supplement-{index}" for index in range(1, 7)]
    assert field["enum"] == expected
    assert field["pattern"] == "^" + contracts.IDENTIFIER_PATTERN + "$"
    assert all(
        re.search(field["pattern"], identifier) for identifier in expected
    )
    field["enum"].append("supplement-7")
    fresh = model_schema.editor_schema()["properties"]["supplemental_packets"][
        "items"
    ]["properties"]["id"]
    assert fresh["enum"] == expected


@pytest.mark.parametrize("location", ["paragraph", "chart", "reading"])
@pytest.mark.parametrize(
    "citation", ["supplement-1/missing-source", "supplement-2/fixture-source"]
)
def test_supplement_citations_require_real_packet_sources(
    packet, draft, location, citation
):
    assert all(
        re.search(field["pattern"], citation)
        for field in citation_fields(model_schema.editor_schema())
    )
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
