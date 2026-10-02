"""Validate topic topology without granting send authority."""

import newsletter.workflow.definition as newsletter_workflow_definition

STORY_TYPES = frozenset({"story_plan", "story_brief", "story_deep", "publish"})


def is_story_recipe(
    definition: newsletter_workflow_definition.WorkflowDefinition,
) -> bool:
    # Partial or corrupt story graphs must not be mistaken for legacy recipes.
    """Detect any story node, including an incomplete or corrupt story graph."""
    return any(node.type in STORY_TYPES for node in definition.nodes)


def validate_story_recipe(
    definition: newsletter_workflow_definition.WorkflowDefinition,
) -> None:
    # Persisted or directly constructed dataclasses are not a syntax bypass.
    """Validate code-owned dependencies, budgets and story-review boundaries."""
    definition = newsletter_workflow_definition.parse_definition(
        definition.snapshot()
    )
    by_id = {node.id: node for node in definition.nodes}
    required = {
        "history",
        "deduplicate",
        "selection",
        "story_plan",
        "story_brief",
        "story_deep",
        "publish",
    }
    allowed = required | {"api_feed", "discovery"}
    if any(node.type not in allowed for node in definition.nodes):
        raise newsletter_workflow_definition.DefinitionError()
    roles: dict[str, newsletter_workflow_definition.NodeDefinition] = {}
    for kind in required:
        nodes = [node for node in definition.nodes if node.type == kind]
        if len(nodes) != 1:
            raise newsletter_workflow_definition.DefinitionError()
        roles[kind] = nodes[0]
    discoveries = [
        node for node in definition.nodes if node.type == "discovery"
    ]
    feeds = [node for node in definition.nodes if node.type == "api_feed"]
    if not discoveries:
        raise newsletter_workflow_definition.DefinitionError()
    history = roles["history"]
    if history.needs or history.on_error != "stop":
        raise newsletter_workflow_definition.DefinitionError()
    for feed in feeds:
        if feed.map is not None or set(feed.needs) - {history.id}:
            raise newsletter_workflow_definition.DefinitionError()
    for discovery in discoveries:
        if (
            discovery.map is None
            or discovery.map.source != "run.instructions"
            or {history.id, *(node.id for node in feeds)} - set(discovery.needs)
        ):
            raise newsletter_workflow_definition.DefinitionError()
    if {history.id, *(node.id for node in feeds + discoveries)} - set(
        roles["deduplicate"].needs
    ):
        raise newsletter_workflow_definition.DefinitionError()
    requirements = {
        "deduplicate": {"history", "discovery"},
        "selection": {"history", "deduplicate"},
        "story_plan": {"history", "deduplicate", "selection"},
        "story_brief": {"history", "deduplicate", "story_plan"},
        "story_deep": {"history", "deduplicate", "story_plan", "story_brief"},
        "publish": {"story_plan", "story_brief", "story_deep"},
    }
    for kind, dependencies in requirements.items():
        if not dependencies <= {
            by_id[dependency].type for dependency in roles[kind].needs
        }:
            raise newsletter_workflow_definition.DefinitionError()
    for node in definition.nodes:
        _validate_node(node)
    _validate_story_maps(roles)


def _validate_node(
    node: newsletter_workflow_definition.NodeDefinition,
) -> None:
    if (
        node.type in {"api_feed", "discovery", "story_brief", "story_deep"}
        and node.on_error != "continue"
    ):
        raise newsletter_workflow_definition.DefinitionError()
    parameters = {"timeout_seconds"}
    parameters |= {"max_candidates"} if node.type == "deduplicate" else set()
    parameters |= {"max_tasks"} if node.type == "selection" else set()
    parameters |= {"max_deep"} if node.type == "story_plan" else set()
    if set(node.params) - parameters:
        raise newsletter_workflow_definition.DefinitionError()
    for key, value in node.params.items():
        bounds = {
            "timeout_seconds": (1, 900),
            "max_candidates": (1, 60),
            "max_tasks": (1, 12),
            "max_deep": (0, 4),
        }
        if (
            type(value) is not int
            or not bounds[key][0] <= value <= bounds[key][1]
        ):
            raise newsletter_workflow_definition.DefinitionError()
    if (
        node.type
        in {"story_plan", "publish", "history", "selection", "deduplicate"}
        and node.map is not None
    ):
        raise newsletter_workflow_definition.DefinitionError()


def _validate_story_maps(
    roles: dict[str, newsletter_workflow_definition.NodeDefinition],
) -> None:
    for kind, field in (
        ("story_brief", "brief_tasks"),
        ("story_deep", "deep_tasks"),
    ):
        node = roles[kind]
        if (
            node.map is None
            or node.map.source != roles["story_plan"].id + "." + field
        ):
            raise newsletter_workflow_definition.DefinitionError()
    brief_map, deep_map = roles["story_brief"].map, roles["story_deep"].map
    if brief_map is None or deep_map is None:
        raise newsletter_workflow_definition.DefinitionError()
    if roles["selection"].params.get("max_tasks", 8) > brief_map.max_items:
        raise newsletter_workflow_definition.DefinitionError()
    if roles["story_plan"].params.get("max_deep", 4) > deep_map.max_items:
        raise newsletter_workflow_definition.DefinitionError()
    if brief_map.max_items > 12 or deep_map.max_items > 4:
        raise newsletter_workflow_definition.DefinitionError()
