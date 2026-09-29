"""Helpers for the owner API runtime tests (tests/runtime/test_owner_*.py).

Responses are checked against api/owner-api-v1.openapi.yaml: the schema for a
status is looked up from the operation itself, so a test cannot pick a looser
schema than the contract promises.
"""

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from typing import Any

import httpx
import jsonschema
import referencing
import referencing.jsonschema
import yaml

from tests.runtime.harness import OWNER, PUBLIC_HOST, Worker

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://todofy.local/api/"
DOCUMENT = BASE + "owner-api-v1.openapi.yaml"
SPEC: dict[str, Any] = yaml.safe_load((ROOT / "api" / "owner-api-v1.openapi.yaml").read_text())
EXTERNAL = ("summary-v1.schema.json", "recommendation-v1.schema.json", "mail-received-v1.schema.json")

CSRF_KEY = "5c" * 32
ORIGIN = f"http://{PUBLIC_HOST}"
PRIVATE_HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}


def _registry() -> referencing.Registry:
    draft = referencing.jsonschema.DRAFT202012
    resources = [(DOCUMENT, draft.create_resource(SPEC))]
    for name in EXTERNAL:
        resource = draft.create_resource(json.loads((ROOT / "api" / name).read_text()))
        resources += [(BASE + name, resource), (resource.id(), resource)]
    return referencing.Registry().with_resources(resources)


REGISTRY = _registry()


def _pointer(*parts: str) -> str:
    return "/".join(part.replace("~", "~0").replace("/", "~1") for part in parts)


def assert_contract(response: httpx.Response, path: str, method: str = "get") -> Any:
    """Assert the status is documented for the operation and the body matches its schema."""
    responses = SPEC["paths"][path][method]["responses"]
    status = str(response.status_code)
    assert status in responses, f"{method.upper()} {path} does not document {status}: {response.text}"
    pointer = f"#/{_pointer('paths', path, method, 'responses', status)}"
    documented = responses[status]
    if "$ref" in documented:
        pointer = documented["$ref"]
        documented = SPEC["components"]["responses"][pointer.rsplit("/", 1)[1]]
    body = response.json()
    if "content" in documented:
        schema = {"$ref": f"{DOCUMENT}{pointer}/content/application~1json/schema"}
        validator = jsonschema.Draft202012Validator(schema, registry=REGISTRY)
        errors = [f"{list(error.absolute_path)}: {error.message}" for error in validator.iter_errors(body)]
        assert errors == [], (method, path, status, body)
    return body


def assert_private(response: httpx.Response) -> None:
    for name, value in PRIVATE_HEADERS.items():
        assert response.headers.get(name) == value, (name, response.headers)
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def error_code(response: httpx.Response) -> str:
    return response.json()["error"]["code"]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def mint_csrf(key: str = CSRF_KEY, **overrides: Any) -> str:
    """A token in the Worker's format, for cases the Worker itself would never issue."""
    claims = {"kind": "csrf", "owner": OWNER, "nonce": "test", "exp": int(time.time()) + 600} | overrides
    payload = _b64(json.dumps(claims).encode())
    signature = _b64(hmac.new(bytes.fromhex(key), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def token_claims(token: str) -> dict[str, Any]:
    payload = token.split(".")[0]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def csrf_headers(token: str, origin: str = ORIGIN) -> dict[str, str]:
    return {"origin": origin, "x-csrf-token": token, "cookie": f"todofy_csrf={token}"}


def issue_csrf(client: httpx.Client, headers: dict[str, str] | None = None) -> dict[str, str]:
    """GET /api/v1/csrf and return the headers a same-origin browser POST would carry."""
    response = client.get("/api/v1/csrf", headers=headers or {})
    assert response.status_code == 200, response.text
    # Tests send the cookie explicitly; the client's jar would add it behind their back.
    client.cookies.clear()
    token = response.json()["token"]
    return csrf_headers(token) | (headers or {})


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def insert(table: str, rows: list[dict[str, Any]]) -> str:
    """One multi-row INSERT for Worker.d1 (each wrangler call takes about a second)."""
    columns = list(rows[0])
    values = ", ".join("(" + ", ".join(sql_literal(row[column]) for column in columns) + ")" for row in rows)
    return f"INSERT INTO {table} ({', '.join(columns)}) VALUES {values}"


def event_row(event_id: str, state: str, created_at: int, **columns: Any) -> dict[str, Any]:
    terminal = state in {"complete", "ignored"}
    return {
        "source_id": "mail-hero-personal",
        "event_id": event_id,
        "payload_hash": "0" * 64,
        "payload": None if terminal else "{}",
        "state": state,
        "version": 1,
        "task_id": "",
        "attempt_count": 0,
        "next_attempt_at": 0,
        "last_error_code": "",
        "imported": 0,
        "created_at": created_at,
        "updated_at": created_at,
    } | columns


def seed(worker: Worker, table: str, rows: list[dict[str, Any]]) -> None:
    worker.d1(insert(table, rows))
