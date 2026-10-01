# CI/CD

Todofy lives in `todofy/` of a monorepo shared with Mail Hero (`mail-hero/`). One root workflow,
`.github/workflows/ci.yml` ("CI and deploy", described in the root README), runs a `Changes` job, each app's
checks from its own directory, a `Shared packages` job for `packages/*` (each package's own typecheck and
tests), a `Contracts` job for the shared contracts (`mail.received.v1` and
`ops-v1`), and `CI gate`. For Todofy, `Contracts` runs `tests/unit/test_mail_hero_compat.py` (every
fixture, the canary one included), `test_contract.py`, `test_openapi_vocab.py`, `test_ops_contract.py`
(ops-v1 fixtures with `jsonschema`), `test_ops_core.py` (the core's ops values against the schema) and the
gateway's `test/ops.test.ts` (which also covers the task-intent-v1 methods); the workerd suites
`tests/runtime/test_ops.py` and `tests/runtime/test_task_intents.py` run in the `Todofy runtime` shards.
task-intent-v1's Python side (`tests/unit/test_task_intent_contract.py`: fixtures with `jsonschema`, the
generated types and the wire JSON codec against the schema on every fixture, the core's input checks
against the schema's verdicts, the generated enums and the `task-intent-v1.ts` constants, every result) runs
with the host tests in `Todofy static checks` and again in `Contracts`, next to Lab's proposer checks.
The Todofy check jobs and `Todofy deploy` below run with `working-directory: todofy`. They check and deploy
both Todofy Workers from the same commit: the TypeScript gateway `todofy` (`gateway/`) and the Python
`todofy-core` (`worker/`, root `wrangler.toml`); see [gateway-contract.md](gateway-contract.md). Both
production configs are committed, top level = production: `wrangler.toml` (todofy-core; pywrangler needs
this exact name) and `gateway/wrangler.toml` (the gateway). Nothing is generated. Actions
are pinned by commit SHA. The gateway compiles in the shared auth package `packages/edge-auth` (a
`file:` dependency, never a Worker of its own), so a change there checks and deploys Todofy as well as
Mail Hero. The workflow never prints secret values; the owner's emails are environment
secrets, and GitHub masks them.

## Triggers

| Event | Todofy checks (all three jobs) | `Todofy deploy` |
|---|---|---|
| push to any branch where `todofy/`, `packages/edge-auth/`, `contracts/` or `.github/` changed since the base | runs | only on `main`, and only when `todofy/`, `packages/edge-auth/` or `contracts/ops-v1/ops-v1.ts` (bundled into the gateway) changed since the base |
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

## Todofy checks: three jobs

Todofy's checks run as three jobs. Every change that checks Todofy runs all of them: the same condition
(`todofy_check`) starts both check jobs, and `Todofy checks` runs whenever that condition holds. It
runs even when a job it needs failed, but never when the run was cancelled.

### `Todofy static checks`

The same sequence as local development:

1. `npm ci`, `uv sync --locked`
2. `ruff check` and `ruff format --check` over `worker tests tools deploy`
3. host tests: `pytest tests/unit tests/fakes tools deploy` (includes a local D1 round trip of the legacy
   migration)
4. gateway (`gateway/`): `npm ci`, `lint`, `typecheck`, `test`
5. UI: `npm ci`, `check:api` (generated types match the OpenAPI), `typecheck`, `test`, `build`, and a grep
   that no UI source names the other repository
6. placeholder production configs for both Workers are generated and dry-run, the gateway's with
   `--secrets-file` (no token needed)

### `Todofy runtime (1/3)`, `(2/3)`, `(3/3)`

The workerd suite `tests/runtime` runs as a matrix of three shards at the same time. Every test server
runs the gateway and `todofy-core` in one process, with D1, the Durable Object, alarms, cron and assets.
Each shard runs these steps:

1. `npm ci` (root, `gateway/`, `web/`), `uv sync --locked`, and the UI build the tests serve (without it
   the harness would serve a placeholder page).
2. Restore the Pyodide bundle cache, then `python -m tests.runtime.warm_up`. The warm-up runs
   `pywrangler sync` once and starts and stops one test server through the harness, so the ~14 MB
   Pyodide bundle is in the harness's disk cache before any test starts. It tries up to 3 times, fails
   if the launcher did not cache the bundle, and runs no test.
3. Plan the shard: `pytest tests/runtime --collect-only -q` lists every test id, and
   `.github/scripts/pytest_shards.py --workers 4 --index <job-index> --total <job-total>` prints this
   shard's files.
   - The unit is always a whole file, never a test.
   - Files are balanced by the recorded seconds per file in `.github/scripts/todofy-runtime-durations.json`,
     longest first, over all 12 processes (3 shards × 4). A file with no recorded time weighs the mean,
     so a new file is always planned.
   - The files in `.github/scripts/todofy-runtime-serial.txt` stay out of the processes: each goes to
     the shard with the least work, which runs it alone after its xdist run (step 4). Today that is
     `tests/runtime/test_alarm.py` (see "Files that run alone" below).
   - The planner refuses an empty shard, a serial file that pytest did not collect, or a plan that does
     not cover every file exactly once.
4. `pytest -n 4 --dist loadfile --no-loadscope-reorder <files>`: four pytest-xdist processes on the
   runner's 4 vCPUs.
   - xdist hands each process whole files, heaviest first, and a file's tests run in file order.
     Some tests rely on the ones before them in the same file; the rootdir `conftest.py` refuses any
     other distribution (`--dist load`, `worksteal`, `loadgroup`, `each`, `loadscope`), however pytest
     reaches `tests/runtime`.
   - Each process takes its ports from its own range below the Linux ephemeral range
     (`tests/runtime/harness.py`).
   - No `-k`, `-m`, `--deselect`, retry or rerun plugin (`test_ci_changes.py` checks the command and
     `uv.lock`).
   - Then, if the shard has serial files, one plain pytest process runs them, with no other test server
     on the runner, into `runtime-<index>-serial.xml`. Both runs always run, and either failing fails
     the step.
5. Upload the shard's JUnit XML (`todofy-runtime-junit-<index>`), plus every server's `dev.log` if the
   shard failed.

#### Files that run alone

`test_alarm.py::test_timeout_really_closes_a_hanging_upstream_connection` checks that the Gemini fake
receives the fallback model's call at least 1.5 s (`GEMINI_TIMEOUT_MS`) after the hung call. workerd
arms `AbortSignal.timeout` on the isolate's clock, which does not advance while Pyodide builds the
request, so the gap the fake sees is 1.5 s plus or minus the Worker's own CPU time around the two
calls. The fake stamps each request within 1 ms of its arrival (measured from accept to body), so the
margin is all on the Worker side. Measured on the laptop, 12 runs each:

| Conditions | Gap | Failures |
| --- | --- | ---: |
| alone, idle | 1.5008–1.5100 s | 0 |
| alone, with 14 busy processes on 10 cores | 1.4968–1.5060 s | 6 |

The review also saw it fail once in 8 full `-n 3`–`-n 8` runs, and 2 of 6 serial runs of the old
`pywrangler dev` harness. The 1.5 s bound stays, and the file runs alone, as the whole suite did before
the split. Adding a file to `todofy-runtime-serial.txt` needs a measured reason.

The serial suite took 17–18 minutes on the runner. Each shard is expected to take about 4 minutes of
setup and tests, but that has not been measured on GitHub yet (see "Speed" below).

### `Todofy checks`

The result `Todofy deploy` needs, and the status check [cloudflare-setup.md](cloudflare-setup.md)
requires. The job is named as before, so that setting is unchanged. It passes only when both of the
following hold:

- `Todofy static checks` and the `Todofy runtime` matrix both succeeded; a failed, skipped or
  cancelled one fails it.
- `.github/scripts/pytest_completeness.py` accepts the shards' JUnit files. The script checks them
  against `pytest tests/runtime --collect-only -q`, run again on the same commit, and fails unless:
  - there is one xdist JUnit file per shard (`--shards 3`, which `test_ci_changes.py` keeps equal to
    the matrix), at most one serial file per shard, and nothing else;
  - the collection is clean: no collection error, no module skipped as a whole
    (`pytest.skip(allow_module_level=True)`, `importorskip`), and every `test_*.py` under
    `tests/runtime` has at least one collected id (`--test-root`), so no file can drop out of the plan;
  - every collected id ran exactly once, and nothing else ran;
  - no test failed or errored, and no collection error occurred;
  - the tests of `todofy-runtime-serial.txt` ran only in serial runs, and serial runs ran nothing else;
  - the skipped tests are exactly `.github/scripts/todofy-runtime-expected-skips.txt`. That list is the
    serial baseline's skips, and it is empty.

  The script also writes each file's measured seconds to the step summary. Copy them into
  `todofy-runtime-durations.json` when the shards drift out of balance. The weights only change the
  balance, never what runs.

`CI gate` needs all three jobs, and so does `Todofy deploy`.

### Speed

Measured on the Apple-silicon laptop that profiled the suite (10 cores):

| Runtime suite | Wall time |
| --- | ---: |
| serial, before this change (`pywrangler dev`, a D1 migration per server) | 794 s |
| serial, now | 590–594 s |
| `-n 4`, all files in one run, heaviest first | 160–162 s (3 runs); 208 s (2 runs) with another test run alongside |
| each of the three shards, `-n 4`, as CI runs it (3 runs) | 99–101 s, 61–63 s, 82–84 s |
| the same with `test_alarm.py` alone after shard 3's xdist run (clean clone) | 98 s, 61 s, 83 s + 8 s |

The harness changes that do not change what any test asserts:

| Change | Saving (laptop) |
| --- | --- |
| Start `node_modules/.bin/wrangler dev` directly. `pywrangler dev` runs `pywrangler sync` and `npx wrangler --version` on every start and then runs the same `npx wrangler dev`; the harness runs `pywrangler sync` once per process instead. | 1.19 s per server start (3.61 → 2.42 s), about 90 s per serial run |
| Migrate an empty persist directory once per process and database, into a template, and copy it for each new server. A directory that already has state is still migrated in place. `test_migrations.py` still checks every applied migration. | 1.33 s → 3 ms per new server, about 80 s per serial run |
| `test_backup.py` reads the nine backed-up tables with one `wrangler d1 execute` instead of one per table, once per database (the same statements, one result each). | about 15 s of the longest test |

On CI, the serial suite was 1029–1091 s of a 17.6–19.2 minute job. The runtime critical path is now the
slowest shard: setup plus its share of the suite. The floor is `test_backup.py`, a single test: 85 s on
the laptop now (102 s before), and about 150 s on the runner before these changes. The runner was
1.4–1.6× slower than the laptop, which puts the slowest shard at roughly 2.5 minutes of tests plus
about a minute of setup. Confirm this on real runners before relying on it.

The fixed sleeps stay. Each one either proves that nothing more happens within a timer (no second
reminder, no resend) or waits for a real-clock boundary. No event marks the end of such a wait without
a new production-code seam, so none of them can become event-driven.

## `Todofy deploy`

`needs: [changes, todofy-static, todofy-runtime, todofy-checks, gate]`, each required to succeed, so the exact commit
that passed is what ships:

1. install locked dependencies (root, `gateway/`, `web/`) and build the UI from the verified revision
2. read the hosts from the committed `gateway/wrangler.toml` (the environment URL and the probes below)
3. "Write the Worker secrets files", the only step that reads the personal environment secrets:
   `deploy/deploy_vars.py secrets core` writes the core's owner-only secrets file (the Todoist projects) and
   `secrets gateway` the gateway's (the owner's Access emails), both in `$RUNNER_TEMP`, removed at the end
   even on failure; then dry-run both bundles before changing anything
