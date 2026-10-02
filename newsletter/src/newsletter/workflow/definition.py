"""A bounded YAML data format, not an executable workflow language.

Node implementations and their parameter schemas live in trusted application
code. YAML cannot register code, expand environment variables or grant sending.
"""

import dataclasses
import json
import pathlib
import re
from typing import Any, cast

import yaml

import newsletter.contracts as contracts

MAX_DEFINITION_BYTES = 65_536
MAX_NODES = 32
MAX_MAP_ITEMS = 32
MAX_TOTAL_TASKS = 128
NODE_TYPES = frozenset(
    {
        "discovery",
        "api_feed",
        "history",
        "deduplicate",
        "selection",
        "research",
        "composition",
        "gap_plan",
        "finalization",
        "review",
        "revision",
        "final_review",
        "story_plan",
        "story_brief",
        "story_deep",
        "publish",
    }
)
CONTINUE_TYPES = frozenset(
    {
        "discovery",
        "api_feed",
        "history",
        "research",
        "story_brief",
        "story_deep",
    }
)
_ID = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
_FIELD = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
_FORBIDDEN_KEYS = frozenset(
    {
        "command",
        "shell",
        "script",
        "exec",
        "python",
        "module",
        "callable",
        "env",
        "environment",
        "secret",
        "secrets",
        "password",
        "api_key",
        "token",
        "access_token",
        "refresh_token",
    }
)


class DefinitionError(ValueError):
    """Fixed diagnostics never include YAML contents or operator values."""

    def __init__(self) -> None:
        super().__init__(
            "Invalid workflow definition: use version 1, registered "
            "node types, unique IDs, acyclic dependencies and bounded "
            "literal parameters/maps."
        )


def _parameters(value: object, depth: int = 0) -> None:
    if depth > 8:
        raise DefinitionError()
    if value is None or isinstance(value, (str, bool, int, float)):
        return
    if isinstance(value, list) and len(value) <= 64:
        for item in value:
            _parameters(item, depth + 1)
        return
    if isinstance(value, dict) and len(value) <= 64:
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in _FORBIDDEN_KEYS:
                raise DefinitionError()
            _parameters(item, depth + 1)
        return
    raise DefinitionError()


@dataclasses.dataclass(frozen=True)
class MapDefinition:
    """Describe a bounded expansion over a run input or dependency field."""

    source: str
    max_items: int


@dataclasses.dataclass(frozen=True)
class NodeDefinition:
    """Freeze a registered node and its literal parameters and dependencies."""

    id: str
    type: str
    needs: tuple[str, ...]
    params_json: str = "{}"
    map: MapDefinition | None = None
    on_error: str = "stop"

    @property
    def params(self) -> dict[str, Any]:
        """Return a detached copy of the frozen literal parameters."""
        return cast(dict[str, Any], json.loads(self.params_json))

    def snapshot(self) -> dict[str, Any]:
        """Serialize the node for hashing and durable replay."""
        result: dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "needs": list(self.needs),
            "params": self.params,
            "on_error": self.on_error,
        }
        if self.map:
            result["map"] = {
                "from": self.map.source,
                "max_items": self.map.max_items,
            }
        return result


@dataclasses.dataclass(frozen=True)
class WorkflowDefinition:
    """Freeze an ordered workflow graph with a versioned semantic snapshot."""

    id: str
    nodes: tuple[NodeDefinition, ...]
    version: int = 1

    def snapshot(self) -> dict[str, Any]:
        """Serialize the complete semantic graph without executable code."""
        return {
            "version": self.version,
            "id": self.id,
            "nodes": [node.snapshot() for node in self.nodes],
        }

    @property
    def digest(self) -> str:
        """Hash the canonical semantic snapshot."""
        return contracts.content_hash(self.snapshot())


def parse_definition(value: object) -> WorkflowDefinition:
    """Validate semantic snapshots, including persisted definitions."""
    try:
        return _parse_definition(value)
    except (KeyError, TypeError, ValueError, RecursionError, OverflowError):
        raise DefinitionError() from None


def _parse_definition(value: object) -> WorkflowDefinition:
    if not isinstance(value, dict) or set(value) != {"version", "id", "nodes"}:
        raise DefinitionError()
    if type(value["version"]) is not int or value["version"] != 1:
        raise DefinitionError()
    if not isinstance(value["id"], str) or not _ID.fullmatch(value["id"]):
        raise DefinitionError()
    items = value["nodes"]
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_NODES:
        raise DefinitionError()
    nodes = [_parse_node(item) for item in items]
    by_id = {node.id: node for node in nodes}
    if len(by_id) != len(nodes) or any(
        set(node.needs) - by_id.keys() for node in nodes
    ):
        raise DefinitionError()
    completed: set[str] = set()
    while len(completed) < len(nodes):
        ready = {
            node.id for node in nodes if set(node.needs) <= completed
        } - completed
        if not ready:
            raise DefinitionError()
        completed.update(ready)
    if (
        sum(node.map.max_items if node.map else 1 for node in nodes)
        > MAX_TOTAL_TASKS
    ):
        raise DefinitionError()
    result = WorkflowDefinition(value["id"], tuple(nodes))
    if (
        len(contracts.canonical_json(result.snapshot()).encode("utf-8"))
        > MAX_DEFINITION_BYTES
    ):
        raise DefinitionError()
    return result


