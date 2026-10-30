# links: agent notes

The root [`AGENTS.md`](../AGENTS.md) applies here too. Rules of the links app:

- **Deployed by CI only.** `Links deploy` (`.github/workflows/ci.yml`) is the only way to production: never a
  plain `wrangler deploy` (it deletes `BUILD_SHA`) and never a D1 command with `--remote` by hand. The one hostname is
  the Custom Domain `s.ziyixi.science`; only `/_` and `/_/*` are behind the path-scoped Access application `links`.
  Never add a hostname that this Access application does not cover in the same way, and never widen the application
  past `/_/*`: the deploy's probe fails when `/robots.txt` or a short link meets an Access login. A new hostname needs
  cf-guard's allowances (`tools/cf-guard/README.md`), set only in the commit that makes the change.
  `deploy/deploy-vars.mjs` still refuses a real deploy with an all-zeros D1 id or AUD.
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
  `{request_id, status, reason}` for a refused owner request and the backup's step, next time, prefixes, counts and
  error names. Tests and fixtures use synthetic links only; never commit
  the owner's real links, an export file or a screenshot of real data.
- **Workers Free.** 10 ms of CPU per request (the owner API is bounded by `src/limits.ts`: LINKS_MAX, a page of 100 or
  250, an import of 100 lines), and D1 writes stay minimal (`test/runtime/budget.test.ts`: two rows per create or edit).
  No KV and no cron trigger (Workers Free has five per account; the other apps use four); one SQLite Durable Object,
  `LinksBackup`, whose Alarm runs the daily backup. A redirect never reaches it: only Ops.status() and the owner's half
  arm it.
- **Backups** ([`docs/backup.md`](docs/backup.md)): every table and column of `migrations/` goes into the daily backup
  (`worker/src/backup.ts` `BACKUP_TABLES`; `test/runtime/backup.test.ts` fails on a table or column it lacks) and
  back through `tools/backup-restore.ts` (`RESTORE_ORDER`). Each Alarm runs one bounded step (under 50 D1 statements,
  and within 10 ms of CPU although an Alarm may use 30 s; `cpu.test.ts` measures each) and sets the next one
  (`worker/src/backup-alarm.ts`); a cursor moves only after its part is stored; the manifest is written
  last and a complete backup is never rewritten. Retention stays in the code (the newest 30), never an R2 lifecycle
  rule on `links-backups`. Home reads the backup's facts only through the `Ops` entrypoint (its `LINKS` binding).
- **The API is `links.ui.v1`** (`proto/links/ui/v1`, AIP-style, through the shared transcoder and client of
  `proto/ts`). Change the IDL there first (`npm run lint && npm run api-lint` in `proto/`), never hand-write a route
  under `/_/api/`.
- **Auth** is `packages/edge-auth` (`src/auth.ts`, SPEC §5.4): Access on everything under `/_/`, exact Origin, a nonempty custom CSRF header and JSON media type on every mutation. Do not reimplement or copy auth code.
- **Style and checks.** English comments, small cohesive modules. Run `bazel test //links:check` and
  `bazel build //links`; package build/test/type/lint commands use those declared targets. Interactive dev keeps local
  bindings. Explicitly authorized recovery is described separately in the backup runbook.