4. `wrangler d1 migrations apply DB --remote --config wrangler.toml`, then
   `deploy_vars.py exec core -- pywrangler deploy --config wrangler.toml --secrets-file ...` of `todofy-core`
   (the projects become core secrets, shown as hidden)
5. `deploy_vars.py exec gateway -- wrangler deploy --config gateway/wrangler.toml --secrets-file ...` of the
   gateway `todofy` (the owner emails become gateway secrets, shown as hidden)

   `deploy/deploy_vars.py` adds what is never committed and refuses a missing or invalid value, because a
   deploy without a var deletes it. With `--var`: `BUILD_SHA` (the commit) and `MAINTENANCE_MODE` on both
   Workers; `REMINDER_ENABLED`, `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST` and `GTD_REVIEW_ENABLED` on the
   core. With `--secrets-file`, as Worker secrets (wrangler and the Cloudflare dashboard show a plain var's
   value, and pywrangler echoes its command line): `TODOIST_DEFAULT_PROJECT_ID` (required),
   `TODOIST_OPS_PROJECT_ID` and `TODOIST_REVIEW_PROJECT_ID` (optional) on the core; `ACCESS_OWNER` and
   `ACCESS_OWNER_ALIASES` on the gateway. A deploy keeps every secret it does not upload, so an unset
   optional project (or an empty alias list) is uploaded as one space, which the Worker reads as unset;
   leaving it out would keep the previous project. `exec` refuses a deploy without exactly one valid
   secrets file of that Worker, `--env`, `--keep-vars`, its caller's own `--var` and any other config file.
   The static checks the retired generator made are unit tests on the committed files
   (`deploy/test_wrangler_configs.py`); the checks across apps and ci.yml are in the root
   `.github/scripts/test_wrangler_configs.py`.

   Until 2026-10 the three projects were plain_text vars. The first deploy of this version replaces each
   by a secret of the same name in the same upload (the upload carries the whole binding list with
   `keep_bindings` secret_text/secret_key, so the plain_text bindings are dropped with no moment without
   the values; Mail Hero's receive address and owner addresses moved the same way). Never move them with
   `wrangler secret put` or `secret bulk`: those are separate deployments next to the var of the same name.
   Rolling this change back (a revert) sends the projects as `--var` again next to the secrets of the same
   name; that direction is not verified in production. If Cloudflare refuses that deploy, delete the three
   secrets (`npx wrangler secret delete <NAME> --config wrangler.toml`, from `todofy/`) and rerun the
   workflow at once (between the two, new tasks have no project and go to the Todoist inbox).
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
`TODOFY_REMINDER_ENABLED`, `TODOFY_GTD_REVIEW_ENABLED`) are the only GitHub environment variables the deploy
reads, so a deploy never
overwrites the operational state:

1. Settings → Environments → `production` → edit the variable.
2. Actions → "CI and deploy" → Run workflow → branch `main`, app `todofy`.
3. The run re-checks and redeploys the current `main` with the new value (the checks take a few
   minutes, then the deploy).

`TODOFY_MAINTENANCE_MODE` reaches both Workers in the same run: the gateway refuses webhook and owner
writes first, and the core stops its own work. The other three switches are core-only.

Every other setting (account, D1, hosts, Access, models, limits, schedules) is committed in `wrangler.toml`
or `gateway/wrangler.toml`: change it with a commit, which is checked and deployed like code.

Do not change vars in the Cloudflare dashboard or with `wrangler`: the next deploy replaces them, on
either Worker. Never run a plain `wrangler deploy` or `pywrangler deploy` of these configs either: it
deletes the injected vars (the switches read as false, the maintenance mode lifts). Worker secrets set with
`wrangler secret put` are kept across deploys.
