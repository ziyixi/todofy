# CI/CD

Todofy lives in `todofy/` of a monorepo shared with Mail Hero (`mail-hero/`). One root workflow,
`.github/workflows/ci.yml` ("CI and deploy", described in the root README), runs a `Changes` job, each app's
checks from its own directory, a `Contracts` job for the shared `mail.received.v1` contract, and `CI gate`.
The `Todofy checks` and `Todofy deploy` jobs below run with `working-directory: todofy`. They check and deploy
both Todofy Workers from the same commit: the TypeScript gateway `todofy` (`gateway/`) and the Python
`todofy-core` (`worker/`, root `wrangler.toml`); see [gateway-contract.md](gateway-contract.md). Actions
are pinned by commit SHA. The workflow never prints secret values; the owner's emails are environment
secrets, and GitHub masks them.

## Triggers

| Event | `Todofy checks` | `Todofy deploy` |
|---|---|---|
| push to any branch where `todofy/`, `contracts/` or `.github/` changed since the base | runs | only on `main`, and only when `todofy/` changed since the base |
| push where none of those changed since the base | skipped | no |
| `workflow_dispatch` with app `both` or `todofy` | runs | only when dispatched on `main` |

The base is cumulative, not the previous commit. On `main` it is the commit of the last successful push
run of the workflow on `main`, so a Todofy change whose run failed or was cancelled (even while pending
behind another run) is checked and deployed by the next run, whatever that run touched. On a branch it is
the merge base with `origin/main`, so the branch head's `CI gate` covers every change on the branch. No
usable base (the first run, an API error, a base that is not an ancestor) runs everything.

There are no pull requests. Work happens on a branch (every push runs the checks); `main` is updated by a
fast-forward push of a branch whose head passed:

```sh
git fetch origin && git checkout main && git merge --ff-only origin/<branch> && git push origin main
```

Branch protection on `main` requires the `CI gate` status check (it fails if any check job failed or was
cancelled; a job skipped because its app is unchanged passes). Deploys run in the `production`
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

`needs: [changes, todofy-checks, gate]`, so the exact commit that passed is what ships:

1. install locked dependencies (root, `gateway/`, `web/`) and build the UI from the verified revision
2. `deploy/generate_ci_config.py` writes three owner-only files, removed at the end even on failure:
   `wrangler.production.ci.json` (core: D1, the `BACKUPS` R2 bucket `todofy-backups`, the `METRICS`
   Analytics Engine dataset, the Durable Object migrations, vars; no routes),
   `gateway/wrangler.production.ci.json` (gateway: custom domains, assets, cron, the `COORDINATOR`
   binding to `todofy-core`, the `METRICS` dataset, migrations, vars) and `gateway/wrangler.production.secrets.json` (the
   owner's Access emails, from environment secrets)
3. dry-run both bundles before changing anything
4. `wrangler d1 migrations apply DB --remote`, then `pywrangler deploy` of `todofy-core`
5. `wrangler deploy --secrets-file ...` of the gateway `todofy` (the owner emails become gateway secrets,
   shown as hidden)
6. poll `https://<first hooks host>/health` until it reports this commit (10 × 15 s; the first deploy waits
   for the Custom Domain certificate). The gateway answers `/health` without the Durable Object, so this
   proves the gateway build only.
7. send one `GET /api/summary` with a wrong Basic credential (up to 5 tries, 10 s apart). The gateway
   hands a failed credential to the object's `newsletter_auth_failure()`, which reads and writes D1 and
   answers 401 (or 429 once this hour's 20 failures are spent). Anything else, such as the 503 of a broken
   core, binding or D1, fails the job. The probe spends one of the hour's 20 failure slots and never blocks
   the real credential, which the gateway sends straight to the report. The Access → owner API path is
   not probed (CI has no Access login); open the owner UI once after a deploy that touches it.

Order matters, and it sets three rules:

- Only backward-compatible (additive) D1 migrations may ship: the migration runs before the new core is
  live. The backup restore relies on this too: it loads an older backup into a database with every
  current migration applied ([cloudflare-setup.md](cloudflare-setup.md) §7).
- The core deploys before the gateway, so the object class and every RPC method a new gateway calls
  exist before it goes live. Between the two deploys the previous gateway talks to the new core, so a
  core change must keep serving the previous gateway's calls, and if the gateway deploy fails the new
  core keeps serving the previous gateway. The one exception is the release that moves from the
  internal fetch routes to RPC: its core answers the previous gateway 503 `unavailable` with
  `Retry-After: 60` ([gateway-contract.md](gateway-contract.md) §6.4). If that release's gateway step
  fails, webhooks stay on Mail Hero's retry backoff and the owner UI and newsletter answer 503. Rerun
  the job once (a transient failure). That release carries no Durable Object migration, so it cannot
  hit the 10061 class-delete refusal; if the rerun fails the same way anyway, roll `todofy-core` alone
  back to its previous version (the one exception to the next rule, spelled out in gateway-contract.md
  §6.4), which pairs the previous gateway and core again, and fix forward on `main`.
- Core and gateway roll back only together: revert the commit on `main` and let this workflow redeploy
  both. Never `wrangler rollback` (or roll back in the dashboard) one Worker otherwise: across the RPC
  release an older gateway or core alone cannot talk to the other, and every core-backed route answers
  503. Once the gateway-only class-delete release is live (`todofy` at migration tag `v2`), a revert of
  an older release must keep the gateway tomls' `[[migrations]]` at `v1` + `v2` and must not bring back
  `gateway/src/retired.ts` (gateway-contract.md §6.6).
- A Durable Object class change ships in a release of its own. The retired gateway class
  `TodofyCoordinator` is deleted by a gateway-only release after the RPC release (gateway-contract.md
  §6.6): a deterministic refusal there (error 10061) fails only that release, and a rerun cannot fix
  it; revert that commit instead.

The first deploy of the split replaces the old single Python Worker `todofy`; its one-time owner steps
(the core's API keys before the merge, removing them from `todofy` after) and the rollback runbook are in
[cloudflare-setup.md](cloudflare-setup.md) §4.

## Changing a switch

Operational switches (`TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST`,
`TODOFY_REMINDER_ENABLED`) and every other setting are GitHub environment variables, so a deploy never
overwrites the operational state:

1. Settings → Environments → `production` → edit the variable.
2. Actions → "CI and deploy" → Run workflow → branch `main`, app `todofy`.
3. The run re-checks and redeploys the current `main` with the new value (the checks take about 10
   minutes, then the deploy).

`TODOFY_MAINTENANCE_MODE` reaches both Workers in the same run: the gateway refuses webhook and owner
writes first, and the core stops its own work. The other three switches are core-only.

Do not change vars in the Cloudflare dashboard or with `wrangler`: the next deploy replaces them, on
either Worker. Worker secrets set with `wrangler secret put` are kept across deploys.
