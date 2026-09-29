# Todofy owner UI、统一门户与可复现 CI/CD：研究结论（2026-09-28）

> 只读研究：未修改任何仓库、主机或 Cloudflare 资源。平台事实以 [S#] 标注来源，来源表见文末（含 URL 与抓取日期）；本地读取标 [L#]；"推断"表示未经官方文档或实测证实。本文研究阶段与 Todofy 计划 v2 并行进行；v2（`cloudflare-migration-plan.md`）已选定 Worker 主程序用 **Python**（备选 Rust，第 1–2 天 spike 决定）。本文的 UI 结论对两种语言同样成立，差异处分别说明；与 v2 的两处衔接见 §2.4（Access 范围需覆盖整个 UI 主机名）与 §5（JWT 验证按 v2 用 `js.crypto.subtle`，不引入第三方包）。

> **owner 决定（2026-09-28 晚，覆盖下文相应建议）**：Todofy 前端**新做**一套 React/TS UI，不照抄 Mail Hero（§2.1 的"复制，不共享包"改为"只借用 Access/CSRF 客户端模式与 API 约定"，`tokens.css` 前置改动取消）；门户只用 App Launcher（§3.3 第 4 步的 tunnel 应用上 Access 由 owner 自行处理）；Mail Hero 的补齐项不走 PR，直接推 main。

## 1 结论摘要

- **Todofy owner UI**：在 todofy 仓库新建 `web/`，几乎原样复制 Mail Hero 的 React 19 + Vite 7 前端，由 Rust/Python Worker 通过 `ASSETS` 绑定、`run_worker_first = true` 和 SPA 回退托管；用检入的 OpenAPI 3.1 合同替代 TS 共享类型；Access 应用覆盖整个 UI 主机名，Worker 内再验 JWT，并复用 Mail Hero 的签名双提交 CSRF。
- **统一入口**：先启用 Cloudflare Access App Launcher + Bookmark（零代码、$0、约 1 小时）；只有明确需要健康徽章或用量面板时才建独立仓库的门户 Worker。不放进 Mail Hero，不用 Pages。
- **CI/CD**：三个仓库共用一份"lockfile + SHA 固定 actions + 只在 CI 构建 + dry-run 后发布 + 部署后 build 断言"的合同；无法 hermetic 的是 Cloudflare 运行时、Vite 产物字节、worker-build 下载的工具链、Python 部署时快照与 dashboard 里的 Access/DNS 配置，只能靠固定 `compatibility_date`、双构建比对和（可选）Terraform 收敛。

## 2 Todofy 的 owner UI

### 2.1 推荐技术栈与理由

结论：**复制，不共享包**。Mail Hero 的 `web/` 是 React 19、react-router 7、@tanstack/react-query 5、Vite 7、vitest 4.1.11、testing-library，构建到 gitignore 的 `uiassets/dist/`；Worker 用 `[assets] binding="ASSETS", not_found_handling="single-page-application", run_worker_first=true` 托管，并在 `env.ASSETS.fetch` 之前完成 Access 鉴权、之后加 no-store/nosniff/CSP 头 [L1]。这些都是运行时特性，与 Worker 语言无关：绑定是 Fetcher，只按 pathname 匹配，`run_worker_first=true` 让每个请求（含 SPA 壳）先进 Worker [S1][S3]；Python 官方 Flask/FastAPI 示例给出完全相同的配置和 `env.ASSETS.fetch(...)` [S7]；Rust `worker` 0.8.7 提供 `Env::assets("ASSETS") -> Fetcher` 与 `fetch_request` [S11][S12]。两点必须写进 Worker：`_headers`/`_redirects` 不作用于 Worker 生成的响应，安全头要在 Rust/Python 里手写 [S4]；Free 计划下每个经 Worker 的资源请求都计入账户级 10 万/天，超限返回 429 而不回退到静态服务 [S5][S6]，单人使用可忽略。

否决的两个替代托管方式：一是 `run_worker_first=["/api/*"]`，静态资源由平台路由直接返回、`_headers` 生效且不计请求数，但 Worker 不再为 SPA 壳复核 JWT，Mail Hero"任何替代路径都不得绕过鉴权"的纵深防御只剩 Access 边缘一层，仅在请求量成为问题时才值得；二是把 UI 放到另一个主机名的纯静态 Worker，需要两个 Access 应用、带凭据的 CORS 和跨域 CSRF，还破坏"UI 与 API 同一提交发布"的保证。语言方面无需等待：Rust 与 Python 在托管、路由、SPA 回退上的语义完全相同，差别只在 JWT/CSRF 库和测试 harness（§2.3、§2.4）。

| 项目 | 选择 | 理由 |
|---|---|---|
| 前端框架/工具 | 与 Mail Hero 同版本（React 19、Vite 7/Rollup、vitest、jsdom） | 一份心智模型；留在 Vite 7 而非 Rolldown 版本以规避确定性问题（§4） |
| 设计系统共享 | 复制 `styles.css`、`UI.tsx`（13 个原语）、`client.ts`、App 壳，写 `UPSTREAM.md` 记录 `mail-hero@<commit>` | GitHub Packages 连安装公共包都要 token，破坏"PR 无密钥" [S17]；submodule/monorepo 违反 Mail Hero AGENTS.md 的仓库边界 [L1] |
| 前置小改动 | Mail Hero 单独 PR：把约 20 个硬编码颜色/圆角提为 `:root` 变量 `tokens.css` | 现 `styles.css` 40 KB 无 CSS 变量 [L1]；提取后品牌差异约 5 行 |
| API 合同 | `api/owner-api-v1.openapi.yaml`（OpenAPI 3.1）为唯一真源；`openapi-typescript` 生成 `web/src/api/schema.d.ts` 并提交，CI 重新生成后 `git diff --exit-code` | 非 JS Worker 没有 TS 共享类型；openapi-typescript 无运行时 [S16]；Worker 侧 serde/pydantic 模型按同一合同做契约测试 |
| 托管 | 同一 Worker、同一主机名、`run_worker_first=true` | 同源无 CORS；与 Mail Hero"任何路径都不绕过鉴权"一致；`workers_dev=false`、`preview_urls=false` [S31] |

### 2.2 需要展示/操作的内容清单

状态词汇沿用现有 Go 代码与计划稿：`pending, summarizing, summarized, todo_sending, todo_unknown, todo_created, complete, ignored, failed_summary`；提醒 `sending|created|unknown|failed`；"需关注" = `failed_summary`、`todo_unknown` 或超过 6 小时未到终态 [L2][L3]。列表接口沿用"只读 ID/状态/错误码，不读 payload/summary"的隐私原则 [L2]。

| 路由 | 展示 | 操作 | 数据来源 |
|---|---|---|---|
| `/attention`（落地页） | 需关注事件表：短 ID、状态、错误码中文映射、attempts、`next_attempt_at`、时间（浏览器时区） | 进入详情 | `GET /api/v1/events?view=attention` |
| `/events`、`/events/:id` | 最近事件（游标分页、按状态筛）；详情：状态/错误码纯文本、Todoist 链接 `https://app.todoist.com/app/task/<id>`（`rel="noopener noreferrer"`）、摘要与 todo 正文预览（纯文本）、时间线 | 四种对账（模态框 + 后果文案）：`task_created`（输入 task id）、`task_not_created`（冻结正文重发，需键入确认，可能重复建任务）、`retry_summary`、`dismiss` | `GET /events/{id}`；`POST /events/{id}/reconcile`（带 `version` + `action_request_id`） |
| `/reminders` | 每 UTC 日一行：状态、attention_count、task 链接、attempts、错误码；"今日"卡片 | 无 | `GET /reminders` |
| `/budget` | 当日 `llm_usage`（reserved/used/limit 3,000,000、calls、模型顺序）、Todoist 15 分钟窗口计数/1000、`todoist_blocked_until`、`next_alarm` | 手动刷新 | `GET /overview`（DO 计数器，前端缓存 5 分钟） |
| `/health` | build SHA（链接到提交）、`compatibility_date`、D1 可达、最老到期行年龄、运行标志 | 无 | `GET /overview`；公开 `/health` 只回 `{build}` |
| `/digest` | 最新 `daily_reports`（summary/recommendation 的 status、窗口、模型、task_count）+ newsletter 收到的原始 JSON | `POST /reports/recompute`（小时上限） | `GET /reports/latest` |
| `/setup` | hooks 主机名、Mail Hero 目标设置步骤、token 轮换、Access 说明；不显示任何密钥 | 复制按钮 | 静态 |
| 壳 | 侧栏徽章 = `attention_count`；AlertStrip 显示 `PROCESSING_PAUSED`/`FORCE_PAUSE_TODOIST`/`MAINTENANCE_MODE`/预算耗尽/Todoist 阻断 | — | 5 分钟轮询 `overview`，与 Mail Hero 同 |

### 2.3 与 Mail Hero UI 的差异及补偿

| 差异 | 影响 | 补偿 |
|---|---|---|
| Worker 不是 TS，无共享类型 | 前后端字段漂移只能在运行时发现 | OpenAPI 合同 + 生成类型 + CI drift 检查 + Worker 侧 schema 契约测试 |
| Mail Hero 用 miniflare `serviceBindings.ASSETS` 桩测试 UI 托管路径 [L1] | Rust/Python 无同类 harness | 用 pytest 对 `wrangler dev`/`pywrangler dev` 进程跑 HTTP 测试，覆盖未登录 401、SPA 回退、安全头 |
| 计划稿 schema 无逐次状态转移记录 [L3] | 时间线只有 created/updated/actions | 增加 `event_transitions(event_id, at, from_state, to_state, error_code, actor)` 或有界 `history_json` |
| 幂等表 `owner_actions` 字段不足 [L3] | 无法做 Mail Hero 式 `action_request_id` 去重 | 扩为 `(owner, action_request_id) UNIQUE, kind, event_id, request_hash, result_ref, http_status`，`INSERT OR IGNORE` 后比对，冲突 409 |
| 列表不含主题 | 可用性略差 | 如需要，入库时存 ≤200 字符的有界 `subject`，不逐行解析 payload（推断） |
| 无 CSS 变量 | 品牌改色要改几十处 | 先在 Mail Hero 提 `tokens.css` |
| 本地开发循环 | Rust 每次改动 cargo 增量重建约 3 秒（本机实测 [L3]）；Python 用 `uv run pywrangler dev` | Vite 代理 `/api -> 127.0.0.1:8787` 不变 |

### 2.4 Access 与 CSRF 方式

**Access 范围必须改。** 计划稿 §5.5 只把 `todofy.ziyixi.science/api/v1/*` 放在 Access 后 [L3]。浏览器 SPA 需要壳与静态资源也在 Access 后，用户才会被重定向登录并拿到 `CF_Authorization` cookie；Worker 返回 401 不会触发登录（推断）。推荐：UI + owner API 放 `todofy.ziyixi.science`，一个自托管 Access 应用覆盖整个主机名，两条 Allow 策略与 Mail Hero 相同（精确邮箱 + IdP），无 Bypass；Mail Hero webhook（Bearer）与 newsletter（Basic）端点放同一 Worker 的第二个 Custom Domain（`todofy-hooks.ziyixi.science`，一级子域以便 Universal SSL 覆盖），代码按主机名路由，并把该主机名加入 `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS`。备选是同主机名下的路径级 Access 应用：更具体路径优先，且不继承宽应用的策略 [S35]。

Worker 内校验与 Mail Hero `security.ts` 等价 [L1][S14]：取 `Cf-Access-Jwt-Assertion`（或 cookie），从 `https://ziyixi.cloudflareaccess.com/cdn-cgi/access/certs` 按 `kid` 取公钥（密钥每 6 周轮换、旧钥 7 天有效，不能硬编码），RS256，校验 `iss`、`aud`、`exp`，`email` 必须等于 owner 或已核实别名。

| 语言 | JWT | CSRF/HMAC | 待探针验证 |
|---|---|---|---|
| Rust | `jsonwebtoken` 11，`default-features=false, features=["rust_crypto"]`（10.0 起必须选后端；Cargo.toml 已声明 wasm32 依赖）[S15]；JWKS 用 `worker::Fetch` 拉取并按 isolate 缓存 | `hmac`+`sha2`+`hkdf`+`subtle` 纯 Rust（推断可编 wasm） | wasm32 下 RSA 栈能否经 worker-build 编译、体积；失败则改用 web-sys 调 Web Crypto 验签 |
| Python | PyJWT（纯 Python，在 `pyproject.toml` 声明即打包 [S8]）+ Pyodide 自带 `cryptography` 47 [S10]；不用 `PyJWKClient`（urllib），改用 Workers `fetch` 取 JWKS 后 `jwt.PyJWK` | stdlib `hmac.compare_digest`、`hashlib`、`secrets` | Cloudflare 把所选 `compatibility_date` 映射到哪个 Pyodide 构建、是否带该 wheel（未验证） |

CSRF 保持 Mail Hero 原样：`GET /api/v1/csrf` 返回由 HKDF 派生密钥签名的 token 并设 `HttpOnly; SameSite=Strict; Secure` cookie；每个非 GET 要求 `Origin` 等于自身、`X-CSRF-Token` 头等于 cookie、HMAC 与 owner 匹配、JSON-only 且 ≤64 KiB [L1]。OWASP 把签名双提交 cookie 称为该模式"最安全的实现"，并指出自定义头会触发预检、`Origin` 属于只有浏览器能设置的 forbidden headers、SameSite 只是纵深防御 [S48]；所以三者叠加而非二选一。移植成本约 60 行，换来两个应用的安全模型逐字一致，便于日后互相对照审计。本地开发沿用 `DEV_AUTH_BYPASS`，只在 loopback 且无 `CF-Ray` 头时生效，生产配置生成器不得输出该变量 [L1]。

### 2.5 工作量（单人专注日，推断）

| 项目 | Python | Rust |
|---|---|---|
| 脚手架 `web/`、品牌、`.nvmrc`、vitest、CI 步骤 | 0.5 | 0.5 |
| OpenAPI 合同 + 类型生成 + 客户端 | 0.5–1 | 0.5–1 |
| 页面与测试（8 个路由、4 个对账模态） | 2–3 | 2–3 |
| Worker 侧（资源托管 + 安全头、JWT、CSRF、约 9 个端点、幂等表、游标分页） | 1.5–2 | 2–3 |
| Mail Hero `tokens.css` PR | 0.5 | 0.5 |
| Owner 手工：Access 应用、允许主机名 | 约 1 小时 | 约 1 小时 |
| 合计 | 5–7 天 | 6–8 天 |

相比 TS Worker，非 JS 后端约多 1 天（Python）到 2 天（Rust），几乎全部花在 JWT/CSRF/合同管道和失去共享类型捷径上；前端本身的工作量与语言无关。

## 3 统一入口/门户

### 3.1 现状（只读 API，2026-09-28）

Access 组织 `ziyixi.cloudflareaccess.com` 有 6 个应用：Mail Hero（Launcher 可见）、Mail Hero backup API（隐藏，正确）、flowday（可见）、flowday-bypass（`/pwa/*`，可见，启用 Launcher 后会出现重复 tile，应设为隐藏）、siyuan（可见）、Warp Login App；均无 tag 与 logo；列表里没有 `app_launcher` 类型应用，推断 App Launcher 尚未启用 [L4][S42]。Tunnel 主机名 changedetection/daily/dash/flowday/slash/ssh/stirling/test/unami 指向同一条隧道，siyuan 另一条；只有 flowday、siyuan 有 Access，其余公网直达 [L5]。

### 3.2 方案对比

| 方案 | 优点 | 缺点 | 判定 |
|---|---|---|---|
| A. App Launcher + Bookmark | $0、约 1 小时；tile 与 Access 应用一一对应；未上 Access 的站用 Bookmark，2026-02 起可挂可见性策略 [S21][S23]；Bookmark 仍是 2026-09-16 文档列出的正式类型 [S24]；每应用 HTTPS logo、≤25 个 tag 过滤 [S25] | 只有团队域，无自定义域（社区帖未能抓取，标"可能"）；品牌定制仅 PAYG/Enterprise [S22]；无健康/用量；配置在 dashboard | **立即做** |
| B. 自建门户 Worker | 自定义域、健康徽章、用量面板；静态 tile 免费不计数（`run_worker_first=["/api/*"]`）[S6]；CI 复用 `native.yml` | 新仓库/Worker/Access 应用/secret；健康探测要跨过 Access 与同 zone fetch 的坑；Mail Hero/Todofy 各需新增机器身份端点 | 仅当明确要面板 |
| C. 放进 Mail Hero | 无新仓库 | 违反 AGENTS.md 单一用途；共用 100k/天与发布周期 | 否 |
| D. Terraform 化 Access | 配置进 git、可审阅回滚；R2 可作 S3 兼容 state 后端 [S42] | 需 Access 写权限 token 放 CI；后端文档未提状态锁；仅 6–15 个应用 | 可选、后做 |
| E. Cloudflare Pages | 成熟 | 文档首页要求新项目用 Workers；博客称后续投入全在 Workers [S30] | 否 |

判定理由：owner 提出的问题是"地址多、记不住"，A 正好解决它，而且不需要新代码、新 Worker、新密钥，也不占 Mail Hero 与 Todofy 共用的每日请求额度。A 的两个限制对单人账户无实际影响：团队域名可以用一条重定向规则遮住；tile 的名称与 logo 在 Free 上可改，只有页面级品牌定制才需付费。B 的所有价值都来自健康徽章与用量面板，而这两项各自带来真实的运维负担：探测要维护 service token 与每个目标的 Service Auth 策略，并且要为 Mail Hero/Todofy 增加机器身份端点；用量面板要多持有一枚只读 Analytics token。这些是"想要才做"的增量，不应捆绑进入口问题。

### 3.3 推荐路径

1. Zero Trust → Access settings → App Launcher：策略与 Mail Hero 相同（精确 owner 邮箱 + IdP，不用 Everyone）；Zero Trust Free 50 用户、$0 [S27]；把 flowday-bypass 设为不可见。
2. 为 umami、stirling、slash、changedetection、dash 与外部站（Cloudflare、GitHub、Todoist）建 Bookmark；将来 `todofy.ziyixi.science` 作为自托管应用自动出现。
3. 可选：一条 Free Redirect Rule（10 条额度，源主机名需为 proxied 记录，可用 `192.0.2.0`/`100::` 占位）把 `home.ziyixi.science` 302 到团队域 [S28][S29]。
4. 顺手把 tunnel 应用上 Access，让 Bookmark 升级为真正的 SSO tile：

| 应用 | 建议 |
|---|---|
| umami | Allow owner；`/script.js` 与 `/api/send` 必须公开（被统计站访客调用，可用 `TRACKER_SCRIPT_NAME`/`COLLECT_API_ENDPOINT` 改名）[S44]，按 flowday-bypass 模式建路径 Bypass；Bypass 不记日志、不能用身份选择器 [S34] |
| stirling、changedetection | 完整上 Access |
| slash | UI 上 Access；短链 `/s/<name>` 若对外分享则 Bypass [S44] |
| dash | 先确认是什么；若已是仪表盘工具，与门户重叠 |
| daily / test / ssh / newsletter | 不进门户；`daily` 是现 Todofy API，迁移后退役 |

上 Access 的隧道主机名同时开启 Protect with Access（cloudflared 校验 `teamName + audTag`）[S36]。

### 3.4 若自建门户 Worker

形状与 Mail Hero 完全同构：独立仓库、同一份 `native.yml`、Custom Domain、hostname 型 Access 应用加 Worker 内 JWT 校验。与 Todofy 不同的是门户几乎没有服务端逻辑，静态 tile 页应由平台直接服务，只有 `/api/health` 与 `/api/usage` 两个只读端点进 Worker。Access 策略与 Mail Hero 相同：两条 Allow（精确 owner 邮箱 + 对应 IdP），不设 Bypass；service token 只用于门户对外探测，不授予任何人访问门户本身的权限。健康探测有一个容易被忽略的平台行为：Worker 对同 zone 主机名的 `fetch()` 默认直接路由到 origin，绕过 Access 等安全设置，因此探测结果可能与用户看到的不一致，必须启用 `global_fetch_strictly_public` 并用合成请求核对 [S38]。用量数据全部来自 GraphQL Analytics API，token 只需账户级 Analytics 只读权限，不需要 Workers、D1 或 R2 的写权限。

| 维度 | 设计 |
|---|---|
| 仓库 | 独立 `home-portal`：`web/`（复制 Mail Hero 前端壳）、`worker/`（语言见 §5）、`api/`（tile 清单 JSON）、`.github/workflows/native.yml` 同形；`uiassets/dist/` gitignore |
| 域名 | Custom Domain `home.ziyixi.science`（主机名不能已有 CNAME）[S29]；`workers_dev=false`、`preview_urls=false` [S31] |
| 托管 | Workers Static Assets，`run_worker_first=["/api/*"]`，tile 页免费 [S6]；不用 Pages [S30] |
| Access | hostname 型自托管应用（Worker 级 Access 不支持 WebSocket）[S32]；Worker 内仍验 JWT [S14] |
| 健康徽章 | Worker 侧 `fetch` + `AbortController`（`RequestInit.signal`）[S39]，每目标 1–2 秒，Free 每次 ≤50 子请求 [S5]；**同 zone fetch 默认直达 origin、绕过 Access**，需启用兼容标志 `global_fetch_strictly_public` 并合成验证 [S38]；受保护目标用 service token（`CF-Access-Client-Id/Secret` 作 Worker secret）+ 目标应用 Service Auth 策略，账户上限 50 个 token [S33][S26]；Mail Hero `/health/ready` 要求 owner 邮箱 JWT，service token 无 email 会被拒 [L1]，故需对 `/health/live` 建 Bypass 路径应用或新增机器端点；浏览器直连跨域不可行（预检不带 cookie）[S37] |
| 用量面板 | GraphQL Analytics：`workersInvocationsAdaptive`、`d1AnalyticsAdaptiveGroups`/`d1StorageAdaptiveGroups`、`durableObjects*Groups`、`r2OperationsAdaptiveGroups`/`r2StorageAdaptiveGroups`（31 天）[S41]；token 仅需 Account → Account Analytics → Read [S40]，存 Worker secret；限流 300 次/5 分钟 [S40]，前端缓存 5 分钟 + 手动刷新 |
| 业务概览 | Mail Hero `/api/v1/overview` 与 Todofy owner API 都要 owner JWT；门户展示需各加"独立 Bearer + service token Service Auth"的机器只读端点（仿 `/api/internal/backup/*`）[L1]，这是真实改动 |
| 成本 | Worker $0（共用 100k/天）；GraphQL、Access 免费；只有 `/api/*` 调用计数 |

## 4 可复现与尽量 hermetic 的 CI/CD 合同

Mail Hero 现状：`permissions: contents: read`、actions 固定到完整 SHA 并注释版本、`persist-credentials: false`、两个 lockfile 走 `npm ci`、检查与部署分 job、`production` environment 仅 main、生成 0600 配置并 `if: always()` 删除、`wrangler deploy --dry-run` 后再迁移与发布、`WRANGLER_SEND_METRICS=false`；wrangler 4.141.0 精确锁定于 devDependencies [L1]。缺口：Node 版本硬编码在 workflow、无 `.nvmrc`/`engines`、无 Dependabot、无部署后 build SHA 断言。Todofy 现有 Go 流水线用 `@v4`/`@v46` 浮动 tag [L2]，重写时整体换成下表合同。

这里"hermetic"的可操作定义分三层：输入固定（源码提交、lockfile、工具链版本、action 的 commit SHA 都在仓库里）；过程固定（只有 CI 从已验证的提交构建，本机产物永不上传）；输出固定（测试过的那个产物就是部署的产物，部署后用 build SHA 断言核对）。三个仓库语言不同，但这三层的条款是同一份，只是"锁定安装"的命令各异。执行 Wrangler 的方式也有讲究：Mail Hero 用 `npx --no-install wrangler`，版本由 lockfile 锁定，比 `cloudflare/wrangler-action` 的 `wranglerVersion` 输入更接近可复现；Rust 仓库还必须在 wrangler 运行 `[build] command` 之前自行安装固定版本的 Rust、wasm32 目标与 `worker-build`，因为 wrangler-action 的 README 不涉及 Rust [S56]；Python 仓库同时需要 uv 与 Node，`pywrangler` 只是把 `sync` 之外的命令转发给 `npx wrangler` [S54]。

| 级别 | 条款 | 依据 |
|---|---|---|
| 必须 | lockfile 提交且用锁定安装：`npm ci`（lock 与 package.json 不一致即报错、从不写 lock）[S19]；`uv sync --locked`（lock 过期即报错）[S49]；`cargo build --locked`（lock 缺失或需变更即报错，文档明说用于 CI 的确定性构建）[S50] | 三仓库 |
| 必须 | 工具链版本进仓库：`.nvmrc` + `engines.node`，`setup-node` 用 `node-version-file`（与 `node-version` 同时给出时后者优先，勿并用）[S18]；`rust-toolchain.toml` 精确 `channel="1.91.0"` [S51]；`pyproject.toml` `requires-python` + 固定 `workers-py`/`workers-runtime-sdk`；`compatibility_date` 显式固定（Python 版本按它选取）[S54] | |
| 必须 | 第三方 action 固定到完整 commit SHA 并注释版本（GitHub：这是"目前唯一把 action 当作不可变发布使用的方式"，tag 可被移动或删除）[S45]；`GITHUB_TOKEN` 默认只读，按 job 提升 [S45] | |
| 必须 | 只在 CI 从已验证提交构建：`uiassets/dist/`、wasm、`python_modules/` 均 gitignore；checks 与 deploy 两个 job 构建同一提交；PR 不接触生产密钥；密钥只放 `production` environment | Mail Hero 现行 [L1] |
| 必须 | 发布前 `wrangler deploy --dry-run`（"编译而不部署到线上"）[S52]，再迁移，再发布；配置由生成器校验字段、0600 写出、结束即删、不打印值 | |
| 必须 | `workers_dev=false`、`preview_urls=false`（关闭 workers.dev 不会关闭预览 URL）[S31]；运维开关（暂停/维护）同步 GitHub variables，避免下次发布覆盖 | |
| 必须 | 部署后断言 `GET /health` 的 build == `GITHUB_SHA`（Todofy 计划稿已有 [L3]），Mail Hero 与门户补上 | |
| 建议 | Dependabot：`github-actions`、`npm`、`cargo` 生态 [S46]（是否同步维护 SHA 与版本注释文档未明说，标"可能"；uv 生态支持待核实） | |
| 建议 | Vite 双构建 `diff -r` 守卫：#13672 已关闭并归因于上游 `@rollup/plugin-commonjs` [S20]，Rolldown #10909 未抓取，字节一致无上游保证 | |
| 建议 | `concurrency` 组 + `timeout-minutes`；记录 version ID；回滚用 `wrangler rollback`，仅限最近 100 个版本，绑定不回滚、DO 类生命周期变更会阻止回滚、数据结构变更可能报错 [S52][S53] | |
| 建议 | Rust：`worker` 与 `worker-build` 同小版本，`cargo install worker-build@=x.y.z --locked` 并缓存；`opt-level="z"`、`lto`、`codegen-units=1`，不用 `strip=true`（wasm-bindgen ≥0.2.125 报错，issue #1014）[S55]；Python：`pywrangler sync` 生成的 `pylock.toml` 提交 [S54] | |
| 建议 | 集成测试用真实 workerd 绑定：TS 走 miniflare；Rust/Python 用 pytest 驱动 `wrangler dev --persist-to` | |
| 可选 | Artifact attestations：`actions/attest`，job 需 `id-token: write`、`contents: read`、`attestations: write`，`gh attestation verify` 验证；单独提供 SLSA Build L2 [S47] | |
| 可选 | Access/DNS 配置 Terraform 化，state 放 R2 [S42] | |

| 无法 hermetic 的部分 | 原因 | 缓解 |
|---|---|---|
| Cloudflare 运行时（workerd、D1、R2、DO 实现，Pyodide 构建） | 平台控制；Python 版本由 `compatibility_date` 门控且旧版"可能性能下降" [S54] | 固定 `compatibility_date`，升级作为显式提交 |
| Python 部署时快照 | Cloudflare 在部署时执行入口与顶层 import 并快照线性内存 [S8] | 无法本地复现该产物；靠 dry-run + 部署后 health 断言 |
| worker-build 工具链 | 从 GitHub Releases/npm 下载 wasm-bindgen、wasm-opt、esbuild，无校验和 [S55] | 用 `<NAME>_BIN` 指向自装并校验的二进制，或缓存 |
| Vite 产物字节 | 上游不保证确定性 [S20] | 双构建比对；"一个提交 → 一次 CI 构建 → 部署该产物" |
| GitHub 托管 runner 镜像、注册表可用性 | `ubuntu-24.04` 标签下镜像内容随时间变化；npm/crates.io/PyPI 在线 | lockfile 的 integrity/checksum 字段保证内容一致；可缓存 |
| Access、DNS、Tunnel、secrets | 在 dashboard/账户中，非仓库产物 | Terraform（可选）；secrets 设计上离线保存 |

对这些不可 hermetic 的部分，正确的姿态是把它们变成显式、可审阅的变更而非追求消除：`compatibility_date` 的每次上调都是一个独立提交并附带测试；worker-build 依赖的二进制若要校验，用 `<NAME>_BIN` 指向 CI 自己下载并核对哈希的副本；Vite 若被双构建守卫抓到不确定性，先定位到具体插件再决定是否换构建器。回滚也不应被当作"撤销一切"：Workers 只回滚代码版本，绑定、DO 迁移与 D1 数据保持原样 [S53]，Mail Hero 的文档已明确"回滚应用代码不能假定数据库一起回滚" [L1]，三个仓库都应沿用这条原则。

## 5 建议的落地顺序与 owner 需要决定的事项

**顺序**

1. 本周：启用 App Launcher + Bookmark，隐藏 flowday-bypass，决定哪些 tunnel 应用上 Access（§3.3）。
2. Mail Hero 三个独立小 PR：`tokens.css`；`.nvmrc`/`engines`/`node-version-file`；Dependabot 与部署后 build 断言。
3. Todofy：语言已由 v2 计划定为 Python（备选 Rust），JWT 验签按 v2 走 `js.crypto.subtle`（不引入 PyJWT/cryptography），其可行性并入 v2 §6.4 的 spike（T-Py-4）；spike 通过后按 §4 合同建仓库骨架与 CI；接着复制 `web/`、写 OpenAPI 合同、做页面；Access 应用与 hooks 主机名最后由 owner 手工创建。
4. 门户 Worker：Todofy 上线后，若仍想要健康徽章/用量面板再启动，并先为 Mail Hero/Todofy 增加机器只读端点。

顺序的理由：第 1 步零风险且可随时撤销，先把"记不住地址"的痛点消掉；第 2 步放在 Todofy 之前，是为了让复制过去的前端一开始就带着 CSS 变量与 Node 版本文件，避免两边再各改一次；第 3 步先做探针再定语言，因为两个候选栈各有一个未经实测的关键点（Rust 的 RSA 验签能否在 wasm 里编译并保持体积可接受，Python 的 `cryptography` wheel 是否随所选兼容日期可用），半天探针能避免在错误前提上投入一周。门户放最后，因为它依赖 Todofy 的机器端点存在，且需求本身尚未确认。本文未做任何部署、合成验收或真实数据核对；工作量均为推断，Access 与 DNS 的改动全部需要 owner 在 dashboard 手工执行。

**待决定**

| 事项 | 选项 | 我的建议 |
|---|---|---|
| Worker 语言 | Rust / Python | v2 计划已定 Python（备选 Rust）；UI 结论不受影响 |
| Access 范围 | 整主机名 + 第二 Custom Domain 放机器端点 / 路径级应用 | 前者 |
| 公开 `/health` | 只回 `{build}` / 全部放 owner API | 只回 `{build}`，CI 断言需要 |
| tunnel 应用上 Access | umami、stirling、slash、changedetection、dash 各自决定 | 除 dash 待确认外全部上 |
| 门户 | 只用 Launcher / 自建 Worker | 先 Launcher；面板需求明确再自建 |
| 门户 Worker 语言 | 是否也适用"主程序不用 TS" | 门户服务端约百行，建议允许 TS；否则 Python |
| Access 配置代码化 | dashboard / Terraform + R2 state | 先 dashboard，应用超过 10 个再 Terraform |
| 列表主题列 | 不显示 / 入库时存 ≤200 字符 | 先不显示 |
| Mail Hero 机器只读端点 | 是否为门户新增 | 仅在自建门户时 |

## 来源

| 编号 | 来源 | 抓取日期 |
|---|---|---|
| S1 | https://developers.cloudflare.com/workers/static-assets/binding/ | 2026-09-28 |
| S3 | https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ ；SPA 回退 https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/ | 2026-09-28 |
| S4 | https://developers.cloudflare.com/workers/static-assets/headers/ ；https://developers.cloudflare.com/workers/static-assets/redirects/ | 2026-09-28 |
| S5 | https://developers.cloudflare.com/workers/platform/limits/ | 2026-09-28 |
| S6 | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ | 2026-09-28 |
| S7 | https://developers.cloudflare.com/workers/languages/python/packages/flask/ ；https://developers.cloudflare.com/workers/languages/python/packages/fastapi/ | 2026-09-28 |
| S8 | https://developers.cloudflare.com/workers/languages/python/packages/ ；https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/ | 2026-09-28 |
| S10 | https://pyodide.org/en/stable/usage/packages-in-pyodide.html | 2026-09-28 |
| S11 | https://docs.rs/worker/latest/worker/struct.Env.html ；https://docs.rs/worker/latest/worker/struct.Fetcher.html | 2026-09-28 |
| S12 | https://github.com/cloudflare/workers-rs ；https://github.com/cloudflare/workers-rs/issues/644 | 2026-09-28 |
| S14 | https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ | 2026-09-28 |
| S15 | https://github.com/Keats/jsonwebtoken （Cargo.toml、CHANGELOG） | 2026-09-28 |
| S16 | https://openapi-ts.dev/introduction | 2026-09-28 |
| S17 | https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry | 2026-09-28 |
| S18 | https://github.com/actions/setup-node | 2026-09-28 |
| S19 | https://docs.npmjs.com/cli/v11/commands/npm-ci | 2026-09-28 |
| S20 | https://github.com/vitejs/vite/issues/13672 | 2026-09-28 |
| S21 | https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/app-launcher/ | 2026-09-28 |
| S22 | https://developers.cloudflare.com/cloudflare-one/reusable-components/custom-pages/app-launcher-customization/ | 2026-09-28 |
| S23 | https://developers.cloudflare.com/cloudflare-one/access-controls/applications/bookmarks/ ；https://developers.cloudflare.com/changelog/post/2026-02-17-policies-for-bookmarks/ | 2026-09-28 |
| S24 | https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/ | 2026-09-28 |
| S25 | https://developers.cloudflare.com/cloudflare-one/reusable-components/tags/ | 2026-09-28 |
| S26 | https://developers.cloudflare.com/cloudflare-one/account-limits/ | 2026-09-28 |
| S27 | https://www.cloudflare.com/sase/products/access/ | 2026-09-28 |
| S28 | https://developers.cloudflare.com/rules/url-forwarding/ | 2026-09-28 |
| S29 | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ | 2026-09-28 |
| S30 | https://developers.cloudflare.com/pages/ ；https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/ | 2026-09-28 |
| S31 | https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ | 2026-09-28 |
| S32 | https://developers.cloudflare.com/workers/configuration/cloudflare-access/ | 2026-09-28 |
| S33 | https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ | 2026-09-28 |
| S34 | https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ | 2026-09-28 |
| S35 | https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ | 2026-09-28 |
| S36 | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/ | 2026-09-28 |
| S37 | https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/ | 2026-09-28 |
| S38 | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ | 2026-09-28 |
| S39 | https://developers.cloudflare.com/workers/runtime-apis/request/ | 2026-09-28 |
| S40 | https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/ ；https://developers.cloudflare.com/analytics/graphql-api/limits/ | 2026-09-28 |
| S41 | https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/ ；https://developers.cloudflare.com/d1/observability/metrics-analytics/ ；https://developers.cloudflare.com/durable-objects/observability/graphql-analytics/ ；https://developers.cloudflare.com/r2/platform/metrics-analytics/ | 2026-09-28 |
| S42 | https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/ ；https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_application | 2026-09-28 |
| S44 | https://docs.umami.is/docs/environment-variables ；https://github.com/yourselfhosted/slash | 2026-09-28 |
| S45 | https://docs.github.com/en/actions/reference/security/secure-use | 2026-09-28 |
| S46 | https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot | 2026-09-28 |
| S47 | https://docs.github.com/en/actions/concepts/security/artifact-attestations ；https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations | 2026-09-28 |
| S48 | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html | 2026-09-28 |
| S49 | https://docs.astral.sh/uv/concepts/projects/sync/ | 2026-09-28 |
| S50 | https://doc.rust-lang.org/cargo/commands/cargo-build.html | 2026-09-28 |
| S51 | https://rust-lang.github.io/rustup/overrides.html | 2026-09-28 |
| S52 | https://developers.cloudflare.com/workers/wrangler/commands/workers/ | 2026-09-28 |
| S53 | https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/ | 2026-09-28 |
| S54 | https://developers.cloudflare.com/workers/languages/python/ ；https://developers.cloudflare.com/changelog/post/2026-09-08-python-workers-314/ ；https://blog.cloudflare.com/python-workers-ga/ | 2026-09-28 |
| S55 | https://raw.githubusercontent.com/cloudflare/workers-rs/main/worker-build/src/build/target.rs ；https://github.com/cloudflare/workers-rs/issues/1014 | 2026-09-28 |
| S56 | https://raw.githubusercontent.com/cloudflare/wrangler-action/main/README.md | 2026-09-28 |
| L1 | mail-hero 仓库本地读取：`web/package.json`、`web/vite.config.ts`、`web/src/components/UI.tsx`、`web/src/api/client.ts`、`cloudflare/src/native/{index,security,api-common,backup}.ts`、`cloudflare/wrangler.native.toml`、`cloudflare/package.json`、`.github/workflows/native.yml`、`deploy/generate-ci-config.mjs`、`docs/ci-cd.md`、`docs/cloudflare-setup.md`、`AGENTS.md` | 2026-09-28 |
| L2 | todofy 仓库本地读取：`mail_inbox.go`、`mail_inbox_worker.go`、`.github/workflows/*.yml` | 2026-09-28 |
| L3 | `scratchpad/todofy-plan/todofy-cloudflare-plan.md`（v1 计划稿）、`research2.json`（Rust/Python 探针与实测） | 2026-09-28 |
| L4 | 只读 `GET /accounts/{id}/access/organizations`、`/access/apps`（`scratchpad/ui-portal/ro_access_apps.py`，仅打印白名单字段） | 2026-09-28 |
| L5 | `scratchpad/cloudflare-live-extra.md`（DNS/Tunnel/Access 只读采集） | 2026-09-27 |
