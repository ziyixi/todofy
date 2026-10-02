# links: design

The owner's short links on `s.ziyixi.science`, decided by the owner on 2026-10-01 (all recommended defaults of the
research report). This document is the reference for the code under `links/` and `proto/links/ui/v1`; section numbers
are cited from the code.

## 1. Scope

- One owner, a few hundred links (at most `LINKS_MAX`, 1,000), on Workers Free at $0: one Worker, one D1 database, no
  KV, no Durable Object, no cron, no queue.
- Owner-defined keys and targets. No click analytics, no last-used time, no link shortening for others.
- A launcher (`/_/`) that filters as you type, mobile first, usable as a home-screen bookmark; light and dark; no
  external resources.

## 2. URLs

| Path | Who | Answer |
| --- | --- | --- |
| `/<key>`, `/<key>/<rest>`, `/<key>%20<rest>` | anyone | the redirect, or the continuation (§4) |
| `/<key>+`, `/<key>+/<rest>` | anyone | the preview page, or the continuation |
| `/` | anyone | `302 /_/` |
| `/robots.txt` | anyone | `Disallow: /` for every agent |
| any other path (no usable key, a reserved key, a rest over 1,024 characters) | anyone | `404` text |
| `/_` | anyone (Access covers it) | `302 /_/` |
| `/_/` | owner | the launcher page |
| `/_/assets/*` | owner (Access at the edge) | the launcher's hashed files, served by the asset layer without the Worker |
| `/_/k/<key>[+][/<rest>]` | owner | the live link's answer (redirect or preview), else the launcher, which offers to create, restore or edit the key |
| `/_/api/csrf` | owner | the CSRF token (transport) |
| `/_/api/v1/...` | owner | `links.ui.v1` (§6) |

Keys: `^[a-z0-9][a-z0-9-]{0,62}$` after ASCII lower-casing (`GH` is `gh`); reserved `_`, `s`, `api`, `v1`, `search`,
`cdn-cgi`, `favicon.ico`, `robots.txt`, `.well-known`. `_` is the one prefix no key can take, so everything of the
owner's lives under `/_/` and the rest of the host stays free for keys. The key ends at the first `/` or encoded space:
a browser's site search (`s.ziyixi.science/%s`) sends `s gh ziyixi/todofy` as `/gh%20ziyixi/todofy`.

