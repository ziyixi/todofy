# links: the owner's short links

`s.ziyixi.science/<key>` redirects to a target the owner chose: `s/gh` to GitHub, `s/gh/ziyixi/todofy` to that
repository, `s/q/some words` to a search. A launcher under `s.ziyixi.science/_/` lists, searches, creates, edits,
deletes and restores them, on a phone as well as a desktop.

Status (2026-10-01, step **L1**): the Worker, its D1 schema, the launcher and the owner API `links.ui.v1` are built and
checked in CI (`Links checks`), and **nothing is deployed**: there is no hostname, no D1 database, no Access application
and no deploy job yet. [`docs/design.md`](docs/design.md) §11 lists what step L2 creates.

| Path | What |
| --- | --- |
| `wrangler.toml` | The Worker `links`: no route yet, D1 `links` (placeholder id), static assets `web/dist` with `run_worker_first = ["/*", "!/_/assets/*"]`, invocation logs and traces off |
| `worker/` | The Worker (TypeScript): the redirect path (`src/resolve.ts`, `targets.ts`, `keys.ts`), the owner half under `/_/` (`src/http.ts`, `auth.ts`, the transcoder handlers in `api.ts`, D1 in `store.ts`) |
| `web/` | The launcher (TypeScript, no framework, Vite): built into `web/dist/_/` |
| `migrations/` | D1: `links`, `link_revisions`, `request_log` |
| `deploy/` | `deploy-vars.mjs` (the deploy wrapper; refuses a real deploy while the placeholders are committed), `bundle-size.mjs` (the Worker's gzip budget) |
| `../proto/links/ui/v1/` | The owner API's IDL (`links.ui.v1`, AIP-style, served by the shared transcoder) |

## What it does

- **Keys** are 1-63 characters of `a-z`, `0-9` and `-` (`^[a-z0-9][a-z0-9-]{0,62}$`), case-insensitive (stored in
  lower case). Reserved: `_`, `s`, `api`, `v1`, `search`, `cdn-cgi`, `favicon.ico`, `robots.txt`, `.well-known`.
- **Redirects** are always `302`, never `301`/`308` (a browser keeps those forever), with `Cache-Control: private,
  no-store`, `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`; `robots.txt` disallows everything. A redirect
  is one D1 read by primary key and writes nothing (no click count). The Worker never logs a key, a path or a target.
- **Visibility** is per link, **private** by default. A public link works for anyone. A private link works for the
  owner (the Access cookie of this host, verified by the Worker); for anyone else, a private key, an unknown key, a
  deleted one and an expired one all get the identical `302` to `/_/k/<key>` (behind Access), so keys cannot be
  enumerated. After login, `/_/k/<key>` redirects if the link resolves, else the launcher offers to create, restore or
  edit it.
- **Preview**: `/<key>+` shows where a link goes instead of going there (same visibility rule).
- **Passthrough** per link: `exact` (default; `/<key>/<rest>` is refused), `append` (`/<key>/<rest>` is appended to the
  target's path, each segment percent-encoded), `template` (one `{path}` in the target is replaced by the rest). The
  result must keep the target's origin, so no path turns a link into an open redirect. The query string never passes.
- **Targets** are `https:` only, without user name or password, at most 2,048 characters, never this host.
- **Edits** are revisions (the last 20 are kept), deletes are soft (purged 30 days later, by the next list or write),
  and the launcher's 撤销 is the API's own: delete after a create, rollback after an edit, undelete after a delete.
- **Import and export** as JSON Lines (one `links.ui.v1.Link` per line).

## Using it

Desktop Chrome: Settings → Search engine → Manage search engines and site search → Site search → Add: name `Short
links`, shortcut `s`, URL `https://s.ziyixi.science/%s`. Then type `s` and a space in the address bar, and `gh`,
`gh/ziyixi/todofy`, `gh ziyixi/todofy` or `q some words`. Chrome puts the text into the path with `/` kept and a
space as `%20`, and the key ends at the first `/` or space, so both spellings pass `ziyixi/todofy` on (an `append` or
`template` link; an `exact` one refuses a path). The launcher itself is `https://s.ziyixi.science/_/` (`/` redirects
there).

Phone: open `https://s.ziyixi.science/_/` once, log in through Access (the session lasts 7 days), then Share → Add to
Home Screen (iOS) or ⋮ → Add to home screen (Android). The launcher opens with the search box focused; type a key and
Enter (or Go) to follow it, or tap a row; a key that does not exist yet offers 新建. Short links themselves also work from
any app on the phone: public ones always, private ones in the browser that holds the Access cookie.

## Develop

```sh
cd links/worker && npm ci && cd ../web && npm ci   # npm ci also generates the proto code (proto/tools/ensure.mjs)
cd ../web && npm run build                          # web/dist, which the Worker serves
cp ../.dev.vars.example ../.dev.vars                # synthetic values only
cd ../worker
npx --no-install wrangler d1 migrations apply DB --local --config ../wrangler.toml   # local D1 only, never --remote
npm run dev                                         # http://127.0.0.1:8790, loopback sign-in under /_/
```

Locally, a short-link request without an Access token is anonymous and one with any `CF_Authorization` cookie is the
owner (the dev bypass, loopback only), so both sides of the visibility rule can be tried with `curl -H 'cookie:
CF_Authorization=dev'`. `cd web && npm run dev` serves the launcher with hot reload and proxies `/_/api` to the Worker.

Before committing, in `worker/`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:runtime`; in `web/`:
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; in `links/`: `node --test deploy/test/*.test.mjs`.

## CI

`Links checks` (`.github/workflows/ci.yml`) runs when `links/`, `packages/edge-auth/`, `proto/` or `.github/` change:
the config and wrapper tests, the Worker's lint, typecheck, unit and workerd runtime tests (real D1, a synthetic Access
issuer, the CPU test of `tools/workerd-cpu`), the launcher's checks and build (its JavaScript budget,
`web/scripts/js-budget.mjs`), an import guard, and a `--dry-run` of the committed config through the wrapper with
placeholder values plus the bundle budget. The app is `CHECK_ONLY` in `.github/scripts/ci_changes.py`: there is no
`links_deploy` output and no deploy job until L2.
