# CI and releases

This is the detailed release reference moved from the root README. Start with
[HANDOFF](../HANDOFF.md) for work in flight and [architecture](architecture.md) for service boundaries.
The workflow and [.github/scripts/ci_changes.py](../.github/scripts/ci_changes.py) are the executable source
of job names, dependencies and reachability; do not maintain a second deployment map here.

## Before a release

- The owner must have authorised the publication/deployment in the task. A design request is not permission to deploy.
- Push a branch, let its full `CI gate` pass, and merge that exact green SHA. A newer pending run is not green.
- Rebase means a new SHA: re-run every affected check. A green branch run may be reused only for that same SHA.
- `main` deploys only the affected applications from its cumulative successful-release base. PR checks use no production secrets.
- Use the `production` environment only for authorised `main` releases; scope each app's secrets and concurrency group. Shared-code changes deploy only their consumers.
- Update HANDOFF with the merge order, the evidence obtained and the post-deploy checks still outstanding.

## CI and deploy jobs

The [service catalog](service-catalog.md) supplies `catalog.apps`, from which `ci_changes.py` derives `APPS`:
nine applications, eight Cloudflare applications plus the VPS Newsletter. Do not add a parallel handwritten
application list. Shared-code deployment reachability still follows actual consumers and the checked maps.

A direct `<app>/app.toml` change checks the application and the catalog but does not deploy the application:
the manifest itself is not bundled. Commit its regenerated outputs in the same change. If the generated Home
registry source changes, that ordinary `dashboard/` source change checks and deploys Home; metadata-only
changes do not secretly update a VPS, Worker, Access policy or database.


[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) ("CI and deploy") runs on a push to any branch and on
a manual run. Actions are pinned by commit SHA.

[`.github/workflows/infra.yml`](../.github/workflows/infra.yml) ("Infra drift") is separate: on `main` only
(a push that changes `infra/`, daily, or a manual run), in the `production` environment and the
`infra-production` concurrency group, it plans `infra/` against its encrypted remote state and fails on any
planned action or on an output (Access AUD, D1 id, bucket) that differs from an app's `wrangler.toml`. Its log holds
only the redacted summary; it applies nothing and is not part of `CI gate` ([`infra/README.md`](../infra/README.md)
"Drift plan"). [`.github/workflows/infra-apply.yml`](../.github/workflows/infra-apply.yml) ("Infra apply") is the only
writer: a manual dispatch on `main`, same environment and concurrency group, which copies the encrypted state, plans,
refuses unless the plan passes its gates (including the exact reviewed actions and plan fingerprint) and applies
exactly that saved plan
([`infra/README.md`](../infra/README.md) "Apply").

