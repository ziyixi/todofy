"""Pure story-component views shared by review and publication admission."""

from collections.abc import Mapping
import copy
from typing import Any, cast

import newsletter.types as types

COMPONENTS = ("body", "reading", "chart", "signal")
OPTIONAL_COMPONENTS = ("recommended_reading", "chart")


def body_content(
    content: Mapping[str, Any], *, copy_values: bool = True
) -> types.Payload:
    """Return the indivisible body, optionally detaching its nested values."""
    body = {
        key: value
        for key, value in content.items()
        if key not in OPTIONAL_COMPONENTS
    }
    return copy.deepcopy(body) if copy_values else body


def component_content(
    content: types.Payload | None,
    signal: types.Payload | None,
    name: str,
) -> types.Payload | None:
    """Select one reviewed component without merging independent approvals."""
    if name == "signal":
        return signal
    if content is None:
        return None
    if name == "body":
        return body_content(content)
    field = "recommended_reading" if name == "reading" else name
    return cast(types.Payload | None, content.get(field))


def component_citations(component: types.Payload, name: str) -> list[str]:
    """Return a component's references in their original encounter order."""
    if name == "reading":
        return [
            component["citation"],
            *component.get("supporting_citations", []),
        ]
    field = "points" if name == "chart" else "paragraphs"
    references = []
    for child in component.get(field, []):
        references.extend(child.get("citations", []))
    return list(dict.fromkeys(references))


def citations(value: object) -> set[str]:
    """Collect all declared citation fields in a nested publication value."""
    references: set[str] = set()
    if isinstance(value, dict):
        for name, child in value.items():
            if name == "citation" and isinstance(child, str):
                references.add(child)
            elif name in {"citations", "supporting_citations"} and isinstance(
                child, list
            ):
                references.update(
                    item for item in child if isinstance(item, str)
                )
            else:
                references.update(citations(child))
    elif isinstance(value, list):
        for child in value:
            references.update(citations(child))
    return references


def validation_draft(
    content: types.Payload, *, subject: str, title: str
) -> types.Payload:
    """Wrap unchanged story text in the existing draft contract."""
    draft: types.Payload = {
        "subject": subject,
        "title": title,
        "introduction": "",
        "limitations": "",
        "sections": [
            {
                "kind": content["kind"],
                "heading": content["title"],
                "paragraphs": content["paragraphs"],
                "limitations": content["limitations"],
            }
        ],
    }
    for name in OPTIONAL_COMPONENTS:
        if name in content:
            draft[name] = content[name]
    return draft
