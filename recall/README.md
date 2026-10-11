# recall

The owner's browsing record on `recall.ziyixi.science`, to answer two questions years from now: what did I do on day X,
and where did I read that. A Chrome extension records each page's visits with the time it really had the focus, and
the page's text once it was read for ten seconds; it scrubs secrets and uploads to the Worker `recall`, which keeps
everything in one SQLite Durable Object (`RecallState`) and the private R2 bucket `recall-store`, indexes it for
full-text search (Chinese included) and serves a timeline and a search UI behind Access. A durable copy leaves
Cloudflare as plain files ([`recall-archive-v1`](../contracts/recall-archive-v1/README.md)): recall writes them into the
owner's own Dropbox app folder about hourly, and the NAS syncs that folder with its own Dropbox support, so nothing of
recall's runs on the NAS. Every owner step is a click. Chinese UI, mobile first. Design:
[`docs/design.md`](docs/design.md). Rules: [`AGENTS.md`](AGENTS.md).

| Path | What it is |
| --- | --- |
| `extension/` | The Chrome extension (Manifest V3, no runtime dependency): visits and focus, captures, scrub, the outbox and uploads, self-update; built by CI into an artifact ([README](extension/README.md)) |
| `shared/` | The code the extension and the Worker both run: URL normalization and the page ID, the scrubber, the denylist, the bigram segmenter |
| `worker/` | The Worker `recall`: the fetch handler (the three machine routes with their own tokens, then Access and CSRF, the Dropbox callback) and `RecallState` (ingest, storage, search, the change feed, the machine tokens, the archive's writer to Dropbox, the owner API, ops-v1, the alarm) |
| `web/` | The UI (时间线 · 搜索 · 设置), built into `web/dist` and served by the Worker |
| `deploy/` | The deploy wrapper `deploy-vars.mjs` and the bundle budget |
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
  以后不保存这个网站的正文 and 删除这个页面的记录 (the visits and texts leave recall; the Dropbox archive only grows:
  it gains the deletion's tombstone line and keeps its files, which the owner removes there by hand if they want).
- **设置**: devices (last upload, version, outbox, clock skew); 插件口令 (the extension's token: 生成, 重新生成 with
  24 hours' grace, revoke a leaked one at once, stop; shown once; the optional export token of the change feed folded
  under it); 备份到 Dropbox (connect with the App key, the account, the last upload, what waits, failures in words,
  断开); storage and the day's budgets; and the owner's 网站名单: sites recorded by their name alone (their own banks)
  or without their text (the owner's own lists live here, never in this repository).

What is never recorded, and what is kept for how long, is in the design's §2 and §2.3: incognito windows, recall's own
pages, visits under one second of focus; sensitive sites (mail, chats, banks, consoles, where API keys are made) and the
owner's site-only list by their site alone; no text of a denylisted page or a page with a password field.

## Develop

From `worker/` (Node 26; the pinned toolchains are in each package's lockfile):

```sh
npm ci && (cd ../web && npm ci) && (cd ../extension && npm ci)
npm run lint && npm run typecheck && npm test   # unit tests (Node): shared/, query building, snippets, the feed's and
                                                # the archive's lines, the Dropbox client, the machine tokens
npm run test:runtime                            # workerd: a real RecallState and R2, a fake Dropbox, the owner API,
                                                # ops-v1, CPU, rows read
(cd ../web && npm run lint && npm run typecheck && npm test && npm run build)
(cd ../extension && npm run lint && npm run typecheck && npm test && npm run build)
node --test ../deploy/test/*.test.mjs
npm run test:smoke                              # the whole path on loopback (needs the UI build)
```

The smoke run (`worker/test/smoke/smoke.mts`) starts the real `wrangler dev`, makes the machine tokens through the
owner API, lets the extension's own code (`extension/test/smoke-upload.ts`, under its fake `chrome.*`) upload a
browsing session, calls the owner API as the UI does, connects a loopback fake of Dropbox
(`worker/test/runtime/fake-dropbox.ts`, through its OAuth flow) and checks the archive the alarm writes there against the
contract with the generated codec, then deletes a page and checks that the archive gains its tombstone and loses
nothing.

Trying the UI by hand (synthetic data only): copy `.dev.vars.example` to `.dev.vars`, build the UI, then `npm run dev`
from `worker/` (wrangler dev on http://127.0.0.1:8797, local bindings only); make a token in 设置 → 插件口令. Local state
is in `recall/.wrangler/` (delete it after a schema change).

## Deploy

Only from GitHub Actions: `Recall deploy` (`.github/workflows/ci.yml`, the recipe in `worker-release.yml`) on `main`
after `CI gate`, in the `production` environment, through `deploy/deploy-vars.mjs` (never a plain `wrangler deploy`).
"Infra apply" created the Access applications (`recall`, the whole host, and `recall machine routes`, the Bypass of
the three machine routes) and the bucket on 2026-10-10; recall is live since its go-live commit (`ee02b62`), and a change
to recall deploys it, and Home after it (design §11).

The wrapper writes the Worker secrets `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` (from the dashboard's secrets: one
owner) and `CSRF_SIGNING_KEY` (from `RECALL_CSRF_SIGNING_KEY`), and sets `BUILD_SHA`. recall has no operational switch.
No deploy carries a machine token or anything of Dropbox: the owner makes the tokens in 设置 (RecallState keeps their
digests) and connects Dropbox there (OAuth with PKCE: an App key, no secret; the refresh token stays in RecallState).
A digest put by hand as a Worker secret (`INGEST_TOKEN_SHA256`, `EXPORT_TOKEN_SHA256` and their `_PREVIOUS`) is
accepted as well, and `wrangler deploy --secrets-file` keeps it (`deploy/test/secrets-kept.test.mjs`).

### The owner's setup: clicks only

1. **The extension's token.** recall → 设置 → 插件口令 → **生成** → **复制** (shown this once).
2. **The extension.** The agent builds it on the owner's Mac into a fixed folder (`npm run install-extension` in
   `extension/`: `~/recall-extension`). Then Chrome → `chrome://extensions` → **开发者模式** on → **加载已解压的扩展程序**
   → choose that folder; click the extension's icon (the puzzle-piece menu → recall) to open its options: the server is
   already `https://recall.ziyixi.science`; paste the token, type the device label, **保存**. Within five minutes of
   browsing, 设置 → 设备 shows the device's upload.
3. **The Dropbox app** (once, at dropbox.com/developers/apps): **Create app** → **Scoped access** → **App folder** →
   any name (it becomes the folder `Apps/<name>`) → **Create app**. On its **Permissions** tab tick
   `files.content.write` and `files.content.read` → **Submit**. On its **Settings** tab, under **OAuth 2** →
   **Redirect URIs**, add exactly `https://recall.ziyixi.science/api/dropbox/callback` → **Add**; copy the **App key**
   from the same page (never the App secret: recall needs none).
4. **Connect.** recall → 设置 → 备份到 Dropbox → paste the App key → **连接** → Dropbox asks to allow access to the app's
   folder → **Allow**. Back in 设置 it says 已连接; the first upload follows within a minute (VERSION, state.json, a file
   per day under `changes/`, the texts under `blobs/`), and then about an hour after each new change.
5. **The NAS** (UGREEN UGOS): **Cloud Drives** → add **Dropbox** and sign in with the same account → create a sync task
   from the Dropbox folder `Apps/<name>` to a NAS shared folder (for example `recall-archive`), direction **cloud → NAS**
   (download only), so the NAS never changes the Dropbox copy.

The export token (设置 → 插件口令 → 导出口令) is optional: only a program reading the change feed needs it.

### Emergency stops and rollback

Fastest first: switch the extension off in `chrome://extensions`; 设置 → 插件口令 → ⋯ → 停用 (every upload 503 within a
minute) or → 旧口令泄露：立即作废并重新生成 for a leaked token (only the new token works; a plain 重新生成 keeps the old
one for 24 hours); 设置 → 备份到 Dropbox → 断开 (revokes the token at Dropbox; the files stay); DeletePage for something
that should not have been kept (the Dropbox copy keeps its files: delete them there by hand). A code-only revert is the
normal rollback. Deleting the Worker deletes `RecallState` (the index and every record) for good; the texts stay in
`recall-store`, and every record in the Dropbox archive and its NAS copy.
