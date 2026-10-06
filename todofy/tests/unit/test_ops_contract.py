"""contracts/ops-v1 checked with the reference JSON Schema implementation (Python jsonschema, Draft 2020-12).

ops-v1.schema.json is generated from proto/ops/v1/ops.proto (proto/tools/gen_schema.py): the reference validator gives
every fixture its verdict on it, and the generated Python codec gives the same verdict (a strict read, the producer's
view), so the IDL's rules, the generator and the codec are checked against an implementation none of them shares.

The schema before the move onto proto/, hand-written and frozen in legacy/, is what the dashboards deployed until then
validate answers with: the generated schema must give its verdict on every fixture and on thousands of mutations of
them (every field removed, or set to values of every kind), so the IDL kept every guarantee of the hand-written
contract, no more and no less (every app's golden answers pass the legacy schema too: each app's own golden test). The
generated schema also stays inside the keyword subset of validate.mjs.
"""

import copy
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from ziyixi_proto.ops.v1 import ops_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire

from tests import mail_contract

ROOT = mail_contract.TODOFY.parent / "contracts" / "ops-v1"
SCHEMA = json.loads((ROOT / "ops-v1.schema.json").read_text())
LEGACY = json.loads((ROOT / "legacy" / "ops-v1.schema.json").read_text())
# The apps that joined ops-v1 after the hand-written schema was frozen (OpsStatus.app is an open list): Watch,
# Fleet, Newsletter and Notion publish. No dashboard that validates with the legacy schema binds one, so it is
# compared with the generated one as if its App list had grown the same way. New optional evidence is checked below.
JOINED_APPS = ["watch", "fleet", "newsletter", "notion-publish"]
LEGACY_GROWN = {
    **LEGACY,
    "$defs": {**LEGACY["$defs"], "App": {"enum": [*LEGACY["$defs"]["App"]["enum"], *JOINED_APPS]}},
}
# validate.mjs: KEYWORDS plus the annotations it skips.
SUPPORTED = {
    *("$ref", "type", "enum", "const", "required", "properties", "additionalProperties", "propertyNames"),
    *("minProperties", "maxProperties", "items", "minItems", "maxItems", "uniqueItems", "pattern"),
    *("minLength", "maxLength", "minimum", "maximum", "oneOf", "anyOf"),
    *("$schema", "$id", "$defs", "title", "description", "format", "examples", "$comment"),
}


def _cases(folder: Path) -> list[tuple[str, Path]]:
    return sorted(
        (path.parent.name, path)
        for path in folder.glob("*/*.json")
        if path.parent.parent == folder and path.parent.name != "invalid"
    )


VALID = _cases(ROOT / "fixtures")
INVALID = _cases(ROOT / "fixtures" / "invalid")


def _errors(name: str, path: Path) -> list[str]:
    validator = jsonschema.Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{name}"})
    return [error.message for error in validator.iter_errors(json.loads(path.read_text()))]


def _keywords(schema: Any, found: set[str]) -> set[str]:
    if isinstance(schema, dict):
        for key, value in schema.items():
            found.add(key)
            if key in ("properties", "$defs"):
                for child in value.values():
                    _keywords(child, found)
            elif key in ("oneOf", "anyOf"):
                for child in value:
                    _keywords(child, found)
            elif key in ("items", "additionalProperties", "propertyNames"):
                _keywords(value, found)
    return found


def test_the_schema_is_valid_draft_2020_12():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


def test_the_schema_stays_inside_the_subset_validate_mjs_implements():
    assert _keywords(SCHEMA, set()) - SUPPORTED == set()


def test_fixtures_exist_for_every_method_input_and_output():
    assert {name for name, _ in VALID} == {
        "CanaryDelivery",
        "CanaryResult",
        "GuardState",
        "OpsReport",
        "OpsReportReceipt",
        "OpsStatus",
        "SetGuardInput",
        "StartCanaryInput",
        "StartCanaryResult",
    }
    assert len(INVALID) >= 20


@pytest.mark.parametrize(("name", "path"), VALID, ids=[f"{n}/{p.stem}" for n, p in VALID])
def test_valid_fixture(name, path):
    assert _errors(name, path) == []
    value = json.loads(path.read_text())
    joined = isinstance(value, dict) and value.get("app") in JOINED_APPS
    # The new relay's optional website_sync evidence is for the new Home only. The frozen reader rejects it,
    # as well as the joined app; compare the pre-existing fields without extending that reader's closed shape.
    assert _validator(LEGACY, name).is_valid(value) != joined
    legacy_value = {key: item for key, item in value.items() if key != "website_sync"} if name == "OpsStatus" else value
    assert _validator(LEGACY_GROWN, name).is_valid(legacy_value)


