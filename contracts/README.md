# Cross-app contracts

The only files `mail-hero/` and `todofy/` share. Neither app imports the other; both read these files.

## `mail-received-v1/`

The webhook Mail Hero POSTs to its consumer. Mail Hero owns it.

| File | Purpose |
| --- | --- |
| `mail-received-v1.md` | Semantics: identity, retries, delivery status, content limits (Chinese) |
| `mail-received-v1.schema.json` | The single JSON Schema. Todofy's OpenAPI (`todofy/api/owner-api-v1.openapi.yaml`) and tests reference it by relative path; there is no copy |
| `fixtures/*.json` | Golden webhook bodies, exact bytes, written by Mail Hero's real `parseMail` + `buildPayload` from synthetic mail (`mail-hero/cloudflare/test/contract-fixtures.mjs`) |
| `fixtures/legacy/*.json` | Frozen bodies from older builders. Retries resend frozen bytes, so consumers keep accepting them; nothing regenerates them |

Checks, all run by the `Contracts` CI job (and by each app's own tests):

- Mail Hero, `mail-hero/cloudflare`: `node --test test/contract-fixtures.test.mjs` rebuilds every case and fails if a fixture differs by one byte, or if a fixture has no case.
- Todofy, `todofy`: `uv run pytest tests/unit/test_mail_hero_compat.py` validates every fixture (current and legacy) against the schema and parses and renders it with `todofy.core.contract.parse_mail_event`; `tests/runtime/test_scenarios_webhook.py` posts each one to a real workerd gateway.

Changing the builder on purpose: in `mail-hero/cloudflare` run `npm run contract:update`, review the fixture diff, run Todofy's tests, and commit both in the same change. An incompatible change then fails `Contracts` before it can merge. The fixture files have no trailing newline; `.gitattributes` keeps git from rewriting them.
