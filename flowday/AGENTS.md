# FlowDay: agent notes

The root [`AGENTS.md`](../AGENTS.md) applies here too. FlowDay-specific rules:

- **Read-only Todoist.** FlowDay only reads Todoist (tasks and projects). Never add a Todoist write;
  Todofy is the only Todoist writer in this repository.
- **Public repository.** Never commit a database file, a Todoist token, an owner email, a real task
  title or a screenshot of real data. Tests, seeds, README figures and goldens use synthetic data only.
  The Todoist key is stored only sealed (AES-GCM under the `CREDENTIAL_KEY` secret, `worker/src/credentials.ts`);
  never store, export or log it in plain text.
  Never open the live FlowDay database; when a real copy is needed, copy it first and open the copy
  read-only (`file:<copy>?immutable=1`).
- **Status (F3).** CI deploys the Worker `flowday` (`worker/`, `migrations/`, `wrangler.toml`) with its static-export
  UI (`web/`) and its D1 migrations ("FlowDay deploy"). Its only hostname is the staging Custom Domain
  `flowday-next.ziyixi.science` (`PUBLIC_HOST`), covered by the Access apps "flowday" and, for `/pwa/*`,
  "flowday-bypass". Do not add a hostname, route or Cloudflare resource before the migration step that calls for it
  ([`docs/design.md`](docs/design.md) §11): `flowday.ziyixi.science` only in the F4 cutover commit (it sets both
  cf-guard allowances: the staging host's removal and the tunnel CNAME's takeover), and any new host only after the
  Access apps cover it. D1 migrations run against production on every deploy: keep each one readable
  by the container code (§11 F5).
- **Workers Free.** A static export of the UI as Workers static assets, a plain-fetch Worker API, D1 via
  `drizzle-orm/d1`, `packages/edge-auth` for the Access JWT plus Origin and CSRF checks on every
  mutation, and reviews and exports computed in the browser. Respect the Free limits: 10 ms CPU per
  request (`worker/test/runtime/cpu.test.ts`), 50 subrequests, 100 bound parameters per D1 statement
  (pass id lists as one JSON parameter to `json_each(?)`), no interactive transactions (one batch).
- **Requests.** Every UI request goes through `web/lib/client/http.ts` (ESLint rejects `fetch`
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
