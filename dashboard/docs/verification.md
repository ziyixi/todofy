# Home dashboard: verification record

Only what was actually run is marked as passed. Local evidence and production evidence are recorded
separately; nothing below "Production" has happened yet.

## 1. Local, from a clean clone (2026-09-29)

Commit `2e3fc28` (branch `dashboard`, on top of `ops-layer` = `main` at `c2bc62a`), cloned fresh
into a throwaway directory; macOS, Node 26.9.0, the workflow's commands and placeholder values, no
token, no Cloudflare API call, synthetic data only. Every CI job's steps were run in the order
`.github/workflows/ci.yml` runs them.

| Job | Step | Result |
| --- | --- | --- |
| `Changes` | `python3 -m unittest discover -s .github/scripts` | 47 tests passed |
| | `ci_changes.py` for this branch (merge base with `origin/main`) | 92 files changed; every check, `contracts`, `packages` and every deploy flag true |
| `Shared packages` | `packages/edge-auth`: `npm ci`, `npm run typecheck`, `npm test` | typecheck OK (both lib sets); 195 tests passed |
| `Dashboard checks` | `npm ci` in `worker` and `web` | OK |
| | `node --test deploy/test/*.test.mjs` | 6 passed |
| | worker `lint`, `typecheck` | OK |
| | worker `npm test` (vitest, Node) | 7 files, 91 tests passed (includes the new `limits.test.ts`: `docs/limits.md` and `limits.ts` agree) |
| | worker `npm run test:runtime` (Miniflare/workerd: real `HomeState`, stub `mail-hero`/`todofy` Ops Workers serving contract fixtures, fake GraphQL, test Access JWKS) | 5 files, 36 tests passed |
| | web `lint`, `typecheck`, `test`, `build` | OK; 7 files, 41 tests passed; build OK, `dist/` has no cross-origin reference |
| | import guard (no `mail-hero/` or `todofy/` import in `worker/src`, `web/src`) | OK (the pattern was also checked to catch static, type and dynamic imports) |
| | generator + `wrangler deploy --dry-run --secrets-file` of the placeholder production config | OK: bindings `HOME` (HomeState), `MAIL_HERO` (mail-hero#Ops), `TODOFY` (todofy#Ops), `ASSETS`; the four secrets shown as "(hidden)"; bundle exports `HomeState` and `default`, contains `packages/edge-auth/src`, no app code, and the only Cloudflare API URL is `https://api.cloudflare.com/client/v4/graphql` |
| `Contracts` | Mail Hero: `contract-fixtures`, `ops-contract`, `native-ops` | 38 passed |
| | Todofy: contract, compat, OpenAPI vocabulary, ops contract and ops core | 310 passed |
| | Todofy gateway `test/ops.test.ts` | 10 passed |
| | Dashboard (new): `ops-client`, `guard`, `canary`, `digest` | 4 files, 48 tests passed |
| `Mail Hero checks` | deploy config tests; backup tests | 3 passed; 29 ran, 1 skipped (no GPG locally) |
| | Worker typecheck and `npm test` (includes workerd bindings) | OK; 168 passed |
| | UI typecheck, tests, build | OK; 66 passed; OK |
| | placeholder config dry-run | OK |
| `Todofy checks` | ruff check / format | OK / 128 files formatted |
| | host tests (`tests/unit tests/fakes tools deploy`) | 941 passed, 1 skipped |
| | gateway lint, typecheck, tests | OK; 86 passed |
| | UI `check:api`, typecheck, tests, build, no-Mail-Hero guard | OK; 76 passed; OK; OK |
| | workerd runtime tests | 391 passed (13 min) |
| | placeholder configs dry-run (core and gateway) | OK; the core bundle contains `python_modules/workers` |
| `CI gate` | the gate script with `Dashboard checks` = success / skipped / failure | exit 0 / 0 / 1 |
| workflow | `ci.yml` parsed as YAML; job graph | `dashboard-deploy` needs `changes, dashboard-checks, gate, todofy-deploy, mail-hero-deploy`, group `dashboard-production`; `gate` needs every check job |
| `Dashboard deploy` probe | the step's script with a stubbed `curl` | 302 to the issuer passes; no connection twice then 302 passes (retry); 200 from the app, a 302 elsewhere, and a persistent 522 fail |

Earlier, per-component evidence (same synthetic data, before the CI integration): the Worker commit
`f6768cb` (77 unit, 36 runtime, 6 generator tests) and the UI commit `78693eb` (41 tests, build).

Not run locally: the deploy jobs themselves (they need the `production` environment), and nothing
that needs a real Access login, a real analytics token or the deployed apps.

## 1a. Local, after the review fixes (2026-09-30)

Commits `97df522` and `7b42c68` (the review findings and the `BUNDLED_BY` entries for the schema and
validator the dashboard now bundles), cloned fresh from the branch into a throwaway directory; macOS,
Node 26.9.0, the workflow's commands and placeholder values, no token, no Cloudflare API call,
synthetic data only.

| Job | Step | Result |
| --- | --- | --- |
| `Changes` | `python3 -m unittest discover -s .github/scripts` | 48 tests passed (the first clean run failed `test_bundled_by_lists_exactly_the_apps_whose_worker_imports_each_contract_file` because the dashboard now imports `ops-v1.schema.json` and `validate.mjs`; fixed in `7b42c68`) |
| | `ci_changes.py` as a branch push | 94 files since the merge base; every flag true |
| `Shared packages` | `packages/edge-auth` typecheck and tests | OK; 195 passed |
| `Dashboard checks` | generator tests | 6 passed |
| | worker lint, typecheck, `npm test` | OK; 7 files, 98 tests passed |
| | worker `npm run test:runtime` (workerd) | 5 files, 42 tests passed |
| | web lint, typecheck, tests, build | OK; 7 files, 46 tests passed; `dist/` has no cross-origin reference |
| | import guard | OK |
| | placeholder config dry-run | OK: the same bindings, the four secrets hidden; the bundle (112 KiB) contains the ops-v1 schema, and its only Cloudflare API URL is the GraphQL endpoint |
| `Contracts` | Mail Hero `contract-fixtures`, `ops-contract`, `native-ops` | 38 passed |
| | Todofy contract, compat, vocabulary, ops contract, ops core | 310 passed |
| | Todofy gateway `test/ops.test.ts` | 10 passed |
| | Dashboard `ops-client`, `guard`, `canary`, `digest` | 4 files, 54 tests passed (every invalid ops-v1 output fixture refused or, for the consumer rules, tolerated as documented) |
| `Mail Hero checks` | deploy config and backup tests | 3 passed; 29 ran, 1 skipped (no GPG locally) |
| | Worker typecheck and tests; UI typecheck, tests, build; placeholder dry-run | OK; 168 passed; OK, 66 passed, OK; OK |
| `Todofy checks` | ruff check / format; host tests | OK / 128 files formatted; 941 passed, 1 skipped |
| | gateway lint, typecheck, tests; UI `check:api`, typecheck, tests, build, guard | OK; 86 passed; OK, OK, 76 passed, OK, OK |
| | workerd runtime tests | 391 passed (13 min) |
| `CI gate` | the gate script with `Dashboard checks` = success / skipped / failure | exit 0 / 0 / 1 |

Not rerun: the Todofy placeholder dry-runs (nothing under `todofy/` changed since section 1).

## 1b. Local, the canary switch (2026-09-30)

Commit `2848f0e` (`DASHBOARD_CANARY_ENABLED` → `CANARY_ENABLED`), cloned fresh from the branch into a
throwaway directory; macOS, Node 26.9.0, the workflow's commands and placeholder values, no token, no
Cloudflare API call, synthetic data only. Only the dashboard, the workflow and the root README changed,
so the app jobs were not rerun.

| Job | Step | Result |
| --- | --- | --- |
| `Changes` | `python3 -m unittest discover -s .github/scripts` (from `todofy/` with `uv run`) | 48 tests passed |
| `Dashboard checks` | generator tests | 7 passed (new: the switch defaults to `true`, accepts exactly `true`/`false`, and names `DASHBOARD_CANARY_ENABLED` for `False`, `0`, `no`, `off`, a stray space or newline) |
| | worker lint, typecheck, `npm test` | OK; 8 files, 102 tests passed (new `config.test.ts`; `holdWhenDisabled`; no digest item for a `canary_disabled` skip; 409 `canary_disabled` with its message) |
| | worker `npm run test:runtime` (workerd) | 5 files, 45 tests passed. New: with `CANARY_ENABLED=false` no `startCanary` over six ticks past the hour, a manual start is 409 `canary_disabled` without any app call, the banner has the info item at level `ok`, and every report sent to `reportOps` is schema-valid with no canary item; a queued run in flight when the Worker is redeployed with `false` (same Durable Object storage) is polled to `ok`, no run starts the next day, and `true` again starts the day's run; a run still `starting` ends as `skipped/start/canary_disabled` without another `startCanary` |
| | web lint, typecheck, tests, build | OK; 7 files, 49 tests passed (the disabled button and its description, the 409 message, the banner item and the canary section's note); `dist/` has no cross-origin reference |
| | import guard | OK |
| | placeholder config dry-run, with the variable unset and with `false` | OK: `env.CANARY_ENABLED ("true")` / `("false")`, the four secrets hidden; `DASHBOARD_CANARY_ENABLED=off` fails the generator by name and writes no file |
| `Contracts` | Dashboard `ops-client`, `guard`, `canary`, `digest` | 4 files, 55 tests passed |
| workflow | `ci.yml` parsed as YAML | the `Dashboard deploy` generator step passes `vars.DASHBOARD_CANARY_ENABLED` |

## 1c. Local, the release review fixes (2026-09-30)

Commit `24922cb` (the digest's day-start hold, guard thresholds on measured usage, the 60 min shed
margin, `DeleteObjects` as Class A, the Access probe's login-page check, the generator refusing the
deploy token as the analytics token, package documents check-only in `ci_changes.py`), cloned fresh from
the branch into a throwaway directory; macOS, Node 26.9.0, the workflow's commands and placeholder
values, no token, no Cloudflare API call, synthetic data only. Nothing under `todofy/` changed, so the
Todofy runtime suite and dry-runs were not rerun.

| Job | Step | Result |
| --- | --- | --- |
| `Changes` | `python3 -m unittest discover -s .github/scripts` (from `todofy/` with `uv run`) | 55 tests passed. New: package Markdown checks every user and deploys none (this branch's own non-dashboard files deploy only the dashboard); the Access probe step run with a stubbed `curl` passes only a 302 to `<issuer>/cdn-cgi/access/login/<host>` (end, `?` or `/`) and fails a 302 to the team domain root, another host, look-alike hosts, a 200/401, and no connection after 10 tries; the generator step receives `CF_API_TOKEN` |
| | `ci_changes.py` classification of `git diff c2bc62a` | every check, `contracts` and `packages` true; `dashboard_deploy` true; `todofy_deploy` and `mail_hero_deploy` false |
| `Shared packages` | `packages/edge-auth` typecheck and tests | OK; 195 passed |
| `Dashboard checks` | generator tests | 8 passed (`DASHBOARD_CF_ANALYTICS_TOKEN` equal to `CF_API_TOKEN`, also with whitespace, is flagged for a CI warning without its value — the owner allowed the reuse until a read-only token is saved; a different or empty deploy token is not flagged and is never written) |
| | worker lint, typecheck, `npm test` | OK; 8 files, 110 tests passed. New: 79.95 % (displayed 80.0) does not shed and 69.95 % clears (real `parseUsage` rows); quota items at 79.95/94.95 %; a shed continuing past midnight stays in force past a late 00:30 retry; the 23:30 report is not replaced at 00:00 (also not by a 6 h refresh), is at 00:30, and a same-day or first report is not held; `DeleteObjects` counts as Class A with no unclassified operations for the live sample's action types; every classified R2 operation is in `limits.md` |
| | worker `npm run test:runtime` (workerd) | 5 files, 45 tests passed (the digest flow now expects no report at 00:00 and the empty report at 00:30; guard `until` values at 01:00) |
| | web lint, typecheck, tests, build | OK; 7 files, 50 tests passed (new: a 79.95 % row is not marked "超过 80%") |
| | import guard | OK |
| | placeholder config dry-run | OK: the same bindings, the four secrets hidden, `BUILD_SHA` the commit; 111.77 KiB |
| `Contracts` | Mail Hero `contract-fixtures`, `ops-contract`, `native-ops` | 38 passed |
| | Todofy contract, compat, vocabulary, ops contract, ops core | 310 passed |
| | Todofy gateway `test/ops.test.ts` | 10 passed |
| | Dashboard `ops-client`, `guard`, `canary`, `digest` | 4 files, 61 tests passed |
| `Mail Hero checks` | Worker typecheck and tests; UI typecheck and tests | OK; 168 passed; OK; 66 passed |
| `Todofy checks` | gateway lint, typecheck, tests; host tests (`tests/unit tests/fakes tools deploy`) | OK; 86 passed; 940 passed, 2 skipped |

## 1d. Local, dashboard v2 end to end (2026-09-30)

Branch `dashboard-v2` at `8ded1db`, rebased on `origin/main` `3a46388` (which added `website/`): the v2
registry, `/api/v2`, the four views, the v1 API removed, the integration fixes below, and the website's
assets-only Worker `ziyixi-website` registered under 个人网站. macOS, Node 26.9.0, synthetic data only,
no token, no Cloudflare API call.

**Browser pass.** The real Worker (`src/index.ts` bundled with esbuild) in Miniflare with a SQLite
`HomeState`, `ASSETS` serving the built `web/dist`, stub `mail-hero`/`todofy` `Ops` Workers answering the
ops-v1 fixtures, an outbound handler answering the GraphQL endpoint with `test/graphql-fixture.ts` and
the website probe with a 200, and the loopback dev bypass (setup.md §5). Headless Chromium
(`playwright-core` 1.63 in a scratch directory, not a repo dependency) opened `#/`, `#/flows`,
`#/flows/mail-to-task`, `#/cloudflare` and `#/ops` at 1280×900 and 390×844, light and dark, in
seven scenarios, each on fresh storage after one tick:

| Scenario | What it shows |
| --- | --- |
| healthy (the mockup's day, 5 Workers) | 全部正常; tiles 正常 with their one number, Flowday/思源 host only, Newsletter 未接入监控; 5 Worker rows joined to their apps and flows; unregistered synthetic D1/DO/R2 IDs as 未登记 + 8 characters |
| Mail Hero degraded (fixture) | strip "1 项故障 · 1 项需关注" linking to the two stages; tile 故障; the mail flow opens on Webhook 投递 |
| Todofy `status()` throws | Todofy tile 无法连接 · 连续 1 次失败; the flows' Todofy stages 未知; Mail Hero unaffected |
| GraphQL 500 | strip item 用量数据获取失败 → Cloudflare; no bars, "Worker 暂无数据", Notion 发布 未知 |
| 20 Workers / 0 Workers | "Worker · 20 个（自动发现）" with every row (15 synthetic scripts not in the registry) / "今天还没有 Worker 的请求数据。"; no overflow at 390 px |
| website probe fails | 个人网站 需关注; 网站发布 需关注 on its 网站可用 stage |

Every page: no console error or warning, no failed or 4xx/5xx request, no horizontal overflow. Clicked
through on both sizes: tile links (`target="_blank"`, `rel="noreferrer noopener"`), the status button's
detail sheet (focus moves in, Escape closes and returns focus) and its links, flow rows → the flow's
card, expand/collapse (`aria-expanded`), a Worker row → `#/cloudflare/worker/<script>`, 刷新用量 and
its cooldown text, and 立即运行金丝雀 / 强制降载 / 解除降载 through their confirmation dialogs (each
`POST /api/v2/canary|guard` carried the CSRF header and was accepted; the result line appeared; on the
phone the canary button was disabled with the running run's id, as intended). The phone's bottom tab
bar does not cover the last content.

Found and fixed in "Integrate the dashboard v2 Worker and UI end to end" (with regression tests): an app whose first-ever poll failed said
数据已过期 instead of 无法连接; a 故障 flow row named an earlier 需关注 stage (`first_issue` is now the
first stage at the flow's worst level, and the card opens on it); the home Cloudflare card said
"0 个 Worker · 今日错误 0" before any GraphQL answer.

**CI steps from a fresh clone** of the branch, the workflow's commands and placeholder values:

| Job | Step | Result |
| --- | --- | --- |
| `Dashboard checks` | generator tests | 8 passed |
| | worker lint, typecheck, `npm test` | OK; 13 files, 181 tests passed |
| | worker `npm run test:runtime` (workerd) | 6 files, 61 tests passed (every v2 endpoint, 0/5/20 Workers, v1 paths 404, the `canary_id` migration) |
| | web lint, typecheck, tests, build | OK; 12 files, 84 tests passed; bundle 361 kB (112 kB gzip); no cross-origin references |
| | import guard | OK |
| | placeholder config dry-run (`GITHUB_SHA` set as in CI) | OK: bindings `HOME`, `MAIL_HERO`, `TODOFY`, `ASSETS`; no `MAIL_HERO_URL`/`TODOFY_URL`; the four secrets hidden; 168.90 KiB |
| `Contracts` | Dashboard `ops-client`, `guard`, `canary`, `digest` | 4 files, 61 tests passed |
| `Changes` | `uv run python -m unittest discover -s ../.github/scripts` (from `todofy/`) | 63 tests OK |

## 1e. Local, the v2 review fixes (2026-09-30)

Branch `dashboard-v2` at `4fb05d5` on `origin/main` `3a46388`: the two commits after `923c973` fix the
fidelity and correctness review (strip and badges never say less than the views, 部分接入 only in
place of 正常, narrow-desktop layout, data age always in the top bar, stage links, stage facts, canary
list semantics, compact phone Worker cards and quota rows, sortable Worker table, full R2 names, D1/DO
`match` accepted by the privacy scan, the Cloudflare view capped at 50 rows, and the three UI tests
lost with v1). Same machine and synthetic setup as §1d.

**Browser pass** (same Miniflare harness and headless Chromium as §1d), seven scenarios × five routes ×
1280/390 px, light and dark: no console error or warning, no failed request, no horizontal overflow.
Measured, not only styled:

| Check | Result |
| --- | --- |
| Top bar and tiles at 720 / 740 / 768 / 800 / 900 / 960 / 1280 px | `scrollWidth − clientWidth` 0 at every width; tabs 64 px high, one line each; brand ends left of the tabs; tiles wrap 3 + 1 below 800 px and never pass the 16 px gutter |
| Todofy `status()` throws once | strip "◆ 1 项未知 · Todofy：无法连接" linking to 首页; 首页 badge 1; tile "◆ 无法连接 · 连续 1 次" with the word on one line |
| Website probe fails | strip "▲ 1 项需关注 · 个人网站：HTTP 状态异常"; the 网站发布 stage is not listed twice |
| Mail Hero degraded | strip "1 项故障 · 1 项需关注"; 查看 opens `#/flows/mail-to-task/<stage>` on that stage |
| 20 Workers at 390 px | each Worker card 95–97 px (was ~240): name, app; 请求 · 错误 · p99 bar; flows, subrequests, DO requests and last request behind 更多 |
| Quota rows at 1280 px | every row 82 px; estimates below 80 % behind the row's disclosure |

**CI steps from a fresh clone** of the branch, the workflow's commands and placeholder values:

| Job | Step | Result |
| --- | --- | --- |
| `Dashboard checks` | generator tests | 8 passed |
| | worker lint, typecheck, `npm test` | OK; 13 files, 186 tests passed |
| | worker `npm run test:runtime` (workerd) | 6 files, 61 tests passed |
| | web lint, typecheck, tests, build | OK; 13 files, 99 tests passed; bundle 365 kB (113 kB gzip); no cross-origin references |
| | import guard | OK |
| | placeholder config dry-run (`GITHUB_SHA` set as in CI) | OK: bindings `HOME`, `MAIL_HERO`, `TODOFY`, `ASSETS`; the four secrets hidden; 172.76 KiB |
| `Contracts` | Dashboard `ops-client`, `guard`, `canary`, `digest` | 4 files, 61 tests passed |
| `Changes` | `python3 -m unittest discover -s .github/scripts`, and from `todofy/` with `uv run` | 63 tests OK (both) |

## 1f. Local, the committed production config (2026-09-30)

`worker/wrangler.toml` and `deploy/generate-ci-config.mjs` were replaced by the committed
`dashboard/wrangler.toml` (top level = production) and `deploy/deploy-vars.mjs`, which adds `CANARY_ENABLED`
and `BUILD_SHA` with `--var` and writes the secrets file. Synthetic values only, no production call:

| Job | Step | Result |
|---|---|---|
| `Dashboard checks` | `node --test deploy/test/*.test.mjs` (config and deploy values) | 14 passed |
| | worker lint, typecheck, unit, runtime | ok; 186 and 61 passed |
| | web lint, typecheck, tests, build; import guard | ok; 99 passed |
| | dry-run of the committed config through `deploy-vars.mjs` (placeholder secrets) | ok; `CANARY_ENABLED`, `BUILD_SHA` and the four secrets shown as `(hidden)` |
| equivalence | the old generator path and the new one, each a full `wrangler deploy` against a local mock of the Cloudflare API (loopback only, placeholder token), with the real static GitHub variables and placeholder secrets | the same 17 requests; bindings identical in value and order; custom domain, cron, DO migration and assets identical; the uploaded script differs only in esbuild's `// path` comments (normalized sha256 `9b36b3c6…` on both sides); `metadata.package_dependencies` is no longer sent (no `package.json` in `dashboard/`) |

## 2. Production (pending)

None of these has been done; each needs the first `Dashboard deploy` on `main` (after Todofy and Mail
Hero with ops-v1 are live) and, where stated, the owner in a browser.

| Item | How | Status |
| --- | --- | --- |
| First deploy | `Dashboard deploy` succeeds; Custom Domain `home.ziyixi.science` gets DNS and a certificate | pending |
| No redirect in front of Access | before the first merge, read only: no zone Redirect Rule or Page Rule matches `home.ziyixi.science` (setup.md §2) | pending |
| Access fronts the host | the job's probe (302 to `<issuer>/cdn-cgi/access/login/home.ziyixi.science` for `/` and `/api/v2/home`) | pending |
| The Worker runs the merged build | after the owner's first login: `/health` shows `BUILD_SHA` = the merged commit (the probe cannot see past Access) | pending |
| Real Access login | the owner opens the page with the primary login and, where configured, an alias; one refresh and one confirmed write (解除降载 is harmless when nothing is shed) | pending |
| Analytics token | the GraphQL query with the production token returns every dataset; then the token is replaced by an "Account Analytics: Read" token (setup.md §4) and checked again; record the replacement date here. Not done while the broad bootstrap token is still the Worker secret `CF_ANALYTICS_TOKEN` (the deploy refuses it only if it equals `CF_API_TOKEN`) | open (a broader token is still reused) |
| Quota numbers | spot-check the page's daily numbers against the Cloudflare dashboard's usage pages for the same UTC day | pending |
| First scheduled canary | the day's run reaches `ok` (Mail Hero delivered, Todofy summarized it, no Todoist task, not listed as mail); this does not exercise Email Routing, raw storage or parsing | pending |
| Guard round trip | only if a real ≥ 80 % day happens, or by the owner's 强制降载 then 解除降载: both apps report the guard in `status()` and clear it | pending |
| Digest | Todofy's next daily reminder carries the dashboard's warning/critical items, or none | pending |
| Canary switch | once, before or after the first canary: deploy with `DASHBOARD_CANARY_ENABLED=false`, check the banner item, the disabled button and that no run starts at the canary hour; deploy again with `true` (or unset) | pending |
| v2: the four views as the owner | after the v2 deploy: `#/`, `#/flows`, `#/cloudflare`, `#/ops` load on a desktop browser and a phone; `/health` shows the merged `BUILD_SHA`; the old v1 anchors (`#apps`, `#quota`, `#canary`, ...) land on their v2 views | pending |
| v2: storage migration | the first v2 tick adds `canary_runs.canary_id` once (existing runs become `mail-todofy`); the canary history and manual count carry over | pending |
| v2: Worker table | the auto-discovered rows (requests, errors, CPU p50/p99, subrequests, DO requests) match the Cloudflare dashboard's Workers pages for the same UTC day; whether `durableObjectsInvocationsAdaptiveGroups.scriptName` is the defining or the calling script and whether `cpuTimeP99` includes DO time (design-v2 §9) | pending |
| v2: resource names | fill the registry's TODO identifiers (two D1 database IDs, three DO namespace IDs, the Mail Hero backup bucket) so the resource tables stop showing 未登记 for them | open |
| v2: website probe | from the production Worker, `GET https://www.ziyixi.science/build-info.json` answers 200 without a redirect (same-zone fetch) and the 个人网站 tile shows its latency; if not, set `enabled: false` (未接入) | pending |
| v2: notion-publish idle rule | the 26 h `max_idle_hours` fits the Worker's real schedule (no false 需关注 on a normal day) | pending |
| v2: observed strip items | after the v2 deploy, the strip and badges match the tiles and flows: nothing "全部正常" while a tile says 需关注/故障/未知. Expect "◆ Notion 发布：还没有观察到请求" for up to 26 h after the first v2 tick if `ziyixi-notion-publish` gets no request in that window (discovery starts empty) | pending |
| v2: layout on real devices | the owner's phone (two-line Worker cards, bottom tabs) and a narrow desktop window (720–960 px: tabs on one row, tiles wrapping, no sideways scroll) | pending |
| v2: request budget | a day's `home` Worker and `HomeState` request counts stay within limits.md's estimate with the four views open (ETag 304s, one GraphQL query and one probe per tick) | pending |
| Open questions from `limits.md` §4 | whether `Ops` calls appear in the apps' Worker request totals; unclassified R2 action types; analytics lag at a tick; `durableObjectsStorageGroups` data | pending |

