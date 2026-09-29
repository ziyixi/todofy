"""api/owner-api-v1.openapi.yaml agrees with core/vocab.py, the schema and the host split.

The contract stays hand-written YAML because the UI generates its types from it;
PyYAML and jsonschema are dev-only dependencies used to read and check it.
"""

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from todofy.core.api_errors import MESSAGES, ApiError
from todofy.core.vocab import (
    EVENT_ERROR_CODES,
    REMINDER_ERROR_CODES,
    TERMINAL_STATES,
    EventState,
    Reconcile,
    ReminderState,
    current_codes,
)

yaml = pytest.importorskip("yaml", reason="dev dependency pyyaml is not installed")
jsonschema = pytest.importorskip("jsonschema", reason="dev dependency jsonschema is not installed")
referencing = pytest.importorskip("referencing")  # jsonschema's $ref resolver
drafts = pytest.importorskip("referencing.jsonschema")

ROOT = Path(__file__).parents[2]
BASE = "https://todofy.local/api/"
DOCUMENT = BASE + "owner-api-v1.openapi.yaml"
SPEC: dict[str, Any] = yaml.safe_load((ROOT / "api" / "owner-api-v1.openapi.yaml").read_text())
SCHEMAS: dict[str, Any] = SPEC["components"]["schemas"]
EXTERNAL = ("summary-v1.schema.json", "recommendation-v1.schema.json", "mail-received-v1.schema.json")

OWNER_PATHS = {
    "/api/v1/csrf",
    "/api/v1/overview",
    "/api/v1/events",
    "/api/v1/events/{event_id}",
    "/api/v1/events/{event_id}/reconcile",
    "/api/v1/reminders",
    "/api/v1/reports/latest",
    "/api/v1/reports/recompute",
    "/api/v1/metrics/daily",
    "/api/v1/legacy_text/{event_id}",
    "/api/v1/setup",
}
MACHINE_SECURITY = {
    "/hooks/mail": [{"mailWebhook": []}],
    "/api/summary": [{"reportBasic": []}],
    "/api/recommendation": [{"reportBasic": []}],
    "/health": [],
}
ACCESS = [{"accessJwt": []}, {"accessCookie": []}]
ACCESS_AND_CSRF = [{**access, "csrfToken": [], "csrfCookie": []} for access in ACCESS]


def registry() -> Any:
    """The document plus the JSON Schemas it references by relative path."""
    resources = [(DOCUMENT, drafts.DRAFT202012.create_resource(SPEC))]
    for name in EXTERNAL:
        resource = drafts.DRAFT202012.create_resource(json.loads((ROOT / "api" / name).read_text()))
        resources += [(BASE + name, resource), (resource.id(), resource)]
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


def test_state_and_action_enums_equal_the_vocabulary():
    assert enum("EventState") == list(EventState)
    assert enum("ReminderState") == list(ReminderState)
    assert enum("ReconcileAction") == list(Reconcile)


@pytest.mark.parametrize(
    ("table", "prefix"), [(EVENT_ERROR_CODES, "Event"), (REMINDER_ERROR_CODES, "Reminder")], ids=["event", "reminder"]
)
def test_error_code_enums_equal_the_vocabulary(table, prefix):
    current, legacy = f"Current{prefix}ErrorCode", f"Legacy{prefix}ErrorCode"
    assert enum(current) == [code for code in table if code in current_codes(table)]
    assert enum(legacy) == [code for code in table if table[code].legacy]
    assert SCHEMAS[legacy]["x-legacy"] is True
    assert "x-legacy" not in SCHEMAS[current]
    assert SCHEMAS[f"{prefix}ErrorCode"]["anyOf"] == [
        {"$ref": f"#/components/schemas/{current}"},
        {"$ref": f"#/components/schemas/{legacy}"},
    ]


def test_api_error_codes_equal_core_and_all_have_ui_text():
    assert enum("ApiErrorCode") == list(ApiError)
    assert list(MESSAGES) == list(ApiError)
    assert all(MESSAGES.values())


def test_transition_actor_matches_the_migration_check():
    migration = (ROOT / "migrations" / "0001_init.sql").read_text()
    actors = re.search(r"CHECK \(actor IN \(([^)]*)\)\)", migration).group(1)
    assert set(enum("TransitionActor")) == set(re.findall(r"'([^']*)'", actors))


def test_overview_counts_are_the_active_states():
    counts = SCHEMAS["Overview"]["properties"]["counts"]
    active = [state for state in EventState if state not in TERMINAL_STATES]
    assert list(counts["properties"]) == counts["required"] == active


def test_paths_are_split_by_host():
    machine_hosts = {"todofy-hooks.ziyixi.science", "daily.ziyixi.science"}
    assert set(SPEC["paths"]) == OWNER_PATHS | set(MACHINE_SECURITY)
    for path, item in SPEC["paths"].items():
        if path in OWNER_PATHS:
            assert "servers" not in item, path
        else:
            (server,) = item["servers"]
            assert set(server["variables"]["hooksHost"]["enum"]) == machine_hosts, path


def test_owner_reads_need_access_and_writes_also_csrf():
    for path, method, operation in operations():
        security = operation.get("security", SPEC["security"])
        if path in OWNER_PATHS:
            assert security == (ACCESS_AND_CSRF if method == "post" else ACCESS), (method, path)
        else:
            assert security == MACHINE_SECURITY[path], (method, path)


def test_newsletter_and_webhook_bodies_use_the_shared_schemas():
    paths = SPEC["paths"]
    assert paths["/api/summary"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "./summary-v1.schema.json"
    }
    assert paths["/api/recommendation"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "./recommendation-v1.schema.json"
    }
    assert paths["/hooks/mail"]["post"]["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "./mail-received-v1.schema.json"
    }


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


@pytest.mark.parametrize(
    "request_body",
    [
        {"action": "task_created", "version": 1, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"},
        {
            "action": "dismiss",
            "version": 1,
            "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11",
            "task_id": "1",
        },
        {"action": "dismiss", "version": 0, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"},
        {
            "action": "dismiss",
            "version": 1,
            "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11",
            "confirmed": True,
        },
    ],
    ids=["task_created_without_task", "task_id_on_dismiss", "version_zero", "unknown_field"],
)
def test_reconcile_request_rejects(request_body):
    assert not validator("ReconcileRequest").is_valid(request_body)
