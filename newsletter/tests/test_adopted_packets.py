"""Adopted material is every packet cited anywhere in a frozen draft."""

import pytest

import newsletter.workflow.pipeline as pipeline


def test_adopted_packets_cover_body_chart_reading_once():
    draft = {
        "sections": [
            {"paragraphs": [{"citations": ["body/source", "shared/source"]}]}
        ],
        "chart": {
            "points": [
                {"citations": ["chart/source", "shared/other"]},
                {"citations": []},
            ]
        },
        "recommended_reading": {"citation": "reading/source"},
    }
    assert pipeline.adopted_packets(draft) == [
        "body",
        "chart",
        "reading",
        "shared",
    ]


@pytest.mark.parametrize(
    "optional",
    [
        {"chart": {"points": [{"citations": ["only-chart/data"]}]}},
        {"recommended_reading": {"citation": "only-reading/source"}},
    ],
)
def test_material_only_used_outside_body_is_still_required_for_publication(
    optional,
):
    draft = {"sections": [{"paragraphs": [{"citations": []}]}], **optional}
    assert len(pipeline.adopted_packets(draft)) == 1


def test_uncited_packets_are_not_added_to_adopted_material():
    assert (
        pipeline.adopted_packets(
            {"sections": [{"paragraphs": [{"citations": []}]}]}
        )
        == []
    )
