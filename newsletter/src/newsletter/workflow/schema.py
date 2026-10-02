"""Define discovery/planning envelopes; published material uses protobuf."""

import newsletter.contracts as contracts
import newsletter.types as types

CANDIDATE_LEGACY_FIELDS = (
    "title",
    "url",
    "doi",
    "version",
    "event_key",
    "published_at",
    "summary",
    "why_now",
    "access_scope",
)
CANDIDATE_RESEARCH_FIELDS = (
    "authors",
    "affiliations",
    "venue",
    "publication_status",
    "contribution",
    "source_basis",
)
CANDIDATE_FIELDS = (
    *CANDIDATE_LEGACY_FIELDS,
    *CANDIDATE_RESEARCH_FIELDS,
    "evidence_urls",
)
MAX_EVIDENCE_URLS = 4
TASK_FIELDS = (
    "id",
    "candidate_ids",
    "question",
    "why",
    "priority",
    "evidence_context",
    "source_urls",
)
EDITORIAL_KINDS = ("news", "research", "unknown")


def object_schema(properties: types.Payload) -> types.Payload:
    """Build a closed object schema requiring every declared property."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(properties),
        "properties": properties,
    }


def discovery_schema(
    max_candidates: int = 5, *, classified: bool = False
) -> types.Payload:
    """Build the bounded candidate envelope expected from discovery jobs."""
    optional_text = {
        "doi",
        "version",
        "event_key",
        "published_at",
        *CANDIDATE_RESEARCH_FIELDS,
    }
    props: types.Payload = {
        key: {
            "type": "string",
            "minLength": 0 if key in optional_text else 1,
            "maxLength": 1200,
        }
        for key in CANDIDATE_FIELDS
        if key != "evidence_urls"
    }
    props["evidence_urls"] = {
        "type": "array",
        "maxItems": MAX_EVIDENCE_URLS,
        "items": {"type": "string", "minLength": 1, "maxLength": 1200},
    }
    props["access_scope"]["enum"] = list(contracts.SOURCE_ACCESS_SCOPES)
    props["title"]["maxLength"] = 500
    props["why_now"]["maxLength"] = 1000
    # Shape only: the parser still checks calendar validity and the issue date.
    # Unknown publication dates are deliberately allowed to remain empty.
    props["published_at"].update(
        maxLength=10, pattern=r"^(?:[0-9]{4}-[0-9]{2}-[0-9]{2})?$"
    )
    if classified:
        props["editorial_kind"] = {
            "type": "string",
            "enum": list(EDITORIAL_KINDS),
        }
        props["change_basis"] = {"type": "string", "maxLength": 1200}
    return object_schema(
        {
            "candidates": {
                "type": "array",
                "maxItems": max_candidates,
                "items": object_schema(props),
            },
            "note": {"type": "string", "minLength": 1, "maxLength": 2000},
        }
    )


def planning_schema(
    candidate_ids: list[str],
    source_urls: list[str],
    max_tasks: int,
    *,
    gaps: bool = False,
    classified: bool = False,
) -> types.Payload:
    """Restrict task IDs and source choices to the supplied public inputs."""

    def choices(values: list[str], minimum: int, maximum: int) -> types.Payload:
        return {
            "type": "array",
            "minItems": minimum,
            "maxItems": maximum if values else 0,
            "items": {"type": "string", **({"enum": values} if values else {})},
        }

    task = object_schema(
        {
            "id": {
                "type": "string",
                "pattern": f"^{contracts.IDENTIFIER_PATTERN}$",
            },
            "candidate_ids": choices(candidate_ids, 0 if gaps else 1, 4),
            "question": {"type": "string", "maxLength": 1600},
            "why": {"type": "string", "maxLength": 1000},
            "priority": {"type": "integer", "minimum": 1, "maximum": max_tasks},
            "evidence_context": {"type": "string", "maxLength": 4000},
            "source_urls": choices(source_urls, 0, 8),
        }
    )
    if classified:
        task["properties"]["editorial_kind"] = {
            "type": "string",
            "enum": list(EDITORIAL_KINDS),
        }
        task["required"].append("editorial_kind")
    return object_schema(
        {
            "research_tasks": {
                "type": "array",
                "maxItems": max_tasks,
                "items": task,
            },
            "note": {"type": "string", "maxLength": 2000},
        }
    )
