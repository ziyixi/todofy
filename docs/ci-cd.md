# CI/CD

One workflow, `.github/workflows/native.yml` ("Todofy CI and deploy"), with two jobs. Actions are pinned
by commit SHA. The workflow never prints secret values; the owner's emails are environment secrets, and
GitHub masks them.

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
4. UI: `npm ci`, `check:api` (generated types match the OpenAPI), `typecheck`, `test`, `build`, and a grep
   that no UI source names the other repository
5. runtime tests: `pytest tests/runtime` against real workerd with D1, the Durable Object, alarms, cron
   and assets
6. a placeholder production config is generated and dry-run with `--secrets-file` (no token needed)

## `Todofy deploy`

`needs: checks`, so the exact commit that passed is what ships:

1. build the UI from the verified revision
2. `deploy/generate_ci_config.py` writes `wrangler.production.ci.json` (vars, routes, D1, from
   environment variables) and `wrangler.production.secrets.json` (the owner's Access emails, from
   environment secrets); both are owner-only and removed at the end even on failure
3. dry-run the bundle before changing anything
4. `wrangler d1 migrations apply DB --remote`, then `pywrangler deploy --secrets-file ...` (the owner
   emails become Worker secrets, shown as hidden)
5. poll `https://<first hooks host>/health` until it reports this commit (10 × 15 s; the first deploy waits
   for the Custom Domain certificate)

Only backward-compatible D1 migrations may ship: the migration runs before the new Worker is live.

## Changing a switch

Operational switches (`TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST`,
`TODOFY_REMINDER_ENABLED`) and every other setting are GitHub environment variables, so a deploy never
overwrites the operational state:

1. Settings → Environments → `production` → edit the variable.
2. Actions → "Todofy CI and deploy" → Run workflow → branch `main`.
3. The run re-checks and redeploys the current `main` with the new value (the checks take about 10
   minutes, then the deploy).

Do not change vars in the Cloudflare dashboard or with `wrangler`: the next deploy replaces them. Worker
secrets set with `wrangler secret put` are kept across deploys.
