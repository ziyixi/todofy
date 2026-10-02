# FlowDay: agent notes

The root [`AGENTS.md`](../AGENTS.md) applies here too. FlowDay-specific rules:

- **Read-only Todoist.** FlowDay only reads Todoist (tasks and projects). Never add a Todoist write;
  Todofy is the only Todoist writer in this repository.
- **Public repository.** Never commit a database file, a Todoist token, an owner email, a real task
  title or a screenshot of real data. Tests, seeds, README figures and goldens use synthetic data only.
  The Todoist key is stored only sealed (AES-GCM under the `CREDENTIAL_KEY` secret, `worker/src/credentials.ts`);
  never store, export or log it in plain text.
  Never open the live FlowDay database; when a real copy is needed, copy it first and open the copy
  read-only (`file:<copy>?immutable=1`), or, when its WAL must be applied, let `deploy/migrate/flowday_migrate.py
  export` checkpoint a second copy in a private local directory (`mktemp -d`; never in the repository or a
  cloud-synced folder). Never print a row of it, and run any wrangler command that returns rows with
  `WRANGLER_WRITE_LOGS=false` (wrangler otherwise keeps all it prints in a debug log in its config directory).
- **Status (F4 done).** CI deploys the Worker `flowday` (`worker/`, `migrations/`, `wrangler.toml`) with its
  static-export UI (`web/`) and its D1 migrations ("FlowDay deploy"). Its only hostname is the production Custom
  Domain `flowday.ziyixi.science` (`PUBLIC_HOST`), covered by the Access apps "flowday" and, for `/pwa/*`,
  "flowday-bypass"; the cutover commit's deploy detached the staging host `flowday-next.ziyixi.science` and
  replaced the tunnel CNAME, which had to be deleted by hand right before it (the Custom Domain API refuses an
  existing DNS record it did not create, error 100117; the two cf-guard allowances were set for that commit only
  and are cleared again). F5 (the rollback window) keeps the old container stopped and untouched. Do not add a hostname, route or Cloudflare resource before the migration step that calls for
  it ([`docs/design.md`](docs/design.md) §11), and any new host only after the Access apps cover it. D1 migrations run against production on every deploy: keep each one readable
  by the container code (§11 F5).
- **Workers Free.** A static export of the UI as Workers static assets, a plain-fetch Worker API, D1 via
  `drizzle-orm/d1`, `packages/edge-auth` for the Access JWT plus Origin and CSRF checks on every
  mutation, and reviews and exports computed in the browser. Respect the Free limits: 10 ms CPU per
  request (`worker/test/runtime/cpu.test.ts`), 50 subrequests, 100 bound parameters per D1 statement
  (pass id lists as one JSON parameter to `json_each(?)`), no interactive transactions (one batch).
- **Owner API.** `proto/flowday/ui/v1` (`flowday.ui.v1`) is the one description of every route the UI calls: change
  the IDL first (`proto/README.md`, HTTP APIs), then the Worker's handler (`worker/src/api.ts`) and the UI's client
  (`web/lib/client/flowday-api.ts`, the only module of API calls; the UI's view models are built there, never a
  hand-written wire type). Keep lists paged at sizes `worker/test/runtime/cpu.test.ts` holds within the CPU limit as an
  isolate's first request, count every repeated field of a page against its bound, and keep `worker/src/warmup.ts`
  in step with each list's query and answer. A page seeks to its cursor through an index and reads about its own D1
  rows, never a whole table sliced (`worker/test/runtime/reads.test.ts`: the account's 5 million reads a day are
  shared). An empty repeated field never selects a broad action, and an `IMMUTABLE` field is never silently ignored
  (AIP-203). The routes before it answer 410 `reload_required` until 2026-11-02: remove them in the first FlowDay
  change after that day.
- **Requests.** Every UI request goes through `web/lib/client/http.ts`, the client's transport (ESLint rejects `fetch`
  elsewhere): CSRF, one retry on an expired token, visible failures. Never swallow a failed write.
- **D1 writes stay minimal.** The 100,000 rows/day write allowance is shared by every app in the
  account, and each index touched counts as another row written. Sync reads only what changed in
  Todoist, writes only rows whose values changed, runs on page open, slow polling while the page is
  visible and a manual refresh, stops while hidden, and is throttled atomically on the server. Keep a
  typical day well under 1,000 rows written: `worker/test/runtime/sync.test.ts` and `budget.test.ts`
  prove it. Remember that SQLite rewrites an index entry whenever its column is in an UPDATE's SET list, and
  add an index only for a query that needs it (each one costs a row on every insert).
- **Bounded sync work.** One request applies at most `SYNC_CHUNK` Todoist items and parses at most
  `MAX_SYNC_ITEMS`/`MAX_SYNC_BYTES`; check a cap change against the cold first run in `cpu.test.ts`.
- **Next.js.** This Next.js version has breaking changes from older ones: read the relevant guide in
  `web/node_modules/next/dist/docs/` before changing framework code, and heed deprecation notices.
- **Style.** English code comments; small, tidy modules. Before committing run, in `worker/`, `npm run
  lint`, `npm run typecheck`, `npm test` and `npm run test:runtime`; in `web/`, `npm run lint`, `npm run
  typecheck`, `npm test`, `npm run test:imports`, `npm run build` and `npm run check:export`.
