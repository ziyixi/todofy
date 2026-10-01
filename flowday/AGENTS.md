# FlowDay: agent notes

The root [`AGENTS.md`](../AGENTS.md) applies here too. FlowDay-specific rules:

- **Read-only Todoist.** FlowDay only reads Todoist (tasks and projects). Never add a Todoist write;
  Todofy is the only Todoist writer in this repository.
- **Public repository.** Never commit a database file, a Todoist token, an owner email, a real task
  title or a screenshot of real data. Tests, seeds, README figures and goldens use synthetic data only.
  Never open the live FlowDay database; when a real copy is needed, copy it first and open the copy
  read-only (`file:<copy>?immutable=1`).
- **Status.** `web/` is the imported Next.js + better-sqlite3 app; it is checked in CI but not
  deployed. Do not add a hostname, route or deploy job until the migration step that calls for it.
- **Target (Workers Free).** A static export of the UI as Workers static assets, a plain-fetch Worker
  API, D1 via `drizzle-orm/d1`, `packages/edge-auth` for the Access JWT plus Origin and CSRF checks on
  every mutation, and analytics and export computed in the browser. Lay it out like `lab/`:
  `wrangler.toml` at this directory's root, `worker/`, `migrations/`, `web/`. Respect the Free limits:
  10 ms CPU per request, 50 subrequests, 100 bound parameters per D1 statement (pass id lists as one
  JSON parameter to `json_each(?)`), no interactive transactions (`db.batch`).
- **D1 writes stay minimal.** The 100,000 rows/day write allowance is shared by every app in the
  account, and each index touched counts as another row written. Sync reads only what changed in
  Todoist, writes only rows whose values changed, runs on page open, slow polling while the page is
  visible and a manual refresh, stops while hidden, and is throttled atomically on the server. Keep a
  typical day well under 1,000 rows written, with a test that proves it.
- **Next.js.** This Next.js version has breaking changes from older ones: read the relevant guide in
  `web/node_modules/next/dist/docs/` before changing framework code, and heed deprecation notices.
- **Style.** English code comments; small, tidy modules; run `npm run lint`, `npm run typecheck`,
  `npm test` and `npm run test:imports` in `web/` before committing.
