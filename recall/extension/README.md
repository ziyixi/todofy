# recall's Chrome extension

Records each page's visits with the time it actually had the focus, and its text once it was read for ten seconds;
scrubs secrets and uploads to the Worker `recall` ([design §3](../docs/design.md#3-the-extension)). Manifest V3, no
runtime dependency, no remote code, never in incognito. Extension ID `kpehdcbafdhgghclgaeigokjoceemfhj` (from the
public key in `src/manifest.json`; the private half was never kept).

| File | What |
| --- | --- |
| `src/sw.ts` | The service worker: every listener at the top level, one queue for the state, the one-minute `tick` |
| `src/focus.ts`, `src/visits.ts` | The focus state machine and visits (§3.2, §3.3) |
| `src/capture.ts`, `src/capture-script.ts`, `src/page-text.ts` | Captures and the script injected into one document (§3.4) |
| `src/page.ts` | What is recorded of a URL and title, through `../shared/` (§3.5-§3.7) |
| `src/db.ts`, `src/store.ts` | The IndexedDB (open visits, outbox, token) and the chrome.storage records |
| `src/upload.ts` | Batches, gzip, every answer (an `unsupported_item` held for a newer recall, not lost), the heartbeat, the badge (§3.8, §3.9) |
| `src/update.ts` | The self-update check through `BUILD` (§3.10) |
| `src/options.*`, `src/settings.ts` | The options page: server, token, device label, the upload's state |
| `scripts/build.mjs`, `scripts/install.mjs` | `npm run build`, `npm run install-extension` |

The uploads are `recall.ingest.v1` wire JSON, typed by the generated `ingest_wire.ts` (types only, nothing in the
bundle); `test/contract.test.ts` reads what the extension builds with the generated strict codec, as the Worker does.

## Build and install

Building is the agent's (or a developer's) part, on the owner's Mac or from CI:

```sh
npm ci
npm run build                 # dist/extension/ (the unpacked extension) and dist/recall-extension-<commit>.zip
npm run install-extension     # into ~/recall-extension (or: -- <folder or zip> [--target <folder>])
```

`install-extension` takes this package's build, a build folder or zip, or the CI artifact `recall-extension-<sha>.zip`
as downloaded; it needs no `npm ci`. It unpacks beside the target, checks the files, the version and the key, swaps
the folders with two renames (the old one becomes `~/recall-extension.prev`) and writes `BUILD` last. The running
extension reloads into the new build on its next tick. Keep the folder outside Google Drive (a cloud-only file there
would fail to load) and in the same place, so Chrome finds it again after an update.

The owner's part, clicks only, once the folder is in place:

1. Chrome → `chrome://extensions` → turn on **开发者模式** (Developer mode) → **加载已解压的扩展程序** (Load unpacked) →
   choose the folder (`~/recall-extension`; `⌘⇧G` types a path in the picker).
2. recall → 设置 → **插件口令** → **生成**, then **复制** (the token is shown this once).
3. Click the extension's icon (Chrome's puzzle-piece menu → recall): its options page opens. The server is already
   `https://recall.ziyixi.science`; paste the token, set the device label (`MacBook · 工作`), **保存**.

## Checks

```sh
npm run lint && npm run typecheck && npm test
```

The tests run in Node over a hand-written fake of the `chrome.*` APIs and a fake clock (`test/fake-chrome.ts`) and
fake-indexeddb, all with synthetic pages and tokens. `test/smoke-upload.ts` is the extension's part of recall's smoke
run (`../worker/test/smoke/smoke.mts`, `npm run test:smoke` in `worker/`): the same code under the same fake records a
short session and uploads it to a real `wrangler dev`, the only real thing being the network.
