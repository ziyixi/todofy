# recall

The owner's browsing record on `recall.ziyixi.science`, to answer two questions years from now: what did I do on day X,
and where did I read that. A Chrome extension records each page's visits with the time it really had the focus, and
the page's text once it was read for ten seconds; it scrubs secrets and uploads to the Worker `recall`, which keeps
everything in one SQLite Durable Object (`RecallState`) and the private R2 bucket `recall-store`, indexes it for
full-text search (Chinese included) and serves a timeline and a search UI behind Access. A durable copy leaves
Cloudflare through an open change feed ([`recall-archive-v1`](../contracts/recall-archive-v1/README.md)) that a small
container on the NAS pulls into plain files. Chinese UI, mobile first. Design: [`docs/design.md`](docs/design.md).
Rules: [`AGENTS.md`](AGENTS.md).

| Path | What it is |
| --- | --- |
| `extension/` | The Chrome extension (Manifest V3, no runtime dependency): visits and focus, captures, scrub, the outbox and uploads, self-update; built by CI into an artifact ([README](extension/README.md)) |
| `shared/` | The code the extension and the Worker both run: URL normalization and the page ID, the scrubber, the denylist, the bigram segmenter |
| `worker/` | The Worker `recall`: the fetch handler (the three machine routes with their own tokens, then Access and CSRF) and `RecallState` (ingest, storage, search, the change feed, the owner API, ops-v1, the alarm) |
| `web/` | The UI (时间线 · 搜索 · 设置), built into `web/dist` and served by the Worker |
| `sync/` | The reference archive consumer: one Python file, standard library only, and its image ([README](sync/README.md)) |
| `deploy/` | The deploy wrapper `deploy-vars.mjs`, the bundle budget, and the owner's token script `mint-tokens.mjs` |
| `wrangler.toml` | The production config (top level = production); `wrangler.test.toml` is for local development and the smoke run |
| `../proto/recall/` | The owner API `recall.ui.v1`, the upload `recall.ingest.v1` and the feed `recall.archive.v1` |

## Use

- **时间线**: a day at a time (‹ ›, the date, 今天; ← → t): the summary, 24 hour cells shaded by focus (a tap jumps to
  the hour), and the day's sessions by site, each opening to its pages.
- **搜索**: words and phrases over titles, URLs and the first 32 KiB of each page's latest text, with the chips 时间,
  网站, 类型 (读过) and 停留, or the operators `site:`, `after:` (`after:昨天` too), `before:`, `type:read` and `dwell:`
  typed in the box; 相关 · 最新. A single Chinese character is not searchable (the index is of character pairs). Each
  search reads a bounded number of rows, and searches stop for the rest of the UTC day once the day's read budget is
  spent (design §6.3).
- **页面详情**: the page's text in a reader view with the matches marked, its visits, and behind ⋯ 打开原网页,
  以后不保存这个网站的正文 and 删除这个页面的记录 (the visits and texts leave recall and, at the next pull, every
  archive).
- **设置**: devices (last upload, version, outbox, clock skew), archives (last pull, how far behind), storage and the
  day's budgets, and the owner's 网站名单: sites recorded by their name alone (their own banks) or without their text
  (the owner's own lists live here, never in this repository).

What is never recorded, and what is kept for how long, is in the design's §2 and §2.3: incognito windows, recall's own
pages, visits under one second of focus; sensitive sites (mail, chats, banks, consoles, where API keys are made) and the
owner's site-only list by their site alone; no text of a denylisted page or a page with a password field.

## Develop

From `worker/` (Node 26; the pinned toolchains are in each package's lockfile):

```sh
npm ci && (cd ../web && npm ci) && (cd ../extension && npm ci)
npm run lint && npm run typecheck && npm test   # unit tests (Node): shared/, query building, snippets, the feed's lines
npm run test:runtime                            # workerd: a real RecallState and R2, the owner API, ops-v1, CPU, rows read
(cd ../web && npm run lint && npm run typecheck && npm test && npm run build)
(cd ../extension && npm run lint && npm run typecheck && npm test && npm run build)
node --test ../deploy/test/*.test.mjs
uv run --no-project --python 3.12 --with-requirements ../sync/requirements-test.txt \
  python -I -m unittest discover -s ../sync -p 'test_*.py'
npm run test:smoke                              # the whole path on loopback (needs the UI build)
```

The smoke run (`worker/test/smoke/smoke.mts`) starts the real `wrangler dev` with synthetic tokens, lets the
extension's own code (`extension/test/smoke-upload.ts`, under its fake `chrome.*`) upload a browsing session, calls the
owner API as the UI does, runs `sync/recall_sync.py --once` into a fresh archive and checks that archive against the
contract with the generated codec, then deletes a page and checks that the next pull removes it. It needs Python 3.12
or newer (`RECALL_SMOKE_PYTHON`, default `python3`).

Trying the UI by hand (synthetic data only): copy `.dev.vars.example` to `.dev.vars` (set the two token digests it
explains), build the UI, then `npm run dev` from `worker/` (wrangler dev on http://127.0.0.1:8797, local bindings
only). Local state is in `recall/.wrangler/` (delete it after a schema change).

## Deploy

Only from GitHub Actions: `Recall deploy` (`.github/workflows/ci.yml`, the recipe in `worker-release.yml`) on `main`
after `CI gate`, in the `production` environment, through `deploy/deploy-vars.mjs` (never a plain `wrangler deploy`).
Until "Infra apply" has created the Access applications (`recall`, the whole host, and `recall machine routes`, the
Bypass of the three machine routes) and the bucket, and the go-live commit has added the AUD, `recall` is in
`CHECK_ONLY` (`.github/scripts/ci_changes.py`): its checks run, its deploy does not (design §11).

The wrapper writes the Worker secrets `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` (from the dashboard's secrets: one
owner) and `CSRF_SIGNING_KEY` (from `RECALL_CSRF_SIGNING_KEY`), and sets `BUILD_SHA`. recall has no operational switch.
It never writes, needs or deletes the machine tokens' digests (`INGEST_TOKEN_SHA256`, `EXPORT_TOKEN_SHA256` and their
`_PREVIOUS`): `wrangler deploy --secrets-file` keeps them (pinned by `deploy/test/secrets-kept.test.mjs`), and only
the owner puts them, with `deploy/mint-tokens.mjs` from their own machine. Until then the machine routes answer 503.

```sh
openssl rand -hex 32 | gh secret set RECALL_CSRF_SIGNING_KEY -R ziyixi/todofy --env production
```

The release checks that production runs the commit, that Access answers the UI, the owner API and any other path with
its login page, and that exactly the three machine routes reach the Worker without it (401, or 503 before the tokens
exist). After the first deploy: `node recall/deploy/mint-tokens.mjs`, the extension installed and its token pasted
(`extension/README.md`), the NAS container started (`sync/README.md`); then an upload within five minutes of browsing
and the archive caught up in 设置.

### Emergency stops and rollback

Fastest first: switch the extension off in `chrome://extensions`; delete the ingest digests
(`npx wrangler secret delete INGEST_TOKEN_SHA256` from `worker/`: every upload 503); `mint-tokens.mjs --revoke ingest`
or `--revoke export` for a leaked token (only the new token works at once; `--rotate` keeps the old one working until
`--retire`, for a planned change); DeletePage for something that should not have been kept. A code-only revert is the normal rollback.
Deleting the Worker deletes `RecallState` (the index and every record) for good; the texts stay in `recall-store` and
every record in the NAS archive.
