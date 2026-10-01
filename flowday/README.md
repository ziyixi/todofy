# FlowDay

FlowDay is a daily execution board for solo work: it shows your Todoist tasks, lets you pick what
belongs in today, order it as a queue, run a timer on one task at a time (time blocks, Pomodoro,
misc time), and review what actually happened.

Todoist is read-only for FlowDay. It never writes to Todoist; in this repository Todofy is the only
Todoist writer. Local tasks can be added without Todoist.

![FlowDay showing a planned day with arranged tasks, a task pool, and completed work](docs/readme/flowday-main.png)

## Status

This directory is a snapshot of the standalone `ziyixi/FlowDay` repository (commit `10a8f43`),
imported without its history; the old repository keeps the history. It still runs the original
architecture: a Next.js app whose route handlers read and write a local SQLite file through
better-sqlite3. It is **not deployed** from this repository yet, and CI only checks it.

The plan is to move it to Workers Free: a static export of the UI served as Workers static assets, a
small Worker API and a D1 database, behind Cloudflare Access (see [`AGENTS.md`](AGENTS.md)). The
container deployment is retired.

## Layout

| Path | What it is |
| --- | --- |
| `web/` | The Next.js app (`app/`, `components/`, `features/`, `lib/`), its tests (`web/__tests__/`) and screenshot scripts |
| `docs/prd.md` | Product requirements and design notes from the standalone repository (historical in parts) |
| `docs/ui-test-plan.md` | The UI test catalog; every `UI-###` id must match a Playwright test (`ui-test-plan-sync.test.ts`) |
| `docs/readme/` | The figures of this README, regenerated from scripted synthetic data |
| `docs/ui-goldens/` | Visual regression goldens, also from synthetic data |

## Develop

Node.js 24 or newer and npm. Every command runs in `web/`:

```bash
cd flowday/web
npm ci
npm run dev        # http://localhost:3000; deletes web/db/flowday.db first
```

| Command | Use |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | Next.js route types, then `tsc --noEmit` |
| `npm test` | Vitest: unit and integration tests against a fresh local SQLite file |
| `npm run test:imports` | Rejects deprecated import paths |
| `npm run build` | Production build (standalone output) |
| `npm run prune:standalone` | After a build: fails if test routes, test markers, docs or database files leak into the standalone output |
| `npm run test:ui` | Playwright UI tests (`desktop` and `portrait` projects) against an `E2E_TEST_MODE=1` build |
| `npm run screenshots:readme[:check]` | Regenerate (or compare) the README figures in `../docs/readme` |
| `npm run screenshots:ui[:check]` | Regenerate (or compare) the goldens in `../docs/ui-goldens` |

`E2E_TEST_MODE=1` builds enable the `/api/test/*` seed routes and the `window.__FLOWDAY_E2E__` bridge;
normal builds leave them out. Screenshots and goldens are rendered on Ubuntu 24.04 with a fixed date,
viewport and seed data, so compare them on the same platform.

Test data is always synthetic. Never commit a database file, a real task title, a screenshot of real
data or a Todoist token.

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
