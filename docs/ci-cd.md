# CI/CD

One workflow, `.github/workflows/native.yml` ("Todofy CI and deploy"), with two jobs. It checks and deploys
both Workers from the same commit: the TypeScript gateway `todofy` (`gateway/`) and the Python
`todofy-core` (`worker/`, root `wrangler.toml`); see [gateway-contract.md](gateway-contract.md). Actions
are pinned by commit SHA. The workflow never prints secret values; the owner's emails are environment
secrets, and GitHub masks them.

## Triggers

| Event | `Todofy checks` | `Todofy deploy` |
|---|---|---|
| push to any branch | runs | only on `main` |
| `workflow_dispatch` | runs | only when dispatched on `main` |

There are no pull requests. Work happens on a branch (every push runs the checks); `main` is updated by a
fast-forward push of a branch whose head passed:

```sh
git fetch origin && git checkout main && git merge --ff-only origin/<branch> && git push origin main
```

Branch protection on `main` requires the `Todofy checks` status check. Deploys run in the `production`
environment (deployment branch `main` only) and never in parallel (`todofy-production` concurrency group).

## `Todofy checks`

The same sequence as local development:

1. `npm ci`, `uv sync --locked`
2. `ruff check` and `ruff format --check` over `worker tests tools deploy`
3. host tests: `pytest tests/unit tests/fakes tools deploy` (includes a local D1 round trip of the legacy
   migration)
4. gateway (`gateway/`): `npm ci`, `lint`, `typecheck`, `test`
5. UI: `npm ci`, `check:api` (generated types match the OpenAPI), `typecheck`, `test`, `build`, and a grep
   that no UI source names the other repository
6. runtime tests: `pytest tests/runtime` against real workerd; every test server runs the gateway and
   `todofy-core` in one process, with D1, the Durable Object, alarms, cron and assets
7. placeholder production configs for both Workers are generated and dry-run, the gateway's with
   `--secrets-file` (no token needed)

## `Todofy deploy`

`needs: checks`, so the exact commit that passed is what ships:

1. install locked dependencies (root, `gateway/`, `web/`) and build the UI from the verified revision
2. `deploy/generate_ci_config.py` writes three owner-only files, removed at the end even on failure:
   `wrangler.production.ci.json` (core: D1, the Durable Object migration, vars; no routes),
   `gateway/wrangler.production.ci.json` (gateway: custom domains, assets, cron, the `COORDINATOR`
   binding to `todofy-core`, migrations, vars) and `gateway/wrangler.production.secrets.json` (the
   owner's Access emails, from environment secrets)
3. dry-run both bundles before changing anything
4. `wrangler d1 migrations apply DB --remote`, then `pywrangler deploy` of `todofy-core`
5. `wrangler deploy --secrets-file ...` of the gateway `todofy` (the owner emails become gateway secrets,
   shown as hidden)
6. poll `https://<first hooks host>/health` until it reports this commit (10 × 15 s; the first deploy waits
   for the Custom Domain certificate). The gateway answers `/health` without the Durable Object, so this
   proves the gateway build only.
7. send one `GET /api/summary` with a wrong Basic credential (up to 5 tries, 10 s apart). The gateway
   hands a failed credential to the object's `/newsletter/auth-failure`, which reads and writes D1 and
   answers 401 (or 429 once this hour's 20 failures are spent). Anything else, such as the 503 of a broken
   core, binding or D1, fails the job. The probe spends one of the hour's 20 failure slots and never blocks
   the real credential, which the gateway sends straight to the report. The Access → owner API path is
   not probed (CI has no Access login); open the owner UI once after a deploy that touches it.

Order matters, and it sets two compatibility rules:

- Only backward-compatible D1 migrations may ship: the migration runs before the new core is live.
- The core deploys before the gateway, so the object class and every internal route a new gateway calls
  exist before it goes live. Between the two deploys the previous gateway talks to the new core, so a
  core change must keep serving the previous gateway's requests. If the gateway deploy fails, the new
  core keeps serving the previous gateway.

The first deploy of the split replaces the old single Python Worker `todofy`; its one-time owner steps
(the core's API keys before the merge, removing them from `todofy` after) and the rollback runbook are in
[cloudflare-setup.md](cloudflare-setup.md) §4.

## Changing a switch

Operational switches (`TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST`,
`TODOFY_REMINDER_ENABLED`) and every other setting are GitHub environment variables, so a deploy never
overwrites the operational state:

1. Settings → Environments → `production` → edit the variable.
2. Actions → "Todofy CI and deploy" → Run workflow → branch `main`.
3. The run re-checks and redeploys the current `main` with the new value (the checks take about 10
   minutes, then the deploy).

`TODOFY_MAINTENANCE_MODE` reaches both Workers in the same run: the gateway refuses webhook and owner
writes first, and the core stops its own work. The other three switches are core-only.

Do not change vars in the Cloudflare dashboard or with `wrangler`: the next deploy replaces them, on
either Worker. Worker secrets set with `wrangler secret put` are kept across deploys.
