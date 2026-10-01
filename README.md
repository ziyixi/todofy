# Mail Hero, Todofy, the home dashboard, the personal website and Lab

Five independent Cloudflare apps in one repository (plus FlowDay, which is being moved onto Cloudflare, and the links
app, the owner's short links), the contracts between them, and the shared code compiled into each.

| Directory | What it is | Start here |
| --- | --- | --- |
| [`mail-hero/`](mail-hero/) | Personal inbox on Workers Free + D1 + R2 + a SQLite Durable Object: receives mail through Email Routing and POSTs a `mail.received.v1` webhook | [`mail-hero/README.md`](mail-hero/README.md), [`mail-hero/AGENTS.md`](mail-hero/AGENTS.md) |
| [`todofy/`](todofy/) | The webhook consumer: TypeScript gateway + Python core Workers that turn mail into Todoist tasks, summaries and reminders | [`todofy/README.md`](todofy/README.md), [`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md) |
| [`dashboard/`](dashboard/) | The owner's console `home` (TypeScript Worker + SQLite Durable Object + React UI) on `home.ziyixi.science`: a launcher for every registered app and site with honest health, business flows as stage chains, auto-discovered per-Worker and D1/DO/R2 monitoring with account-wide Workers Free quotas and guardrails, both apps' health through their `Ops` entrypoints, a daily end-to-end canary and the unified ops digest | [`dashboard/README.md`](dashboard/README.md), [`dashboard/docs/`](dashboard/docs/) |
| [`website/`](website/) | The personal website `www.ziyixi.science`: Next.js static export on the assets-only Worker `ziyixi-website`, Notion as the content source, and the Notion relay Worker `ziyixi-notion-publish` (buttons plus a 15-minute change detector that publishes automatically; the release workflow's own schedule dispatches the daily reconcile release when the relay has not). `www` (canonical) and the apex `ziyixi.science` are both Custom Domains of the site Worker, sharing one certificate that covers no app host ([`website/docs/architecture.md`](website/docs/architecture.md#hostnames)). Uses no contract and no package | [`website/README.md`](website/README.md), [`website/docs/`](website/docs/) |
| [`lab/`](lab/) | Lab / Paper Radar `lab` (TypeScript Worker + SQLite Durable Object + D1 + Workers AI + React UI) on `lab.ziyixi.science`: ranks each day's arXiv cs.IR/cs.CL/cs.LG papers against the owner's likes and seeds, writes a Chinese 简介 per card under a hard daily neuron cap, serves them as a swipe deck (like / dislike, undo, 重来) and, after an explicit confirm, sends the liked papers to Todofy as Todoist tasks | [`lab/README.md`](lab/README.md), [`lab/docs/`](lab/docs/) |
| [`flowday/`](flowday/) | FlowDay, a daily execution board over a read-only view of Todoist (time blocks, timers, reviews). Imported from `ziyixi/FlowDay` and ported to Workers Free: the Worker `flowday` serves a Next.js static export and a small API on D1 ([`flowday/docs/design.md`](flowday/docs/design.md)). Since F2 `FlowDay deploy` deploys the Worker and its D1 migrations; since the F4 cutover it serves `flowday.ziyixi.science` behind Access (the F3 staging host `flowday-next.ziyixi.science` before it; the old container stays untouched for the F5 rollback window). Compiles in `packages/edge-auth`; uses no contract | [`flowday/README.md`](flowday/README.md), [`flowday/AGENTS.md`](flowday/AGENTS.md) |
| [`links/`](links/) | The owner's short links on `s.ziyixi.science/<key>` (Worker `links`, D1 `links`, a launcher UI under `/_/`): one D1 read and a 302 per redirect, no writes and no logs on that path; public or private per link, and an anonymous request for a private key gets exactly the answer an unknown key gets (a 302 to the Access-protected `/_/k/<key>`); path passthrough with open-redirect guards; the owner API `links.ui.v1` (`proto/links/ui/v1`) with soft delete, revisions and undo, JSON Lines import and export. Deployed by CI (`Links deploy`) since its step L2 on the Custom Domain `s.ziyixi.science`, with only `/_` and `/_/*` behind the path-scoped Access application `links` | [`links/README.md`](links/README.md), [`links/AGENTS.md`](links/AGENTS.md), [`links/docs/design.md`](links/docs/design.md) |
| [`contracts/`](contracts/) | `mail.received.v1`: schema, semantics and golden payloads built by Mail Hero's real builder; `ops-v1`: the `Ops` entrypoints of Mail Hero, Todofy and Lab, which the dashboard calls; `task-intent-v1`: Lab proposes Todoist tasks to Todofy's `Ops` entrypoint | [`contracts/README.md`](contracts/README.md) |
| [`infra/`](infra/) | OpenTofu for the account objects the monorepo apps depend on but wrangler does not own: their Cloudflare Access applications and policies, and the existence of their D1 databases and R2 buckets. Encrypted remote state in R2, a daily drift plan that also checks every `ACCESS_AUDIENCE`/`database_id` against the live objects, and a manually dispatched, gated apply. Manages no Worker, domain, route, DNS record, Email Routing setting or anything outside the monorepo | [`infra/README.md`](infra/README.md) |
| [`proto/`](proto/) | Protobuf as the IDL of every interface we define: the cross-app contracts and each app's UI API. The buf module (`todofy/taskintent/v1/task_intent.proto` mirrors `task-intent-v1`; `lab/ui/v1` is Lab's owner API in Google's AIP style), the pinned toolchain, the wire JSON codecs (TypeScript, stdlib Python) and the HTTP runtime (a `google.api.http` transcoder for Workers and a typed client). The wire stays JSON. Generated code is never committed: an app's `npm ci` (postinstall) or `uv sync` generates it. Lab's Worker and UI and todofy-core run on it; Todofy's gateway uses its types | [`proto/README.md`](proto/README.md) |
| [`packages/edge-auth/`](packages/edge-auth/) | Shared auth code compiled into every Worker (Todofy gateway, Mail Hero, dashboard, Lab): Cloudflare Access JWT verification, signed double-submit CSRF, private response headers. TypeScript, Web Crypto only, no runtime dependencies; not a Worker of its own | [`packages/edge-auth/README.md`](packages/edge-auth/README.md), [`SPEC.md`](packages/edge-auth/SPEC.md) |

Rules ([`AGENTS.md`](AGENTS.md)): the apps never import each other; shared code lives only in `contracts/`,
`packages/` and `proto/`, plus the test and build tools under `tools/` that no bundle carries (`tools/workerd-cpu`,
the calibrated CPU meter of the workerd CPU tests; `tools/bundle-size`, the bundle budgets), which apps import only
from their tests and build or deploy scripts; each app deploys on its own. An app uses a package through a
`"file:../../packages/<name>"` dependency and its bundler compiles it in, so a change to a package's code
checks and deploys every app that uses it (its Markdown documents only check them). `contracts/` holds documents, schemas and fixtures, plus
dependency-free files the TypeScript Workers import by relative path (the rules the IDL cannot express:
`ops-v1/ops-v1.ts`, `task-intent-v1/task-intent-v1.ts`; `ops-v1/validate.mjs`, Lab's task-intent validator); the
contracts' types, codecs and (for ops-v1) value rules and JSON Schema come from their IDL in `proto/`. Work inside an app's directory: `cd mail-hero`, `cd todofy`,
`cd dashboard`, `cd website`, `cd lab`, `cd flowday` or `cd links`, then follow that app's README. Mail Hero and Todofy were separate
repositories until 2026-09-29, the website (`ziyixi/ziyixi.science`) until 2026-09-30; their histories are
kept (`git log --follow todofy/<file>`, `git log -- mail-hero/<file>`, `git log --follow website/<file>`;
old commit IDs are mapped in [`mail-hero/docs/history-map.md`](mail-hero/docs/history-map.md) and
[`website/docs/history-map.md`](website/docs/history-map.md)).

## Ops surface (`contracts/ops-v1`)

Each app's TypeScript Worker also exports a named `WorkerEntrypoint` `Ops` for the dashboard Worker `home`
in the same account ([`dashboard/`](dashboard/)): `[[services]] binding = "MAIL_HERO", service =
"mail-hero", entrypoint = "Ops"` and `binding = "TODOFY", service = "todofy", entrypoint = "Ops"`. There is no new public route and
no Access check; only a Worker deployed in this account can bind it.

| App | Methods | Where |
| --- | --- | --- |
| Mail Hero | `status()`, `setGuard()`, `startCanary({run_id})`, `canaryDelivery(event_id)` | [`mail-hero/docs/cloudflare-setup.md`](mail-hero/docs/cloudflare-setup.md) §2.3, [`mail-hero/cloudflare/README.md`](mail-hero/cloudflare/README.md) |
| Todofy | `status()`, `setGuard()`, `canaryResult(event_id)`, `reportOps(report)`; `proposeTasks(intent)`, `taskIntentStatus(ref)` for Lab (`contracts/task-intent-v1`, its `TODOFY` binding) | [`todofy/docs/gateway-contract.md`](todofy/docs/gateway-contract.md) §3.7, [`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md) |
| Lab | `status()`, `setGuard()` (answered from its own Durable Object, no D1 read) | [`lab/docs/design.md`](lab/docs/design.md) §10 |

- `status()` uses a small, documented number of indexed D1 reads and returns codes, numbers, booleans,
  times and the UI URL only; never mail content.
- A `shed` guard expires by itself (at most 36 h ahead) and defers only cleanup and safety-net jobs, each
  within a bound; it never stops intake, parsing, delivery, retries or real-mail processing.
- The canary is a synthetic `mail.received.v1` event with a top-level `canary` marker
  ([`fixtures/canary_event.json`](contracts/mail-received-v1/fixtures/canary_event.json)); consumers must
  not cause external side effects for it. Todofy runs it through Gemini and records the result, never
  Todoist, summaries, reports or reminders. The dashboard runs it once a day (plus up to 3 manual runs).
- Todofy's daily attention reminder (still at most one Todoist task per UTC day) carries the warning and
  critical items of the latest `reportOps` report, which only the dashboard sends. Mail Hero's own
  `ALERT_WEBHOOK_URL` stays optional and unconfigured; the dashboard's report replaces it.
- The dashboard sets `shed` on both apps when an account-wide daily allowance (or a monthly R2
  operation class) reaches 80 %, and clears it below 70 % or on a new UTC day
  ([`dashboard/docs/limits.md`](dashboard/docs/limits.md)).

Release order: Todofy (canary consumer) before Mail Hero, Lab after Todofy (its `TODOFY` binding), then
the dashboard; in one CI run `Lab deploy` waits for `Todofy deploy` and `Dashboard deploy` for all three app
deploys. The contract and the per-app plan are
[`contracts/ops-v1/README.md`](contracts/ops-v1/README.md) and
[`IMPLEMENTATION.md`](contracts/ops-v1/IMPLEMENTATION.md).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) ("CI and deploy") runs on a push to any branch and on
a manual run. Actions are pinned by commit SHA.

[`.github/workflows/infra.yml`](.github/workflows/infra.yml) ("Infra drift") is separate: on `main` only
(a push that changes `infra/`, daily, or a manual run), in the `production` environment and the
`infra-production` concurrency group, it plans `infra/` against its encrypted remote state and fails on any
planned action or on an output (Access AUD, D1 id, bucket) that differs from an app's `wrangler.toml`. Its log holds
only the redacted summary; it applies nothing and is not part of `CI gate` ([`infra/README.md`](infra/README.md)
"Drift plan"). [`.github/workflows/infra-apply.yml`](.github/workflows/infra-apply.yml) ("Infra apply") is the only
writer: a manual dispatch on `main`, same environment and concurrency group, which copies the encrypted state, plans,
refuses unless the plan passes its gates (including the exact reviewed actions and plan fingerprint) and applies
exactly that saved plan
([`infra/README.md`](infra/README.md) "Apply").

| Job | Runs when | Does |
| --- | --- | --- |
| `Changes` | always | Runs every `.github/scripts` test (including [`test_wrangler_configs.py`](.github/scripts/test_wrangler_configs.py), the checks across the apps' Wrangler configs and this workflow, which needs Python 3.11+: locally `uv run --no-project --python 3.12 python -m unittest discover -s .github/scripts`, since an older `python3` skips it), then [`.github/scripts/ci_changes.py`](.github/scripts/ci_changes.py): `git diff --name-only` from a cumulative base to the pushed commit. On `main` the base is the commit of the last successful push run of this workflow on `main` (read with the job's `actions: read` token), so changes from a failed or cancelled run, including one cancelled while pending, are checked and deployed by the next run. On other branches the base is `git merge-base origin/main HEAD`, so the head commit's gate covers the whole branch. No usable base (first run, API error, base not an ancestor) runs everything. The base is also an output (`base`, empty when everything runs), which `Proto checks` compares the IDL with. A push to `main` then looks for a green branch push run of the same commit (same workflow, `head_sha`, a non-`main` branch, concluded success) whose `Changes`, `CI gate` and every check job this push needs succeeded (`CHECK_JOBS`; a matrix counts only when all its shards succeeded): if one exists, every check output is false, `checks_reused` names that run, and the deploy outputs and the last-successful-`main` base are unchanged. The same commit is the same tree and the same workflow, and no check job uses a secret (`test_wrangler_configs.py` fails if a job before the deploys reads a secret, runs in an environment, runs `wrangler deploy` without `--dry-run` or calls wrangler with `--remote`). Any doubt (no such run, a needed check it skipped, an API error, a manual run) runs the checks. It also runs the tests of the deploy hostname guard [`tools/cf-guard`](tools/cf-guard/README.md) and of the shared test and build tools `tools/bundle-size` and `tools/workerd-cpu`. A manual run's `app` input selects the apps: `both` (the default: Todofy and Mail Hero), `all`, `todofy`, `mail-hero`, `dashboard`, `website` (the site and its relay), `lab`, `flowday` or `links` |
| `Shared packages` | `packages/<name>/` or `.github/` changed, or a manual run | For every `packages/*/`, from its own directory: `npm ci`, `npm run typecheck`, `npm test` |
| `Todofy static checks` | `todofy/`, `packages/edge-auth/`, `contracts/`, `proto/` or `.github/` changed | From `todofy/`: ruff, host tests, gateway lint/typecheck/tests, UI API check/typecheck/tests/build and the no-Mail-Hero guard, dry-run of both committed production configs through `deploy_vars.py` with placeholder values |
| `Todofy runtime (1/3)`, `(2/3)`, `(3/3)` | same as `Todofy static checks` | The workerd runtime suite (`tests/runtime`), split into three shards of whole test files that run at the same time, each with 4 pytest-xdist processes ([`pytest_shards.py`](.github/scripts/pytest_shards.py) balances recorded seconds per file), then the files of [`todofy-runtime-serial.txt`](.github/scripts/todofy-runtime-serial.txt) alone in one process; each uploads the JUnit results of the tests it ran |
| `Todofy checks` | same as `Todofy static checks` | Passes only when the static checks and every runtime shard passed and, per [`pytest_completeness.py`](.github/scripts/pytest_completeness.py), the shards together ran every runtime test `pytest --collect-only` lists on the commit exactly once, none failed, the skips are exactly the serial baseline's (none), the collection had no error or module-level skip, and the serial files ran alone. The check `Todofy deploy` needs |
| `Mail Hero checks` | `mail-hero/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | Everything Mail Hero's CI ran, from `mail-hero/`: config and backup tool tests, Worker typecheck and tests (workerd bindings, contract fixtures), the CPU of its `Ops` entrypoint alone and serially (`npm run test:cpu`, `tools/workerd-cpu`), UI typecheck/tests/build, plus a dry-run of the committed `mail-hero/wrangler.toml` through `deploy-vars.mjs` with placeholder values |
| `Dashboard checks` | `dashboard/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | From `dashboard/`: production config and deploy-values tests, Worker lint/typecheck/unit tests, workerd runtime tests (the real `HomeState` with stub `mail-hero`/`todofy` Workers serving the ops-v1 fixtures over `Ops` RPC, a fake GraphQL endpoint and a test Access JWKS), UI lint/typecheck/tests/build, a guard against imports from `mail-hero/` or `todofy/`, and a dry-run of the committed `dashboard/wrangler.toml` through `deploy-vars.mjs` with placeholder values |
| `Lab checks` | `lab/`, `packages/edge-auth/`, `contracts/`, `proto/` or `.github/` changed | From `lab/`: production config and deploy-values tests, Worker lint/typecheck/unit tests, workerd runtime tests (the real `LabState` and D1 with a fake AI binding, a fake arXiv and a stub `todofy` Worker whose `Ops` checks every task-intent-v1 input; the CPU of the heaviest owner requests, the isolate's first API request included, against bounds scaled by the machine's measured speed, `tools/workerd-cpu`), UI lint/typecheck/tests/build (the build holds the UI's JavaScript to its gzip budget, `web/scripts/js-budget.mjs` on `tools/bundle-size`), an import guard, and a dry-run of the committed `lab/wrangler.toml` through `deploy-vars.mjs` with placeholder values whose bundle is held to Lab's budget and the Workers Free limit (`deploy/bundle-size.mjs`) |
| `Website checks` | `website/`, `contracts/`, `.github/` changed (or an unregistered package) | From `website/`, no secrets: format, lint, typecheck, unit tests (release steps, relay buttons and change detector included); for the empty source and the synthetic fixture the static export and Playwright against it under `wrangler dev` with the production `wrangler.toml`, `_headers` and `_redirects`; the release route contract on the fixture; `wrangler deploy --dry-run` of the two Workers; an import guard |
| `FlowDay checks` | `flowday/`, `packages/edge-auth/` or `.github/` changed | The committed config and deploy-wrapper tests; the F4 D1 import tool on synthetic files (export, a local D1 import, verify, reset); the Worker's lint, typecheck and unit tests; its workerd runtime tests with real D1 (including the D1 write budget of a simulated day and the CPU of the heaviest handlers against bounds scaled by the machine's measured speed, `tools/workerd-cpu`); the UI's lint, typecheck, import audit, Vitest tests, static export and its leak check; an import guard; and a `--dry-run` of the committed config through the wrapper with placeholder values plus the bundle-size budget |
| `Links checks` | `links/`, `packages/edge-auth/`, `proto/`, `contracts/`, `tools/` or `.github/` changed | From `links/`, no secrets: the committed config and deploy-wrapper tests; the Worker's lint, typecheck and unit tests (keys, targets and passthrough, the redirect's single read); its workerd runtime tests with real D1 and a synthetic Access issuer (redirects, visibility and the enumeration rule, passthrough and open-redirect attempts, previews, the owner API, the D1 writes per action, and the CPU of the redirect and the heaviest owner requests against bounds scaled by the machine's measured speed, `tools/workerd-cpu`); the launcher's lint, typecheck, tests and build (its layout and its JavaScript budget); an import guard; and a `--dry-run` of the committed config through the wrapper with placeholder values plus the bundle budget (`deploy/bundle-size.mjs`) |
| `Contracts` | any app except the website, FlowDay and the links app, a package an app uses, `contracts/` or `.github/` changed | `mail.received.v1`: Mail Hero rebuilds every golden fixture byte for byte (the canary one included); Todofy validates and parses every fixture; neither side allows two fixtures to share an event ID. `ops-v1`: the JSON Schema is the one generated from `proto/ops/v1/ops.proto` (`npm run check:schema`); Todofy gives every fixture the `jsonschema` verdict on it and checks the Python codec agrees (`test_ops_contract.py`); every app's answers keep the bytes they had before the move onto proto/ and pass the hand-written schema older dashboards validate with (`ops-golden` in Mail Hero, Lab, Todofy and the dashboard); each app's own `Ops` code is checked on the host (Mail Hero `native-ops.test.mjs`, Todofy `test_ops_core.py` and the gateway's `ops.test.ts`), and the caller: the dashboard calls only the methods of the generated services, handles every declared error code, and every input it sends passes the contract's rules (`dashboard/worker` `ops-client`, `guard`, `canary`, `digest` tests). `task-intent-v1`: Todofy gives every fixture the `jsonschema` verdict (`test_task_intent_contract.py`), Lab the `validate.mjs` verdict, the generated types and both wire JSON codecs agree with the schema on every fixture, and every intent Lab builds and every result it reads is checked against the schema (`lab/worker` `task-intent-contract` and `intent` tests). A `proto/` change runs it too. Nothing here needs workerd; each app's check job runs the real-binding tests |
| `Infra checks` | `infra/`, `tools/infra-plan-summary/` or `.github/` changed | From `infra/`, with no Cloudflare token, state or plan: guards (no `external`/`http` data source, provisioner, other provider, email address or file outside the allowed kinds; [`infra_guard.py`](.github/scripts/infra_guard.py) reads the HCL structure), `tofu fmt -check`, `tofu init -backend=false -lockfile=readonly` and `tofu validate` (the locked provider download only), the [plan-summary](tools/infra-plan-summary/summary.py) and local-values tests. The checks of `infra/` against the apps' `wrangler.toml` files ([`test_infra_config.py`](.github/scripts/test_infra_config.py)) run in `Changes`. [`infra/README.md`](infra/README.md) |
| `Proto checks` | `proto/`, `.github/` or `tools/` changed, `contracts/ops-v1/` or `contracts/task-intent-v1/` changed (their fixtures are what both codecs round-trip), or a manual run | From `proto/`, no secret: `npm ci` (the pinned buf, protoc-gen-es and protobuf-es runtime), `buf format` and `buf lint` (STANDARD + COMMENTS), Google's api-linter (`npm run api-lint`: the version pinned in `proto/tools/api-linter/go.mod`, Go from `actions/setup-go` reading that file; first a check that the googleapis compiled into the linter equals `buf.lock`'s for every file the module imports), `buf breaking` (FILE) plus the wire profile's own rules against the `Changes` job's diff base (`fetch-depth: 0`; no base: `HEAD~1`, said in the log), the rules self-test, generation twice more compared byte for byte, the contracts' JSON Schemas generated from the IDL compared with the committed ones (`npm run check:schema`), [`test_proto.py`](.github/scripts/test_proto.py) (one runtime at the generator's version, every user wired the same way, `PROTO_USERS`), and both codecs' typecheck and tests on the same shared edge cases. A `proto/` change also checks every app in `PROTO_USERS` (Lab, Todofy, Mail Hero, the dashboard, the links app), runs `Contracts`, and deploys only the apps whose bundle the changed path reaches: the TypeScript runtime (`proto/ts/`, `buf.gen.yaml`) deploys Lab, Mail Hero, the dashboard and the links app, `lab/ui/` Lab, `links/ui/` the links app, the Python runtime and generators (`proto/python/`, `tools/gen_py.py`, `tools/wire_rules.py`) Todofy, `ops/` the four apps with an `Ops` entrypoint or caller (Lab, Mail Hero, the dashboard, Todofy), `todofy/taskintent/` Lab and Todofy, `prototest/` (the runtimes' fixtures) and `common/errors/` (types only) none, and the wire profile's options (`common/wire/`) and the module and toolchain files (`buf.yaml`, `buf.lock`, `package-lock.json`, `tools/ensure.mjs`) all five; tests, test data, the check scripts, the wire-type and schema generators, the api-linter tool module, check configs and Markdown deploy none. [`proto/README.md`](proto/README.md) |
| `CI gate` | always | Fails if any job above failed or was cancelled; skipped as unchanged (or as reused: it prints the reused run and its jobs) is fine. **The one check to require on `main`** |
| `Todofy deploy` | `main` only, `todofy/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts`, `contracts/task-intent-v1/task-intent-v1.ts` or a `proto/` path todofy-core bundles (the Python runtime and generators, `common/wire/`, `ops/`, `todofy/taskintent/`, the module and toolchain files) changed (or dispatched), after `CI gate` and all three Todofy jobs | Dry-run, the hostname guard on both configs, D1 migrations, deploy `todofy-core` then the gateway (the committed configs plus `deploy_vars.py`), `/health` and core probes. `production` environment, group `todofy-production` |
| `Mail Hero deploy` | `main` only, `mail-hero/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts` or a `proto/` path Mail Hero bundles (the TypeScript runtime, `common/wire/`, `ops/`, the module and toolchain files) changed (or dispatched), after `CI gate` | Write the secrets file, dry-run, the hostname guard (with Mail Hero's own token), D1 migrations, deploy (the committed config plus `deploy-vars.mjs`: the receive address and owner addresses as Worker secrets, the switches and `BUILD_SHA` as vars). `production` environment, group `mail-hero-production` |
| `Website deploy` | `main` only, `website/` outside `website/relay/` changed (or dispatched with `website`/`all`), after `CI gate` | Dispatches [`.github/workflows/website-release.yml`](.github/workflows/website-release.yml) (`gh workflow run`, `actions: write`) and returns, as the Notion buttons and the relay's detector do. That run builds the newest `main` commit whose push run passed `CI gate`: Notion sync, static export, verification under `wrangler dev`, the hostname guard (`pnpm release hostnames`, before anything is uploaded or recorded, and again in `deploy`), `wrangler versions upload`, `versions deploy` only if production still serves the recorded version, `triggers deploy` for the hostnames in `website/wrangler.toml` (the Custom Domains `www.ziyixi.science` and `ziyixi.science`, the Worker's complete set), live verification on both, rollback on failure, Notion feedback. An unchanged identity (newest `website/` commit, content, config) skips the deploy. The release job holds the group `website-production` and the `production` environment ([`website/docs/release.md`](website/docs/release.md)) |
| `Website relay deploy` | `main` only, `website/relay/` changed (or dispatched with `website`/`all`), after `CI gate` | `wrangler deploy` of the relay Worker `ziyixi-notion-publish` (keeps its Worker secrets, applies its cron), then a `/health` probe. `production` environment, group `website-relay-production` |
| `Lab deploy` | `main` only, `lab/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts`, `validate.mjs`, `contracts/task-intent-v1/task-intent-v1.ts` / `.schema.json` or a `proto/` path Lab bundles (the TypeScript runtime, `common/wire/`, `lab/ui/`, `ops/`, `todofy/taskintent/`, the module and toolchain files) changed (or dispatched), after `CI gate` and after `Todofy deploy` (success or skipped: its `TODOFY` binding names Todofy's `Ops`) | Build the UI, write the secrets file, dry-run (the bundle held to its budget), the hostname guard, apply the D1 migrations, deploy (the committed config plus `deploy-vars.mjs`), then a read of production through the API (one version at 100% whose `BUILD_SHA` is this commit, no pending D1 migration; Access answers every request before the Worker, so this is what shows the new code serves) and the dashboard's Access probe for `GET /` and `/api/v1/today` on `lab.ziyixi.science`. `production` environment, group `lab-production` |
| `FlowDay deploy` | `main` only, `flowday/` or `packages/edge-auth/` changed (or dispatched with `flowday`/`all`), after `CI gate` | Build and check the static export, write the secrets file, dry-run, the hostname guard, apply the D1 migrations, deploy (the committed config plus `deploy-vars.mjs`), then a read of production through wrangler with the deploy token (the Worker serves exactly one version at 100% whose `BUILD_SHA` is the commit, and no D1 migration is pending), the dashboard's Access probe for `GET /` and `/api/tasks` on its host `flowday.ziyixi.science` (`PUBLIC_HOST`), and a check that only the PWA files reach the Worker anonymously (manifest, icons and `/pwa/sw` 200 with their media types, `/pwa/sw.js` the Worker's 401). `production` environment, group `flowday-production` ([`flowday/README.md`](flowday/README.md) "Deploy") |
| `Links deploy` | `main` only, `links/`, `packages/edge-auth/` or a `proto/` path the links app bundles (the TypeScript runtime, `common/wire/`, `links/ui/`, the module and toolchain files) changed (or dispatched with `links`/`all`), after `CI gate` | Build the launcher, write the secrets file, dry-run (the bundle held to its budget), the hostname guard, apply the D1 migrations, deploy (the committed config plus `deploy-vars.mjs`), then FlowDay's read of production through wrangler (one version at 100% whose `BUILD_SHA` is this commit, no pending D1 migration), the dashboard's Access probe for `GET /_`, `/_/` and `/_/api/v1/links` on `s.ziyixi.science`, and a check that the rest of the host reaches the Worker without Access (`/robots.txt` 200 with the Worker's text, an unknown key the Worker's 302 to `/_/k/<key>`, both `no-store` and `noindex`). `production` environment, group `links-production` ([`links/README.md`](links/README.md) "Deploy") |
| `Dashboard deploy` | `main` only, `dashboard/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts` or a `proto/` path the dashboard bundles (the TypeScript runtime, `common/wire/`, `ops/`, the module and toolchain files) changed (or dispatched), after `CI gate` and after `Todofy deploy`, `Mail Hero deploy` and `Lab deploy` (each success or skipped: the service bindings need their `Ops` entrypoints live) | Build the UI, write the secrets file, dry-run, the hostname guard, deploy (the committed config plus `deploy-vars.mjs`; no D1), then a probe that an unauthenticated `GET /` and `/api/v2/home` are answered by Access with a 302 to its login page for this host (`<issuer>/cdn-cgi/access/login/<host>`), never by the app or another redirect. `production` environment, group `dashboard-production` |

A change to only `contracts/`, `.github/` or `tools/` (CI, test and build tooling; `tools/infra-plan-summary/` runs only `Infra checks`) re-checks every app but deploys none, except the contract
files the Workers bundle: the four TypeScript Workers bundle the constants of
`contracts/ops-v1/ops-v1.ts` (`OPS_LIMITS`), so a change to it deploys all four; Lab bundles
`validate.mjs` (its task intents), so a change to it deploys Lab; `ops-v1.schema.json` is generated and
bundled by none (every app reads ops-v1 with the code generated from `proto/ops/`); and
`contracts/task-intent-v1/task-intent-v1.ts` ships in Lab and Todofy's gateway (its schema in Lab only; the types come from `proto/`, `PROTO_USERS`) (`BUNDLED_BY` in `.github/scripts/ci_changes.py` maps each bundled
contract file to its apps; its test compares the map with the Workers' imports). Dispatch on `main` to
redeploy an app. A change to `packages/edge-auth/` runs `Shared packages` and checks **and deploys** all
three apps, because every Worker compiles it in; a change to only its Markdown documents
(`packages/<name>/**/*.md`, e.g. `README.md`, `SPEC.md`) runs `Shared packages` and checks the three apps
but deploys none (nothing of it is compiled in). `ci_changes.py` maps each package
to the apps that use it (`PACKAGE_USERS`); `test_ci_changes.py` fails unless that map matches every
`"file:../../packages/<name>"` dependency and lists every `packages/*/` directory, and a package missing
from it counts as used by every app. A dashboard-only change checks and deploys only the dashboard (and
runs `Contracts`); it never redeploys the apps it calls. Root-only files (`README.md`, `AGENTS.md`,
`packages/README.md`) run only `Changes` and `CI gate`.

The deploy jobs' `if:` must stay explicit: `!cancelled()` plus `needs.<job>.result == 'success'` for every
job they need (for `Dashboard deploy`, `success` or `skipped` for the two app deploys; for a check job,
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
[`tools/cf-guard`](tools/cf-guard/README.md) on that config with the job's own token, before any production
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

[`.github/workflows/mail-hero-backup-image.yml`](.github/workflows/mail-hero-backup-image.yml) builds Mail
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
| `Lab deploy` | none (Lab's pause is an owner setting; everything static is committed in `lab/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy and D1 migrations only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, [`lab/README.md`](lab/README.md) "Deploy secrets"), `LAB_CSRF_SIGNING_KEY` (Lab's own) |
| `FlowDay deploy` | none (everything static is committed in `flowday/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy, D1 migrations and the production check only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, as for Lab), `FLOWDAY_CSRF_SIGNING_KEY` and `FLOWDAY_CREDENTIAL_KEY` (FlowDay's own; the credential key seals the Todoist key in D1) |
| `Links deploy` | none (everything static is committed in `links/wrangler.toml`) | `CF_API_TOKEN` (hostname guard (read-only), deploy, D1 migrations and the production check only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES` (the dashboard's: the same owner, as for Lab and FlowDay), `LINKS_CSRF_SIGNING_KEY` (the links app's own) |
| `Dashboard deploy` | `DASHBOARD_CANARY_ENABLED` (exactly `true` or `false`; unset is refused) | `CF_API_TOKEN` (hostname guard (read-only) and deploy only; the secrets step also receives it to warn about reuse as the analytics token), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`, `DASHBOARD_CSRF_SIGNING_KEY`, `DASHBOARD_CF_ANALYTICS_TOKEN` (GraphQL Analytics only; to be replaced by an "Account Analytics: Read" token, [`dashboard/docs/setup.md`](dashboard/docs/setup.md) §4) |

Every Worker's production config is one committed file named `wrangler.toml` in the folder that names
the Worker: `mail-hero/wrangler.toml`, `todofy/wrangler.toml` (todofy-core), `todofy/gateway/wrangler.toml`
(the gateway `todofy`), `dashboard/wrangler.toml`, `website/wrangler.toml`, `website/relay/wrangler.toml`,
`lab/wrangler.toml`, `flowday/wrangler.toml` and `links/wrangler.toml`. The top level is production (no `[env.*]`, no `keep_vars`), and every static value is committed there:
account, D1 IDs, buckets, hostnames and routes, crons, compatibility settings, Durable Object bindings and
migrations, Access issuers and AUDs, limits and defaults. Changing one is a commit that checks and deploys
that app. Nothing is generated. What is never committed is added at deploy by each app's wrapper
(`mail-hero/deploy/deploy-vars.mjs`, `todofy/deploy/deploy_vars.py`, `dashboard/deploy/deploy-vars.mjs`,
`lab/deploy/deploy-vars.mjs`, `flowday/deploy/deploy-vars.mjs`, `links/deploy/deploy-vars.mjs`): the personal values and owner identities from the secrets above as Worker
secrets with `wrangler deploy --secrets-file` (wrangler and the Cloudflare dashboard show a plain var's
value), and with `--var NAME:value` the operational switches from the variables above (the only GitHub
variables CI reads, so a release restates the live switches and never overwrites them) and `BUILD_SHA`. A deploy without a var deletes it, so each wrapper refuses a missing or invalid value, `--env`,
`--keep-vars` and any other config; never run a plain `wrangler deploy` of these configs.
[`.github/scripts/test_wrangler_configs.py`](.github/scripts/test_wrangler_configs.py) (in `Changes`) checks
across apps: only these configs (and the runtime-test ones next to their tests) exist, none has `[env]` or
`keep_vars`, one account, the hosts are consistent (the dashboard's is its own; its links match the apps'),
every step that calls a wrapper sets every input, personal values come only from secrets and reach the
Workers only as Worker secrets, and no personal value, switch or build is committed. [`.github/scripts/test_drift_desired.py`](.github/scripts/test_drift_desired.py)
(also in `Changes`) checks that the dashboard's bundled desired state `dashboard/worker/src/drift-desired.json`
(names, types and flags only, for its private daily drift check, `dashboard/docs/design-v2.md` §10) equals a
fresh `python3 .github/scripts/drift_desired.py`: a change to any config or wrapper regenerates it in the same
commit. Local development uses local bindings only (never `--remote`, D1
commands with `--local`) and each app's `.dev.vars` (see its `.dev.vars.example`).

The repository is public, and Actions prints a step's variables in its log, so personal values (the receive
address, owner emails, the Todoist project id) are secrets even though they are not credentials. The backup image workflow uses only
the job's own `GITHUB_TOKEN`.

#### Rolling back the committed-config layout

Before the committed configs, CI generated each config from GitHub variables. These production variables
are still set but **nothing reads them now**; changing one has no effect (change the committed
`wrangler.toml` instead): `CLOUDFLARE_ACCOUNT_ID`, `MAIL_HERO_PUBLIC_HOST`, `MAIL_HERO_D1_DATABASE_ID`,
`MAIL_HERO_D1_DATABASE_NAME`, `MAIL_HERO_R2_BUCKET_NAME`, `MAIL_HERO_BACKUP_BUCKET_NAME`,
`MAIL_HERO_ACCESS_ISSUER`, `MAIL_HERO_ACCESS_AUDIENCE`, `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS`,
`MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT`, `MAIL_HERO_INGEST_DAILY_BYTE_LIMIT`, `TODOFY_PUBLIC_HOST`,
`TODOFY_D1_DATABASE_ID`, `TODOFY_HOOKS_HOSTS`, `TODOFY_ACCESS_ISSUER`, `TODOFY_ACCESS_AUDIENCE`,
`DASHBOARD_PUBLIC_HOST`, `DASHBOARD_ACCESS_ISSUER`, `DASHBOARD_ACCESS_AUDIENCE`.

They are the rollback path: reverting the layout's merge commit on `main` brings the generators back, CI
redeploys Mail Hero, both Todofy Workers (together, as `todofy/docs/ci-cd.md` requires) and the dashboard
from them, and a generator refuses a missing one ("Invalid or missing CI setting"). So keep all of them
until every Worker has had at least one successful deploy and one full cron cycle (a day) on the new
layout, and delete them in a follow-up change only after that. A revert deploys the values in these
variables, not the committed ones: if a committed value changed since the merge, update its variable
before reverting. Without them, the only rollback is Cloudflare's `wrangler rollback`, which Todofy allows
only for both Workers to their pre-merge pair; Mail Hero or the dashboard alone may be rolled back that
way in an emergency.
