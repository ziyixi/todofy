from __future__ import annotations

import copy
import decimal

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.contracts as contracts


@pytest.fixture
def packet_body():
    return {
        "title": "Research packet",
        "body": "The source describes the measurement and its limitations.",
        "sources": [
            {
                "id": "official",
                "title": "Original release",
                "url": "https://example.org/research",
                "excerpt": "Measured value: 12.5.",
                "access_scope": "full_text",
                "published_at": "2026-09-05",
            }
        ],
        "tags": ["science"],
    }


@pytest.fixture
def packets(packet_body):
    return [{"id": "packet-1", "content": packet_body}]


@pytest.fixture
def draft():
    return {
        "subject": "每日简报",
        "title": "今天值得理解的事",
        "introduction": "概览。",
        "sections": [
            {
                "kind": "feature",
                "heading": "测量与解释",
                "paragraphs": [
                    {
                        "text": "原始材料说明了测量方法。",
                        "citations": ["packet-1/official"],
                    }
                ],
                "limitations": "不能从这次测量推断因果。",
            }
        ],
        "chart": {
            "kind": "bar",
            "question": "两组测量相差多少？",
            "metric": "测量值",
            "unit": "units",
            "period": "2026-09",
            "caption": "来源所报告的值。",
            "alt_text": "A 为 12.5，B 数据缺失。",
            "limitations": "B 没有报告。",
            "points": [
                {
                    "label": "A",
                    "decimal_value": "12.5",
                    "citations": ["packet-1/official"],
                },
                {
                    "label": "B",
                    "missing_reason": "Not reported",
                    "citations": [],
                },
            ],
        },
        "recommended_reading": {
            "citation": "packet-1/official",
            "reason": "阅读原始方法。",
        },
        "limitations": "结构检查不证明研究结论正确。",
    }


def test_service_descriptor_exposes_trigger_and_editor_methods():
    assert list(editorial_pb2.DESCRIPTOR.services_by_name) == [
        "NewsletterService"
    ]
    service = editorial_pb2.DESCRIPTOR.services_by_name["NewsletterService"]
    assert [method.name for method in service.methods] == [
        "StartRun",
        "GetRun",
        "GetEdition",
        "SendEdition",
    ]
    assert editorial_pb2.DESCRIPTOR.package == "newsletter.v1"


def test_reading_has_one_primary_link_and_validated_supporting_citations(
    draft, packets
):
    packets[0]["content"]["sources"].append(
        {**packets[0]["content"]["sources"][0], "id": "journal"}
    )
    draft["recommended_reading"]["supporting_citations"] = ["packet-1/journal"]
    contracts.validate_draft(draft, packets)
    normalized = contracts.to_dict(
        contracts.parse_message(draft, editorial_pb2.Draft)
    )
    assert normalized["recommended_reading"]["citation"] == "packet-1/official"
    assert normalized["recommended_reading"]["supporting_citations"] == [
        "packet-1/journal"
    ]


@pytest.mark.parametrize(
    "citations",
    [
        ["packet-1/missing"],
        ["packet-1/official"],
        ["packet-1/journal", "packet-1/journal"],
        ["packet-1/journal"] * 33,
    ],
)
def test_reading_rejects_unknown_duplicate_or_unbounded_support(
    draft, packets, citations
):
    packets[0]["content"]["sources"].append(
        {**packets[0]["content"]["sources"][0], "id": "journal"}
    )
    draft["recommended_reading"]["supporting_citations"] = citations
    with pytest.raises(contracts.ContractError):
        contracts.validate_draft(draft, packets)


def test_snake_case_round_trip_and_default_values(packet_body):
    request = contracts.parse_message(
        {"request_key": "k", "workflow_id": "research", "content": packet_body},
        editorial_pb2.PutPacketRequest,
    )
    contracts.validate_request(request)
    value = contracts.to_dict(request)
    assert value["request_key"] == "k"
    assert "requestKey" not in value
    assert (
        contracts.parse_message(value, editorial_pb2.PutPacketRequest)
        == request
    )
    assert contracts.to_dict(editorial_pb2.ReadInboxRequest()) == {
        "limit": 0,
        "cursor": "",
    }


