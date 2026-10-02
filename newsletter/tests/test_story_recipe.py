"""Test topic-graph history, verification and publication barriers."""

import copy
import dataclasses
import importlib.resources as resources

import pytest

import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.nodes as nodes
import newsletter.workflow.story_recipe as story_recipe


def recipe():
    return newsletter_workflow_definition.load_definition(
        resources.files("newsletter")
        .joinpath("workflows/daily.yaml")
        .read_bytes()
    ).snapshot()


def role(value, kind):
    return next(node for node in value["nodes"] if node["type"] == kind)


def validate(value):
    definition = newsletter_workflow_definition.parse_definition(value)
    story_recipe.validate_story_recipe(definition)
    nodes.validate_recipe(definition)
    return definition


def test_default_recipe_is_publication_by_deadline_not_a_global_review_tail():
    definition = validate(recipe())
    assert story_recipe.is_story_recipe(definition)
    kinds = [node.type for node in definition.nodes]
    assert kinds[-4:] == ["story_plan", "story_brief", "story_deep", "publish"]
    assert not set(kinds) & {
        "review",
        "revision",
        "final_review",
        "render",
        "send",
        "mail",
        "notion",
    }
    assert role(recipe(), "selection")["params"]["max_tasks"] == 8
    assert role(recipe(), "story_plan")["params"]["max_deep"] == 4


@pytest.mark.parametrize(
    "kind",
    [
        "history",
        "deduplicate",
        "selection",
        "story_plan",
        "story_brief",
        "story_deep",
        "publish",
    ],
)
def test_each_critical_role_is_required_exactly_once(kind):
    value = recipe()
    removed = role(value, kind)["id"]
    value["nodes"] = [node for node in value["nodes"] if node["id"] != removed]
    for node in value["nodes"]:
        node["needs"] = [
            dependency for dependency in node["needs"] if dependency != removed
        ]
        if node.get("map", {}).get("from", "").startswith(removed + "."):
            node["map"]["from"] = "run.instructions"
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)
    value = recipe()
    duplicate = copy.deepcopy(role(value, kind))
    duplicate["id"] += "-duplicate"
    value["nodes"].append(duplicate)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind,dependency",
    [
        ("discovery", "history"),
        ("discovery", "api_feed"),
        ("deduplicate", "history"),
        ("deduplicate", "api_feed"),
        ("deduplicate", "discovery"),
        ("selection", "history"),
        ("selection", "deduplicate"),
        ("story_plan", "history"),
        ("story_plan", "deduplicate"),
        ("story_plan", "selection"),
        ("story_brief", "history"),
        ("story_brief", "deduplicate"),
        ("story_brief", "story_plan"),
        ("story_deep", "history"),
        ("story_deep", "deduplicate"),
        ("story_deep", "story_plan"),
        ("story_deep", "story_brief"),
        ("publish", "story_plan"),
        ("publish", "story_brief"),
        ("publish", "story_deep"),
    ],
)
def test_required_predecessors_cannot_be_removed(kind, dependency):
    value = recipe()
    target, predecessor = role(value, kind), role(value, dependency)
    target["needs"].remove(predecessor["id"])
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "source",
    [
        "run.history",
        "run.editions",
        "run.packets",
        "history.editions",
        "run.policy",
    ],
)
def test_discovery_scans_frozen_instructions(
    source,
):
    value = recipe()
    role(value, "discovery")["map"]["from"] = source
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind",
    [
        "history",
        "api_feed",
        "deduplicate",
        "selection",
        "story_plan",
        "publish",
    ],
)
def test_scalar_critical_or_metadata_nodes_cannot_be_mapped(kind):
    value = recipe()
    role(value, kind)["map"] = {"from": "run.instructions", "max_items": 1}
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize("kind", ["discovery", "story_brief", "story_deep"])
def test_required_map_cannot_be_deleted(kind):
    value = recipe()
    role(value, kind).pop("map")
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind,source",
    [
        ("story_brief", "run.instructions"),
        ("story_brief", "story_plan.deep_tasks"),
        ("story_deep", "run.editions"),
        ("story_deep", "story_plan.brief_tasks"),
    ],
)
def test_story_maps_use_their_actual_frozen_plan_fields(kind, source):
    value = recipe()
    role(value, kind)["map"]["from"] = source
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind", ["api_feed", "discovery", "story_brief", "story_deep"]
)
def test_a_single_optional_leaf_cannot_be_configured_to_stop_the_issue(kind):
    value = recipe()
    role(value, kind)["on_error"] = "stop"
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind", ["history", "deduplicate", "selection", "story_plan", "publish"]
)
def test_local_critical_nodes_cannot_silently_continue_after_failure(kind):
    value = recipe()
    role(value, kind)["on_error"] = "continue"
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind,maximum",
    [
        ("story_brief", 7),
        ("story_brief", 13),
        ("story_deep", 3),
        ("story_deep", 5),
    ],
)
def test_capacity_cannot_silently_omit_selected_briefs_or_exceed_deep_budget(
    kind, maximum
):
    value = recipe()
    role(value, kind)["map"]["max_items"] = maximum
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


