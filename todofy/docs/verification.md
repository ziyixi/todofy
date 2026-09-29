# Verification

Only what actually ran is recorded here, with the date and where. "Pending" means not done yet; nothing
in a pending section may be read as passed.

## Local suites (2026-09-29, macOS, clean copy of branch `cf-rewrite` plus uncommitted finisher changes)

The `Todofy checks` sequence was run from a copy holding only tracked and new source files (no
`node_modules`, `.venv`, `python_modules`, `uiassets/dist` or `.wrangler`):

| Step | Result |
|---|---|
| `npm ci`, `uv sync --locked` | ok |
| `ruff check worker tests tools deploy` | all checks passed |
| `ruff format --check worker tests tools deploy` | 110 files already formatted |
| `pytest tests/unit tests/fakes tools deploy` | 646 passed, 1 skipped (the proto cross-check needs the sibling `protos` checkout) |
| `web`: `npm ci`, `check:api`, `typecheck`, `test`, `build`, source guard | generated types match; 8 files, 61 tests passed; build ok; guard ok |
| `pytest tests/runtime` (workerd, real D1, Durable Object, alarms, cron, assets) | 326 passed in 8 min 16 s |
| placeholder production config + `pywrangler deploy --dry-run --secrets-file ...` | generated; `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` shown as `(hidden)`; workers SDK vendored in the bundle |

Also run on system Python 3.9.6 (the mini-PC's class of interpreter), synthetic data only:
`tools/legacy_migration/snapshot.py` on a WAL-mode inbox with an un-checkpointed commit kept the
committed change (a plain copy of the main file did not), and `legacy_to_d1.py` exported the snapshot
(47 summaries, 46 texts, CloudMailin rows included by default).

Limits of these runs: workerd does not enforce or report CPU time locally, so Workers Free CPU limits
(10 ms per Worker request, 30 s per Durable Object invocation) are not proven here; production CPU comes
from Workers Logs. Cloudflare Access, Custom Domains, TLS and D1 remote behaviour are not exercised.

## Production

| Check | Status |
|---|---|
| D1 created, Access app, GitHub `production` environment | pending (record here when verified) |
| First deploy from `main`: `/health` reports the commit on the hooks host; UI host 401 without Access | pending |
| Worker secrets set; webhook smoke test (`tools/smoke_webhook.py`: 401/415/413/400/204/204/409) | pending |
| Owner login through Access (primary email and GitHub-login alias) and a UI reconcile | pending |
| Mail Hero test event → `complete` with a Todoist task | pending |
| Cutover: snapshot, export, import, `verify_d1.py` PASS | pending |
| Newsletter: `/api/summary` and `/api/recommendation?top=10` return 200 | pending |
| First real mail end to end | pending |
| One-week usage check (Workers, DO, D1 reads/writes against the shared Free allowance) | pending |
