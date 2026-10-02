"""Strict model output shapes from the public protobuf contract."""

from collections.abc import Sequence
import re
from typing import cast

import google.protobuf.descriptor as google_protobuf_descriptor
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.contracts as contracts
import newsletter.types as types

_FIELD_ENUMS = {
    ("Source", "access_scope"): contracts.SOURCE_ACCESS_SCOPES,
    ("Section", "kind"): contracts.SECTION_KINDS,
    ("Chart", "kind"): contracts.CHART_KINDS,
}
_SUPPLEMENT_IDS = tuple(f"supplement-{number}" for number in range(1, 7))


def _identifier_schema() -> types.Payload:
    # JSON Schema uses portable anchors; the application validator retains its
    # strict full-string check (including rejection of trailing line endings).
    return {
        "type": "string",
        "pattern": f"^{contracts.IDENTIFIER_PATTERN}$",
        "description": (
            "Local citation identifier, 1-128 ASCII characters: start with "
            "a letter or "
            "digit, then only letters, digits, underscore, dot, colon or "
            "hyphen. "
            "No slash, whitespace, URL or DOI; use a short label such as "
            "source-1. "
            "Put the actual source URL in source.url, never in this identifier."
        ),
    }


def message_schema(
    descriptor: google_protobuf_descriptor.Descriptor,
) -> types.Payload:
    """Translate public proto fields; each call owns its mutable schema tree."""
    props: types.Payload = {}
    for proto_field in descriptor.fields:
        item: types.Payload
        if proto_field.message_type:
            item = message_schema(proto_field.message_type)
        elif (
            proto_field.type
            == google_protobuf_descriptor.FieldDescriptor.TYPE_BOOL
        ):
            item = {"type": "boolean"}
        else:
            item = {"type": "string"}
        if values := _FIELD_ENUMS.get((descriptor.name, proto_field.name)):
            item["enum"] = list(values)
        if (descriptor.name, proto_field.name) == ("Source", "id"):
            item = _identifier_schema()
        props[proto_field.name] = (
            {"type": "array", "items": item}
            if proto_field.is_repeated
            else item
        )
    if descriptor.name == "Draft":
        # Structured-output strict mode represents omitted message fields as
        # null. The adapter removes those nulls before ProtoJSON validation.
        for name in ("chart", "recommended_reading"):
            props[name] = {"anyOf": [props[name], {"type": "null"}]}
    if descriptor.oneofs:
        # ChartPoint's observation must be a number OR a missing reason,
        # never both. Derive alternatives from the actual protobuf oneof.
        group = descriptor.oneofs[0]
        alternatives = []
        for selected in group.fields:
            variant = {
                k: v
                for k, v in props.items()
                if k == selected.name or k not in {f.name for f in group.fields}
            }
            alternatives.append(
                {
                    "type": "object",
                    "properties": variant,
                    "required": list(variant),
                    "additionalProperties": False,
                }
            )
        return {"anyOf": alternatives}
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
    }


def packet_body_schema() -> types.Payload:
    """Shared material contract, independent of editor or research envelopes."""
    return message_schema(
        cast(
            google_protobuf_descriptor.Descriptor,
            editorial_pb2.PacketBody.DESCRIPTOR,
        )
    )


def _draft_schema(packets: Sequence[types.Payload]) -> types.Payload:
    draft = message_schema(
        cast(
            google_protobuf_descriptor.Descriptor,
            editorial_pb2.Draft.DESCRIPTOR,
        )
    )
    # Existing references are data, not a grammar the model should reconstruct.
    # Group source alternatives per packet instead of repeating long packet IDs.
    alternatives = [
        re.escape(packet["id"])
        + "/(?:"
        + "|".join(
            re.escape(source["id"]) for source in packet["content"]["sources"]
        )
        + ")"
        for packet in packets
    ]
    alternatives.append(f"supplement-[1-6]/{contracts.IDENTIFIER_PATTERN}")
    citation = {
        "pattern": "^(?:" + "|".join(alternatives) + ")$",
        "description": (
            "Copy an exact reference from available_citations, or "
            "reference a source "
            "in your own supplement-1 through supplement-6 packet. Never "
            "invent or "
            "abbreviate existing packet/source IDs. The server does not "
            "repair citations."
        ),
    }
    props = draft["properties"]
    props["sections"]["items"]["properties"]["paragraphs"]["items"][
        "properties"
    ]["citations"]["items"].update(citation)
    for point in props["chart"]["anyOf"][0]["properties"]["points"]["items"][
        "anyOf"
    ]:
        point["properties"]["citations"]["items"].update(citation)
    props["recommended_reading"]["anyOf"][0]["properties"]["citation"].update(
        citation
    )
    props["recommended_reading"]["anyOf"][0]["properties"][
        "supporting_citations"
    ]["items"].update(citation)
    props["recommended_reading"]["anyOf"][0]["properties"][
        "supporting_citations"
    ].update(maxItems=31)
    return draft


def editor_schema(packets: Sequence[types.Payload] = ()) -> types.Payload:
    """Bind the legacy editor envelope to the available packet citations."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["draft", "review", "supplemental_packets"],
        "properties": {
            "draft": _draft_schema(packets),
            "review": {
                "type": "object",
                "additionalProperties": False,
                "required": ["passed", "findings"],
                "properties": {
                    "passed": {"type": "boolean"},
                    "findings": {"type": "array", "items": {"type": "string"}},
                },
            },
            "supplemental_packets": {
                "type": "array",
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "content"],
                    "properties": {
                        "id": {
                            **_identifier_schema(),
                            "enum": list(_SUPPLEMENT_IDS),
                        },
                        "content": packet_body_schema(),
                    },
                },
            },
        },
    }


def research_schema() -> types.Payload:
    """Describe a collector result with explicit findings or an empty search."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["state", "note", "packets"],
        "properties": {
            "state": {"type": "string", "enum": ["collected", "no_findings"]},
            "note": {"type": "string"},
            "packets": {
                "type": "array",
                "maxItems": 2,
                "items": packet_body_schema(),
            },
        },
    }


def legacy_review_schema() -> types.Payload:
    """Return the final-review envelope for immutable legacy graphs."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["passed", "findings"],
        "properties": {
            "passed": {"type": "boolean"},
            "findings": {
                "type": "array",
                "maxItems": 24,
                "items": {"type": "string", "maxLength": 2000},
            },
        },
    }
