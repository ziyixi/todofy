"""Strict model output shapes from the public protobuf contract."""

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