@pytest.mark.parametrize(("name", "path"), INVALID, ids=[f"{n}/{p.stem}" for n, p in INVALID])
def test_invalid_fixture(name, path):
    assert _errors(name, path) != []
    value = json.loads(path.read_text())
    legacy = list(_validator(LEGACY, name).iter_errors(value))
    assert legacy != []
    # The frozen reader must reject the fixture's own mutation, not only an app it never knew (a joined one).
    if path.stem != "unknown-app":
        assert all(list(error.absolute_path) != ["app"] for error in legacy)


def _validator(schema: dict[str, Any], name: str) -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator({**schema, "$ref": f"#/$defs/{name}"})


@pytest.mark.parametrize(("name", "path"), VALID + INVALID, ids=[f"{n}/{p.stem}" for n, p in VALID + INVALID])
def test_the_python_codec_gives_the_reference_verdict(name, path):
    """A strict read (the producer's view) refuses exactly what the generated schema refuses."""
    value = json.loads(path.read_text())
    try:
        from_wire(getattr(pb, name), value, strict=True)
        read = True
    except WireJsonError:
        read = False
    assert read == (_errors(name, path) == [])


# Values of every kind a mutation puts in a field: nothing, the wrong types, free text, an address, timestamps with and
# without an offset, codes, numbers out of range, and the enum-like words of the contract.
MUTATIONS = (
    *(None, "", "x", "Free text", "owner@example.com", "x\n", 0, 1, -1, 1.5, 21, 99, 100, 599, 600, True, False),
    *("2026-09-29T08:00:00Z", "2026-09-29T08:00:00.000Z", "2026-09-29T08:00:00+01:00"),
    *("6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31", "https://a.example.com/", "http://a.example.com/"),
    *([], ["x"], ["x", "x"], {}, {"maintenance": True}, {"Bad Key": 1}, {"a": "text"}),
    *("paused", "queued", "unknown", "delivered", "failed", "shed", "normal", "ok", "processing", "mail-hero"),
    *("send_paused", "maintenance", "retry_wait", "ops-v1", "ops-v2"),
)


def _paths(value: Any, path: tuple[Any, ...] = ()) -> Iterator[tuple[Any, ...]]:
    yield path
    children = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
    for key, child in children:
        yield from _paths(child, (*path, key))


def _mutants(value: Any) -> Iterator[Any]:
    """`value`, every field (and list item) removed, every field set to each of MUTATIONS, and an extra field."""
    yield value
    for path in list(_paths(value))[1:]:
        for replacement in (_REMOVE, *MUTATIONS):
            mutant = copy.deepcopy(value)
            parent = mutant
            for key in path[:-1]:
                parent = parent[key]
            if replacement is _REMOVE:
                del parent[path[-1]]
            else:
                parent[path[-1]] = copy.deepcopy(replacement)
            yield mutant
    if isinstance(value, dict):
        yield {**value, "subject": "Your invoice"}


_REMOVE = object()


@pytest.mark.parametrize(("name", "path"), VALID, ids=[f"{n}/{p.stem}" for n, p in VALID])
def test_the_generated_schema_keeps_every_guarantee_of_the_hand_written_one(name, path):
    """About 22,000 mutants of the valid fixtures (the invalid ones get the same verdict from both above)."""
    generated, legacy = _validator(SCHEMA, name), _validator(LEGACY_GROWN, name)
    value = json.loads(path.read_text())
    if name == "OpsStatus":
        value.pop("website_sync", None)  # The frozen profile has no rules for this new optional field.
    differ = [m for m in _mutants(value) if generated.is_valid(m) != legacy.is_valid(m)]
    assert differ == []


def test_the_new_website_sync_field_is_checked_by_the_schema_and_python_codec():
    value = json.loads((ROOT / "fixtures" / "OpsStatus" / "notion-publish-ok.json").read_text())
    assert not _validator(LEGACY_GROWN, "OpsStatus").is_valid(value)
    generated = _validator(SCHEMA, "OpsStatus")
    for sync in _mutants(value["website_sync"]):
        mutant = {**value, "website_sync": sync}
        try:
            from_wire(pb.OpsStatus, mutant, strict=True)
            read = True
        except WireJsonError:
            read = False
        assert read == generated.is_valid(mutant), mutant