@pytest.mark.parametrize(
    "data",
    [
        {"requestKey": "k"},
        {"request_key": "k", "unknown": True},
        {"content": {"title": "x", "instruction": "execute"}},
        '{"request_key":"one","request_key":"two"}',
        '{"content":{"title":"one","title":"two"}}',
        '{"request_key":NaN}',
        "[]",
        b"\xff",
    ],
)
def test_strict_parser_rejects_unknown_aliases_duplicates_and_bad_json(data):
    with pytest.raises(contracts.ContractError):
        contracts.parse_message(data, editorial_pb2.PutPacketRequest)


def test_oneof_preserves_missing_not_zero(draft):
    parsed = contracts.parse_message(draft, editorial_pb2.Draft)
    missing = parsed.chart.points[1]
    assert missing.WhichOneof("observation") == "missing_reason"
    dumped = contracts.to_dict(parsed)
    assert "decimal_value" not in dumped["chart"]["points"][1]
    both = {"label": "bad", "decimal_value": "0", "missing_reason": "unknown"}
    with pytest.raises(contracts.ContractError):
        contracts.parse_message(both, editorial_pb2.ChartPoint)


def test_proto_bytes_round_trip():
    rendered = editorial_pb2.RenderedEdition(
        html="<p>中文</p>",
        text="中文",
        chart_png=b"\x89PNG",
        render_hash="a" * 64,
    )
    assert contracts.to_dict(rendered)["chart_png"] == "iVBORw=="
    assert (
        contracts.parse_message(
            contracts.to_dict(rendered), editorial_pb2.RenderedEdition
        )
        == rendered
    )


def test_canonical_hash_is_key_order_independent_and_preserves_unicode():
    assert (
        contracts.canonical_json({"z": "中文", "a": 1}) == '{"a":1,"z":"中文"}'
    )
    assert contracts.content_hash(
        {"a": 1, "z": "中文"}
    ) == contracts.content_hash({"z": "中文", "a": 1})
    assert contracts.content_hash({"a": 1}) != contracts.content_hash(
        {"a": "1"}
    )
    with pytest.raises(contracts.ContractError):
        contracts.canonical_json({"bad": float("inf")})


@pytest.mark.parametrize(
    "url",
    [
        "https://example.org/research",
        "http://example.com/report?q=a%20b",
        "https://8.8.8.8/data",
        "https://[2606:4700:4700::1111]/data",
    ],
)
def test_public_urls_allowed_without_network(url):
    contracts.validate_public_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.org/a",
        "https://localhost/a",
        "http://localhost./",
        "http://worker.internal/a",
        "http://server/a",
        "http://127.0.0.1/",
        "http://127.1/",
        "http://2130706433/",
        "http://0x7f.0.0.1/",
        "http://0x7f.1/",
        "http://0177.0.0.1/",
        "http://10.0.0.1/",
        "http://169.254.169.254/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://192.0.2.1/",
        "https://user:password@example.org/",
        "https://user@example.org/",
        "https://example.org:8080/",
        "https://example.org/%0aHeader:value",
        "https://example.org/\r\n",
        "https://example.org\\@127.0.0.1/",
        "https://exa_mple.org/",
        "https://%31%32%37.0.0.1/",
    ],
)
def test_unsafe_urls_rejected(url):
    with pytest.raises(contracts.ContractError) as error:
        contracts.validate_public_url(url)
    assert error.value.code == "INVALID_URL"


def test_packet_validation_accepts_dict_and_proto(packet_body):
    contracts.validate_packet_body(packet_body)
    contracts.validate_packet_body(
        contracts.parse_message(packet_body, editorial_pb2.PacketBody)
    )


@pytest.mark.parametrize(
    "mutation", ["duplicate", "slash", "scope", "large", "no_sources"]
)
def test_packet_limits_and_source_identity(packet_body, mutation):
    bad = copy.deepcopy(packet_body)
    if mutation == "duplicate":
        bad["sources"].append(copy.deepcopy(bad["sources"][0]))
    elif mutation == "slash":
        bad["sources"][0]["id"] = "other/source"
    elif mutation == "scope":
        bad["sources"][0]["access_scope"] = "verified"
    elif mutation == "large":
        bad["body"] = "x" * 65537
    else:
        bad["sources"] = []
    with pytest.raises(contracts.ContractError):
        contracts.validate_packet_body(bad)