@pytest.mark.parametrize(
    "kind,key,value",
    [
        ("story_plan", "max_deep", -1),
        ("story_plan", "max_deep", 5),
        ("story_plan", "max_deep", True),
        ("story_plan", "max_deep", 1.0),
        ("selection", "max_tasks", 0),
        ("selection", "max_tasks", 13),
        ("deduplicate", "max_candidates", 0),
        ("deduplicate", "max_candidates", 61),
        ("story_brief", "timeout_seconds", 0),
        ("story_deep", "timeout_seconds", 901),
        ("publish", "timeout_seconds", "30"),
        ("history", "timeout_seconds", None),
        ("story_plan", "recipient", "example@example.com"),
        ("discovery", "model", "untrusted"),
    ],
)
def test_parameters_are_registered_literals_with_explicit_bounds(
    kind, key, value
):
    value_recipe = recipe()
    role(value_recipe, kind)["params"][key] = value
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value_recipe)


def test_optional_feed_removal_keeps_discovery_and_history():
    value = recipe()
    identity = role(value, "api_feed")["id"]
    value["nodes"] = [node for node in value["nodes"] if node["id"] != identity]
    for node in value["nodes"]:
        node["needs"] = [dep for dep in node["needs"] if dep != identity]
    validate(value)


def test_discovery_itself_cannot_be_removed_to_publish_stale_history():
    value = recipe()
    identity = role(value, "discovery")["id"]
    value["nodes"] = [node for node in value["nodes"] if node["id"] != identity]
    for node in value["nodes"]:
        node["needs"] = [dep for dep in node["needs"] if dep != identity]
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


def test_extra_discovery_must_also_feed_the_candidate_pool():
    value = recipe()
    extra = copy.deepcopy(role(value, "discovery"))
    extra["id"] = "second-discovery"
    value["nodes"].append(extra)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)
    role(value, "deduplicate")["needs"].append(extra["id"])
    validate(value)


def test_renaming_node_ids_preserves_semantics_and_all_map_sources():
    value = recipe()
    identities = {
        node["id"]: "renamed-" + node["id"] for node in value["nodes"]
    }
    for node in value["nodes"]:
        node["id"] = identities[node["id"]]
        node["needs"] = [identities[dep] for dep in node["needs"]]
        if "map" in node:
            prefix, field = node["map"]["from"].split(".", 1)
            node["map"]["from"] = identities.get(prefix, prefix) + "." + field
    validate(value)


def test_zero_deep_budget_still_keeps_all_briefs_and_publish_gate():
    value = recipe()
    role(value, "story_plan")["params"]["max_deep"] = 0
    validate(value)


@pytest.mark.parametrize(
    "kind", ["review", "revision", "composition", "research"]
)
def test_old_global_review_types_cannot_be_inserted_into_new_publication_recipe(
    kind,
):
    value = recipe()
    value["nodes"].append({"id": "legacy-step", "type": kind})
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        validate(value)


def test_partial_story_recipe_is_detected_even_without_story_plan():
    definition = newsletter_workflow_definition.parse_definition(
        {
            "id": "partial",
            "version": 1,
            "nodes": [{"id": "publish", "type": "publish"}],
        }
    )
    assert story_recipe.is_story_recipe(definition)
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        story_recipe.validate_story_recipe(definition)


def test_direct_dataclasses_still_validate_syntax_and_edges():
    definition = newsletter_workflow_definition.parse_definition(recipe())
    broken = dataclasses.replace(
        definition,
        nodes=(
            dataclasses.replace(definition.nodes[0], needs=("missing",)),
            *definition.nodes[1:],
        ),
    )
    with pytest.raises(newsletter_workflow_definition.DefinitionError):
        story_recipe.validate_story_recipe(broken)


def test_legacy_definition_is_still_accepted_by_its_own_validator():
    legacy = newsletter_workflow_definition.load_definition(
        resources.files("newsletter")
        .joinpath("workflows/legacy-daily.yaml")
        .read_bytes()
    )
    assert not story_recipe.is_story_recipe(legacy)
    nodes.validate_recipe(legacy)
