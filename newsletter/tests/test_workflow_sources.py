"""Test the metadata-only lead shape and its additive researcher fields.

Fetching and parsing feeds is covered by test_researcher.py with synthetic
bytes; this module only checks what a lead may and may not assert.
"""

import dataclasses
import json

import pytest

import newsletter.workflow.sources as sources

DAY = "2026-09-06"


def lead(**changes):
    values = {
        "title": "Synthetic journal research",
        "url": "https://doi.org/10.1234/synthetic",
        "doi": "10.1234/Synthetic",
        "published": "2026-09-05",
        "provenance": "crossref_metadata",
        "direction": "02-science",
    }
    values.update(changes)
    return sources.metadata_candidate(
        values.pop("title"),
        values.pop("url"),
        values.pop("doi"),
        values.pop("published"),
        values.pop("provenance"),
        **values,
    )


def test_metadata_lead_never_asserts_feed_text_or_reading():
    item = lead()
    assert item["access_scope"] == "metadata"
    assert item["provenance"] == "crossref_metadata"
    assert item["doi"] == "10.1234/synthetic"
    assert item["direction"] == "02-science"
    assert item["id"] == sources.candidate_id(item)
    assert "尚未核验" in item["summary"]
    # Without attribution the frozen shape is the old one, not empty fields.
    assert "venue" not in item and "source_basis" not in item


def test_researcher_attribution_and_direction_are_explicit():
    item = lead(
        direction="08-llm-architectures",
        venue="Synthetic Journal",
        source_basis="研究员订阅源：Synthetic Journal（仅元数据，未打开原文）",
        version="v3",
    )
    assert item["direction"] == "08-llm-architectures"
    assert item["venue"] == "Synthetic Journal"
    assert item["source_basis"].startswith("研究员订阅源：")
    assert item["version"] == "v3"


def test_wrapped_titles_collapse_to_one_line():
    item = lead(title="  Synthetic\n   wrapped\ttitle  ")
    assert item["title"] == "Synthetic wrapped title"


@pytest.mark.parametrize(
    "changes",
    [
        {"title": ""},
        {"title": "x" * 501},
        {"title": "bad\x00title"},
        {"url": "http://127.0.0.1/x"},
        {"url": "https://localhost/x"},
        {"url": "file:///private"},
    ],
)
def test_invalid_titles_and_unsafe_links_are_rejected(changes):
    with pytest.raises(ValueError, match=r"title|public HTTP"):
        lead(**changes)


def test_old_metadata_artifacts_read_without_notes():
    old = {"candidates": [lead()], "diagnostics": ["nature_rss:metadata_only"]}
    assert old.get("notes", {}) == {}
    current = sources.MetadataResult([lead()], ["nature:ok"])
    assert dataclasses.asdict(current)["notes"] == {}
    assert "notes" in json.dumps(dataclasses.asdict(current))


def test_per_source_counts_are_additive():
    # Older artifacts lack the key; positional construction keeps working.
    current = sources.MetadataResult([lead()], ["nature:ok"], {})
    assert dataclasses.asdict(current)["sources"] == []
    assert list(dataclasses.asdict(current)) == [
        "candidates",
        "diagnostics",
        "notes",
        "sources",
    ]


def test_identity_keys_and_ids_are_unchanged_for_tracking_parameters():
    first = lead(url="https://example.org/a?utm_source=x&fbclid=y", doi="")
    second = lead(url="https://example.org/a", doi="")
    assert first["id"] == second["id"]
    # Researcher-only parameters such as ref_src stay part of the identity.
    third = lead(url="https://example.org/a?ref_src=x", doi="")
    assert third["id"] != second["id"]
