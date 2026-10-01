# links: the owner's short links

`s.ziyixi.science/<key>` redirects to a target the owner chose: `s/gh` to GitHub, `s/gh/ziyixi/todofy` to that
repository, `s/q/some words` to a search. A launcher under `s.ziyixi.science/_/` lists, searches, creates, edits,
deletes and restores them, on a phone as well as a desktop.

Status (2026-10-01, step **L2**): the D1 database `links` and the path-scoped Access application `links`
(`s.ziyixi.science/_/*` and the exact `s.ziyixi.science/_`, the owner's identities, a 7-day session) exist, and CI's
`Links deploy` deploys the Worker on its one Custom Domain `s.ziyixi.science` ([Deploy](#deploy)). The rest of the host
stays outside Access: short links reach the Worker anonymously. Next is L3, the owner's own links
([`docs/design.md`](docs/design.md) §11).

| Path | What |
| --- | --- |
| `wrangler.toml` | The Worker `links`: the Custom Domain `s.ziyixi.science`, D1 `links`, the Access issuer and AUD, static assets `web/dist` with `run_worker_first = ["/*", "!/_/assets/*"]`, invocation logs and traces off |
| `worker/` | The Worker (TypeScript): the redirect path (`src/resolve.ts`, `targets.ts`, `keys.ts`), the owner half under `/_/` (`src/http.ts`, `auth.ts`, the transcoder handlers in `api.ts`, D1 in `store.ts`) |
| `web/` | The launcher (TypeScript, no framework, Vite): built into `web/dist/_/` |
| `migrations/` | D1: `links`, `link_revisions`, `request_log` |
| `deploy/` | `deploy-vars.mjs` (the deploy wrapper: `BUILD_SHA` as a var, the owner and CSRF key as Worker secrets; refuses a real deploy with an all-zeros D1 id or AUD), `bundle-size.mjs` (the Worker's gzip budget) |
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

Desktop Chrome (from L2, once per Chrome profile; the setting syncs with the profile): open
`chrome://settings/searchEngines` (Settings → Search engine → Manage search engines and site search), then Site
search → Add: name `Short links`, shortcut `s`, URL `https://s.ziyixi.science/%s`, and Add. Then type `s` and a space
(or Tab) in the address bar, and `gh`,
`gh/ziyixi/todofy`, `gh ziyixi/todofy` or `q some words`. Chrome puts the text into the path with `/` kept and a
space as `%20`, and the key ends at the first `/` or space, so both spellings pass `ziyixi/todofy` on (an `append` or
`template` link; an `exact` one refuses a path). The launcher itself is `https://s.ziyixi.science/_/` (`/` redirects
there). A private link needs the Access cookie of this host in that profile: open the launcher once and log in, then
private links redirect without a login page for the 7 days of the session (after it, a private key goes through the
login and then on to its target).

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

`Links checks` (`.github/workflows/ci.yml`) runs when `links/`, `packages/edge-auth/`, `proto/`, `contracts/`, `tools/`
or `.github/` change (the last three re-check every app and deploy none): the config and wrapper tests, the Worker's
lint, typecheck, unit and workerd runtime tests (real D1, a synthetic Access issuer, the CPU test of
`tools/workerd-cpu`), the launcher's checks and build (its JavaScript budget, `web/scripts/js-budget.mjs`), an import
guard, and a `--dry-run` of the committed config through the wrapper with placeholder values plus the bundle budget.

## Deploy

Only from GitHub Actions: `Links deploy` (`.github/workflows/ci.yml`) runs on `main` after `CI gate` when `links/`,
`packages/edge-auth/` or a `proto/` path the app bundles (the TypeScript runtime, `proto/links/ui/`, the module and
toolchain files) changed, or on a dispatch with `links` or `all`, in the `production` environment and the group
`links-production`. It builds the launcher, writes the secrets file, dry-runs (the bundle held to its budget), runs the
hostname guard (`tools/cf-guard`, no allowance: `s.ziyixi.science` had no DNS record before L2), applies the D1
migrations (`wrangler d1 migrations apply DB --remote`), deploys through `deploy/deploy-vars.mjs`, and then checks
production:

- through the API with the deploy token (nothing anonymous shows the build): the Worker serves exactly one version at
  100%, its `BUILD_SHA` is the commit, and no migration is pending;
- the owner's half, anonymously: `GET /_` (the Access application's exact destination), `/_/` and `/_/api/v1/links`
  are answered by Access with a 302 to its login page for this host (the dashboard's probe);
- the rest of the host, anonymously: `/robots.txt` is the Worker's own 200 `text/plain` "Disallow: /", and
  `/some-unknown-key` the Worker's 302 to `https://s.ziyixi.science/_/k/some-unknown-key` (what a private, deleted or
  expired key gets too), both `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`. A 302 to the Access
  login page there means the Access application covers more than `/_/*`. Never make a public link with that key.

The deploy token is `CF_API_TOKEN`, as for Lab and FlowDay. The wrapper writes three Worker secrets:

| Worker secret | From the `production` environment secret | Why |
| --- | --- | --- |
| `ACCESS_OWNER` | `DASHBOARD_ACCESS_OWNER` | the links app's owner is the dashboard's owner: one person with the same Access identities, so it reuses the dashboard's secret (as Lab and FlowDay do) instead of a copy that could drift |
| `ACCESS_OWNER_ALIASES` | `DASHBOARD_ACCESS_OWNER_ALIASES` | as above |
| `CSRF_SIGNING_KEY` | `LINKS_CSRF_SIGNING_KEY` (the links app's own) | a separate key per app: a token of one app never verifies at another |

Inside the job the inputs keep their `LINKS_*` names; only the job's `env:` maps the owner's two to the dashboard's
secrets, and `.github/scripts/test_wrangler_configs.py` checks that mapping (and that the dashboard's, Lab's, FlowDay's
and this wrapper accept the same owner values). A change to either owner secret reaches the links app only with its
own deploy: after changing one, dispatch `all` (or `dashboard`, `lab`, `flowday` and `links`), as
[`../dashboard/docs/setup.md`](../dashboard/docs/setup.md) §3 says. The CSRF key is 64 hex characters, made where `gh`
is logged in and never pasted anywhere; rotating it is the same command followed by a links deploy (an open launcher
then fetches a new token):

```sh
openssl rand -hex 32 | gh secret set LINKS_CSRF_SIGNING_KEY -R ziyixi/todofy --env production
```

The dashboard's daily drift check compares the live Worker with `dashboard/worker/src/drift-desired.json`
(generated by `.github/scripts/drift_desired.py`: these three secrets, `BUILD_SHA`, the config's bindings and the
Custom Domain), and its registry names the Worker and the D1 database under the hidden entry 短链接 (no tile). The D1
database and the Access application "links" are managed by `infra/` since IaC P4 (`infra/README.md`): change them there,
not by hand, and "Infra drift" checks every day that `database_id` and `ACCESS_AUDIENCE` here equal the live objects.

### Rollback

A deploy without `routes` leaves an attached Custom Domain in place, so: detach `s.ziyixi.science` from the Worker
`links` by hand in the Cloudflare dashboard (Workers & Pages → links → Settings → Domains & Routes), then revert the
L2 commit. The D1 database and the Access application can stay, or be deleted by hand after an export through the
launcher (导出). To roll back the code only, revert the commit that broke it: the next `Links deploy` ships the revert
and keeps the host.