| Job | Runs when | Does |
| --- | --- | --- |
| `Changes` | always | Runs every `.github/scripts` test (including [`test_wrangler_configs.py`](../.github/scripts/test_wrangler_configs.py), the checks across the apps' Wrangler configs and this workflow, which needs Python 3.11+: locally `uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts`, since an older `python3` skips it), then [`.github/scripts/ci_changes.py`](../.github/scripts/ci_changes.py): `git diff --name-only` from a cumulative base to the pushed commit. On `main` the base is the commit of the last successful push run of this workflow on `main` (read with the job's `actions: read` token), so changes from a failed or cancelled run, including one cancelled while pending, are checked and deployed by the next run. On other branches the base is `git merge-base origin/main HEAD`, so the head commit's gate covers the whole branch. No usable base (first run, API error, base not an ancestor) runs everything. The base is also an output (`base`, empty when everything runs), which `Proto checks` compares the IDL with. A push to `main` then looks for a green branch push run of the same commit (same workflow, `head_sha`, a non-`main` branch, concluded success) whose `Changes`, `CI gate` and every check job this push needs succeeded (`CHECK_JOBS`; a matrix counts only when all its shards succeeded): if one exists, every check output is false, `checks_reused` names that run, and the deploy outputs and the last-successful-`main` base are unchanged. The same commit is the same tree and the same workflow, and no check job uses a secret (`test_wrangler_configs.py` fails if a job before the deploys reads a secret, runs in an environment, runs `wrangler deploy` without `--dry-run` or calls wrangler with `--remote`). Any doubt (no such run, a needed check it skipped, an API error, a manual run) runs the checks. It also runs the tests of the deploy hostname guard [`tools/cf-guard`](../tools/cf-guard/README.md) and of the shared test and build tools `tools/bundle-size` and `tools/workerd-cpu`. A manual run's `app` input selects the apps: `both` (the default: Todofy and Mail Hero), `all`, `todofy`, `mail-hero`, `dashboard`, `website` (the site and its relay), `lab`, `flowday`, `links` or `watch` |
| `Shared packages` | `packages/<name>/` or `.github/` changed, or a manual run | For every `packages/*/`, from its own directory: `npm ci`, `npm run typecheck`, `npm test` |
| `Todofy static checks` | `todofy/`, `packages/edge-auth/`, `contracts/`, `proto/` or `.github/` changed | From `todofy/`: ruff, host tests, gateway lint/typecheck/tests and its workerd CPU test (the owner API's heaviest requests against bounds scaled by the machine's measured speed, `tools/workerd-cpu`), UI typecheck/tests/build (its JavaScript budget) and the no-Mail-Hero guard, dry-run of both committed production configs through `deploy_vars.py` with placeholder values plus the gateway's bundle budget (`deploy/bundle-size.mjs`) |
| `Todofy runtime (1/3)`, `(2/3)`, `(3/3)` | same as `Todofy static checks` | The workerd runtime suite (`tests/runtime`), split into three shards of whole test files that run at the same time, each with 4 pytest-xdist processes ([`pytest_shards.py`](../.github/scripts/pytest_shards.py) balances recorded seconds per file), then the files of [`todofy-runtime-serial.txt`](../.github/scripts/todofy-runtime-serial.txt) alone in one process; each uploads the JUnit results of the tests it ran |
| `Todofy checks` | same as `Todofy static checks` | Passes only when the static checks and every runtime shard passed and, per [`pytest_completeness.py`](../.github/scripts/pytest_completeness.py), the shards together ran every runtime test `pytest --collect-only` lists on the commit exactly once, none failed, the skips are exactly the serial baseline's (none), the collection had no error or module-level skip, and the serial files ran alone. The check `Todofy deploy` needs |
| `Mail Hero checks` | `mail-hero/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | Everything Mail Hero's CI ran, from `mail-hero/`: config and backup tool tests, Worker typecheck and tests (workerd bindings, contract fixtures), the CPU of its `Ops` entrypoint alone and serially (`npm run test:cpu`, `tools/workerd-cpu`), UI typecheck/tests/build, plus a dry-run of the committed `mail-hero/wrangler.toml` through `deploy-vars.mjs` with placeholder values |
| `Dashboard checks` | `dashboard/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | From `dashboard/`: production config and deploy-values tests, Worker lint/typecheck/unit tests, workerd runtime tests (the real `HomeState` with stub `mail-hero`/`todofy` Workers serving the ops-v1 fixtures over `Ops` RPC, a fake GraphQL endpoint and a test Access JWKS), UI lint/typecheck/tests/build, a guard against imports from `mail-hero/` or `todofy/`, and a dry-run of the committed `dashboard/wrangler.toml` through `deploy-vars.mjs` with placeholder values |
| `Lab checks` | `lab/`, `packages/edge-auth/`, `contracts/`, `proto/` or `.github/` changed | From `lab/`: production config and deploy-values tests, Worker lint/typecheck/unit tests, workerd runtime tests (the real `LabState` and D1 with a fake AI binding, a fake arXiv and a stub `todofy` Worker whose `Ops` checks every task-intent-v1 input; the CPU of the heaviest owner requests, the isolate's first API request included, against bounds scaled by the machine's measured speed, `tools/workerd-cpu`), UI lint/typecheck/tests/build (the build holds the UI's JavaScript to its gzip budget, `web/scripts/js-budget.mjs` on `tools/bundle-size`), an import guard, and a dry-run of the committed `lab/wrangler.toml` through `deploy-vars.mjs` with placeholder values whose bundle is held to Lab's budget and the Workers Free limit (`deploy/bundle-size.mjs`) |
| `Website checks` | `website/`, `contracts/`, `.github/` changed (or an unregistered package) | From `website/`, no secrets: format, lint, typecheck, unit tests (release steps, relay buttons and change detector included); for the empty source and the synthetic fixture the static export and Playwright against it under `wrangler dev` with the production `wrangler.toml`, `_headers` and `_redirects`; the release route contract on the fixture; `wrangler deploy --dry-run` of the two Workers; an import guard |
| `FlowDay checks` | `flowday/`, `packages/edge-auth/`, `proto/`, `tools/` or `.github/` changed | The committed config and deploy-wrapper tests; the F4 D1 import tool on synthetic files (export, a local D1 import, verify, reset); the Worker's lint, typecheck and unit tests; its workerd runtime tests with real D1 (including the D1 write budget of a simulated day and the CPU of the heaviest handlers against bounds scaled by the machine's measured speed, `tools/workerd-cpu`); the UI's lint, typecheck, import audit, Vitest tests, static export and its leak check (and its JavaScript budget, `web/scripts/js-budget.mjs`); an import guard; and a `--dry-run` of the committed config through the wrapper with placeholder values plus the Worker's bundle budget (`worker/scripts/bundle-size.mjs`) |
| `Links checks` | `links/`, `packages/edge-auth/`, `proto/`, `contracts/`, `tools/` or `.github/` changed | From `links/`, no secrets: the committed config and deploy-wrapper tests; the Worker's lint, typecheck and unit tests (keys, targets and passthrough, the redirect's single read); its workerd runtime tests with real D1 and a synthetic Access issuer (redirects, visibility and the enumeration rule, passthrough and open-redirect attempts, previews, the owner API, the D1 writes per action, and the CPU of the redirect and the heaviest owner requests against bounds scaled by the machine's measured speed, `tools/workerd-cpu`); the launcher's lint, typecheck, tests and build (its layout and its JavaScript budget); an import guard; and a `--dry-run` of the committed config through the wrapper with placeholder values plus the bundle budget (`deploy/bundle-size.mjs`) |
| `Watch checks` | `watch/`, `packages/edge-auth/`, `proto/`, `contracts/`, `tools/` or `.github/` changed | From `watch/`, no secrets: the committed config and deploy-wrapper tests; the Worker's lint, typecheck and unit tests (normalization and masks, the diff, triggers, robots.txt, scheduling, the URL policy, feeds, structured data, charsets, the health gate, snapshots); its workerd runtime tests with a real SQLite `WatchState` and synthetic sites behind Miniflare's outbound service (every fetch tier, the etiquette with redirect targets, every stage of the noise pipeline, triggers, confirmation and flicker, BROKEN and the auto-pause, GBK and UTF-16 pages, shadow mode, the owner API, real alarms, the SQLite rows read and written per path against Workers Free's daily limits, and the CPU of the fetch handler and of `WatchState` on its API and alarm paths, hostile page text included, against bounds scaled by the machine's measured speed, `tools/workerd-cpu`); the UI's lint, typecheck, tests and build (its layout and its JavaScript budget); the Todofy sink against a stub of Todofy's `Ops` and the app's own `Ops` entrypoint over a service binding; an import guard; and a `--dry-run` of the committed config through the wrapper with placeholder values plus the bundle budget (`deploy/bundle-size.mjs`) |
| `Contracts` | any app except the website, FlowDay and the links app, a package an app uses, `contracts/` or `.github/` changed | `mail.received.v1`: the JSON Schema is the one generated from `proto/mailhero/webhook/v1/mail_received.proto`; Mail Hero rebuilds every golden fixture byte for byte with the generated message and the wire codec (the canary one included) and pins the one ECMAScript difference of the generated schema; Todofy validates and parses every fixture with the generated Python codec, and gives every fixture and about 9,000 mutations the verdicts of the frozen hand-written schema and parser (`test_mail_received_*_legacy.py`); neither side allows two fixtures to share an event ID. `ops-v1`: the JSON Schema is the one generated from `proto/ops/v1/ops.proto` (`npm run check:schema`); Todofy gives every fixture the `jsonschema` verdict on it and checks the Python codec agrees (`test_ops_contract.py`); every app's answers keep the bytes they had before the move onto proto/ and pass the hand-written schema older dashboards validate with (`ops-golden` in Mail Hero, Lab, Todofy and the dashboard); each app's own `Ops` code is checked on the host (Mail Hero `native-ops.test.mjs`, Todofy `test_ops_core.py` and the gateway's `ops.test.ts`), and the caller: the dashboard calls only the methods of the generated services, handles every declared error code, and every input it sends passes the contract's rules (`dashboard/worker` `ops-client`, `guard`, `canary`, `digest` tests). `task-intent-v1`: Todofy gives every fixture the `jsonschema` verdict (`test_task_intent_contract.py`), Lab the `validate.mjs` verdict, the generated types and both wire JSON codecs agree with the schema on every fixture, and every intent Lab builds and every result it reads is checked against the schema (`lab/worker` `task-intent-contract` and `intent` tests); the watch app's digest and urgent intents keep the contract's watch fixtures byte for byte and its ops-v1 answers their golden bytes and fixtures (`watch/worker` `todofy` and `ops-golden` tests). A `proto/` change runs it too. Nothing here needs workerd; each app's check job runs the real-binding tests |
| `Infra checks` | `infra/`, `tools/infra-plan-summary/` or `.github/` changed | From `infra/`, with no Cloudflare token, state or plan: guards (no `external`/`http` data source, provisioner, other provider, email address or file outside the allowed kinds; [`infra_guard.py`](../.github/scripts/infra_guard.py) reads the HCL structure), `tofu fmt -check`, `tofu init -backend=false -lockfile=readonly` and `tofu validate` (the locked provider download only), the [plan-summary](../tools/infra-plan-summary/summary.py) and local-values tests. The checks of `infra/` against the apps' `wrangler.toml` files ([`test_infra_config.py`](../.github/scripts/test_infra_config.py)) run in `Changes`. [`infra/README.md`](../infra/README.md) |
| `Proto checks` | `proto/`, `.github/` or `tools/` changed, `contracts/ops-v1/`, `contracts/task-intent-v1/` or `contracts/mail-received-v1/` changed (their fixtures are what both codecs round-trip; `PROTO_READS`), or a manual run | From `proto/`, no secret: `npm ci` (the pinned buf, protoc-gen-es and protobuf-es runtime), `buf format` and `buf lint` (STANDARD + COMMENTS), Google's api-linter (`npm run api-lint`: the version pinned in `proto/tools/api-linter/go.mod`, Go from `actions/setup-go` reading that file; first a check that the googleapis compiled into the linter equals `buf.lock`'s for every file the module imports), `buf breaking` (FILE) plus the wire profile's own rules against the `Changes` job's diff base (`fetch-depth: 0`; no base: `HEAD~1`, said in the log), the rules self-test, generation twice more compared byte for byte, the contracts' JSON Schemas generated from the IDL compared with the committed ones (`npm run check:schema`), [`test_proto.py`](../.github/scripts/test_proto.py) (one runtime at the generator's version, every user wired the same way, `PROTO_USERS`), and both codecs' typecheck and tests on the same shared edge cases. A `proto/` change also checks every app in `PROTO_USERS` (Lab, Todofy, Mail Hero, the dashboard, FlowDay, the links app, the watch app), runs `Contracts`, and deploys only the apps whose bundle the changed path reaches: the TypeScript runtime (`proto/ts/`, `buf.gen.yaml`) deploys Lab, Mail Hero, the dashboard, FlowDay, the links app, the watch app and Todofy (its gateway and UI), `lab/ui/` Lab, `flowday/ui/` FlowDay, `todofy/ui/` Todofy, `links/ui/` the links app, `mailhero/ui/` Mail Hero, `watch/ui/` the watch app, `dashboard/ui/` the dashboard, the Python runtime and generators (`proto/python/`, `tools/gen_py.py`, `tools/wire_rules.py`) Todofy, `ops/` the five apps with an `Ops` entrypoint or caller (Lab, Mail Hero, the dashboard, Todofy, the watch app), `todofy/taskintent/` Lab, Todofy and the watch app, `prototest/` (the runtimes' fixtures) and `common/errors/` (types only) none, and the wire profile's options (`common/wire/`) and the module and toolchain files (`buf.yaml`, `buf.lock`, `package-lock.json`, `tools/ensure.mjs`) all seven users; tests, test data, the check scripts, the wire-type and schema generators, the api-linter tool module, check configs and Markdown deploy none. [`proto/README.md`](../proto/README.md) |
| `Newsletter checks` | `newsletter/`, shared check tooling or a dispatch requires it | Locked engine checks, unit tests, synthetic Codex/model smoke checks, build and wheel smoke tests; no production credentials or real email |
| `Newsletter image checks` | after the required Newsletter checks | Build linux/amd64, smoke-test its exact image ID, validate candidate content configuration in that image, then save the image tar and manifest as a one-day artifact |
| `CI gate` | always | Fails if any job above failed or was cancelled; skipped as unchanged (or as reused: it prints the reused run and its jobs) is fine. **The one check to require on `main`** |
| `Newsletter image publish` | authorised `main` push or dispatch, after `CI gate` and successful Newsletter checks/image checks (or verified same-SHA reuse) | Download the tested archive, verify it, load and publish that same image to `ghcr.io/ziyixi/todofy-newsletter`; independent `newsletter-production` concurrency and `packages: write`, no VPS update |
| `Todofy deploy` | `main` only, `todofy/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts`, `contracts/task-intent-v1/task-intent-v1.ts` or a `proto/` path Todofy bundles (the Python runtime and generators for todofy-core, the TypeScript runtime for its gateway and UI, `common/wire/`, `ops/`, `todofy/taskintent/`, `todofy/ui/`, the module and toolchain files) changed (or dispatched), after `CI gate` and all three Todofy jobs | Dry-run, the hostname guard on both configs, D1 migrations, deploy `todofy-core` then the gateway (the committed configs plus `deploy_vars.py`), `/health` and core probes. `production` environment, group `todofy-production` |
| `Mail Hero deploy` | `main` only, `mail-hero/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts` or a `proto/` path Mail Hero bundles (the TypeScript runtime, `common/wire/`, `ops/`, `mailhero/webhook/`, `mailhero/ui/`, the module and toolchain files) changed (or dispatched), after `CI gate` | Write the secrets file, dry-run, the hostname guard (with Mail Hero's own token), D1 migrations, deploy (the committed config plus `deploy-vars.mjs`: the receive address and owner addresses as Worker secrets, the switches and `BUILD_SHA` as vars). `production` environment, group `mail-hero-production` |
| `Website deploy` | `main` only, `website/` outside `website/relay/` changed (or dispatched with `website`/`all`), after `CI gate` | Dispatches [`.github/workflows/website-release.yml`](../.github/workflows/website-release.yml) (`gh workflow run`, `actions: write`) and returns, as the Notion buttons and the relay's detector do. That run builds the newest `main` commit whose push run passed `CI gate`: Notion sync, static export, verification under `wrangler dev`, the hostname guard (`pnpm release hostnames`, before anything is uploaded or recorded, and again in `deploy`), `wrangler versions upload`, `versions deploy` only if production still serves the recorded version, `triggers deploy` for the hostnames in `website/wrangler.toml` (the Custom Domains `www.ziyixi.science` and `ziyixi.science`, the Worker's complete set), live verification on both, rollback on failure, Notion feedback. An unchanged identity (newest `website/` commit, content, config) skips the deploy. The release job holds the group `website-production` and the `production` environment ([`website/docs/release.md`](../website/docs/release.md)) |
| `Website relay deploy` | `main` only, `website/relay/` changed (or dispatched with `website`/`all`), after `CI gate` | `wrangler deploy` of the relay Worker `ziyixi-notion-publish` (keeps its Worker secrets, applies its cron), then a `/health` probe. `production` environment, group `website-relay-production` |
| `Lab deploy` | `main` only, `lab/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts`, `validate.mjs`, `contracts/task-intent-v1/task-intent-v1.ts` / `.schema.json` or a `proto/` path Lab bundles (the TypeScript runtime, `common/wire/`, `lab/ui/`, `ops/`, `todofy/taskintent/`, the module and toolchain files) changed (or dispatched), after `CI gate` and after `Todofy deploy` (success or skipped: its `TODOFY` binding names Todofy's `Ops`) | Build the UI, write the secrets file, dry-run (the bundle held to its budget), the hostname guard, apply the D1 migrations, deploy (the committed config plus `deploy-vars.mjs`), then a read of production through the API (one version at 100% whose `BUILD_SHA` is this commit, no pending D1 migration; Access answers every request before the Worker, so this is what shows the new code serves) and the dashboard's Access probe for `GET /` and `/api/v1/today` on `lab.ziyixi.science`. `production` environment, group `lab-production` |
| `FlowDay deploy` | `main` only, `flowday/`, `packages/edge-auth/` or a `proto/` path FlowDay bundles (the TypeScript runtime, `common/wire/`, `flowday/ui/`, the module and toolchain files) changed (or dispatched with `flowday`/`all`), after `CI gate` | Build and check the static export, write the secrets file, dry-run, the hostname guard, apply the D1 migrations, deploy (the committed config plus `deploy-vars.mjs`), then a read of production through wrangler with the deploy token (the Worker serves exactly one version at 100% whose `BUILD_SHA` is the commit, and no D1 migration is pending), the dashboard's Access probe for `GET /` and `/api/v1/tasks` on its host `flowday.ziyixi.science` (`PUBLIC_HOST`), and a check that only the PWA files reach the Worker anonymously (manifest, icons and `/pwa/sw` 200 with their media types, `/pwa/sw.js` the Worker's 401). `production` environment, group `flowday-production` ([`flowday/README.md`](../flowday/README.md) "Deploy") |
| `Links deploy` | `main` only, `links/`, `packages/edge-auth/` or a `proto/` path the links app bundles (the TypeScript runtime, `common/wire/`, `links/ui/`, the module and toolchain files) changed (or dispatched with `links`/`all`), after `CI gate` | Build the launcher, write the secrets file, dry-run (the bundle held to its budget), the hostname guard, apply the D1 migrations, deploy (the committed config plus `deploy-vars.mjs`), then FlowDay's read of production through wrangler (one version at 100% whose `BUILD_SHA` is this commit, no pending D1 migration), the dashboard's Access probe for `GET /_`, `/_/` and `/_/api/v1/links` on `s.ziyixi.science`, and a check that the rest of the host reaches the Worker without Access (`/robots.txt` 200 with the Worker's text, an unknown key the Worker's 302 to `/_/k/<key>`, both `no-store` and `noindex`). `production` environment, group `links-production` ([`links/README.md`](../links/README.md) "Deploy") |
| `Watch deploy` | `main` only, `watch/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts`, `contracts/task-intent-v1/task-intent-v1.ts` or a `proto/` path the watch app bundles (the TypeScript runtime, `common/wire/`, `watch/ui/`, `ops/`, `todofy/taskintent/`, the module and toolchain files) changed (or dispatched with `watch`/`all`), after `CI gate` and after `Todofy deploy` (success or skipped: its `TODOFY` binding names Todofy's `Ops`) | Build the UI, write the secrets file, dry-run (the bundle held to its budget), the hostname guard, deploy (the committed config plus `deploy-vars.mjs`; no D1), then the links app's read of production through wrangler without its D1 part (one version at 100% whose `BUILD_SHA` is this commit) and the dashboard's Access probe for `GET /`, `/api/v1/watches` and `/new` on `watch.ziyixi.science` (the whole host is behind Access, `/health` too). Whether `WatchState`'s alarm is armed cannot be seen anonymously: the first owner API call or the dashboard's next `status()` arms it ([`watch/README.md`](../watch/README.md) "Deploy" has the post-deploy check). `production` environment, group `watch-production` |
| `Dashboard deploy` | `main` only, `dashboard/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts` or a `proto/` path the dashboard bundles (the TypeScript runtime, `common/wire/`, `dashboard/ui/`, `ops/`, the module and toolchain files) changed (or dispatched), after `CI gate` and after `Todofy deploy`, `Mail Hero deploy`, `Lab deploy` and `Watch deploy` (each success or skipped: the service bindings need their `Ops` entrypoints live) | Build the UI, write the secrets file, dry-run, the hostname guard, deploy (the committed config plus `deploy-vars.mjs`; no D1), then a probe that an unauthenticated `GET /` and `/api/v1/homeView` are answered by Access with a 302 to its login page for this host (`<issuer>/cdn-cgi/access/login/<host>`), never by the app or another redirect. `production` environment, group `dashboard-production` |

A change to only `contracts/`, `.github/` or `tools/` (CI, test and build tooling; `tools/infra-plan-summary/` runs only `Infra checks`) re-checks every app but deploys none, except the contract
files the Workers bundle: the five Ops participants bundle the constants of
`contracts/ops-v1/ops-v1.ts` (`OPS_LIMITS`), so a change to it deploys all five; Lab bundles
`validate.mjs` (its task intents), so a change to it deploys Lab; `ops-v1.schema.json` is generated and
bundled by none (every app reads ops-v1 with the code generated from `proto/ops/`); and
`contracts/task-intent-v1/task-intent-v1.ts` ships in Lab, Watch and Todofy's gateway (its schema in Lab only; the types come from `proto/`, `PROTO_USERS`) (`BUNDLED_BY` in `.github/scripts/ci_changes.py` maps each bundled
contract file to its apps; its test compares the map with the Workers' imports). Dispatch on `main` to
redeploy an app. A change to `packages/edge-auth/` runs `Shared packages` and checks **and deploys** all seven consuming apps, because every Worker compiles it in; a change to only its Markdown documents
(`packages/<name>/**/*.md`, e.g. `README.md`, `SPEC.md`) runs `Shared packages` and checks the seven consuming apps
but deploys none (nothing of it is compiled in). `ci_changes.py` maps each package
to the apps that use it (`PACKAGE_USERS`); `test_ci_changes.py` fails unless that map matches every
`"file:../../packages/<name>"` dependency and lists every `packages/*/` directory, and a package missing
from it counts as used by every app. A dashboard-only change checks and deploys only the dashboard (and
runs `Contracts`); it never redeploys the apps it calls. Root-only files (`README.md`, `AGENTS.md`,
`packages/README.md`) run only `Changes` and `CI gate`.

The deploy jobs' `if:` must stay explicit: `!cancelled()` plus `needs.<job>.result == 'success'` for every
job they need (for `Dashboard deploy`, `success` or `skipped` for the four upstream app deploys; for a check job,
`skipped` only together with `needs.changes.outputs.checks_reused == 'true'`). `CI gate` needs
every app's check job and some are skipped whenever only another app changed; a condition without a
status function gets an implicit `success()` that also sees that skipped ancestor and would skip the
deploy ([actions/runner#2205](https://github.com/actions/runner/issues/2205)). `test_ci_changes.py` (run
by `Changes`) fails if a job after the gate loses this shape, if a production job lacks its own
concurrency group, or if the dispatch options and `DISPATCH` differ. It also fails if the `Contracts`
job stops naming both sides' contract tests and the dashboard's caller test, or names a test file that
does not exist. `test_doc_references.py` (also run by `Changes`) fails if any doc or comment names a D1
migration file that does not exist, such as a migration's number from before a rebase renumbered it.

Every deploy that applies a config with Custom Domains or zone routes first runs
[`tools/cf-guard`](../tools/cf-guard/README.md) on that config with the job's own token, before any production
change: wrangler applies each non-empty category as the Worker's complete set (and in CI overwrites another
Worker's hostname or a DNS record), so the guard fails when a live hostname would be detached or taken
over. It only reads, and prints the config's hostnames and patterns, counts and PASS/FAIL; a live hostname
that is not in the repository is only counted, so the public log never names it. An intentional removal sets
`CF_GUARD_ALLOW_REMOVE` (an intentional takeover `CF_GUARD_ALLOW_CONFLICT`, as `worker:<host>`, `dns:<host>` or
`route:<pattern>`) on that job's guard step to the exact hostnames, in the same commit that edits
`wrangler.toml`. A hostname moving off a DNS record that the Workers Custom Domain API did not create (a tunnel
CNAME) needs that record deleted right before the deploy: the API refuses it (error `100117`) even though CI's
wrangler asks it to overwrite the record.

The website jobs cache the Playwright browser download by the locked Playwright version
(`~/.cache/ms-playwright`); the system libraries it needs are installed on every run.

The first push run of this workflow on `main` has no earlier successful run of it and therefore checks and
deploys every app. (The Go-era `ci.yml` of the old Todofy repository shares the file name; its last green
`main` commit is either an ancestor, whose diff covers both apps, or not, which also runs everything.)

[`.github/workflows/mail-hero-backup-image.yml`](../.github/workflows/mail-hero-backup-image.yml) builds Mail
Hero's backup collector when `mail-hero/deploy/backup/**` or `mail-hero/cloudflare/migrations/**` change: other
branches build only; `main` publishes `ghcr.io/ziyixi/mail-hero-backup-collector`. That is a new package
name: the old `ghcr.io/ziyixi/mail-hero-backup` stays linked to the old repository, and the server keeps its
pinned digest of it until the next collector upgrade switches the Compose image to the new package's digest.

### Production environment

All deploy jobs use the one `production` environment (deployment branch `main`).

| Job | Variables | Secrets |
| --- | --- | --- |
| `Todofy deploy` | `TODOFY_REMINDER_ENABLED`, `TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST`, `TODOFY_GTD_REVIEW_ENABLED` | `CF_API_TOKEN`, `TODOFY_ACCESS_OWNER`, `TODOFY_ACCESS_OWNER_ALIASES`, `TODOFY_TODOIST_DEFAULT_PROJECT_ID`; optional (unset = the default project) `TODOFY_TODOIST_OPS_PROJECT_ID`, `TODOFY_TODOIST_REVIEW_PROJECT_ID` |
| `Mail Hero deploy` | `MAIL_HERO_FORCE_SEND_PAUSED`, `MAIL_HERO_MAINTENANCE_MODE` | `MAIL_HERO_CF_API_TOKEN` (named `CF_API_TOKEN` in the old Mail Hero repository), `MAIL_HERO_RECEIVE_ADDRESS`, `MAIL_HERO_ACCESS_OWNER`, `MAIL_HERO_ACCESS_OWNER_ALIASES` |
| `Website deploy` (the release workflow) | none: `SITE_URL`, `NOTION_API_VERSION` and the legacy repository are committed in the workflow, the account and hostnames in `website/wrangler.toml`; optional `WEBSITE_BOOTSTRAP_APPROVAL` (only an empty-registry bootstrap) | `CF_API_TOKEN`, `WEBSITE_NOTION_TOKEN`, `WEBSITE_NOTION_DATA_SOURCE_ID` |
| `Website relay deploy` | none (its settings are committed in `website/relay/wrangler.toml`; its four secrets are Worker secrets) | `CF_API_TOKEN` |
| `Lab deploy` | none (Lab's pause is an owner setting; everything static is committed in `lab/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy and D1 migrations only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, [`lab/README.md`](../lab/README.md) "Deploy secrets"), `LAB_CSRF_SIGNING_KEY` (Lab's own) |
| `FlowDay deploy` | none (everything static is committed in `flowday/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy, D1 migrations and the production check only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, as for Lab), `FLOWDAY_CSRF_SIGNING_KEY` and `FLOWDAY_CREDENTIAL_KEY` (FlowDay's own; the credential key seals the Todoist key in D1) |
| `Links deploy` | none (everything static is committed in `links/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy, D1 migrations and the production check only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, as for Lab and FlowDay), `LINKS_CSRF_SIGNING_KEY` (the links app's own) |
| `Watch deploy` | none (everything static is committed in `watch/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy and the production check only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, as for Lab, FlowDay and the links app), `WATCH_CSRF_SIGNING_KEY` (the watch app's own, 64 hex) |
| `Dashboard deploy` | `DASHBOARD_CANARY_ENABLED` (exactly `true` or `false`; unset is refused) | `CF_API_TOKEN` (hostname guard (read-only) and deploy only; the secrets step also receives it to warn about reuse as the analytics token), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`, `DASHBOARD_CSRF_SIGNING_KEY`, `DASHBOARD_CF_ANALYTICS_TOKEN` (fixed read-only Cloudflare endpoints only; least-privilege token, [`dashboard/docs/setup.md`](../dashboard/docs/setup.md) §4) |

Every Worker's production config is one committed file named `wrangler.toml` in the folder that names
the Worker: `mail-hero/wrangler.toml`, `todofy/wrangler.toml` (todofy-core), `todofy/gateway/wrangler.toml`
(the gateway `todofy`), `dashboard/wrangler.toml`, `website/wrangler.toml`, `website/relay/wrangler.toml`,
`lab/wrangler.toml`, `flowday/wrangler.toml`, `links/wrangler.toml` and `watch/wrangler.toml`. The top level is production (no `[env.*]`, no `keep_vars`), and every static value is committed there:
account, D1 IDs, buckets, hostnames and routes, crons, compatibility settings, Durable Object bindings and
migrations, Access issuers and AUDs, limits and defaults. Changing one is a commit that checks and deploys
that app. Nothing is generated. What is never committed is added at deploy by each app's wrapper
(`mail-hero/deploy/deploy-vars.mjs`, `todofy/deploy/deploy_vars.py`, `dashboard/deploy/deploy-vars.mjs`,
`lab/deploy/deploy-vars.mjs`, `flowday/deploy/deploy-vars.mjs`, `links/deploy/deploy-vars.mjs`, `watch/deploy/deploy-vars.mjs`): the personal values and owner identities from the secrets above as Worker
secrets with `wrangler deploy --secrets-file` (wrangler and the Cloudflare dashboard show a plain var's
value), and with `--var NAME:value` the operational switches from the variables above (the only GitHub
variables CI reads, so a release restates the live switches and never overwrites them) and `BUILD_SHA`. A deploy without a var deletes it, so each wrapper refuses a missing or invalid value, `--env`,
`--keep-vars` and any other config; never run a plain `wrangler deploy` of these configs.
[`.github/scripts/test_wrangler_configs.py`](../.github/scripts/test_wrangler_configs.py) (in `Changes`) checks
across apps: only these configs (and the runtime-test ones next to their tests) exist, none has `[env]` or
`keep_vars`, one account, the hosts are consistent (the dashboard's is its own; its links match the apps'),
every step that calls a wrapper sets every input, personal values come only from secrets and reach the
Workers only as Worker secrets, and no personal value, switch or build is committed. [`.github/scripts/test_drift_desired.py`](../.github/scripts/test_drift_desired.py)
(also in `Changes`) checks that the dashboard's bundled desired state `dashboard/worker/src/drift-desired.json`
(names, types and flags only, for its private daily drift check, `dashboard/docs/design-v2.md` §10) equals a
fresh `python3 .github/scripts/drift_desired.py`: a change to any config or wrapper regenerates it in the same
commit. Local development uses local bindings only (never `--remote`, D1
commands with `--local`) and each app's `.dev.vars` (see its `.dev.vars.example`).

The repository is public, and Actions prints a step's variables in its log, so personal values (the receive
address, owner emails, the Todoist project id) are secrets even though they are not credentials. The backup image workflow uses only
the job's own `GITHUB_TOKEN`.


## Newsletter image and configuration releases

Newsletter is a separate container service in [newsletter/](../newsletter/README.md). Its independent CI
tests the built image before saving `newsletter-image-<source SHA>` for one day. The artifact contains the image
tar and a manifest with the source SHA, tar SHA-256 and tested local image ID.

When a `main` push reuses the green branch run of that exact SHA, the publish job downloads the artifact from
that reused run. `find_reusable` must find the matching non-expired artifact as well as every required successful
check. A missing or expired artifact disables reuse: this `main` run performs the checks/build again. It never
substitutes an untested rebuild in the publish job. An artifact that becomes unavailable after selection fails
the publication rather than bypassing the gate.

[image.py](../tools/newsletter-release/image.py) verifies the expected source SHA, archive hash and loaded image
ID before tagging/pushing. The publish job does not build. It publishes the same tested image as
`ghcr.io/ziyixi/todofy-newsletter:service-<SHA>` and `:service`; release evidence also records the resulting registry
manifest digest. The local image ID and registry digest are different identities: a VPS update pins the registry
digest. This new package is created and published by the monorepo Actions token with `packages: write` and is
associated with this repository. The older Newsletter package keeps its original repository permissions.

The existing VPS continues to use the original `ghcr.io/ziyixi/newsletter` image; it has not been upgraded or
switched to the new package. Publishing an image does not automatically update the VPS or deploy any Cloudflare application. A VPS update
uses the immutable digest and the app's versioned machine HTTP/drain contract. The external `ziyixi-protos`/wire
JSON runtime is retained; importing the repository is not a runtime or IDL rewrite.

Two other workflows are carried into the monorepo:

- [content-config.yml](../.github/workflows/content-config.yml) validates authored configuration in an already
  tested/published compatible engine and publishes a receipted bundle to the `published` branch. A successful
  monorepo run without a successful Newsletter image publication cannot be selected as an engine. Stale-main
  checks prevent a late run from rolling back newer configuration. It does not upgrade the VPS or send email.
- [newsletter-daily.yml](../.github/workflows/newsletter-daily.yml) is **preparation-only**: manual or repository
  dispatch can request collection/preview, with an idempotent run key. It contains no schedule and no send job;
  the existing external server scheduler owns the cadence.

The VPS config-sync source still points to the original repository; this foundation change has not switched it.
The daily trigger's service URL/token settings have not been migrated to the root repository. Therefore the
presence of these workflows is not evidence that monorepo configuration syncing or preparation dispatch is live.
Keep existing scheduling and sending unchanged until the separately authorised migration is verified.

## Other release paths

Mail Hero's collector image is likewise independent from its Worker. Neither a published image nor a successful
Worker upload proves a VPS update, a complete backup or live business success. Release probes share
[production.sh](../tools/deploy-probes/production.sh) and [access.sh](../tools/deploy-probes/access.sh), with each
application retaining its own config, credentials, wrapper and expected paths.

The old generated-config rollback procedure is retained in [history](history.md#committed-config-rollback).
Follow the current application runbook and HANDOFF before attempting a rollback.
