"""Test deterministic public-candidate pooling without providers."""

import collections
import copy
import importlib.resources as resources
import pathlib

import pytest
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.store as newsletter_store
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as engine
import newsletter.workflow.nodes as newsletter_workflow_nodes
import newsletter.workflow.story_nodes as story_nodes

DAY = "2026-09-06"


def candidate(direction, index):
    identifier = f"direction-{direction}-candidate-{index}"
    return {
        "id": identifier,
        "direction": f"direction-{direction}",
        "title": "Synthetic public candidate " + identifier,
        "url": "https://example.org/" + identifier,
        "doi": "",
        "version": "",
        "event_key": "",
        "published_at": DAY,
        "summary": "Offline fixture only; not real research.",
        "why_now": (
            "Only tests source-preserving candidate pooling across directions."
        ),
        "access_scope": "abstract",
        "provenance": "fixture-discovery",
        "authors": "Fixture Author",
        "affiliations": "Fixture Institute",
        "venue": "Fixture Venue",
        "publication_status": "Fixture status",
        "contribution": "Fixture contribution",
        "source_basis": "Fixture lead, not proof",
        "evidence_urls": ["https://example.org/" + identifier + "/evidence"],
    }


@pytest.fixture(
    params=[newsletter_workflow_nodes.EditorialNodes, story_nodes.StoryNodes],
    ids=["legacy", "topics"],
)
def pool(request, tmp_path, monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("Candidate pooling cannot call a provider")

    monkeypatch.setattr(editor.CodexEditor, "execute", forbidden)
    definition = newsletter_workflow_definition.load_definition(
        pathlib.Path(
            str(resources.files("newsletter").joinpath("workflows/daily.yaml"))
        )
    )
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    nodes = request.param(
        store,
        definition,
        editor.CodexEditor(tmp_path / "unused-auth"),
        tmp_path,
    )

    async def run(groups, *, limit=30, history=(), feeds=(), states=None):
        context = engine.NodeContext(
            run_id="fixture-pooling",
            node_id="candidates",
            item_id="",
            params={"max_candidates": limit},
            inputs={
                "history": {
                    "candidates": list(history),
                    "editions": [],
                    "watchlist": [],
                },
                "feeds": {"candidates": list(feeds)}
                if feeds is not None
                else None,
                "discovery": groups,
            },
            run_inputs={"issue_date": DAY},
            dependency_states=states or {},
        )
        original = copy.deepcopy(context.inputs)
        result = await nodes.execute("deduplicate", context, tmp_path)
        assert context.inputs == original
        return result

    yield run
    store.close()


async def test_eight_directions_share_thirty_candidate_cap_and_order(
    pool,
):
    groups = [
        {"candidates": [candidate(direction, i) for i in range(5)]}
        for direction in range(8)
    ]
    expected = [
        groups[direction]["candidates"][i]
        for i in range(5)
        for direction in range(8)
    ][:30]
    original_hash = contracts.content_hash(groups)
    first = await pool(groups)
    second = await pool(copy.deepcopy(groups))
    assert first == second
    assert first["candidates"] == [
        contracts.to_dict(
            contracts.parse_message(item, editorial_pb2.Candidate)
        )
        for item in expected
    ]
    assert len(first["candidates"]) == 30
    assert collections.Counter(
        item["direction"] for item in first["candidates"]
    ) == {f"direction-{i}": 4 if i < 6 else 3 for i in range(8)}
    assert contracts.content_hash(groups) == original_hash


@pytest.mark.parametrize("limit", [1, 5, 30])
async def test_uneven_directions_respect_configured_caps_and_order(pool, limit):
    a = [candidate(0, i) for i in range(5)]
    b = [candidate(1, 0)]
    groups = [{"candidates": a}, {"candidates": []}, {"candidates": b}]
    result = await pool(groups, limit=limit)
    assert [item["id"] for item in result["candidates"]] == [
        item["id"] for item in [a[0], b[0], *a[1:]][:limit]
    ]


async def test_alias_history_dedup_still_run_before_cap_keep_first_source(
    pool,
):
    a, b, followup, extra = [candidate(0, i) for i in range(4)]
    a["doi"] = "10.1234/shared"
    alias = {**candidate(1, 0), "doi": "https://doi.org/10.1234/shared"}
    old = {**followup, "published_at": "2026-09-05", "version": "v1"}
    followup["version"] = "v2"
    groups = [{"candidates": [a, b, extra]}, {"candidates": [alias, followup]}]
    result = await pool(groups, history=[b, old], limit=3)
    assert result["candidates"] == [
        contracts.to_dict(
            contracts.parse_message(item, editorial_pb2.Candidate)
        )
        for item in (a, followup, extra)
    ]
    assert result["candidates"][0]["url"] == a["url"]
    assert result["candidates"][0]["evidence_urls"] == a["evidence_urls"]


@pytest.mark.parametrize("discovery", [None, [], [{"candidates": []}]])
async def test_missing_discovery_keeps_metadata_and_failure_coverage(
    pool, discovery
):
    states = {
        "discovery": {
            "state": "succeeded",
            "degraded": True,
            "items": [
                {
                    "id": "direction-7",
                    "state": "unknown",
                    "error_code": "timeout",
                }
            ],
        }
    }
    supplement = candidate("feed", 0)
    result = await pool(discovery, feeds=[supplement], states=states)
    assert [item["id"] for item in result["candidates"]] == [supplement["id"]]
    assert result["coverage"][0]["degraded"] is True
    assert result["coverage"][0]["failures"] == [
        {"id": "direction-7", "error_code": "timeout"}
    ]


async def test_metadata_remains_after_discovery_missing_feed_never_change_pool(
    pool,
):
    first, second, supplement = (
        candidate(0, 0),
        candidate(1, 0),
        candidate("feed", 0),
    )
    groups = [{"candidates": [first]}, {"candidates": [second]}]
    capped = await pool(groups, feeds=[supplement], limit=2)
    assert [item["id"] for item in capped["candidates"]] == [
        first["id"],
        second["id"],
    ]
    assert capped == await pool(groups, feeds=None, limit=2)
    supplemented = await pool(groups, feeds=[supplement], limit=3)
    assert [item["id"] for item in supplemented["candidates"]] == [
        first["id"],
        second["id"],
        supplement["id"],
    ]