def _parse_node(item: object) -> NodeDefinition:
    if not isinstance(item, dict) or set(item) - {
        "id",
        "type",
        "needs",
        "params",
        "map",
        "on_error",
    }:
        raise DefinitionError()
    identifier, kind = item["id"], item["type"]
    if (
        not isinstance(identifier, str)
        or not _ID.fullmatch(identifier)
        or identifier == "run"
    ):
        raise DefinitionError()
    if not isinstance(kind, str) or kind not in NODE_TYPES:
        raise DefinitionError()
    on_error = item.get("on_error", "stop")
    if on_error not in {"stop", "continue"} or (
        on_error == "continue" and kind not in CONTINUE_TYPES
    ):
        raise DefinitionError()
    needs = item.get("needs", [])
    if (
        not isinstance(needs, list)
        or len(needs) > MAX_NODES
        or any(
            not isinstance(dep, str) or not _ID.fullmatch(dep) for dep in needs
        )
        or len(set(needs)) != len(needs)
        or identifier in needs
    ):
        raise DefinitionError()
    params = item.get("params", {})
    if not isinstance(params, dict):
        raise DefinitionError()
    _parameters(params)
    params_json = contracts.canonical_json(params)
    if len(params_json.encode("utf-8")) > 8192:
        raise DefinitionError()
    mapping = _parse_map(item["map"], needs) if "map" in item else None
    return NodeDefinition(
        identifier, kind, tuple(needs), params_json, mapping, on_error
    )


def _parse_map(mapping: object, needs: list[str]) -> MapDefinition:
    if not isinstance(mapping, dict) or set(mapping) != {
        "from",
        "max_items",
    }:
        raise DefinitionError()
    source, maximum = mapping["from"], mapping["max_items"]
    if (
        not isinstance(source, str)
        or type(maximum) is not int
        or not 1 <= maximum <= MAX_MAP_ITEMS
    ):
        raise DefinitionError()
    parts = source.split(".")
    if not 2 <= len(parts) <= 4 or not _ID.fullmatch(parts[0]):
        raise DefinitionError()
    if any(not _FIELD.fullmatch(field) for field in parts[1:]):
        raise DefinitionError()
    if parts[0] != "run" and parts[0] not in needs:
        raise DefinitionError()
    return MapDefinition(source, maximum)


class _UniqueSafeLoader(yaml.SafeLoader):
    pass


def _unique_mapping(
    loader: _UniqueSafeLoader, node: yaml.MappingNode, deep: bool = False
) -> Any:
    result: dict[str, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result:
            raise DefinitionError()
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


_UniqueSafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping
)


def load_definition(source: pathlib.Path | bytes | str) -> WorkflowDefinition:
    """Read operator-owned paths or literal YAML strings."""
    try:
        if isinstance(source, pathlib.Path):
            absolute = source.absolute()
            if (
                any(path.is_symlink() for path in (absolute, *absolute.parents))
                or not absolute.is_file()
            ):
                raise DefinitionError()
            with absolute.open("rb") as stream:
                raw = stream.read(MAX_DEFINITION_BYTES + 1)
        else:
            raw = source.encode("utf-8") if isinstance(source, str) else source
        if (
            not isinstance(raw, bytes)
            or len(raw) > MAX_DEFINITION_BYTES
            or b"\x00" in raw
        ):
            raise DefinitionError()
        text = raw.decode("utf-8")
        for token in yaml.scan(text):
            if isinstance(
                token, (yaml.AliasToken, yaml.AnchorToken, yaml.TagToken)
            ):
                raise DefinitionError()
        depth = 0
        for event in yaml.parse(text):
            if isinstance(
                event, (yaml.MappingStartEvent, yaml.SequenceStartEvent)
            ):
                depth += 1
            elif isinstance(
                event, (yaml.MappingEndEvent, yaml.SequenceEndEvent)
            ):
                depth -= 1
            if depth > 16:
                raise DefinitionError()
        return parse_definition(yaml.load(text, Loader=_UniqueSafeLoader))
    except (
        OSError,
        UnicodeError,
        yaml.YAMLError,
        TypeError,
        ValueError,
        RecursionError,
    ):
        raise DefinitionError() from None
