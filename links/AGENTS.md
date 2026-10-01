# links: agent notes

The root [`AGENTS.md`](../AGENTS.md) applies here too. Rules of the links app:

- **Not deployed (L1).** Do not add a hostname, route, Cloudflare resource or deploy job before the step of
  [`docs/design.md`](docs/design.md) §11 that calls for it, and never a host that the path-scoped Access application
  does not cover first. The committed D1 id and Access AUD are all-zeros placeholders; `deploy/deploy-vars.mjs`
  refuses any deploy but `--dry-run` while they are.
- **The redirect path is the product.** `GET /<key>` is one D1 read by primary key (`src/resolve.ts`), no write of any
  kind (no click count, no last-used time, no purge), no log line, and an Access verification only when the request
  carries a token. Keep it that way: `test/runtime/redirect.test.ts` checks that the tables are unchanged and nothing
  is logged, and `cpu.test.ts` holds its CPU to about a millisecond.
- **No enumeration.** For a request that is not the owner's, a private, unknown, deleted or expired key must give a
  byte-identical answer (the 302 to `/_/k/<path>`). Never add a header, status, body or timing branch that depends on
  whether a private key exists.
- **Only 302.** Never 301 or 308, never a cacheable redirect (`private, no-store`).
- **No open redirect.** Build every destination with the URL API from the stored target; percent-encode the request's
  path segment by segment; refuse dot segments, encoded separators and control characters; the result must keep the
  stored target's origin (`src/targets.ts`). No query passthrough.
- **Never log keys, paths or targets.** Invocation logs and traces are off in `wrangler.toml`; the Worker logs only
  `{request_id, status, reason}` for a refused owner request. Tests and fixtures use synthetic links only; never commit
  the owner's real links, an export file or a screenshot of real data.
- **Workers Free.** 10 ms of CPU per request (the owner API is bounded by `src/limits.ts`: LINKS_MAX, a page of 100 or
  250, an import of 100 lines), and D1 writes stay minimal (`test/runtime/budget.test.ts`: two rows per create or edit).
  No KV, no cron, no Durable Object.
- **The API is `links.ui.v1`** (`proto/links/ui/v1`, AIP-style, through the shared transcoder and client of
  `proto/ts`). Change the IDL there first (`npm run lint && npm run api-lint` in `proto/`), never hand-write a route
  under `/_/api/`.
- **Auth** is `packages/edge-auth` (`src/auth.ts`, SPEC §5.4): Access on everything under `/_/`, Origin and the CSRF
  token on every mutation. Do not reimplement or copy auth code.
- **Style.** English code comments; small modules. Before committing run, in `worker/`, `npm run lint`, `npm run
  typecheck`, `npm test` and `npm run test:runtime`; in `web/`, `npm run lint`, `npm run typecheck`, `npm test` and
  `npm run build`; in `links/`, `node --test deploy/test/*.test.mjs`.