def test_draft_and_render_validate_with_real_reference_mapping(draft, packets):
    contracts.validate_draft(draft, packets)
    contracts.validate_draft(
        contracts.parse_message(draft, editorial_pb2.Draft),
        [contracts.parse_message(p, editorial_pb2.Packet) for p in packets],
    )
    contracts.validate_render_request(
        {
            "draft": draft,
            "packets": packets,
            "issue_date": "2026-09-05",
            "is_fixture": True,
        }
    )


@pytest.mark.parametrize("location", ["paragraph", "chart", "reading"])
def test_all_citation_positions_validate_packet_and_source(
    draft, packets, location
):
    bad = copy.deepcopy(draft)
    if location == "paragraph":
        bad["sections"][0]["paragraphs"][0]["citations"] = ["missing/official"]
    elif location == "chart":
        bad["chart"]["points"][0]["citations"] = ["packet-1/missing"]
    else:
        bad["recommended_reading"]["citation"] = "https://example.org/fake"
    with pytest.raises(contracts.ContractError) as error:
        contracts.validate_draft(bad, packets)
    assert error.value.code == "INVALID_CITATION"


@pytest.mark.parametrize(
    "value", ["NaN", "Infinity", "-Infinity", "1e101", "1e-101", "", "1/2"]
)
def test_chart_numbers_are_finite_and_bounded(value):
    with pytest.raises(contracts.ContractError):
        contracts.validate_decimal(value)


def test_valid_decimal_precision_is_not_rounded():
    assert contracts.validate_decimal(
        "0.10000000000000000001"
    ) == decimal.Decimal("0.10000000000000000001")
    assert contracts.validate_decimal("1.2e6") == decimal.Decimal("1200000")


def test_missing_point_needs_reason_and_numeric_point_needs_source(
    draft, packets
):
    draft["chart"]["points"][1]["missing_reason"] = ""
    with pytest.raises(contracts.ContractError):
        contracts.validate_draft(draft, packets)
    draft["chart"]["points"][1]["missing_reason"] = "not measured"
    draft["chart"]["points"][0]["citations"] = []
    with pytest.raises(contracts.ContractError):
        contracts.validate_draft(draft, packets)


def test_limits_and_header_injection(draft, packets):
    draft["subject"] = "Daily\r\nBcc: unwanted@example.org"
    with pytest.raises(contracts.ContractError):
        contracts.validate_draft(draft, packets)
    draft["subject"] = "Daily"
    draft["sections"] *= contracts.MAX_SECTIONS + 1
    with pytest.raises(contracts.ContractError):
        contracts.validate_draft(draft, packets)


def test_one_section_per_topic_fits_the_operator_topic_ceiling(draft, packets):
    draft["sections"] *= contracts.MAX_SECTIONS
    contracts.validate_draft(draft, packets)
    assert contracts.MAX_SECTIONS == 12


@pytest.mark.parametrize(
    "message",
    [
        editorial_pb2.ReadInboxRequest(limit=101),
        editorial_pb2.PrepareEditionRequest(
            request_key="k", issue_date="2026-02-30", packet_ids=["p"]
        ),
        editorial_pb2.PrepareEditionRequest(
            request_key="k", issue_date="2026-09-05", packet_ids=["p", "p"]
        ),
        editorial_pb2.GetEditionRequest(id="../../etc"),
        editorial_pb2.SendEditionRequest(
            id="edition-1", request_key="k", expected_render_hash="not-a-hash"
        ),
    ],
)
def test_request_semantic_failures(message):
    with pytest.raises(contracts.ContractError):
        contracts.validate_request(message)


def test_valid_request_shapes():
    for request in [
        editorial_pb2.ReadInboxRequest(limit=0),
        editorial_pb2.PrepareEditionRequest(
            request_key="prepare/one", issue_date="2026-09-05", packet_ids=["p"]
        ),
        editorial_pb2.GetEditionRequest(id="edition-1"),
        editorial_pb2.SendEditionRequest(
            id="edition-1",
            request_key="send/one",
            expected_render_hash="a" * 64,
        ),
    ]:
        contracts.validate_request(request)
