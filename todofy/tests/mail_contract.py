"""The shared ``mail.received.v1`` contract, kept in the monorepo's ``contracts/`` directory.

Mail Hero owns the schema and writes ``fixtures/*.json`` with its real payload builder
(``mail-hero/cloudflare/test/contract-fixtures.mjs``); ``fixtures/legacy`` holds frozen bytes
from older builders that retries still resend. Todofy only reads these files: it never imports
Mail Hero code.
"""

from pathlib import Path
from urllib.parse import urljoin

TODOFY = Path(__file__).resolve().parents[1]
CONTRACT = TODOFY.parent / "contracts" / "mail-received-v1"
SCHEMA = CONTRACT / "mail-received-v1.schema.json"
# How api/machine-api-v1.openapi.yaml references the schema, relative to the api/ directory.
SCHEMA_REF = "../../contracts/mail-received-v1/mail-received-v1.schema.json"


def fixtures() -> dict[str, Path]:
    """Every event shape Mail Hero emits or once emitted, by name."""
    paths = [*(CONTRACT / "fixtures").glob("*.json"), *(CONTRACT / "fixtures" / "legacy").glob("*.json")]
    named = {path.stem: path for path in paths}
    assert len(named) == len(paths), "a legacy fixture must not reuse a current fixture's name"
    return dict(sorted(named.items()))


def api_schemas(base: str) -> dict[str, Path]:
    """The JSON Schemas the OpenAPI document at ``base`` references, by resolved URL."""
    local = {name: TODOFY / "api" / name for name in ("summary-v1.schema.json", "recommendation-v1.schema.json")}
    return {urljoin(base, ref): path for ref, path in {**local, SCHEMA_REF: SCHEMA}.items()}
