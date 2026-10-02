"""Fail closed on untested Structured Outputs vocabulary, without model calls.

This is a transport compatibility gate, not an application content validator or
a complete JSON Schema implementation. Constraints supported by JSON Schema in
general (notably uniqueItems) need not be supported by the model endpoint. Keep
semantic validation in the parsers. Updating this allowlist requires an opt-in
live acceptance probe; never silently strip unfamiliar schema constraints.

Reference: https://developers.openai.com/api/docs/guides/structured-outputs
The deployed ChatGPT-auth endpoint also accepts minLength and maxLength.
This was verified with the exact production writer schema on 2026-09-06.
"""

from typing import Literal

import newsletter.errors as errors
import newsletter.types as types

_KEYWORDS = frozenset(
    {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "anyOf",
        "enum",
        "description",
        "title",
        "$ref",
        "$defs",
        "pattern",
        "format",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minItems",
        "maxItems",
    }
)
_TYPES = frozenset(
    {"object", "array", "string", "number", "integer", "boolean", "null"}
)


def validate_output_schema(schema: types.Payload) -> None:
    """Reject unsupported vocabulary before auth, SDK startup or token usage.

    Walk schema positions only: a property *named* uniqueItems is ordinary data,
    not the unsupported constraint. An empty schema has no vocabulary to reject;
    the production catalog separately requires object roots.
    """

    def visit(node: object, depth: int = 0) -> None:
        if not isinstance(node, dict) or depth > 100 or set(node) - _KEYWORDS:
            raise errors.EditorError("configuration")
        kind = node.get("type")
        if kind is not None and (
            not isinstance(kind, str) or kind not in _TYPES
        ):
            raise errors.EditorError("configuration")
        if kind == "object":
            props = node.get("properties")
            required = node.get("required")
            if (
                not isinstance(props, dict)
                or not isinstance(required, list)
                or not all(isinstance(key, str) for key in required)
                or len(required) != len(set(required))
                or set(required) != set(props)
                or node.get("additionalProperties") is not False
            ):
                raise errors.EditorError("configuration")
        for key in ("properties", "$defs"):
            if key in node:
                children = node[key]
                if not isinstance(children, dict):
                    raise errors.EditorError("configuration")
                for child in children.values():
                    visit(child, depth + 1)
        if "items" in node:
            visit(node["items"], depth + 1)
        if "anyOf" in node:
            alternatives = node["anyOf"]
            if not isinstance(alternatives, list) or not alternatives:
                raise errors.EditorError("configuration")
            for child in alternatives:
                visit(child, depth + 1)

    visit(schema)


def production_output_schemas() -> dict[str, types.Payload]:
    """Enumerate every model operation, including inactive legacy graph paths.

    Imports are local because StoryEditor itself uses CodexEditor. Nonempty
    identifiers exercise dynamic enum and citation-pattern construction; the
    actual request is independently checked by CodexEditor.execute.
    """
    # Break the documented schema catalog -> editor -> validator import cycle.
    import newsletter.model_schema as model_schema  # noqa: PLC0415
    import newsletter.workflow.schema as newsletter_workflow_schema  # noqa: PLC0415
    import newsletter.workflow.story_editor as story_editor  # noqa: PLC0415

    packets: list[types.Payload] = [
        {
            "id": "schema-packet",
            "content": {
                "sources": [
                    {"id": "schema-source", "access_scope": "full_text"},
                ]
            },
        }
    ]
    schemas = {
        "discovery": newsletter_workflow_schema.discovery_schema(),
        "planning": newsletter_workflow_schema.planning_schema(
            ["schema-candidate"], ["https://example.com/source"], 12
        ),
        "gaps": newsletter_workflow_schema.planning_schema(
            [], ["https://example.com/source"], 12, gaps=True
        ),
        "research": model_schema.research_schema(),
        "legacy_editor": model_schema.editor_schema(packets),
        "legacy_review": model_schema.legacy_review_schema(),
        "story_review": story_editor.story_review_schema(),
    }
    modes: tuple[Literal["brief", "deep"], ...] = ("brief", "deep")
    for mode in modes:
        for repair in (False, True):
            schemas[f"story_{mode}" + ("_repair" if repair else "")] = (
                story_editor.story_writer_schema(
                    mode,
                    repair=repair,
                    story_id="schema-acceptance",
                    packets=packets,
                )
            )
    return schemas


def check_production_output_schemas() -> None:
    """Offline startup gate: a writer bug must fail before discovery begins."""
    for schema in production_output_schemas().values():
        if schema.get("type") != "object" or "anyOf" in schema:
            raise errors.EditorError("configuration")
        validate_output_schema(schema)
