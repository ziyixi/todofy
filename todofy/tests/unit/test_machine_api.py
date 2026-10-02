"""api/machine-api-v1.openapi.yaml: the machine routes other systems call, agreeing with core and the shared schemas.

The owner API is todofy.ui.v1 (proto/todofy/ui/v1; tests/unit/test_owner_ui.py checks its enums against
core/vocab.py). This document keeps the routes on the hooks hosts, whose wire the IDL does not describe as a service.
PyYAML and jsonschema are dev-only dependencies used to read and check it.
"""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tests.mail_contract import SCHEMA_REF, api_schemas
from todofy.core.api_errors import MESSAGES, ApiError

yaml = pytest.importorskip("yaml", reason="dev dependency pyyaml is not installed")
jsonschema = pytest.importorskip("jsonschema", reason="dev dependency jsonschema is not installed")
referencing = pytest.importorskip("referencing")  # jsonschema's $ref resolver
drafts = pytest.importorskip("referencing.jsonschema")

ROOT = Path(__file__).parents[2]
BASE = "https://todofy.local/api/"
DOCUMENT = BASE + "machine-api-v1.openapi.yaml"
SPEC: dict[str, Any] = yaml.safe_load((ROOT / "api" / "machine-api-v1.openapi.yaml").read_text())
SCHEMAS: dict[str, Any] = SPEC["components"]["schemas"]

MACHINE_SECURITY = {
    "/hooks/mail": [{"mailWebhook": []}],
    "/api/summary": [{"reportBasic": []}],
    "/api/recommendation": [{"reportBasic": []}],
    "/health": [],
}


def registry() -> Any:
    """The document plus the JSON Schemas it references by relative path."""
    resources = [(DOCUMENT, drafts.DRAFT202012.create_resource(SPEC))]
    for url, path in api_schemas(BASE).items():
        resource = drafts.DRAFT202012.create_resource(json.loads(path.read_text()))
        resources += [(url, resource), (resource.id(), resource)]
    return referencing.Registry().with_resources(resources)


REGISTRY = registry()


def validator(schema_name: str) -> Any:
    return jsonschema.Draft202012Validator({"$ref": f"{DOCUMENT}#/components/schemas/{schema_name}"}, registry=REGISTRY)


def operations() -> Iterator[tuple[str, str, dict[str, Any]]]:
    for path, item in SPEC["paths"].items():
        for method in ("get", "post"):
            if method in item:
                yield path, method, item[method]


def refs(node: Any) -> Iterator[str]:
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str):
            yield node["$ref"]
        for value in node.values():
            yield from refs(value)
    elif isinstance(node, list):
        for value in node:
            yield from refs(value)


def enum(name: str) -> list[str]:
    return SCHEMAS[name]["enum"]


def test_api_error_codes_equal_core_and_all_have_ui_text():
    assert enum("ApiErrorCode") == list(ApiError)
    assert list(MESSAGES) == list(ApiError)
    assert all(MESSAGES.values())


def test_only_the_machine_routes_on_the_hooks_hosts():
    assert set(SPEC["paths"]) == set(MACHINE_SECURITY)
    (server,) = SPEC["servers"]
    assert set(server["variables"]["hooksHost"]["enum"]) == {"todofy-hooks.ziyixi.science", "daily.ziyixi.science"}


def test_each_route_has_its_credential():
    for path, method, operation in operations():
        assert operation["security"] == MACHINE_SECURITY[path], (method, path)


def test_newsletter_and_webhook_bodies_use_the_shared_schemas():
    paths = SPEC["paths"]
    assert paths["/api/summary"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "./summary-v1.schema.json"
    }
    assert paths["/api/recommendation"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "./recommendation-v1.schema.json"
    }
    assert paths["/hooks/mail"]["post"]["requestBody"]["content"]["application/json"]["schema"] == {"$ref": SCHEMA_REF}


def test_every_error_response_is_the_envelope():
    envelope = {"$ref": "#/components/schemas/Error"}
    for name, response in SPEC["components"]["responses"].items():
        assert response["content"]["application/json"]["schema"] == envelope, name
    for path, method, operation in operations():
        for status, response in operation["responses"].items():
            if int(status) >= 400:
                assert response["$ref"].startswith("#/components/responses/"), (method, path, status)


def test_every_ref_resolves():
    resolver = REGISTRY.resolver(base_uri=DOCUMENT)
    for ref in set(refs(SPEC)):
        resolver.lookup(ref)


@pytest.mark.parametrize("name", [name for name, schema in SCHEMAS.items() if "examples" in schema])
def test_schema_examples_validate(name):
    for example in SCHEMAS[name]["examples"]:
        assert [error.message for error in validator(name).iter_errors(example)] == []
