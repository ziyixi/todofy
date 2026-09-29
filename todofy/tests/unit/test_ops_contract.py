"""contracts/ops-v1 checked with the reference JSON Schema implementation.

The TypeScript Workers validate the same fixtures with the dependency-free
``contracts/ops-v1/validate.mjs`` (mail-hero/cloudflare/test/ops-contract.test.mjs); this test
proves the verdicts of the standard validator and keeps the schema inside the keyword subset that
validate.mjs implements, so the two cannot drift apart.
"""

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from tests import mail_contract

ROOT = mail_contract.TODOFY.parent / "contracts" / "ops-v1"
SCHEMA = json.loads((ROOT / "ops-v1.schema.json").read_text())
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


@pytest.mark.parametrize(("name", "path"), INVALID, ids=[f"{n}/{p.stem}" for n, p in INVALID])
def test_invalid_fixture(name, path):
    assert _errors(name, path) != []
