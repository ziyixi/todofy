# Todofy 一次性重写：实施顺序（2026-09-28 修订版）

> 依据：todofy `6c46ed4`（main，工作区含另一任务的未提交修改）、mail-hero `5d2b625`、self-host-on-vultr `bcad459`、protos `protobuf`/`main` 分支的只读阅读；方案 v2 `docs/cloudflare-migration-plan.md` 与 UI/门户研究 `docs/ui-and-portal-research.md`。owner 2026-09-28 的最新决定优先于两份文档。本文只是计划：未改任何仓库、主机或 Cloudflare 资源，未读 env、token、数据库或真实邮件。`file:line` 无仓库前缀时指 todofy；平台事实沿用两份文档已标注的来源；"推断"表示未经实测。

> **As-built notes (2026-09-29).** The rewrite is built on `cf-rewrite`; where this plan and the tree
> differ, the tree and `docs/dev-notes.md` win. Setup and CI details: `docs/cloudflare-setup.md`,
> `docs/ci-cd.md`; what actually ran: `docs/verification.md`.
>
> - Hooks hosts are a list, `TODOFY_HOOKS_HOSTS` (not `TODOFY_HOOKS_HOST`): `todofy-hooks.ziyixi.science`
>   first; at cutover `daily.ziyixi.science` moves onto the Worker as a second hooks host, so Mail Hero's
>   existing target and the newsletter keep their URLs (C11's env change then becomes optional).
> - `TODOFY_ACCESS_OWNER` and `TODOFY_ACCESS_OWNER_ALIASES` are GitHub **environment secrets**, not
>   variables (the repo and its logs are public; wrangler prints plain vars). The deploy passes them to the
>   Worker with `--secrets-file`. The alias to list is the owner's GitHub-login email.
> - Worker secret names: `MAIL_WEBHOOK_TOKEN_SHA256`, `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS`,
>   `REPORT_BASIC_AUTH_SHA256` (comma-separated digests while rotating; no `_PREVIOUS`), `GEMINI_API_KEY`,
>   `TODOIST_API_KEY`, and `CSRF_SIGNING_KEY` (64 hex, new). The newsletter password must be random
>   (≥128 bits): the hourly lockout only throttles failures and never blocks a correct credential.
> - `TODOFY_REPORT_DEFAULT_TOP=10` (the newsletter asks for `?top=10`); `TODOFY_LEGACY_TEXT_RETENTION_DAYS`
>   defaults to `0` (keep).
> - A report is served to the newsletter only when computed since the latest precompute time and usable;
>   otherwise it is computed on demand, and a failure is 503, never a `stale` 200.
> - `/hooks/mail` accepts a body without `Content-Length` (no 411); the coordinator stops reading at 1 MiB.
> - Local cron is `GET /cdn-cgi/local/scheduled?cron=...`; `/__scheduled` and `--test-scheduled` no longer
>   work in wrangler 4.142.
> - CloudMailin-era cache rows are exported by default (`--skip-cloudmailin` opts out and leaves a manifest
>   warning, which fails the C6 gate). C5 uses `tools/legacy_migration/snapshot.py` (stdlib, reads through
>   the WAL); the mini-PC needs no `sqlite3` CLI.
> - `PROCESSING_PAUSED` also stops the daily reminder; report precompute continues.
> - S11 is done: the Go tree, its tooling and workflows are deleted (100 paths, §1.7).

## 总览（阅读顺序就是执行顺序）

1. **阶段 1 仓库内重写**（分支 `cf-rewrite`，S1–S11）：spike 定语言 → 骨架与 CI → schema、合同与旧行为逐字固定 → Worker、测试、UI、迁移工具 → 生成器与 deploy job → 文档 → 删 Go。
   **关口**：分支 head 的 `Todofy checks` 全绿（含生产配置 dry-run、§1.5 对照表每行一个绿测试）；`git ls-files` 与 §1.7 预期一致。
2. **阶段 2 引导与首次上线**（切换前数日，无生产影响）：D1、Access、GitHub 配置 → 一次 fast-forward 推 main（新 Worker 空库上线）→ 写密钥 → 合成冒烟 → Mail Hero 白名单加新主机 → 建新目标、"测试"、再暂停。
   **关口**：两个主机名 TLS 正常且 `/health` 的 build 等于 main SHA；冒烟七码正确；Mail Hero 测试事件在 Todofy 为 `complete` 且 Todoist 有任务。
3. **阶段 3 切换日**（17:00 UTC 之后开始，约 2–3 小时，推断）：Mail Hero 当前目标切到已暂停的新目标 → 排空并暂停旧目标 → 旧侧对账 → 停旧栈 → 备份、导出、导入、校验 → 开提醒 → 解除新目标暂停 → newsletter 改指向。
   **关口**：`verify_d1.py` 三表 PASS；窗口内邮件在新 Todofy 为 `complete`；newsletter 两端点 200。
4. **阶段 4 首封真实邮件**。
   **关口**：至少一封真实邮件走完 Mail Hero `delivered` → Todofy `complete` → Todoist 任务（窗口内积压的邮件可计入）。
5. **阶段 5 同日退役**：离机加密备份校验 → Mail Hero 旧目标零在途 → 删容器与镜像 → self-host 清理 compose → 删数据与 env → Tunnel/DNS → 白名单去旧域。
   **关口**：主机无 todofy 容器、目录与 env 文件；`daily.ziyixi.science` 无 DNS 记录；Mail Hero 旧目标无等待投递。
6. **阶段 6 收尾与一周核查**：protos 退役 `proto/todofy` 与 `go/todofy`、重写 mail-hero 集成文档、newsletter 连续两期、一周只读用量核查。
   **关口**：protos `main` 只剩 newsletter 模块；`docs/verification.md` 记齐证据。

这个顺序由三条主线决定。第一，代码仍然一次落 main，但落 main 放在阶段 2：TLS、Access、token 权限这类只有线上才会暴露的问题，都在无生产影响时出现，切换日只剩与数据一致性有关的动作。第二，Mail Hero 在收信那一刻就把当前目标的 revision 冻结进邮件（mail-hero `cloudflare/src/native/ingest.ts:38`、`pipeline.ts:223-234`），投递永远走这个 revision；所以切换日的第一步是把"当前目标"指向已暂停的新目标，窗口内到达的邮件直接排在新目标上，不必事后逐条重放。第三，所有删除都排在离机备份校验与 Mail Hero 零在途之后。

## 0. 决策基线

| # | 事项 | 决定（2026-09-28） | 相对两份文档的变化 |
|---|---|---|---|
| 1 | Owner UI | 在 `web/` **新建** React/TypeScript UI，移动优先，不复制 Mail Hero 的 `styles.css`、`UI.tsx`、页面与壳；只借用 CSRF 客户端模式与 `action_request_id`（mail-hero `web/src/api/client.ts:35-73`）、服务端 JWT/CSRF 安全模型（`cloudflare/src/native/security.ts:110-142`）。Worker 主程序仍是 Python | 取代 UI 文档 §2.1 的"复制不共享包"、`UPSTREAM.md` 与 Mail Hero `tokens.css` 前置改动 |
| 2 | 交付方式 | 不开 PR；分支完成后**一次 fast-forward 推 main**；整个重写一次做完 | 取代 v2 §4.10 的"PR 系列"、UI 文档 §5 的三个小 PR |
| 3 | 门户 | 只用 Cloudflare Access App Launcher；不自建门户（将来若建可用 TS）；其他 tunnel 应用上 Access 由 owner 自行处理，不在范围 | UI 文档 §3.3 第 4 步与 §3.4 出计划 |
| 4 | 域名与旧数据 | UI 与 owner API 在 `todofy.ziyixi.science`（Access 覆盖整个主机名，出现在 App Launcher）；`/hooks/mail`、newsletter 两端点、`/health` 在同一 Worker 的第二个 Custom Domain `todofy-hooks.ziyixi.science`；`todofy.db` 邮件全文**导入** `legacy_mail_text`，默认永久保留 | v2 §4.2 默认不导全文 → 导入；v2 §5.5 路径级 Access → 整主机名 |
| 5 | 旧容器 | 首封真实邮件通过后**当天**删除 compose 四个服务块、容器、镜像、数据目录与 env 文件；GHCR 四个包原样保留，可随时重拉；todofy 仓库**删除全部 Go 代码** | 取代 v2 §7.4/§7.5 的"停机保留 30 天" |
| 6 | 本轮产出 | 仍是研究，不写代码 | — |

hooks 主机名用一级子域 `todofy-hooks.ziyixi.science`：Universal SSL 只覆盖 `*.ziyixi.science` 这一级，`hooks.todofy.…` 这类二级名需要额外证书，没有任何收益。

**不变的 v2 决定**（§4.1–§4.12）：Python Workers（Rust 唯一备选，由 spike 决定）；Workers Free，$0/月；一个 Worker + 一个 SQLite DO `TodofyCoordinator`（实例 `inbox-v1`）+ 一个 D1 `todofy`；§5.2 的 schema（本文 S3 补三处）；Access + 代码内 `js.crypto.subtle` 验 RS256；Todoist 幂等四层保护，`todo_unknown` 永不自动重发；newsletter 的 `GET /api/summary`、`/api/recommendation` 字段只增不删；每 UTC 日最多一条 Todoist 提醒；无 DAG、CloudMailin、Containers、Queues、KV、R2；日报 `13:30 UTC` 预计算；运维开关镜像为 GitHub variables；部署只走 GitHub Actions。

**本文对 v2 的三处更正**（以仓库为准）：① Todoist 描述模板的标签是 FROM/DATE/RECEIVED/SUBJECT（`templates/todoDescription.tmpl:1-4`，RECEIVED 填收件人地址），不是 v2 §5.3 写的 FROM/TO/DATE/SUBJECT；② Mail Hero 目标没有"归档"操作，只能创建、修改（含暂停）、轮换凭据、解除阻断、检查、测试（mail-hero `api-endpoints.ts:155-185`），v2 §7.5 的"归档旧目标"改为永久暂停；③ offen 备份服务整体收录了 `./data` 与 `./env`（self-host `docker-compose.yml:314-320`），"删干净旧数据"必须考虑它的归档保留期。

## 1. 阶段 1：仓库内重写

### 1.1 起点与推送规则

另一任务的未提交文件是 `handle_recommendation_test.go`（M）、`utils/consts.go`（M，推荐 prompt 改为"至多 N 条、可返回 `[]`、自动扣款证据规则"，`:37-78`）、`utils/recommendation_prompt_test.go`（新）与未跟踪 `docs/`。确认那个任务已结束后，把它们原样作为 `cf-rewrite` 的第一个提交并注明出处。不先推 main，是因为旧 `ci.yml` 监听 main（`ci.yml:3-7`），任何 `*.go` 改动都会跑完整 Go 流水线并向 GHCR 发布四个永不部署的镜像（`ci.yml:47-60`）。

```sh
git checkout -b cf-rewrite 6c46ed4      # 首个提交 = 另一任务的文件
git push -u origin cf-rewrite           # 之后每次 push 只跑 checks
git config --unset core.hooksPath       # 若曾 make install-hooks；旧钩子要求 golangci-lint
```

mail-hero 的触发器是 `pull_request` + `push: [main]`（`native.yml:3-7`）。Todofy 没有 PR，改为：

```yaml
on:
  push:                      # 任何分支 push 都跑 checks
  workflow_dispatch:
concurrency: {group: todofy-native-${{ github.ref }}, cancel-in-progress: false}
jobs:
  checks: {name: Todofy checks, runs-on: ubuntu-24.04, timeout-minutes: 15, ...}
  deploy:
    needs: checks
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    timeout-minutes: 15
    environment: {name: production, url: 'https://${{ vars.TODOFY_PUBLIC_HOST }}'}   # 只有 main 可用
    concurrency: {group: todofy-production, cancel-in-progress: false}
```

main 上的每个提交必须满足：(a) 同一 SHA 上 `Todofy checks` 绿；(b) `deploy` 成功，且 hooks 主机 `/health` 的 `build == GITHUB_SHA`；(c) D1 migration 只做前向兼容；(d) 不同时含两套栈。(a) 由分支保护强制执行：main 设 required check `Todofy checks`、禁止 force push、不要求 PR、勾选"不允许绕过"（owner 是管理员，不勾则规则对他无效）。required check 对直接 push 同样生效，而 fast-forward 不改 SHA，所以分支上绿过的 head 可以直接推（mail-hero `docs/ci-cd.md:15` 也建议 required check）。由此，Todofy main 不使用 `[skip ci]` 提交：包括文档在内的所有改动都先推分支、等绿、再 fast-forward；main push 触发的重复部署是同一份代码，没有副作用。运维开关只改 GitHub variable 后 `workflow_dispatch`，不手工 `wrangler deploy`；main 上 deploy 失败时，修好外部配置后重跑同一个 run。

### 1.2 落地后的 main

```
todofy/
  pyproject.toml  uv.lock  pylock.toml      # runtime 零第三方包；dev: pytest, httpx；workers-py 钉版本
  package.json  package-lock.json  .nvmrc   # 仅 wrangler（钉版本）、openapi-typescript；Node 26
  wrangler.toml  wrangler.test.toml  wrangler.test-auth.toml
  migrations/0001_init.sql
  worker/todofy/core/      # 纯 Python：contract vocab prompts render reminder_text backoff classify
                           #   request_id report_schema access_claims
  worker/todofy/runtime/   # entry coordinator(DO) ledger gemini todoist access_jwt csrf api reports retention health
  tests/unit/(golden/)  tests/runtime/  tests/fakes/{gemini_fake,todoist_fake,test_fakes}.py
  web/                     # 新 React/TS：src/{api,app,pages,components}、tokens.css
  api/owner-api-v1.openapi.yaml  api/{summary,recommendation}-v1.schema.json
  api/mail-received-v1.schema.json          # 自 mail-hero api/ 复制，文件头注明来源 commit
  tools/legacy_migration/{legacy_to_d1.py,verify_d1.py,test_legacy_to_d1.py,fixtures/}
  tools/smoke_webhook.py
  deploy/generate_ci_config.py  deploy/test_generate_ci_config.py
  docs/{cloudflare-migration-plan(-v1).md, ui-and-portal-research.md, implementation-order.md,
        cloudflare-setup.md, ci-cd.md, verification.md}
  README.md  architecture-diagram.md  LICENSE  .gitignore  .github/workflows/native.yml
```

`.gitignore`：`uiassets/dist/`、`python_modules/`、`wrangler.production.ci.json`、`.wrangler/`、`node_modules/`、`.venv/`。`core/` 不导入 `workers`/`js`，在宿主 CPython 上秒级测试；`runtime/` 只由黑盒运行时测试覆盖。`api/` 是前后端唯一共享真源：生成的 `schema.d.ts` 提交进仓库并在 CI 做漂移检查。

### 1.3 步骤

依赖：S1 → S2 → (S3 ∥ S4) → S5 ∥ S6 ∥ S7 ∥ S8 → S9 → S10 → S11。关键路径 S1 → S2 → S5 → S9 → S11。spike 在第一天，因为它决定语言；合同与旧行为固定（S4）先于 Worker 和 UI，也是删 Go 的硬前置；运行时夹具（S6）与 S5 交错生长；迁移工具的枚举表要在 protos 删 proto 之前固化；删 Go 是分支的最后一个提交。每步的"完成"指分支 push 的 Actions run 绿且 `docs/verification.md` 记了 run 链接，本机跑过不算。

| # | 步骤 | 做什么 | 完成定义 / 门禁 |
|---|---|---|---|
| S1 | Spike（v2 §6.4，T-Py-1…4） | 最小 Worker：`/hooks/mail` → DO `/ingest` → D1 → alarm 调假 Gemini → `/__scheduled`；`js.crypto.subtle` 验本地密钥签的 RS256；`AbortSignal.timeout` 对挂起的假服务真正断开；1 MiB 载荷过 `/ingest`；核实 `pywrangler deploy --dry-run --config` 是否透传 | 四个回退条件全为否并附 run 链接；任一为真且一日内绕不过 → 改 Rust，其余步骤形状不变 |
| S2 | 骨架 + checks | `pyproject`/`uv.lock`（`uv sync --locked`）、`package.json`、`.nvmrc`、`wrangler.toml`（`compatibility_date="2026-09-08"`、`python_workers`、两条 `custom_domain` route、`[assets] run_worker_first=true`、`crons=["*/10 * * * *"]`）；`Todofy checks` job，actions 用 commit SHA 固定（复用 mail-hero `native.yml:26-29` 与 protos `publish-python.yml:30` 的 SHA） | 空套件下分支 push 绿 |
| S3 | D1 `0001_init.sql` | v2 §5.2 全部表 + ① `owner_actions(owner, action_request_id, kind, event_id, request_hash, result_ref, http_status, created_at, UNIQUE(owner, action_request_id))`；② `event_transitions(id INTEGER PRIMARY KEY, event_id, at, from_state, to_state, error_code, actor)` + 索引 `(event_id, at)`；③ `legacy_mail_text(event_id PK, created_at, text, expires_at)`，`expires_at` NULL=永久，部分索引 `WHERE expires_at IS NOT NULL`；`summaries.imported`、`mail_events.imported` | 宿主 `sqlite3` 执行成功；`wrangler d1 migrations apply --local` 成功；pytest 断言表与索引存在 |
| S4 | 合同与逐字固定 | `api/owner-api-v1.openapi.yaml`（UI 主机：`/api/v1/csrf`、`/overview`、`/events?view=recent\|attention&state&cursor`、`/events/{id}`、`POST /events/{id}/reconcile`、`/reminders`、`/reports/latest`、`POST /reports/recompute`、`/legacy_text/{id}`、`/setup`；hooks 主机：`POST /hooks/mail`、`GET /api/summary`、`/api/recommendation`、`/health`），`state`、`error_code`、`reminder.state` 定义为 enum，旧码标 `x-legacy: true`；两份日报 JSON Schema；`core/contract.py`（规则来自 `mail_inbox.go:67-122`）；`core/vocab.py`、`prompts.py`、`render.py`、`reminder_text.py` 按 §1.4；在删 Go 前执行一次**不提交**的 `go run`，把三段 prompt（推荐 prompt 以 n=1/3/10 格式化）与两例 `renderMailTodoBody` 输出（ASCII、中文，不含 `&<>'"`）写成 `tests/unit/golden/*.txt` 并提交；`openapi-typescript` 生成 `web/src/api/schema.d.ts` | golden 逐字节相等；`test_vocab.py` 断言 OpenAPI enum 与 Python 集合相等；`schema.d.ts` 重新生成后 `git diff --exit-code` |
| S5 | Worker 核心（最大项） | `entry.py` 按 `Host` 路由（公开主机 → JWT → assets/owner API；hooks 主机 → Bearer/Basic；其他 404）；DO：`/ingest`、`/wake`、alarm 状态机（v2 §5.3 步骤 A/B/B′、提醒、日报、清理），每次 CAS 与 `event_transitions` 写同一 `batch()`；`gemini.py`、`todoist.py`（建任务、页脚分页查找、提醒）；`access_jwt.py`（JWKS 缓存、`iss/aud/exp/iat/email`、别名映射到 `ACCESS_OWNER`；issuer 必须匹配 `^https://[a-z0-9-]+\.cloudflareaccess\.com$`，同 `security.ts:113`，只有测试配置的 `DEV_ACCESS_LOOPBACK_ISSUER` 可放宽）；`csrf.py`（签名双提交 + `Origin` 同源，语义同 `security.ts:130-142`，cookie 名 `todofy_csrf`）；`api.py` 幂等（`INSERT OR IGNORE owner_actions`，同 `request_hash` 回放、不同则 409）；`/health` 只回 `{build}`（取 `BUILD_SHA`）；缺 `MAIL_WEBHOOK_TOKEN_SHA256` 时 hooks 端点回 503 `not_configured` | `tests/unit` 与 S6 场景全绿 |
| S6 | 运行时夹具 | 两份配置、假服务合同、场景清单见 §1.5；fixture：起假服务 → `wrangler d1 migrations apply --local --persist-to` → `uv run pywrangler dev --config … --test-scheduled` → `httpx` | 本机与 CI 各 ≤5 分钟；vocab 中每个 `error_code` 至少一个能产生它的场景 |
| S7 | 新 React UI | 简报见 §1.6 | `npm run typecheck && npm test && npm run build`；drift 检查；S6 的 SPA 场景 |
| S8 | 迁移工具 | v2 :199 所说的 scratchpad 原型（`dbmig/`）从未进仓库，按 v2 §4.2（:187-199）规格在 `tools/legacy_migration/` 重写：只读打开源库；`--include-text` **默认开**；>90 KB 文本先插前 80 KB 再分块 `UPDATE … text = text \|\| ?`（每条 <100 KB）；`expires_at` 默认 NULL；模型枚举表固化 protos `proto/todofy/large_language_model.proto:15-55` 全部 19 项（0–18），名字取 `llm/consts.go:7-19`，其余按枚举名派生，未知 → `legacy-model-<n>`；解析 `**SUBJECT:` 行用 `core/render.py` 的同一常量并 `html.unescape`（旧模板经 `html/template` 转义，`mail_inbox_worker.go:11`）；`--check-schema` 用 `PRAGMA table_info` 比对预期列（fixture DDL 头注引用 `database/database.go:42-51` 与 `mail_inbox.go:239-274`@`6c46ed4`；`database_entries` 列名 `llm_model`、`hash_id`、`deleted_at` 来自 GORM 默认命名，推断）；`verify_d1.py` 对账本、摘要、全文三表各算规范化 SHA-256。`tools/smoke_webhook.py` 由 `scripts/test_mail_inbox_integration.py:36-64` 改写：去掉 docker restart 与 BasicAuth，补 415/413/400，用 `needs_review=true` 代替 `[Todofy System]` 前缀（该忽略规则不移植，v2 C1）；其 payload 同时作为 `tests/runtime` 共享 fixture | 合成 SQLite（40 条 Mail Hero 行 + 8 条 CloudMailin 行 + 重复 hash + 空 hash + 120,000 字文本）pytest；本地 D1 导入 → `verify_d1.py` PASS 留证据（v2 指出此前没有） |
| S9 | 生成器 + deploy job | `deploy/generate_ci_config.py` 是 mail-hero `deploy/generate-ci-config.mjs:21-62` 的 Python 孪生：逐项正则校验（账户 32 hex、D1 UUID、issuer、AUD 64 hex、邮箱、域名、布尔、整数、`HH:MM`），缺失即失败；`TODOFY_D1_DATABASE_NAME` 可省、回退 `todofy`（同 `generate-ci-config.mjs:54`）；`vars.BUILD_SHA` 取 `GITHUB_SHA`；输出两条 route；永不输出 `DEV_*`；只打印变量名。`checks` 加一步：用合法占位值（32 个 0 的账户、`00000000-0000-4000-8000-000000000000`、64 个 0 的 AUD、`https://example.cloudflareaccess.com`）生成到 `$RUNNER_TEMP` 再 dry-run（无需 token，mail-hero 也在 token 步骤之前 dry-run，`native.yml:105-107`）。`deploy`：`npm ci`、`uv sync --locked`、`npm run build --prefix web` → 生成配置 → dry-run → `wrangler d1 migrations apply DB --remote` → `pywrangler deploy` → `curl https://$TODOFY_HOOKS_HOST/health` 断言 build（10 次 × 15 s，首发 DNS 需时间）→ `if: always()` 删配置 | `deploy/test_generate_ci_config.py` 断言 `BUILD_SHA` 为 40 hex、`DEV_*` 从不出现；占位配置 dry-run 在分支上绿 |
| S10 | 文档 | README（是什么、状态词汇、对账 runbook、开关）、`architecture-diagram.md`、`docs/cloudflare-setup.md`（= 阶段 2）、`docs/ci-cd.md`（含 §1.1 规则）、`docs/verification.md`（只写实际跑过的）；删除所有 gRPC/Docker/CloudMailin 文字 | 文档中的变量名与生成器一致（grep 校验，覆盖 `TODOFY_D1_DATABASE_NAME`） |
| S11 | 删 Go 树 | `git rm -r` §1.7 全部；重写 `.gitignore` | 分支 push 绿；§1.7 两项核对为空 |

### 1.4 必须逐字固定的旧行为（S4/S5，删 Go 之前）

下表各项的唯一出处都在待删的 Go 文件里，删掉之后只能凭记忆重写，所以必须在 S11 之前变成 Python 常量和测试。golden 文件需要 Go 工具链，只能在删 Go 之前生成；它们是一次性产物，生成用的 `go run` 不进仓库。凡是与 Go 输出有意不同的地方（不转义 HTML、`#tag` 换成空格、提醒指引改写），表中写明决定，测试断言新行为而不是旧行为。

| 行为 | 来源（`6c46ed4`） | Python 落点与决定 |
|---|---|---|
| Todoist 描述 | `templates/todoDescription.tmpl:1-7`；字段 `mail_inbox_worker.go:120-132`（From[0]、To[0]、`sent_at` 优先于 `received_at`、UTC RFC3339）；页脚 `:156-173` | `core/render.py` 常量：`**FROM: …**`、`**DATE: …**`、`**RECEIVED: <To[0]>**`、`**SUBJECT: …**`、空行、24 个 `=`、正文（模板无结尾换行），再接 `\n\nMail Hero event: <id>`；不做 HTML 转义（有意修正 v2 列出的 B1） |
| 截断提示 | `mail_inbox_worker.go:134-154`、`:219-223` | 中文提示逐字保留，同时进摘要缓存与任务正文 |
| `#tag` 清洗 | `mail_inbox_worker.go:27,218` 用字面量 `<removed tag>` | 按已批准的 v2 §5.3 换成单个空格；golden 断言不出现 `<removed tag>` |
| 任务标题与请求 ID | `mail_inbox_worker.go:256-262`；`todo/todo.go:169-178` | 主题为空白时 `content="(No subject)"`（契约允许只有正文，`mail_inbox.go:95`）；`X-Request-Id = "todofy-" + sha256(替换后主题 \0 含页脚的 todo_body \0 From[0])[:28]` |
| 提醒文本 | 标题 `mail_inbox_worker.go:602` + 前缀 `utils/consts.go:7`；正文首行 `:676`、条目 `:677-686`；上限与重试 `:540-545`；指引 `:547-556` | `core/reminder_text.py`：标题保持 `[Todofy System] Mail Hero：N 封邮件需要处理`（前缀只作标签，无忽略语义）；条目 `- <event_id> · <state> · <code> · 收到 <RFC3339>`，最多 20 行，其余 `- … 另有 N 条`；指引改写为 `https://todofy.ziyixi.science/attention` 与 UI 四种对账动作（旧 BasicAuth 与 `X-Todofy-Admin-Action` 不再存在） |
| 提醒结果分类 | gRPC 码分类 `mail_inbox_worker.go:633-645` | 沿用步骤 B 的 HTTP 分类（v2 §5.3）：发出前连接失败、400/401/403/404、429/502/503/504 重试用尽 → `reminder_create_failed`（每小时重试，≤5 次）；500、发出后超时或断连、2xx 无 id → `reminder_result_unknown`（当日不再发） |
| 三段 prompt | `utils/consts.go:9-78`（工作区版本） | 逐字含 raw string 行首制表符；用 `.replace("{top_n}", str(n))`，不用 `str.format`（`:76` 的 JSON 示例含花括号）；断言渲染后无 `{top_n}`、示例原样存在 |
| 状态与错误码 | 状态 `mail_inbox.go:244-246`，提醒状态 `:264`；码散落在 `mail_inbox_worker.go:101-312,638-644,765` 与 `mail_inbox.go:300,310` | `core/vocab.py` 单一来源：旧码（`invalid_saved_event`、`mail_needs_review`、`summary_failed`、`todo_result_unknown`、`dismissed_by_owner` 等，保留供导入行显示）+ v2 新码（`llm_quota`、`llm_budget_exhausted`、`llm_request_rejected`、`todoist_rejected`、`todoist_auth_blocked`、`lookup_not_found`、`lookup_failed`、`processing_interrupted_limit`）；可用对账动作按 `(state, error_code)` 计算，`retry_summary` 排除 `mail_needs_review`（`mail_inbox_worker.go:748-757`） |

### 1.5 测试：配置、假服务、场景与 Go 测试对照

两份运行时配置。`wrangler.test.toml` 打开 `DEV_FAKES`、`DEV_AUTH_BYPASS` 与短退避，只跑 owner API 形状与状态机。`wrangler.test-auth.toml` 不开 bypass，`ACCESS_ISSUER` 指向夹具的 loopback 假 issuer（JWKS 在 `/cdn-cgi/access/certs`），只有这份配置设 `DEV_ACCESS_LOOPBACK_ISSUER=true`；生产生成器的 issuer 正则不变，也永不输出 `DEV_*`。

| 假服务 | 必备行为（`tests/fakes/test_fakes.py` 先测假服务本身） |
|---|---|
| 共同 | 控制端点 `/admin/{reset,seed,queue,state}`，记录 `{method,path,query,headers,body}`（沿用 `sut/contracts/admin/common.go:9-15`）；按 method+path 的 FIFO 响应队列、`delay_ms`、**挂起直到客户端断开**；429 带 `Retry-After`，秒数与 HTTP-date 两种（对照 `todo/internal/todoist/client.go:486-507`） |
| 假 Todoist | Bearer 校验 → 401（`sut/fakes/todoist/main.go:176-182`）；自增 ID（`:406-428`）；`GET /api/v1/tasks?project_id=&cursor=` 分页返回 `{results,next_cursor}`、按 project 过滤、排除已完成与已删除（Go 版只回裸数组，`:228-241`）；记录 `X-Request-Id` |
| 假 Gemini | `x-goog-api-key` 校验（`sut/fakes/gemini/main.go:160-163`）；`countTokens`、`generateContent` 各自队列（`:182-203`）；返回 `usageMetadata`；记录 `systemInstruction`、`responseMimeType`、`responseSchema` |

假服务的规格按新设计的失败模式倒推：页脚查找要翻页，所以假 Todoist 必须能分页；`AbortSignal.timeout` 只有在对方真的不响应时才能被验证，所以要能挂起；`Retry-After` 在两侧都会出现，两种格式都要能播种。现有 Go 假服务只覆盖其中一部分，照抄会让这些分支第一次被执行就发生在生产上。

场景 = v2 §6.2 全表，加：UI 主机无 JWT、错 aud、过期、非 owner → 401，别名邮箱 200 且 CSRF 归属 `ACCESS_OWNER`，service token 无 email → 拒绝，跨源 POST → 403，hooks 主机不受 JWT 影响；缺密钥 503 `not_configured`；`_PREVIOUS` 轮换期新旧 token 都 204；newsletter Basic 错口令 401、每小时 20 次后 429；日报 `stale` 与每小时 30 次上限；Gemini 429 → `llm_quota` 且尊重 `Retry-After`，预算耗尽 → `llm_budget_exhausted` 推迟不丢；Todoist 400 → `todoist_rejected` 退避，401/403 → `todoist_auth_blocked`，500 或超时 → `todo_unknown`，页脚查找命中、未命中与失败（含翻页）；提醒 HTTP 结果到 failed/unknown 的映射；SPA 回退、安全头、同 `action_request_id` 重放得同结果、`event_transitions` 时间线、`legacy_text` 读取与到期清理。

| Go 测试 | 固定的行为 | Python 测试 |
|---|---|---|
| `mail_inbox_test.go:64` | 同事件同字节 204 幂等，异字节 409 | runtime `test_hooks_idempotency` |
| `mail_inbox_test.go:282` | 契约不完整 → 400 | unit `test_contract.py` + runtime |
| `mail_inbox_test.go:347-380` | 空主题 → `(No subject)`，描述含 event id，请求 ID 稳定 | unit `test_render.py`、`test_request_id.py` |
| `mail_inbox_test.go:382` | token 轮换期间去重与单写者不变 | runtime `test_token_rotation` |
| `mail_inbox_attention_test.go:144` | attention 查询走有界索引 | unit `test_ledger_sql.py`（`EXPLAIN QUERY PLAN`） |
| `mail_inbox_attention_test.go:223` | 瞬态摘要失败持续重试 7 天后才放弃 | unit `test_backoff.py` + runtime |
| `mail_inbox_attention_test.go:355-433` | 每 UTC 日一条、不含主题/地址/正文、≤20 行、计数进标题 | unit `test_reminder_text.py` + runtime |
| `mail_inbox_attention_test.go:481`、`:561` | 只重试确定失败且请求冻结；结果不明当日不重发 | runtime `test_reminder_retry` |
| `mail_content_policy_test.go:38`、`:63`、`:98` | storage-v1 元数据一致；截断提示进摘要与任务；needs_review 不能 retry 进业务副作用 | unit `test_contract.py`、`test_render.py`、`test_vocab.py` |
| `todo/internal/todoist/client_test.go:210`、`client_extended_test.go:169` | 发送 `X-Request-Id`；请求体与头部上限 | runtime（假 Todoist 记录）+ unit `test_todoist_request.py` |
| `utils/recommendation_prompt_test.go:16-91`、`handle_recommendation_test.go:48` | prompt 四处 N、可返回 `[]`；不足 N 条不填充 | unit `test_prompts.py`、`test_report_schema.py` |

S11 的门禁：这张表每一行都有一个绿测试，并附 run 链接。

### 1.6 UI 简报（S7）

代码全部新写，版本与 UI 文档 §2.1 一致但不复制文件：React 19、react-router 7、@tanstack/react-query 5、Vite 7、vitest 4.1.11、testing-library、lucide-react（本地打包）。先按 390 px 设计：宽度 <768 px 用底部四个 tab（关注、事件、日报、更多；"更多"里是提醒、预算、健康、设置），≥768 px 改为左侧导航；"关注"带 attention 计数徽章。顶部自有的 `StatusBanner` 只在异常时出现，覆盖五种状态：维护模式、处理暂停、Todoist 暂停、当日 Gemini 预算耗尽、Todoist 认证阻断，每种一句中文说明后果。

`tokens.css` 的最小集合写死：颜色 `--bg --surface --fg --muted --border --accent --danger --warn --ok`，三档字号，四档间距，一个圆角，浅色与深色各一套（跟随 `prefers-color-scheme`）；组件只用 token。页面沿用 UI 文档 §2.2 的路由：落地页 `/attention`，手机上用卡片列表，一屏显示短 ID、状态、错误码中文说明与下次重试时间；`/events/:id` 的四种对账动作各开一个模态框，可用动作由 `(state, error_code)` 决定；`task_not_created` 要键入事件短 ID 才能确认，并写明"会再次调用 Todoist，可能重复建任务"；`dismiss` 写明"不会检查 Todoist"。错误态显示 API 的 `code` 与 `request_id`。不加载远程字体、图标或脚本；全部操作可用键盘完成。

`src/api/client.ts` 按 mail-hero `web/src/api/client.ts:35-73` 的模式重写：取令牌、403 后清掉重取、`actionId()`；类型来自 `schema.d.ts`；错误码的中文说明表以 `schema.d.ts` 的 enum 为键，vitest 断言每个值都有说明。CI 守卫 `grep -rnE 'mail_hero|mail-hero' web/src` 必须为空（文案中的产品名 "Mail Hero" 不受影响）。

### 1.7 删除清单（S11；`git ls-files`@`6c46ed4` 共 104 项：100 删、3 重写、1 保留）

| 类别 | 文件/目录 |
|---|---|
| 根目录工具链（12） | `.codecov.yml`、`.dockerignore`、`.githooks/pre-commit`、`.golangci.yml`、`Dockerfile`、`entrypoint.sh`、`Makefile`、`go.mod`、`go.sum`、`docker-compose.sut-scheduler.yml`、`docker-compose.sut.yml`、`docker-compose.test.yml` |
| 根目录 Go（17） | `main.go`、`main_test.go`、`grpc.go`、`grpc_test.go`、`handle_{dependency,recommendation,summary,updatetodo}.go` 及各自 `_test.go`、`mail_inbox.go`、`mail_inbox_test.go`、`mail_inbox_attention_test.go`、`mail_inbox_worker.go`、`mail_content_policy_test.go` |
| 整目录（64） | `database/`(4)、`dependency/`(5)、`llm/`(9)、`todo/`(14)、`utils/`(12，另加分支首提交里的 `recommendation_prompt_test.go`)、`sut/`(12)、`scripts/`(1)、`templates/`(1)、`testdata/`(1)、`testutils/`(2)、`env/`(3) |
| Go workflows（7） | `.github/workflows/{ci,reusable-build,reusable-integration-test,reusable-lint,reusable-security,reusable-sut-test,reusable-test}.yml` |
| 重写（3） | `README.md`（622 行）、`architecture-diagram.md`（85 行）、`.gitignore` |
| 保留（1） | `LICENSE`；`docs/` 由分支首提交纳入 |

核对：`git ls-files` 与 §1.2 预期清单逐项比对无差异；`git grep -nE 'github.com/ziyixi/protos|gin-gonic|google.golang.org/grpc' -- ':!docs'` 为空（只匹配 import 级字符串，迁移脚本里的 `--include-cloudmailin` 与注释不会误报）。旧实现永远留在 `6c46ed4` 的历史里。

## 2. 阶段 2：引导与首次上线（切换前数日，无生产影响）

新 Worker 在空库上线后，cron 照常运行；空窗口的日报为 `empty_window`，不调 Gemini（v2 :396）。旧栈继续服务：主镜像按 digest 固定（self-host `docker-compose.yml:222`），这次 push 同时删掉了 `ci.yml`，不会再产生新镜像。提醒在本阶段关闭：B7 的合成事件一进入 `failed_summary` 就算 attention，而 cron 每 10 分钟检查一次，下一次检查可能就在几秒之后；一旦当天的提醒被它占用，当天真实的积压就不会再有提醒（v2 :394）。

GitHub variables（B3）：`CLOUDFLARE_ACCOUNT_ID`、`TODOFY_D1_DATABASE_ID`、`TODOFY_D1_DATABASE_NAME`（可省，回退 `todofy`）、`TODOFY_PUBLIC_HOST=todofy.ziyixi.science`、`TODOFY_HOOKS_HOSTS=todofy-hooks.ziyixi.science`（切换时加 `daily.ziyixi.science`）、`TODOFY_MAIL_SOURCE_ID=mail-hero-personal`（须等于 self-host `docker-compose.yml:231`）、`TODOFY_ACCESS_ISSUER=https://ziyixi.cloudflareaccess.com`（以 Zero Trust 的 team 域名为准）、`TODOFY_ACCESS_AUDIENCE`、`TODOFY_GEMINI_MODELS=gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite`（`llm/consts.go:21-25`）、`TODOFY_GEMINI_DAILY_TOKEN_BUDGET=3000000`、`TODOFY_TODOIST_DEFAULT_PROJECT_ID`、`TODOFY_REPORT_DEFAULT_TOP=10`（as-built；等于 newsletter 的 `?top=10`）、`TODOFY_REPORT_PRECOMPUTE_UTC=13:30`、`TODOFY_REMINDER_ENABLED=false`（C9 改 true）、`TODOFY_LOOKUP_DELAY_MS=120000`、`TODOFY_LEGACY_TEXT_RETENTION_DAYS=0`（0 = 永久）、`TODOFY_MAINTENANCE_MODE=false`、`TODOFY_PROCESSING_PAUSED=false`、`TODOFY_FORCE_PAUSE_TODOIST=false`。`BUILD_SHA` 不是变量，由生成器写入。

B9 是一次真实的业务调用：它会让 Gemini 生成摘要、在 Todoist 建一条任务。之所以放在阶段 2，是因为只有它能在切换之前证明 Mail Hero → Todofy → Gemini → Todoist 整条链在生产上可用。做完立刻暂停 T_new；而在切换日之前当前目标仍是 T_old，所以 T_new 也不会收到任何真实事件。

| # | 哪里 | 动作 | 通过标准 |
|---|---|---|---|
| B1 | 本机 | `npx wrangler d1 create todofy` → 记下 `database_id` | 输出含 UUID |
| B2 | Zero Trust → Access → Applications | Self-hosted 应用，domain 精确 `todofy.ziyixi.science`（无路径）；两条 Allow 策略照抄 Mail Hero（精确邮箱 + 对应 IdP，无 Bypass，mail-hero `docs/cloudflare-setup.md:109-111`）；App Launcher 可见；记下 AUD。不为 `todofy-hooks.ziyixi.science` 建任何应用。若 dashboard 因 DNS 记录尚不存在而拒绝（推断可能），B3 先填随机 64 hex 占位 AUD，B6 再建应用并替换 | AUD 为 64 hex |
| B3 | GitHub todofy | Environment `production`（可部署分支仅 `main`）；main 分支保护（§1.1）；environment secrets：`CF_API_TOKEN`（Workers Scripts 编辑、D1 编辑、zone `ziyixi.science` 的 Workers Routes/Custom Domains 与 DNS 编辑、账户设置读；无 Billing；参照 mail-hero `docs/ci-cd.md:40`）、`TODOFY_ACCESS_OWNER`、`TODOFY_ACCESS_OWNER_ALIASES`（可空；as-built 为 secrets）；variables 如上 | 变量名与生成器一致 |
| B4 | 本机 | 生成 webhook Bearer（`openssl rand -hex 32`）与 newsletter Basic 用户名/口令，`printf '%s' "$VALUE" \| shasum -a 256` 得摘要；建议为新 Worker 新签发 Gemini key 与 Todoist token（旧的在 R5 吊销，理由见 §5）；明文只进密码管理器 | 摘要备好 |
| B5 | 本机 → Actions | 首次落 main：`git fetch origin && git checkout main && git merge --ff-only origin/cf-rewrite && git push origin main`（一次 push 只为 head SHA 跑一次 run）→ `checks` → `deploy`（0001 迁移、发布、两条 Custom Domain 及 DNS、`/health` 断言）；`curl -sv` 两个主机名核对 TLS | deploy 绿；hooks `/health` 200、build 等于该 SHA、无 302（排除通配 Access 盖住 hooks 主机）；无 token `POST /hooks/mail` → 503 `not_configured`；UI 主机无 JWT → 401 |
| B6 | 本机 | `npx wrangler secret put MAIL_WEBHOOK_TOKEN_SHA256 --name todofy`，同法 `GEMINI_API_KEY`、`TODOIST_API_KEY`、`REPORT_BASIC_AUTH_SHA256`、`CSRF_SIGNING_KEY`（as-built；`MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS` 可选；newsletter 口令须随机 ≥128 bit）；占位 AUD 情形：此时建 Access 应用，改 `TODOFY_ACCESS_AUDIENCE` 后 dispatch | 无 token `POST /hooks/mail` → 401；浏览器经 Access 登录后 UI 可用（真实 AUD 生效的证据） |
| B7 | 本机 | `MAIL_WEBHOOK_TOKEN=… python3 tools/smoke_webhook.py https://todofy-hooks.ziyixi.science/hooks/mail` → 401/415/413/400/204/204/409（合成事件 `needs_review=true`，不调 LLM/Todoist）；UI `/attention` 出现该行 → UI `dismiss`（在生产上走一遍 Access + CSRF + `action_request_id`） | 七码全对；该行变为 `ignored`；`mail_reminders` 无行 |
| B8 | GitHub mail-hero | variable `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS=daily.ziyixi.science,todofy-hooks.ziyixi.science` → Actions "Native CI and deploy" → Run workflow（main）；生成器只读变量（`deploy/generate-ci-config.mjs:24-25`），无代码改动 | run 绿 |
| B9 | Mail Hero UI | 新建目标 T_new：`https://todofy-hooks.ziyixi.science/hooks/mail`，Bearer = B4，超时 20 s（默认，`api-endpoints.ts:33`），**不设为当前** → "测试"（真 POST，走完整 LLM + Todoist；测试投递同样受全局与目标暂停约束，`pipeline.ts:336-354,390`，此刻两者都必须关闭）→ 通过后把 T_new 设为 `paused=true` | 测试事件 `delivered`；Todofy UI 中该事件 `complete` 且有 `task_id`；Todoist 任务带 `Mail Hero event:` 页脚、无 HTML 实体、无标签（owner 核对后删除）；T_new 显示暂停 |
| B10 | protos（任何时候） | `protobuf` 分支：`generate-go-modules.yml:50-51` 改为 `go/newsletter/go.mod`/`go.sum`，删 `:68-74` 的 seed 步骤，直接 push（`:9-11` 使该文件的改动触发运行） | run 绿；`:28` 的 `ubuntu-latest` 与 `:57-60` 未钉版本的 apt protoc 可能改变 `.pb.go` 头里的 protoc 版本，若 `publish-go`（`:110-137`）因此推了再生成提交，记下其 SHA；`publish-go` 结束前不动 protos `main` |

## 3. 阶段 3：切换日

时间约束：17:00 UTC 之后开始。newsletter 在 07:00 America/Los_Angeles 触发（PDT 为 14:00 UTC，PST 为 15:00 UTC），工作流约 90 分钟（self-host `newsletter-trigger/crontab:1-5`），当天那一期仍由旧栈服务；全段须在次日 13:30 UTC（Todofy 日报预计算）之前结束。次日那一期 newsletter 是新端点的第一次真实验证。

C1 与 C2 的先后是本阶段的关键。Mail Hero 在收信时读出当前目标的 revision 写进原件元数据，之后创建的投递永远指向它；暂停只让投递等待，不会把它改投到别处（`pipeline.ts:390`）。所以先把当前目标切到 T_new，再排空 T_old：C1 之后的新邮件全部排在 T_new 上，T_old 只剩切换前的存量，而旧栈此刻仍在运行，可以照常接收。不用全局 `send_paused` 也是这个原因：它既不改变任何邮件的 revision 绑定，又会同时冻结 T_old 的排空。T_new 一直暂停到 C8 校验通过：导入期间若有新事件进入 D1 并已建了 Todoist 任务，一旦需要 `time-travel restore`，这些账本记录会被一起抹掉，重投时就会重复建任务。

| # | 哪里 | 动作 | 通过标准 |
|---|---|---|---|
| C1 | Mail Hero 设置 | `current_endpoint_id` 改为 T_new（T_new 保持暂停，模式仍为 forward）。之后到达的邮件冻结 T_new 的 revision（`backup-state.ts:21-31`、`ingest.ts:38`），在 T_new 上排队；暂停与解除暂停只改 `paused`，不生成新 revision（`api-endpoints.ts:73-74`）。设置页出现"当前目标已暂停"提醒属预期（`alerts.ts:60-90`） | 当前目标为 T_new |
| C2 | Mail Hero 投递 | 排空旧目标 T_old：消息列表按 `status` 过滤（`api-messages.ts:29-32`，按每封最新一次投递）查 `pending`/`retry_wait`/`sending`，属于 T_old 的等它投完，`retry_wait` 可点"重试"；属于 T_old 的 `failed` 逐条决定：需要建任务的"重新发送为新事件"到 T_new（新 event_id，`api-messages.ts:207-220`，在 T_new 上排队），其余"取消"。然后把 T_old 设为 `paused=true` | T_old 无 pending/retry_wait/sending/未处理的 failed；T_old 已暂停 |
| C3 | 本机 | `curl -u … https://daily.ziyixi.science/api/v1/mail_inbox?view=attention` → `attention_count=0`，且 `pending/summarizing/summarized/todo_sending=0`；有剩余先在旧侧对账 | 全为 0（2026-09-28 只读结果：complete 108 / ignored 1 / 其余 0） |
| C4 | mini-PC | `docker compose stop todofy todofy-llm todofy-todo todofy-database`（先不 `rm`） | `docker ps` 无这四个 |
| C5 | mini-PC | as-built：`sudo python3 tools/legacy_migration/snapshot.py --inbox ./data/todofy-mail/inbox.sqlite --legacy ./data/todofy/todofy.db --out /root/mig/snap`（SQLite backup API，经 WAL 读全，副本转为 rollback journal，0600；不需要 `sqlite3` CLI；绝不只 `cp` 主文件） | 两个副本存在；打印的 `state_counts` 等于 C3 |
| C6 | mini-PC | `python3 legacy_to_d1.py --check-schema …` 通过后导出：`--inbox /root/mig/snap/inbox.sqlite --legacy /root/mig/snap/todofy.db --out /root/mig/out --source-id mail-hero-personal`（全文与 CloudMailin 时代行默认导入）；`scp` `out/` 到本机 | schema 核对 PASS；`manifest.json` 的 `state_counts` 等于 C3，`options.include_cloudmailin=true`，`warnings` 为空或只有"超长分块"；记下 `stats.cloudmailin_entries` |
| C7 | 本机 | `npx wrangler d1 time-travel info todofy --json` → 保存书签 | 书签已存 |
| C8 | 本机 | 依次 `npx wrangler d1 execute todofy --remote --file=out/01-ledger.sql`、`02-reminders.sql`、`03-summaries.sql`、`04-legacy-text.sql`（最大，需数分钟；`ON CONFLICT DO NOTHING` 可安全重跑）；再 `python3 verify_d1.py --manifest out/manifest.json --remote --db todofy`；删本机 `out/` | 四次无错；三表 PASS；`imported=1` 的状态计数等于 C3 |
| C9 | GitHub todofy | `TODOFY_REMINDER_ENABLED=true` → dispatch | run 绿；`/health` build 不变 |
| C10 | Mail Hero | T_new 设为 `paused=false`：窗口内排队的邮件与 C2 重新发送的事件依次投递（目标默认约 2 次/分钟） | 每封 `delivered`；Todofy UI 中为 `complete` 且有 `task_id`；T_old 投递数不再增加 |
| C11 | mini-PC | 私有 `env/newsletter.env`：`TODO_API_BASE=https://todofy-hooks.ziyixi.science`、`TODO_API_USER`、`TODO_API_PASSWORD`（键已存在，`env/newsletter.env.example:31-33`）→ `docker compose up -d --no-deps newsletter`；`curl -u … /api/summary`、`/api/recommendation?top=5`；一次错口令 → 401 | 两端点 200 JSON，`time_window_hours=24`，`status ∈ {ok, empty_window}` |

失败处理。C1–C3 失败时旧栈仍在运行：设置切回 T_old 并解除它的暂停；C1 之后绑在 T_new 上的邮件，在投递页"重新发送为新事件"到 T_old，再"取消"原事件（T_new 处于暂停，不会投两次）。C4–C8 失败：用 C7 的书签 `time-travel restore`，或执行 v2 :220 的四条 DELETE 清空导入行，`docker compose start` 四个容器，然后同上。C9 之后的失败按 §8 回滚。

## 4. 阶段 4：首封真实邮件

它单独成为一个阶段，因为它是退役的唯一前置条件：合成冒烟与 Mail Hero 测试事件都不能代替一封真实来源邮件走完转发、解析与投递的全过程。不制造测试邮件。若 C10 已有窗口内的真实邮件走完全链，关口即已满足；否则等第一封。关口通过前不进入阶段 5，当晚没有邮件就顺延到次日。

## 5. 阶段 5：同日退役

退役按"先保全、再断流、后删除"排列。R1 的加密副本是删除数据目录之前唯一经过校验的离机副本。R2 确认 Mail Hero 不再有指向 T_old 的等待投递：否则删掉 origin 后，这些投递先会因网络错误反复重试，白名单移除后又会在投递时被判为目标无效而阻断（`pipeline.ts:401-423`），而不是被干净地处理掉。R3 必须在 R4 之前，因为 compose 文件改掉之后，compose 就不再认识这四个容器。R7 放在最后，因为对 T_old 的任何修改都要按白名单重新校验 URL。

offen 备份服务把 `./data` 与 `./env` 整体收进归档（self-host `docker-compose.yml:314-320`）。因此旧 `todofy.db`（含全文）、`inbox.sqlite`、四个容器共用的 `env/todofy.env`（`:227`）与 webhook token 文件（`:234`）都已在历史归档中。这些归档同时装着其他服务的数据，不做手术式删除：让它们按私有 `env/backup.env` 的保留期自然滚出（本文未读该文件，保留期未知），owner 在 `docs/verification.md` 记下最后一份含 Todofy 数据的归档何时过期。凭据若按 B4/R5 轮换，归档里的旧密钥即作废。

| # | 哪里 | 动作 | 通过标准 |
|---|---|---|---|
| R1 | 本机 | `scp` 两个 `.backup` → `gpg --symmetric --cipher-algo AES256` → 存离机加密介质 30 天；`gpg --decrypt … \| sha256sum` 与源文件一致 | 校验和一致；不一致则停在这一步 |
| R2 | Mail Hero | 再查 T_old：无 pending/retry_wait/sending/failed（有则按 C2 处理）；T_old 保持暂停。暂停的目标只在仍有等待投递时才告警（`alerts.ts:77-82`） | T_old 零等待 |
| R3 | mini-PC | 在旧 compose 文件还含四个服务时执行 `docker compose rm -sf todofy todofy-llm todofy-todo todofy-database`；再 `docker image rm` 四个镜像（`update.sh:5` 的 `down` 不清孤儿容器，`update.sh:9` 的 `prune -f` 只删悬空镜像） | 四个容器与镜像消失，其余容器 ID 不变 |
| R4 | self-host 仓库 → mini-PC | 直接 push：删 `docker-compose.yml:219-267`（四个服务、`10003` 端口、两处挂载）；`tests/test_newsletter_deployment.py:323-324` 去掉四个名字；`tests/test_newsletter_maintenance.py:159` 的 `todofy` 改为 `stirling`；删 `env/todofy.env.example`；`TODO_API_*` 保留；主机 `git pull` | `python3 -m unittest discover -s tests` 绿；`docker compose config --services` 无 todofy |
| R5 | mini-PC | `rm -rf ./data/todofy ./data/todofy-mail /root/mig env/todofy.env env/todofy-mail-webhook.env`，以及 v2 :560 提到的 `~/todofy-releases`（若存在）；若 B4 新签了凭据，在 Gemini 与 Todoist 控制台吊销旧的 | 路径不存在；下一次 offen 备份不含 todofy 路径 |
| R6 | Zero Trust → Tunnels | 删 Public Hostname `daily.ziyixi.science → localhost:10003`；确认 `daily` 的 CNAME 随之删除，否则手删 | `dig daily.ziyixi.science` 无记录 |
| R7 | GitHub mail-hero | `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS=todofy-hooks.ziyixi.science` → dispatch。必须在 R2 之后：修改目标时会按白名单重新校验 URL（`api-endpoints.ts:26`），旧域移出后 T_old 就不能再改 | run 绿 |
| R8 | GHCR | 四个包原样保留，不归档、不删除 | — |

## 6. 阶段 6：收尾与一周核查

protos 两步对回滚没有影响（回滚只用 GHCR 镜像），放在最后只是为了集中收尾；它们依赖 todofy 已落 main（`go/todofy` 再无消费者，`go.mod:14`）与 S8 已固化枚举表。

| # | 哪里 | 动作 | 通过标准 |
|---|---|---|---|
| F1 | protos `protobuf` | `git rm -r proto/todofy`；README 删 "Gemini model catalog" 一节（`README.md:6-26`），`:43` 的示例改为 `go/newsletter`，`:52` 的 `protoc` 检查命令改为 newsletter；push | run 绿；`publish-python.yml` 因 `proto/**` 多发一个 dev wheel（接受）；等 `publish-go` 结束 |
| F2 | protos `main` | `git rm -r go/todofy`（`scripts/generate-go-proto.sh` 只做 mkdir、mv、`go mod tidy`，从不删旧产物）并 push | `find go -name go.mod` 只剩 newsletter |
| F3 | mail-hero `main` | 重写 `docs/todofy-integration.md`：`:3` 目标地址；`:13-31` 的 BasicAuth 与 `X-Todofy-Admin-Action` 对账改为 Todofy UI + Access，`:29-30` 的提醒格式按 §1.4；`:33-50` 发布流程、compose 块与 CloudMailin 句；`:52-61` 换成新证据；`:73-84` 基于 docker 的暂停与回滚改为本文 §8。按 mail-hero 惯例作 `[skip ci]` 提交 | 文档不再含 `daily.ziyixi.science` 与 BasicAuth |
| F4 | newsletter | 次日与第三日两期来自新端点 | 两期邮件的 Todofy 段正常 |
| F5 | 只读核查 | 一周内：Workers Logs 的 `cpuTime` p50/p99（Worker `fetch()`、DO `/ingest`、alarm）；D1 与 DO 行读写对照 v2 §4.3；可选：故意错 `TODOIST_API_KEY` → `todoist_auth_blocked` → 次日一条提醒 | 记入 `docs/verification.md` |

## 7. 验证清单（当前全部"未执行"；只有实际跑过的才改为"通过"并附证据）

部署成功、合成冒烟通过、真实邮件通过、newsletter 两期通过是四件事，分别记录，不互相代替。

| 层 | 项目 | 证据 |
|---|---|---|
| Spike | T-Py-1…4 在 `ubuntu-24.04` runner 绿 | Actions run |
| CI checks | unit；runtime 两份配置；§1.5 对照表每行；golden 逐字节；vocab 与 OpenAPI enum 相等；生成器 unittest；占位配置 dry-run；web typecheck/test/build；`schema.d.ts` 漂移；UI 守卫 grep；本地 D1 导入 → `verify_d1.py` PASS | 分支 push 的 run |
| 生产部署 | B5 `/health` SHA、两主机 TLS、hooks 无 302；B6 前 503、之后 401/204 | run 日志、curl |
| 安全 | UI 主机无 JWT → 401；跨源 POST → 403；同 `action_request_id` 重放同结果；service token 无 email 拒绝 | curl |
| 业务 | B7 七码；B9 完整 LLM + Todoist；C8 三表 PASS 与计数；C10 窗口邮件；C11 两端点；阶段 4 首封真实邮件；F4 连续两期 | UI 截图、Todoist 任务、newsletter 邮件 |
| 退役 | R1 校验和；R3/R4 服务列表；R6 `dig`；R2 T_old 零等待；offen 下一份归档不含 todofy | 命令输出 |
| 一周核查 | F5 各项 | `docs/verification.md` |

## 8. 风险与回滚

| # | 风险 | 处理 |
|---|---|---|
| K1 | Python SDK 刚 GA，版本变化快 | S1 spike + 钉版本；四个回退条件 → Rust |
| K2 | DNS 记录存在前可能无法建 Access 应用（推断） | B2/B6 占位 AUD；其间 UI 主机由代码内 JWT 校验失败关闭 |
| K3 | `CF_API_TOKEN` 缺 zone/DNS 权限，Custom Domain 创建失败 | B5 大声失败，补权限后重跑同一 run；只影响阶段 2 |
| K4 | Free 日额度账户级共享，Todofy 的无界查询会拖垮 Mail Hero | 账本查询都走索引并带 LIMIT；S6 覆盖；F5 核查 |
| K5 | 全文导入 76 MB 耗时，>90 KB 需分块 | C7 书签；可重跑；失败则 restore |
| K6 | 同日删容器，回滚变慢 | R1 先校验；回滚材料见下 |
| K7 | 没有浸泡期 | 阶段 2 已在生产上跑过冒烟与完整 LLM + Todoist 链；Mail Hero 在消费者接管前自动重试最多 48 次或 7 天（`pipeline.ts:393-395`） |
| K8 | `pywrangler` 是否透传 `--dry-run --config`（推断） | S1 核实；否则先 `pywrangler sync` 再 `npx wrangler deploy --dry-run` |
| K9 | 旧库列名来自 GORM 约定而非 DDL（推断） | C6 的 `--check-schema` 在导出前拦截 |

原先"二级子域证书"一行已删除：hooks 主机名改为一级子域后该风险不存在。

回滚的含义随阶段变化。R3 之前，旧栈只是停着，回滚就是重新启动它，并把 Mail Hero 切回去。R3 之后，旧栈拆成三份材料：GHCR 上的镜像、git 历史里的 compose 块与 env 示例、R1 的离机加密副本；回滚就是把它们重新拼起来，密钥从密码管理器重建。这是 owner 接受的交换：不保留热备，换来当天干净的主机。

**回滚步骤。** C9 之前见 §3 的失败处理。C9 之后、R3 之前：T_new 暂停 → `docker compose start` 四个容器 → Mail Hero 当前目标切回 T_old 并解除暂停，T_new 上尚未投出的事件"重新发送为新事件"到 T_old 后取消原事件 → newsletter env 三个键还原。R3 之后（约 30–45 分钟）：① T_new 暂停；② self-host `git revert` R4 提交，从密码管理器重建 `env/todofy.env`（若已轮换，填新凭据）与 `env/todofy-mail-webhook.env`，`gpg --decrypt` R1 副本还原两个库（R1 不可用时 offen 归档是第二来源，但它含旧密钥，取用后应轮换），`docker compose pull`（主镜像 digest 在 git 历史 `docker-compose.yml:222`，其余三个 `:latest` 仍在 GHCR）后 `up -d`；③ Tunnel 重建 `daily.ziyixi.science → localhost:10003`；④ Mail Hero 白名单加回 `daily` 并 dispatch，T_old 解除暂停并设为当前；⑤ newsletter env 还原；⑥ Todofy `TODOFY_PROCESSING_PAUSED=true` 并 dispatch（保留 Worker 与 D1）。切换后进入新 Worker 的事件留在 D1，需要旧栈处理的，用 Mail Hero"重新发送为新事件"到 T_old。

## 9. 工作量（单人专注日，推断）

| 项 | 天 | 说明 |
|---|---|---|
| S1 Spike | 1–2 | 含回退判定 |
| S2 骨架 + checks | 0.5 | |
| S3 D1 schema | 0.5 | |
| S4 合同与逐字固定 | 1–1.5 | 含 vocab、golden |
| S5 Worker 核心 | 4–5 | 最大项；若回退 Rust 再加 3–5 天 |
| S6 运行时夹具 | 2–2.5 | 两份配置、假服务合同 |
| S7 新 React UI | 3 | 8 个路由、4 个模态、vitest |
| S8 迁移工具 + 本地 D1 往返 | 1 | |
| S9 生成器 + deploy job | 0.5 | |
| S10 文档 | 0.5 | |
| S11 删 Go | 0.25 | |
| 外部仓库（B8/B10、R4、F1–F3） | 0.75 | 各自直接 push |
| 阶段 2–6 操作 | 1 | owner：阶段 2 约 2 小时，阶段 3 约 2–3 小时，阶段 5 约 1 小时 |
| **合计** | **16–19 天** | 比初稿多约 1.5 天，来自逐字固定、词汇枚举与认证测试 |

## 附录 审阅记录

| # | 审阅意见 | 结论 | 处理 |
|---|---|---|---|
| 1 | 暂停窗口内的邮件被冻结到旧 revision（blocker） | 属实（`ingest.ts:38`、`pipeline.ts:223-234,273-274,321`） | 问题采纳，修法不同：C1 先把当前目标指向已暂停的 T_new，窗口邮件直接绑到新 revision，无需逐条 replay。不用全局 `send_paused`：它既不改变 revision 绑定，又会卡住旧目标排空和测试投递（`pipeline.ts:390,438-439`）。replay/cancel 只留给 T_old 的 failed 事件与中止回退；C2 补上 Mail Hero 侧检查 |
| 2 | 退役段在确认零在途之前就删 origin/DNS | 属实 | R2 移到删除之前；另发现 Mail Hero 没有"归档目标"操作，改为永久暂停，且必须在白名单去旧域之前完成（`api-endpoints.ts:26`） |
| 3 | 首次部署、密钥、冒烟应移出切换日；白名单应在主机名验证之后 | 属实 | 全部移到阶段 2（B5–B9）；主机名改为一级子域后 TLS 风险消失，但 Access 与 token 权限仍从中受益 |
| 4 | 切换窗口会撞上 newsletter | 属实 | 采纳并加严为 17:00 UTC 之后（兼顾 PST 与约 90 分钟的工作流） |
| 5 | offen 备份收录 `./data` 与 `./env` | 属实（`docker-compose.yml:314-320`） | 更正 §0 与回滚表述；加保留期记录与凭据轮换建议 |
| 6 | 回退路径缺 AUD 占位 | 属实（`generate-ci-config.mjs:45`） | B2/B6 |
| 7 | S13-1 的"unchanged"不可靠 | 属实（`.pb.go` 头记录 protoc 版本） | B10 通过标准改为记录 bot 提交 |
| 8 | 合成行可能触发当日提醒 | 属实，但"10 分钟内 dismiss"不够：下一次 cron 可能在几秒后 | 阶段 2 `REMINDER_ENABLED=false`，C9 打开 |
| 9 | 缺 `TODOFY_D1_DATABASE_NAME` | 属实 | 可省，回退 `todofy`，列入变量表与 S10 校验 |
| 10 | 提醒文本无来源 | 属实 | §1.4；保留 `[Todofy System]` 前缀作标签；F3 同步 mail-hero 文档 |
| 11 | 描述模板格式未固定，v2 标签写错 | 属实 | §1.4 与 §0 更正；`#tag` 取 v2 的单空格；golden 来自一次性 `go run` |
| 12 | 状态与错误码无可测枚举 | 属实 | `core/vocab.py` + OpenAPI enum + 双向测试 |
| 13 | bypass 配置下测不到 401 | 属实 | 两份运行时配置（§1.5） |
| 14 | 生产配置首发前未经 wrangler 解析，`BUILD_SHA` 无来源 | 属实 | S9 占位 dry-run；生成器写入 `BUILD_SHA` |
| 15 | 假服务规格过薄 | 属实 | §1.5 假服务表 |
| 16 | 删除清单计数错误 | 属实（`todo/` 14、`sut/` 12） | §1.7 更正；核对改为 `git ls-files` 比对与 import 级 `git grep` |
| 17 | `(No subject)` 与请求 ID 输入未写入 | 属实 | §1.4 |
| 18 | 缺 Go → Python 测试对照 | 属实 | §1.5 对照表，S11 以其为门禁 |
| 19 | 冒烟脚本已有种子 | 属实 | S8 注明来源并共享 payload |
| 20 | UI 简报带 Mail Hero 壳残留 | 属实（`AlertStrip` 是 mail-hero 组件，`styles.css` 无 CSS 变量） | §1.6 重写导航、横幅、token、依赖，加 grep 守卫 |
| 21 | 场景遗漏错误码与认证路径 | 属实 | §1.5 场景补全；每个码至少一个场景 |
| 22 | prompt 逐字细节 | 属实 | 用 `.replace`；不采纳 dedent，保留制表符并以 golden 逐字节比对 |
| 23 | legacy schema 只靠推断 | 属实 | `--check-schema` 与 DDL 出处注释 |
| 24 | "main 永远可部署"无强制 | 属实 | 分支保护 + 不允许绕过；由此 Todofy main 不用 `[skip ci]` |
| — | lead：hooks 主机名 | 采纳 | 全文改为 `todofy-hooks.ziyixi.science`，删除对应风险行 |
| — | 自查 | 新发现 | 枚举为 0–18 共 19 项（初稿写 18）；mail-hero 文档 `:13-31`、`:73-84` 与 protos README `:52` 也要改；v2 的 `dbmig/` 原型不在任何仓库，S8 按规格重写 |
