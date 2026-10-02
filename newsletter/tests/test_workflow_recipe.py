"""Frozen legacy YAML retains its original trusted editorial safety tail."""

import importlib.resources as resources

import pytest

import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.nodes as nodes
import newsletter.workflow.pipeline as pipeline


def recipe():
    return newsletter_workflow_definition.load_definition(
        resources.files("newsletter")
        .joinpath("workflows/legacy-daily.yaml")
        .read_bytes()
    ).snapshot()


def by_type(value, kind):
    return next(node for node in value["nodes"] if node["type"] == kind)


def test_packaged_legacy_recipe_passes_both_syntax_and_semantic_safety_checks():
    definition = newsletter_workflow_definition.parse_definition(recipe())
    nodes.validate_recipe(definition)
    assert [node.type for node in definition.nodes][-4:] == [
        "finalization",
        "review",
        "revision",
        "final_review",
    ]
    assert {node.type for node in definition.nodes}.isdisjoint(
        {"send", "mail", "notion", "render"}
    )


@pytest.mark.parametrize(
    "kind",
    [
        "history",
        "deduplicate",
        "selection",
        "composition",
        "gap_plan",
        "finalization",
        "review",
        "revision",
        "final_review",
    ],
)
def test_critical_role_cannot_be_deleted_even_if_dag_stays_valid(kind):
    value = recipe()
    removed = by_type(value, kind)["id"]
    value["nodes"] = [node for node in value["nodes"] if node["id"] != removed]
    for node in value["nodes"]:
        node["needs"] = [dep for dep in node["needs"] if dep != removed]
        if node.get("map", {}).get("from", "").startswith(removed + "."):
            node["map"]["from"] = "run.instructions"
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


@pytest.mark.parametrize(
    "kind",
    [
        "selection",
        "composition",
        "gap_plan",
        "finalization",
        "review",
        "revision",
        "final_review",
    ],
)
def test_critical_role_cannot_run_as_zero_item_map_or_continue_after_failure(
    kind,
):
    for bypass in ("map", "continue"):
        value = recipe()
        target = by_type(value, kind)
        if bypass == "map":
            target["map"] = {"from": "run.history", "max_items": 1}
        else:
            target["on_error"] = "continue"
        with pytest.raises(newsletter_workflow_definition.DefinitionError):
            nodes.validate_recipe(
                newsletter_workflow_definition.parse_definition(value)
            )


@pytest.mark.parametrize(
    "kind,dependency",
    [
        ("selection", "deduplicate"),
        ("selection", "history"),
        ("composition", "research"),
        ("composition", "history"),
        ("gap_plan", "composition"),
        ("finalization", "composition"),
        ("finalization", "research"),
        ("finalization", "history"),
        ("review", "finalization"),
        ("revision", "review"),
        ("final_review", "revision"),
        ("deduplicate", "history"),
        ("deduplicate", "discovery"),
    ],
)
def test_required_dependency_cannot_be_bypassed(kind, dependency):
    value = recipe()
    removed = {
        node["id"] for node in value["nodes"] if node["type"] == dependency
    }
    target = by_type(value, kind)
    target["needs"] = [dep for dep in target["needs"] if dep not in removed]
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


@pytest.mark.parametrize("late", [False, True])
def test_research_map_must_consume_its_actual_selected_or_gap_tasks(late):
    value = recipe()
    targets = [node for node in value["nodes"] if node["type"] == "research"]
    # The DAG remains syntactically valid. An empty historic-editions list must
    # not stand in for actual selected tasks and silently skip planned research.
    targets[int(late)]["map"]["from"] = "run.editions"
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


@pytest.mark.parametrize("index,maximum", [(0, 7), (1, 2), (1, 4)])
def test_map_capacity_matches_planned_research_and_gap_budget(index, maximum):
    value = recipe()
    targets = [node for node in value["nodes"] if node["type"] == "research"]
    targets[index]["map"]["max_items"] = maximum
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


def test_role_checks_follow_node_types_when_operator_renames_ids():
    value = recipe()
    renamed = {node["id"]: "custom-" + node["id"] for node in value["nodes"]}
    for node in value["nodes"]:
        node["id"] = renamed[node["id"]]
        node["needs"] = [renamed[dep] for dep in node["needs"]]
        if node.get("map"):
            head, tail = node["map"]["from"].split(".", 1)
            if head != "run":
                node["map"]["from"] = renamed[head] + "." + tail
    nodes.validate_recipe(
        newsletter_workflow_definition.parse_definition(value)
    )


@pytest.mark.parametrize(
    "parameter,value",
    [
        ("timeout_seconds", 0),
        ("timeout_seconds", 901),
        ("timeout_seconds", True),
        ("timeout_seconds", 0.5),
        ("unknown_option", 1),
    ],
)
def test_recipe_parameter_values_stay_literal_bounded_and_registered(
    parameter, value
):
    definition = recipe()
    by_type(definition, "review")["params"] = {parameter: value}
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(definition)
        )


@pytest.mark.parametrize(
    "kind,maximum", [("selection", 12), ("gap_plan", 3), ("deduplicate", 30)]
)
def test_candidate_and_research_budgets_cannot_exceed_recipe_limits(
    kind, maximum
):
    value = recipe()
    key = "max_candidates" if kind == "deduplicate" else "max_tasks"
    by_type(value, kind)["params"][key] = maximum + 1
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


@pytest.mark.parametrize("kind", ["selection", "gap_plan"])
@pytest.mark.parametrize("bad", [None, "not-a-number"])
def test_research_budget_types_rejected_before_comparing_map_bounds(kind, bad):
    value = recipe()
    by_type(value, kind)["params"]["max_tasks"] = bad
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


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


def test_pre_revision_immutable_recipe_remains_valid():
    value = recipe()
    value["nodes"] = [
        node
        for node in value["nodes"]
        if node["type"] not in {"revision", "final_review"}
    ]
    nodes.validate_recipe(
        newsletter_workflow_definition.parse_definition(value)
    )
    assert value["nodes"][-1]["type"] == "review"


@pytest.mark.parametrize("kind", ["revision", "final_review"])
def test_revision_stages_cannot_be_duplicated_or_have_extra_dependency(kind):
    value = recipe()
    target = by_type(value, kind)
    duplicate = {**target, "id": "duplicate-" + kind}
    value["nodes"].append(duplicate)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )
    value = recipe()
    by_type(value, kind)["needs"].append(by_type(value, "history")["id"])
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(
            newsletter_workflow_definition.parse_definition(value)
        )


def test_recovery_subgraph_requires_separate_code_owned_validator():
    value = {
        "version": 1,
        "id": "held-edition-revision",
        "nodes": [
            {"id": "repair", "type": "revision"},
            {"id": "audit", "type": "final_review", "needs": ["repair"]},
        ],
    }
    definition = newsletter_workflow_definition.parse_definition(value)
    nodes.validate_revision_subgraph(definition)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_recipe(definition)
    value["nodes"][1]["needs"] = []
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_revision_subgraph(
            newsletter_workflow_definition.parse_definition(value)
        )


@pytest.mark.parametrize("bad", [None, "bad", 0, 901, True])
def test_recovery_subgraph_cannot_relax_timeout_or_add_work(bad):
    value = {
        "version": 1,
        "id": "held-edition-revision",
        "nodes": [
            {
                "id": "repair",
                "type": "revision",
                "params": {"timeout_seconds": bad},
            },
            {"id": "audit", "type": "final_review", "needs": ["repair"]},
        ],
    }
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        nodes.validate_revision_subgraph(
            newsletter_workflow_definition.parse_definition(value)
        )