Every answer of the Worker is `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and the strict CSP (`packages/edge-auth`
`withPrivateHeaders`). Redirects are `302` only: a `301` or `308` would be kept by browsers forever and outlive an edit
or a delete.

`wrangler.toml` sends every request to the Worker first except `/_/assets/*` (`run_worker_first = ["/*",
"!/_/assets/*"]`) and sets no `not_found_handling`: with the single-page-application fallback a key path that is not a
file would be answered with the launcher's `index.html` by the asset layer. The launcher's files carry their headers
through `_headers` (`web/_headers`, copied to `web/dist/_headers` by the build).

## 3. Targets and passthrough

A target is an absolute `https:` URL of at most 2,048 characters, without whitespace, control characters, user name or
password, on another host than `PUBLIC_HOST` (no loops). `exact` and `append` targets are stored as the URL parser
writes them; a `template` target holds exactly one `{path}` after its authority and is stored as written.

The path after the key (the "rest") reaches the target by the link's `path_mode`:

- `exact` (the default): none; a request with a rest gets `404` ("takes no path").
- `append`: each segment of the rest, decoded and percent-encoded again, is appended to the target's path; the target's
  query and fragment stay.
- `template`: `{path}` is replaced by the rest, segment by segment when `{path}` is in the path, as one
  percent-encoded value (slashes included) when it is in the query or fragment.

Every destination is built with the URL API, and a rest is refused (`404`) when a segment does not decode, is `.` or
`..`, hides a `/` or `\` in an escape, or holds a control character; the result must keep the origin of the stored
target and stay under 4,096 characters. So `/<key>/@evil.example`, `//evil.example`, `%2F%2Fevil.example` or
`..%2F..` cannot turn a link into an open redirect (`worker/test/targets.test.ts`, `test/runtime/redirect.test.ts`).
The request's query string never passes through.

## 4. Visibility and the redirect path

Each link is `private` (the default) or `public`. `src/resolve.ts`:

1. Parse the path (§2). Not a key: `404`.
2. Read the link: `SELECT target, path_mode, visibility, description, expire_time, delete_time FROM links WHERE key = ?`,
   one primary-key search (the table is `WITHOUT ROWID`). Nothing is written, ever: no click count, no purge.
3. The link is *live* when it exists, is not deleted and has not expired. A live public link is answered for anyone.
   A live private link is answered when the request is the owner's: only a request that carries an Access token (the
   `CF_Authorization` cookie Access sets for the host, or the header) is verified (`packages/edge-auth`, the cached
   keys of the issuer), and any failure (another person, an expired or forged token, keys that cannot be fetched,
   Access not configured) reads as anonymous. An anonymous request never fetches the keys.
4. Anything else, a private key for an anonymous request, an unknown key, a deleted or expired one, gets the same
   `302` to `/_/k/<the same path>`. That answer is built from the request path alone, with the same headers and an
   empty body, after the same one read, so it says nothing about whether a private key exists
   (`redirect.test.ts` compares the answers byte for byte). Behind Access, `/_/k/...` redirects the owner if the link
   resolves by then, or opens the launcher on that key.
5. Nor does its timing. Every request that is not for a live public link asks whether it is the owner's, whether or
   not the key exists: a request with a token (even a forged one) is verified, and on an isolate without the issuer's
   keys that includes fetching them, for an unknown key exactly as for a private one. Were the check made only for a
   live private row, a forged well-formed cookie would make private keys measurably slower than unknown ones
   (`resolve.test.ts` and `access.test.ts` "a forged token on a short link" hold this). A request without a token,
   and any request for a live public link, verifies nothing.

The Worker logs nothing on this path (never a key, a path or a target), and `wrangler.toml` turns invocation logs and
traces off, since they record each request's URL. A D1 failure is a `503` with `Retry-After: 5`, the same for every
key.

## 5. Storage (D1 `links`, `migrations/0001_init.sql`)

- `links` (`WITHOUT ROWID`, key as primary key): target, path_mode, visibility, description, tags (a JSON array),
  expire_time, create_time, update_time, delete_time, purge_time, revision and revision_time (the current revision),
  etag (16 random hex digits, new on every write). The only secondary index is `links_purge (purge_time) WHERE
  purge_time IS NOT NULL`, which costs a write only for deleted rows.
- `link_revisions` (`WITHOUT ROWID`, `(key, revision)`): the content of each change, the last 20 per link.
- `request_log` (`WITHOUT ROWID`, request_id: a UUID4, which the transcoder checks, of 36 characters, which a `CHECK`
  holds): the first response of each mutation sent with a request ID, for 24 hours, with the rpc (`method`) and the resource it named (`name`, `links/<key>`, empty for an
  import). A repeat is answered with that response only when both match; the ID reused for another rpc or link is
  `INVALID_ARGUMENT` (`BAD_REQUEST`) and applies nothing.

Soft delete (AIP-164): a delete sets `delete_time` and `purge_time` (30 days later). Every list and every write batch
first purges what is due: deleted links past their purge time with their revisions, and request IDs older than a day.
There is no cron; a store nobody touches keeps its deleted rows, which no read returns once due.

D1 has no interactive transactions, so each write is one batch built from what the request read: every `UPDATE` is
conditional on the etag it read, every derived row (the revision, the request log entry) is inserted only where the
link now carries the new etag, and a lost race reads again and answers what it finds (`src/store.ts`). D1 writes per
action, measured with `meta.rows_written` (`test/runtime/budget.test.ts`): a create 2 rows (3 with a request ID), an
edit 2, a delete 2 (the purge index), a list with nothing due 0, an import 2 per new link.

## 6. The owner API (`links.ui.v1`)

`proto/links/ui/v1` (`link.proto`, `errors.proto`, `links_ui_service.proto`), AIP-style, served by the shared transcoder
(`proto/ts/http-transcoder.ts`) under `/_/api/v1/` and called by the launcher through the shared client; errors are
`google.rpc.Status` with the reasons of `links.ui.v1.ErrorReason` and `common.errors.v1.CommonReason`, in the domain
`s.ziyixi.science`. The resource is `links/{link}`:

| rpc | HTTP | Notes |
| --- | --- | --- |
| GetLink | `GET /_/api/v1/{name=links/*}` | deleted links too until purged |
| ListLinks | `GET /_/api/v1/links` | key order, `page_size` (100), AIP-158 tokens bound to `filter` and `show_deleted`, AIP-160 literals over key, description, target and tags |
| CreateLink | `POST /_/api/v1/links?link_id=` | `LINK_EXISTS` (with the link as a detail) for a live or not yet purged deleted key, `LINKS_FULL` |
| UpdateLink | `PATCH /_/api/v1/{link.name=links/*}` | AIP-134 `update_mask`; the link's `etag` (AIP-154) as a precondition when sent; a new revision |
| DeleteLink | `DELETE /_/api/v1/{name=links/*}` | soft; answers the deleted link; `NOT_FOUND` (404, the link as a detail) when it is deleted already (AIP-164) |
| UndeleteLink | `POST ...:undelete` | `NOT_DELETED`, `ALREADY_EXISTS` (409), for a live link (AIP-164) |
| ListLinkRevisions | `GET ...:listRevisions` | newest first |
| RollbackLink | `POST ...:rollback` | a kept revision's content as a new revision; the link's `etag` (AIP-154) as a precondition when sent |
| ImportLinks | `POST /_/api/v1/links:import` | JSON Lines, at most 100 links and 65,536 characters; every bad line is reported, the rest is written in one batch |
| ExportLinks | `GET /_/api/v1/links:export` | JSON Lines of the live links, 250 per page |

Every mutation takes an AIP-155 `request_id`; a repeat within 24 hours answers the first response and writes nothing,
and the same ID sent with another rpc or for another link is refused (`BAD_REQUEST`), never answered with another
call's response.
The launcher's undo is the API's own: DeleteLink after a create, RollbackLink to the previous revision after an edit,
UndeleteLink after a delete, each with the etag of the change it undoes, so an undo never reverts a later change made
in another tab or on the phone (`ETAG_MISMATCH`, and the launcher shows the current link). Value rules the IDL cannot express are in `worker/src/limits.ts` (which the launcher
imports) and in each field's comment.

## 7. Authentication

`packages/edge-auth` with the dashboard's parameters (SPEC §5.4): Access JWT (RS256, the issuer's keys cached 10
minutes), the owner and aliases matched case-insensitively. Under `/_/` every request must be the owner; every method
but GET also needs the same-origin `Origin` (`https://s.ziyixi.science`) and the signed double-submit CSRF token (cookie
`links_csrf`, header `X-CSRF-Token`), checked by the transcoder's `authorize` hook before the body is read.

The Access application (created in L2) is path-scoped: `s.ziyixi.science/_/*` plus the exact `s.ziyixi.science/_`, the
owner's identities only, a 7-day session. Short links are outside it; the Worker reads the Access cookie there itself
(§4). The Worker verifies the JWT on `/_/` too, so a missing or misconfigured Access application never opens the owner
API.

Local development: `DEV_AUTH_BYPASS=true` signs the owner in over loopback http (never through Cloudflare's edge);
on a short link only a request that carries a token is checked, so `curl` without a cookie is anonymous and with any
`CF_Authorization` cookie the owner.

## 8. Workers Free

Measured in workerd with `tools/workerd-cpu` (reference machine, 2026-10-01, `test/runtime/cpu.test.ts`, no dev
bypass): the isolate's first request (a redirect) 1.25-1.56 ms, a warm redirect 0-0.4 ms (the sampler's resolution),
the owner's private redirect with the cookie verified 0.4 ms warm (1.95 ms for its first RS256 verification). The
isolate's first owner API request (a one-link list page, the transcoder's, codec's and handlers' first run) is measured
on its own: 3.3-4.5 ms (five runs, 2026-10-01). After it, first runs and warm medians: a full list page of 100 links
2.5-3.0 / 1.4-1.9 ms, a filter over 1,000 links 1.6-2.5 / 1.4-1.6 ms, an export page of 250 links 2.2-2.8 / 2.0-2.2 ms,
an import of 100 lines 3.7-4.4 / 1.7-2.0 ms (its first run is also the isolate's first mutation: the CSRF check and the
first request body). The test holds redirects to 3 ms first and 1.5 ms warm, the isolate's first API request to 9 ms,
every other API path to 7 ms first and 5 ms warm: reference milliseconds, the medians of three fresh isolates measured
one after another, each isolate's numbers divided by its own measured speed (`tools/workerd-cpu` and its README;
GitHub runners read the first request 1.0-1.7 ms and the first API request 3.2-4.3 ms, single isolates). Before the
first API request was measured apart, the full list page carried it (4.9-5.3 ms against 7 ms) and failed once of ten
runs on a machine loaded with nine busy processes; measured apart, eight such loaded runs passed (speed 2.4-2.8). An
export of all 1,000 links in one answer measured about 5 ms, which is why it is paged.

Bundles: the Worker 300 KiB raw, 71.9 KiB gzip (budget 82 KiB, set at 67.5 KiB, `deploy/bundle-size.mjs`; 68.4 KiB
before the wire codec gained its value-rule checker and the `common/wire/v1` descriptors with ops-v1); the
launcher's JavaScript 37.5 KiB gzip (budget 45 KiB, `web/scripts/js-budget.mjs`): the protobuf-es runtime and the
embedded `links.ui.v1` descriptors are most of both.

## 9. Tests

- `worker/test/*.test.ts` (Node): keys and paths, targets and every passthrough mode with open-redirect attempts, the
  wire form of a link (the export's hand-written JSON equals the codec's), the preview page's escaping, and the
  redirect read against a recording D1 (one `SELECT ... WHERE key = ?` through `first()`, nothing else).
- `worker/test/runtime/*.test.ts` (workerd, real D1, `harness.ts`): `redirect` (headers, visibility, the byte-identical
  enumeration answer, passthrough, previews, no SPA fallback, no write and no log), `access` (RS256 tokens of a synthetic
  issuer, the cookie on short links, keys unavailable), `api` (the whole owner API), `schema`, `budget` (rows written
  per action) and `cpu`.
- `web/src/*.test.ts` (jsdom): the launcher's logic, the transport (CSRF renewal, retries), the page against a fake API
  served by the same shared transcoder, and the no-external-request rules.
- `deploy/test/*.test.mjs`: the committed config (assets, observability, the one Custom Domain, the real D1 id and
  AUD) and the deploy wrapper (it still refuses a real deploy with an all-zeros id or AUD).
- `.github/scripts/test_ci_changes.py` runs the `Links deploy` checks of production against a stubbed `npx` and
  `curl` (`LinksProductionCheck`, `AccessProbe`, `LinksWorkerProbe`).

All data is synthetic.

## 10. The launcher

One screen (`web/src/view.ts`): a sticky search box (focused on load, `/` focuses it), the list ranked as you type
(exact key, key prefix, key substring, then description, target and tags), Enter opens the best match with the typed
rest (`gh ziyixi/todofy` opens `/gh/ziyixi/todofy`), arrow keys move the selection. Each row: the key, public or private,
expired or deleted, the description and target; 复制 (the short URL), 编辑, 删除 or 恢复. A key that does not exist is
offered as 新建. Every change shows a toast with 撤销. 显示已删除 lists deleted links for restoring. 导出 downloads every
page of ExportLinks as one `.jsonl` file; 导入 sends a file in requests of at most 100 lines and names the skipped lines
of the file. The page's text is Chinese; the short-link side's own pages (preview, refusals) are English.

## 11. Steps

- **L1 (done):** the Worker, D1 schema, launcher, `links.ui.v1`, tests, `Links checks` in CI (`CHECK_ONLY`: no deploy
  output), the deploy wrapper refusing anything but `--dry-run` while the D1 id and Access AUD were all-zeros
  placeholders.
- **L2 (first deploy; steps 1-4 done in the commit "Deploy links on s.ziyixi.science (L2)", step 5 after its first
  `Links deploy`):** the lead created the D1 database `links` (WNAM), the Access application `links` (self-hosted,
  `s.ziyixi.science/_/*` and the exact `s.ziyixi.science/_`, the two owner policies of Lab and Home, session 168 h) and
  the `production` secret `LINKS_CSRF_SIGNING_KEY`; `s.ziyixi.science` had no DNS record, so the Custom Domain attaches
  without a cf-guard allowance. The commit made every edit of step 4 except the `infra/` adoption: the dashboard
  registry names the Worker and the D1 database under a hidden entry 短链接 (no tile, status `none`), and the
  `Links deploy` job also checks the Worker's own anonymous answers (`/robots.txt`, and an unknown key's 302 to
  `/_/k/<key>`, both no-store and noindex). **Adopted by IaC P4:** the D1 database and the Access application are in
  `infra/` (`import {}` blocks, applied by "Infra apply"; `infra/README.md`); they were managed by hand until then,
  like FlowDay's. The steps as planned:
  1. Create the D1 database `links` (`wrangler d1 create links`, Workers Free) and commit its id as `database_id` in
     `wrangler.toml`.
  2. Create the Access application for `s.ziyixi.science/_/*` with an extra destination for the exact
     `s.ziyixi.science/_`, a policy allowing exactly the owner's identities (the dashboard's), session duration 7 days;
     commit its AUD as `ACCESS_AUDIENCE`. The rest of the host stays outside Access.
  3. Add the GitHub `production` secret `LINKS_CSRF_SIGNING_KEY` (64 hex, `openssl rand -hex 32`); the owner values
     come from the dashboard's `DASHBOARD_ACCESS_OWNER` and `DASHBOARD_ACCESS_OWNER_ALIASES`, as for Lab and FlowDay.
  4. In one commit (FlowDay's F2 and F3 commits needed the same edits):
     - `routes = [{ pattern = "s.ziyixi.science", custom_domain = true }]` in `wrangler.toml`.
     - `.github/scripts/test_wrangler_configs.py`: move `links` from `UNDEPLOYED` to `PRODUCTION` and `WRAPPERS` (with
       `LINKS_ACCESS_OWNER*` in `PERSONAL_INPUTS` and `SHARED_SECRETS`), and add `links` to the routed Workers of
       `LocalDev.test_the_production_configs_with_routes_are_the_ones_dev_runs`.
     - `.github/scripts/ci_changes.py`: drop `links` from `CHECK_ONLY` and add the `links_deploy` output.
     - `.github/workflows/ci.yml`: a `Links deploy` job shaped like `FlowDay deploy` (secrets file, dry-run with the
       bundle budget, `tools/cf-guard` on the config, `wrangler d1 migrations apply DB --remote`, the wrapper's deploy,
       the production check of the live version and the migrations, then an Access probe that `GET /_` (the exact
       destination), `GET /_/` and `GET /_/api/v1/links` each answer with Access's login redirect while
       `GET /robots.txt` answers the Worker's own text).
     - `tools/cf-guard/test/cf-guard.test.mjs`: `"links/wrangler.toml": ["links", ["s.ziyixi.science"]]` in the
       committed configs' expected hosts.
     - The drift check's desired state: `links` in `.github/scripts/drift_desired.py` `WORKERS` (test_drift_desired
       holds it equal to `PRODUCTION`) and in `WRAPPERS` as `{"language": "js", "file": "links/deploy/deploy-vars.mjs",
       "vars": "links", "secrets": "links"}` (without it `BUILD_SHA`, `ACCESS_OWNER`, `ACCESS_OWNER_ALIASES` and
       `CSRF_SIGNING_KEY` would be missing from the desired state and the daily check would report them;
       `test_drift_desired.py` now checks all four); regenerate `dashboard/worker/src/drift-desired.json` (`python3 .github/scripts/drift_desired.py`); the
       9 Workers in `dashboard/worker/test/drift.test.ts` ("names every production Worker") and in
       `dashboard/docs/design-v2.md` (the drift check's "8 Workers ... three ticks": 9 still take three ticks, 3 + 4 + 2).
     - The dashboard registry (`dashboard/worker/src/registry.ts` `WORKERS` and `RESOURCES`: the Worker `links` and the
       D1 database `links` by id), or an explicit exclusion with its reason, as `dashboard/worker/test/registry.test.ts`
       records for FlowDay.
     - Adopt the D1 database and the Access application into `infra/` as for the other apps (done by IaC P4, above).
  5. Verify with synthetic links only: a public and a private link, anonymous and logged in, the continuation, and
     that nothing is logged.
- **L3:** the owner's own links, through 导入 or the launcher; the Chrome site search and the home-screen bookmark
  (README "Using it").

Rollback: detach the Custom Domain by hand (a deploy without `routes` leaves an existing one attached), then revert the
L2 commit (its wrapper then refuses a real deploy again: the placeholders are back); the D1 database and the Access
application can stay or be deleted by hand (README.md "Rollback").
