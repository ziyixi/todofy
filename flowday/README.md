# FlowDay

FlowDay is a daily execution board for solo work: it shows your Todoist tasks, lets you pick what
belongs in today, order it as a queue, run a timer on one task at a time (time blocks, Pomodoro,
misc time), and review what actually happened.

Todoist is read-only for FlowDay. It never writes to Todoist; in this repository Todofy is the only
Todoist writer. Local tasks can be added without Todoist.

![FlowDay showing a planned day with arranged tasks, a task pool, and completed work](docs/readme/flowday-main.png)

## Status

FlowDay was imported from the standalone `ziyixi/FlowDay` repository (commit `10a8f43`, without its history) and
ported to Workers Free (F1): one Worker, `flowday`, serves the UI as a Next.js static export and a small owner API
on D1, behind Cloudflare Access. See [`docs/design.md`](docs/design.md) for the design, the D1 write budget and the
measurements.

It is **not deployed yet**. CI only checks it. There is no hostname, no route and no Cloudflare resource:
`wrangler.toml` holds all-zeros placeholders for the D1 id and the Access AUD, and the deploy wrapper refuses
anything but a `--dry-run` until F2. The container deployment is retired.

## Layout

| Path | What it is |
| --- | --- |
| `wrangler.toml` | The Worker's production config (static assets from `web/out`, D1 `DB`, no route yet) |
| `worker/` | The Worker: `src/` (router, Access and CSRF, API, D1 stores, the read-only Todoist sync), `test/` (Node unit tests; `test/runtime/` on workerd with real D1) |
| `migrations/` | D1 schema: `0001` is the container-era SQLite schema, unchanged; `0002` adds `tasks.todoist_project_id`; `0003` drops four indexes no query needs |
| `web/` | The UI (`app/`, `components/`, `features/`, `lib/`), its tests (`web/__tests__/`) and scripts |
| `deploy/` | `deploy-vars.mjs` (the deploy wrapper, Lab's shape) and its tests |
| `docs/design.md` | The Workers Free design: sync, write budget, limits, security, migration plan |
| `docs/prd.md` | Product requirements from the standalone repository (historical in parts) |
| `docs/ui-test-plan.md` | The UI test catalog; every `UI-###` id must match a Playwright test (`ui-test-plan-sync.test.ts`) |
| `docs/readme/`, `docs/ui-goldens/` | README figures and visual goldens, rendered from scripted synthetic data |

## Develop

Node.js 26 and npm.

```bash
cd flowday/worker && npm ci            # the Worker (and the pinned wrangler)
cd ../web && npm ci && npm run build   # the UI -> web/out
cd ../worker
cp ../.dev.vars.example ../.dev.vars   # synthetic local values
npx wrangler d1 migrations apply DB --local --config ../wrangler.toml
npm run dev                            # http://127.0.0.1:8789, local D1, loopback sign-in
```

| Where | Command | Use |
| --- | --- | --- |
| `worker/` | `npm run lint`, `npm run typecheck`, `npm test` | ESLint (strict, type-checked), tsc, Node unit tests |
| `worker/` | `npm run test:runtime` | workerd with real D1: schema, stores, API, Access/CSRF/PWA, sync, the write budget, CPU |
| `web/` | `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:imports` | ESLint (no `fetch` outside `lib/client/http.ts`), tsc, Vitest, the import audit |
| `web/` | `npm run build`, `npm run check:export` | The static export, then: no test code, manifest with credentials, PWA files present |
| `web/` | `npm run test:ui` | Playwright (`desktop` and `portrait`) against `wrangler dev` with an `E2E_TEST_MODE=1` export and a fresh local D1 (`scripts/e2e-server.mjs`) |
| `web/` | `npm run screenshots:readme[:check]`, `npm run screenshots:ui[:check]` | Regenerate (or compare) the README figures and the goldens |
| `flowday/` | `node --test deploy/test/*.test.mjs` | The committed config and the deploy wrapper |

`E2E_TEST_MODE=1` exports include the `window.__FLOWDAY_E2E__` bridge, and the Worker serves `/api/test/*` only
with `E2E_TEST_ROUTES=true` under the loopback bypass. Screenshots and goldens are rendered on Ubuntu 24.04 with a
fixed date, viewport and seed data, so compare them on the same platform.

Test data is always synthetic. Never commit a database file, a real task title, a screenshot of real
data or a Todoist token.

## Deploy

Not yet (F2). The deploy job will run `deploy/deploy-vars.mjs` like Lab's: the owner's addresses come from the
dashboard's GitHub secrets `DASHBOARD_ACCESS_OWNER(_ALIASES)`, and the CSRF key and the credential key (it seals
the Todoist key stored in D1) from FlowDay's own `FLOWDAY_CSRF_SIGNING_KEY` and `FLOWDAY_CREDENTIAL_KEY`. Until then
CI dry-runs the committed config with placeholder values and checks the bundle size.

## Feature tour

Plan the day with the wizard, which checks the plan against your daily capacity:

![FlowDay planning wizard with three tasks ready to add to the day](docs/readme/flowday-planning.png)

Drag tasks from the sidebar into the day flow:

![FlowDay dragging a task card from the sidebar into the empty day flow](docs/readme/flowday-drag.png)

Reorder the queue when priorities change:

![FlowDay dragging one planned task before another task in the day flow](docs/readme/flowday-reorder.png)

Run a timer on one task at a time:

![FlowDay running a timer on the first task in the day flow](docs/readme/flowday-timer.png)

Keep a small pop-out timer window open while working in other apps:

![FlowDay with a small floating pop-out timer window for the active task](docs/readme/flowday-popout.png)

Look at the next three or five days:

![FlowDay three-day view with planned tasks across today and upcoming days](docs/readme/flowday-multiday.png)

Review the day or the week:

![FlowDay analytics dialog showing daily review metrics and task breakdowns](docs/readme/flowday-analytics.png)
