# Todofy Cloudflare 迁移方案 v2

> 日期 2026-09-28。本文在 v1（同目录 `cloudflare-migration-plan-v1.md`）的基础上，把 owner 的六点回复与随后追加的六项决定（7–12）落实为决策。依据：todofy `6c46ed4`（main）、mail-hero `5d2b625`、self-host-on-vultr `bcad459`、protos `protobuf` 分支的只读阅读；v1 的三份代码评审与两位评委打分；2026-09-28 新增的三份研究（Python Workers、Rust workers-rs、Workers Free 额度）及其本地实测。所有仓库、主机和 Cloudflare 均未改动，未读取任何 env/token/数据库/真实邮件。平台事实均标注来源 URL 与抓取日期；标注"推断"的内容未经直接验证。文中 `file:line` 未加仓库前缀时指 todofy 仓库。**本文只是计划，不写任何代码。**

## 0. 变更记录 v2

| # | 变更 | v1 | v2 |
|---|---|---|---|
| 1 | 语言 | TypeScript | **Python Workers（GA 2026-09-21）**；Rust workers-rs 为唯一备选；不写 TypeScript 代码，Node/wrangler 仅作工具链 |
| 2 | 旧数据 | "旧缓存归档后删除，可选导入非内容列" | **迁移 `todofy.db` 与 `inbox.sqlite` 进 D1**：账本、提醒、摘要默认导入；全文可选且带保留期；有导出脚本、校验脚本与回滚 |
| 3 | 计划 | Workers Paid $5/月 | **Workers Free $0/月**，与 Mail Hero 共享额度；列出必须升 Paid 的精确触发条件；Containers 彻底移出 |
| 4 | 切换 | 四阶段灰度（暗部署 → 浸泡 ≥7 天 → 切换 → 退役） | **直接切换**：构建 → 一次性引导 → 部署 → 当天切 Mail Hero 目标与 newsletter env；旧栈停机保留 30 天仅供回滚 |
| 5 | 拓扑 | 一个 Worker + 一个 DO | 确认：**一个 Worker、一个 SQLite DO、一个 D1**；无 sidecar、无容器、无 Queues/Workflows |
| 6 | protos | "归档 proto/todofy，停止生成 go/todofy" | 给出 protos 仓库的具体改动顺序：先解开 `generate-go-modules.yml` 对 `go/todofy` 的依赖，再删 `proto/todofy` 与 `go/todofy`；Python wheel 不受影响；没有任何 proto 值得保留为新契约 |
| 7 | DAG | 移植 `dependency/`、Cron reconcile、`dag_runs`、`/api/v1/dependency/*`、bootstrap 开关 | **整个去掉**：架构、schema、流程、预算、工作量中全部删除；Todoist 用途缩小为建任务 + 只读页脚查找，任务不带标签 |
| 8 | CloudMailin | "推断已停用，需 owner 确认" | **owner 已确认停用**：删除 `/api/v1/update_todo` 与 `utils/cloudmailin.go`，不做兼容层 |
| 9 | Todoist 幂等 | 未决（R1） | **已决定**：REST v1 `POST /api/v1/tasks` + 确定性 `X-Request-Id` 作为无害附加项，永不依赖它；安全来自冻结请求体、`todo_unknown` 永不自动重发、重发前约 2 分钟的只读页脚查找、owner 确认的 `task_not_created`；不用 Sync API |
| 10 | 旧代码 | 退役阶段再删 Go 树；过渡期两套栈两个 CI | **同一 PR 系列内删除 Go 树**；仓库任何时刻不并存两套栈；VPS 容器切换日停机、保留 30 天后随 self-host-on-vultr 清理一并删除 |
| 11 | 部署 | CI 发布 + 本机引导 | **只走 GitHub Actions**：`checks`（单元 + 真实绑定运行时测试 + dry-run）通过后 `deploy`（仅 main push/dispatch、`production` environment）；永不手工 `wrangler deploy`；手工步骤只有一次性引导（建 D1、Access 应用、CI token、`wrangler secret put`，以及本文新增的一次性数据导入）和切换日的 Mail Hero UI 点击、newsletter env 编辑 |
| 12 | 交付物 | 方案 | 仍是方案；按所选语言写明单元/运行时测试的具体工具（§6） |
| — | 热路径 | webhook 在 Worker `fetch()` 内完成校验与 D1 写入 | 为满足 Free 普通 handler 10 ms CPU：Worker 只做认证与体积检查，**校验、hash、D1 写入移入 DO `/ingest`**（DO 每次调用 30 s CPU） |
| — | 可观测性 | Workers Logs Paid 7 天 | Free：200,000 事件/天、保留 3 天；D1 Time Travel 7 天 |

### 0.1 v2.1 决策更新（owner，2026-09-28 晚）

以下决定覆盖本文相应段落；具体实施顺序见 `docs/implementation-order.md`：

- **UI**：为 Todofy 新做一套 React/TypeScript 前端，不为复用而照抄 Mail Hero（只借用 Access/CSRF 客户端模式等确有价值的部分）。Worker 主程序仍是 Python。
- **不用 PR**：代码直接推 main；整体一次完成，不分阶段。因此 `native.yml` 的 `checks` 须在任意分支 push 上运行，`deploy` 仍只在 main；重写在本地分支完成、一次推上 main。
- **门户**：只用 Cloudflare Access App Launcher；tunnel 应用是否上 Access 由 owner 自行处理，不在本计划内。
- **域名**：`todofy.ziyixi.science`（UI + owner API）；`/hooks/mail` 与 newsletter 端点放第二个 Custom Domain `todofy-hooks.ziyixi.science`（一级子域，Universal SSL 直接覆盖；二级子域 `hooks.todofy.…` 不在免费通配证书内）。
- **旧数据**：邮件全文**默认导入** `legacy_mail_text`（§4.2 的 `--include-text` 成为默认）。
- **旧容器**：切换验证通过后当天即删除四个容器、compose 块、数据目录与 env 文件，不再"停机保留 30 天"；回滚依赖 GHCR 上仍在的镜像 + git 历史里的 compose 块 + 离机保存 30 天的两份 SQLite `.backup` 加密副本。§7.4/§7.5 相应作废。
- **仓库**：同一次推送内删除全部 Go 代码，不保留任何 legacy。

## 1. 结论摘要

**推荐：用 Python Workers 把 Todofy 重写为一个 Worker + 一个 SQLite Durable Object 执行器（alarm 驱动）+ 一个 D1 账本，跑在 Workers Free 上，旧数据迁入 D1，直接切换，同一 PR 系列内删除全部 Go 代码。** 形状与 Mail Hero 的 `MailCoordinator`/`inbox-v1` 完全一致（mail-hero AGENTS.md §1），但不共享任何 TypeScript 代码。

三条理由不变（见 v1 §1）：Todofy 的全部工作是等待两个慢 HTTPS API（Gemini 10–20 秒、Todoist 约 1 秒），每天约 100 次，等待不计 CPU；真正有价值的代码很小（收件箱状态机约 1,200 行 Go、Todoist 客户端策略、三段 prompt）；其余本来就该删。v2 新增的三个判断：

- **Python 不会让 Todofy 变慢。** 本地 workerd 实测，webhook 热路径（JSON 解析 + 字段校验 + SHA-256 + 常量时间比对）2 KB 载荷 0.013 ms、64 KB 0.295 ms、1 MiB（契约上限）4.57 ms；Pyodide 约为原生 CPython 的 2–3 倍慢。Gemini/Todoist 的等待发生在 DO alarm 里（30 s CPU、15 分钟 wall），解释器开销与之无关；约 1 秒的快照冷启动躲在 Mail Hero 20 秒超时和 10–20 秒 LLM 调用之后。真正的代价是成熟度与测试工具，不是速度（§4.1）。
- **Free 够用。** 按 300 封/日（Mail Hero 的接收上限）估算，Todofy + Mail Hero 合计占各项 Free 每日额度 1–16%，最坏情形 DO 时长占 42%；单个串行 DO 全天常开也只有 10,800 GB-s，低于 13,000 GB-s 的上限（§4.3）。
- **数据不必丢。** 账本（约 110 行）、提醒、摘要（≤ 数 MB）和可选的全文（76 MB < Free 单库 500 MB）都能经 `wrangler d1 execute --file` 导入并用 SHA-256 清单校验；D1 Time Travel（Free 7 天）与保留 30 天的旧 SQLite 文件提供回滚（§4.2）。

**owner 需要接受的事项（替代 v1 清单）：**

- Python Workers 一周前 GA，SDK 仍在快速变化；必须钉死 `compatibility_date`、`workers-py`、`workers-runtime-sdk` 与 wrangler 版本，并在第 1 天做一次 CI 环境的可行性 spike（§4.1 的四个回退触发条件）。触发即改用 Rust，架构、D1 schema 与黑盒运行时测试原样保留。
- Todofy 换新公网域名（建议 `todofy.ziyixi.science`，owner 决定）。理由同 v1：Routes 不能作为同 zone `fetch()` 的目标，Mail Hero 正是同 zone Worker `fetch()`（§3 表 1）。
- 一次性手工引导（约 1 小时）+ 切换日约 2–3 小时的 owner 操作（§7）；此后一切发布都是 push 到 main。
- 全文邮件是否迁入 D1 由 owner 决定；本文默认**不**迁（Mail Hero 已按 7/30 天保留原件），给出带保留期的可选路径。
- 旧 VPS 栈停机保留 30 天，期间任何回滚都是 Mail Hero UI 切回旧目标 + `docker compose start` + newsletter env 还原。

## 2. Todofy 现状评审

沿用 v1 §2 的评审（依据 todofy `6c46ed4`）；此处只重列发现表并按 v2 决策更新"迁移后"一列。Todofy 是一个单用户、每天约 100 封邮件的流水线，却被打包成 4 个 gRPC 微服务（网关 `main.go:119-149` 拨 4 个 insecure 客户端，`grpc.go:60`；"dependency" 地址其实就是 todo 地址，`main.go:115,212-214`）。真正设计良好的是 Mail Hero 收件箱：先持久再回 204、字节级 hash 幂等、CAS 状态迁移、`todo_unknown` 永不自动重试、每 UTC 日一次的提醒任务（`mail_inbox.go:365-394`；`mail_inbox_worker.go:58-73,269-279,559-666`）。

### 2.1 已确认发现（按严重程度）

| # | 严重度 | 发现 | 证据 | v2 迁移后 |
|---|---|---|---|---|
| A1 | 高 | 4 个明文、无认证、开启 reflection 的 gRPC 服务与第三方 `:latest` 镜像同在 `allexport` 网络；`QueryRecent` 向任何调用者返回全部邮件正文 | `grpc.go:60`；`utils/grpc.go:30-32`；`todo/todo.go:195,203`；`database/database.go:117-154`；self-host `docker-compose.yml:220-268` | 消失（无内部网络） |
| A2 | 高 | 密钥经 argv 传递且四个容器共用一个 env 文件 | `llm/entrypoint.sh:5`；`todo/entrypoint.sh:5`；self-host compose `:227,242,252,262` | 消失（Worker secrets） |
| A3 | 高 | prompt 注入零缓解：无 systemInstruction、无输出 schema；模型输出被二次喂入；解析失败时把原文当推荐项返回 | `llm/llm.go:70,162`；`handle_summary.go:34-38`；`handle_recommendation.go:86-101,124-136` | 部分：结构性缓解（§5.3），性质不变 |
| A4 | 高 | 网关 handler 无 deadline、无取消；`/api/recommendation` 最坏 70–196 秒，超过 Cloudflare 代理 125 秒 | `handle_recommendation.go:104-116`；`handle_summary.go:50`；`main.go:163,281`；`llm/llm.go:119,174-182` | 消失（日报预计算） |
| A5 | 高 | 旧 CloudMailin 路径同步执行 LLM+Todoist+写库，失败返回 500 诱发重试；hash 随 prompt 变化 | `handle_updatetodo.go:28,46-47,126,145`；`utils/utils.go:18,72-85`；`main.go:182` | 消失（决策 8：删除，不做兼容层） |
| A6 | 高 | 状态碎片化：三个 SQLite/进程内存；重启即清零 | `mail_inbox.go:185-225`；`grpc.go:185-189`；`database/database.go:53-72`；`llm/token_tracker.go` | 消失（单一 D1 + DO 计数器） |
| A7 | 高 | 旧"缓存"是无保留期的全文邮件归档：`database.go` 里没有任何 DELETE | `database/database.go:42-51`；`handle_updatetodo.go:140`；`mail_inbox_worker.go:305,316` | 消失：只迁摘要；全文可选且带保留期（§4.2） |
| A8 | 高 | CI 供应链：可变 tag、`gosec -no-fail`、多镜像半套 `:latest` | `ci.yml:43,49`；`reusable-security.yml:22-23`；`reusable-build.yml:20-22,73-76` | 消失（Go workflow 全部删除；新 workflow 复制 Mail Hero `native.yml` 形状） |
| A9 | 高 | 公网 Tunnel 域名上直接 BasicAuth 且认证失败不限流 | `main.go:174-180`；`utils/utils.go:66-85` | 部分：Access + 锁定（§5.5） |
| B1 | 中 | `html/template` 渲染 Markdown 任务描述产生 HTML 实体 | `handle_updatetodo.go:7,103`；`mail_inbox_worker.go:11,158`；`templates/todoDescription.tmpl` | 消失（f-string 渲染 + 黄金测试） |
| B2 | 中 | Todoist 超时预算错配；所有错误压平为 `todo_unknown` | `mail_inbox_worker.go:263,269-278`；`todo/internal/todoist/client.go:114,375-449` | 消失（§5.3 分类） |
| B3 | 中 | `todofy-database` 句柄依赖网关启动顺序；nil `Schema` panic | `database/database.go:53-86`；`grpc.go:174-194` | 消失 |
| B4 | 中 | 无优雅关闭，`update.sh` 以 SIGKILL 结束 | `main.go:281`；三个 `entrypoint.sh:3`；self-host `update.sh:5,11` | 消失（启动恢复规则） |
| B5 | 中 | `/health` 无条件 200；发布=手抄 digest + ssh | `main.go:166-172`；self-host `docker-compose.yml:221-222` | 消失 |
| B6 | 中 | 收件箱与缓存卷在 mini-PC 上无备份作业 | self-host compose `:233,264` | 消失（D1 Time Travel 7 天；后续可接 Mail Hero 备份收集器模式） |
| B7 | 中 | 按字节截断 UTF-8；CountTokens 循环 | `utils/cloudmailin.go:48-50`；`llm/llm.go:174-182` | 消失 |
| B8 | 中 | DAG 调度器嵌在 todo 服务里；bootstrap 重写所有任务标题 | `todo/dependency_service.go:150-187,333-379`；`main.go:183-187` | **消失（决策 7：DAG 整体移除）** |
| B9 | 中 | proto 契约健康度差；发布要跨仓库再生成 | protos `todo.proto`、`large_language_model.proto`；`go.mod:14` | 消失（决策 6：不移植 protos） |
| C1 | 低 | 发送方可控的静默丢弃：`[Todofy System]` 前缀即 `ignored` | `mail_inbox_worker.go:193-202`；`utils/consts.go:7` | 消失（不移植该规则） |
| C2 | 低 | 错误响应回显上游错误文本 | `handle_updatetodo.go:87,128,147`；`llm/llm.go:103` | 消失 |
| C3 | 低 | 镜像 root 运行、`alpine:latest`、无校验和下载 | 四个 Dockerfile；`llm/Dockerfile:39,53-55` | 消失 |

### 2.2 值得保留的东西（v2 修订）

收件箱 DDL 与状态词汇（`mail_inbox.go:239-274`）、hash/409 语义、`source_id` 固定、启动恢复规则（`:289-311`）、退避 `1 min×2^n` 封顶约 4 小时与 12 次/7 天放弃（`mail_inbox_worker.go:75-105`）、`todo_unknown` 语义、完成后清 payload、attention 视图与每日提醒（`:383-386,559-666`）、reconcile 动作（`:703-782`）、90/40/15 秒的阶段预算；Todoist 客户端的重试分类、`Retry-After`、14 秒超时、1 MiB 体积上限（`todo/internal/todoist/client.go:28`）、游标分页（`:137-159`）；`todofy-<sha256(subject\0body\0from)[:28]>` 请求 ID（`todo/todo.go:104,169-178`）与 `Mail Hero event: <id>` 页脚（`mail_inbox_worker.go:168-172`）；三段 prompt（`utils/consts.go`，注意工作区里另一任务对推荐 prompt 的未提交修改）与模型回退顺序（`llm/consts.go:21-25`）；newsletter 依赖的两个 JSON 形状；SUT 的"可播种假 Gemini/假 Todoist"思路（`sut/fakes/gemini`、`sut/fakes/todoist`，用 Python 重写）。

**不再保留**（相对 v1）：`dependency/` 解析器、分析器、环检测、标签 diff 及其测试向量；`EnsureLabels`/`UpdateTaskLabels`/`ListLabels`（`todo/internal/todoist/client.go:197-306`）；`/api/v1/dependency/*`（`main.go:183-187`）；`/api/v1/update_todo`（`main.go:182`）与 `utils/cloudmailin.go`。

## 3. Cloudflare 平台事实

### 3.1 v1 已核实且仍然成立的事实（抓取 2026-09-27）

| 主题 | 事实 | 来源 |
|---|---|---|
| Wall time | HTTP 触发的 Worker 在客户端保持连接期间无时长上限；Cron、DO alarm 各 15 分钟；`waitUntil` 只延长到响应后 30 秒；单 isolate 128 MB；单请求 6 个并发出站连接 | https://developers.cloudflare.com/workers/platform/limits/ |
| Durable Objects | alarm 至少一次执行、失败指数退避（2 秒起）最多 6 次、每对象一个 alarm | https://developers.cloudflare.com/durable-objects/api/alarms/ |
| D1 | 行/字符串/BLOB 2,000,000 字节；100 个绑定参数；单条 SQL 语句 100,000 字节（batch 内每条各自受限） | https://developers.cloudflare.com/d1/platform/limits/ |
| 同 zone 调用 | 同 zone 内一个 Worker 对运行在 **Custom Domain** 上的另一 Worker 的 `fetch()` 无需 service binding 即可成功；**Routes 不能作为同 zone `fetch()` 的目标**；已有 CNAME 的主机名不能创建 Custom Domain | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ ；/workers/configuration/routing/routes/ |
| Access | Service Token 以 `CF-Access-Client-Id/Secret` 头发送；JWT 在 `Cf-Access-Jwt-Assertion`，公钥在 `<team>/cdn-cgi/access/certs`；应用可按路径通配划分 | https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/ ；/cloudflare-one/identity/authorization-cookie/validating-json/ |
| CI/CD | `wrangler deploy` 需 Workers 产品范围 Editor；secrets 用 `wrangler secret put`，普通 deploy 保留已有 secret | https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ ；/workers/configuration/secrets/ |
| 外部 API | Gemini REST `POST /v1beta/models/{model}:generateContent`，`x-goog-api-key` 头，返回 `usageMetadata`；Todoist API v1 统一 Sync v9 与 REST v2，1 MiB POST 上限，429 带 `retry_after`；`X-Request-Id` 去重仅在 REST v2 文档描述 | https://ai.google.dev/api/generate-content ；https://developer.todoist.com/api/v1/ |
| Containers | 仅 Workers Paid；绑定 DO 类；非事务发布 | https://developers.cloudflare.com/containers/pricing/ |
| Go on Workers | 官方语言为 JS/TS/Python/Rust，Go 仅经实验性 WASM；Todofy 依赖 cgo SQLite 与 gRPC 监听，无法直接编译 | https://developers.cloudflare.com/workers/languages/ |

### 3.2 Workers Free 额度（抓取 2026-09-28）

| 项目 | Free | Paid（对照） | 来源 |
|---|---|---|---|
| Workers 请求 | 100,000/天，超出返回 Error 1027，00:00 UTC 重置 | 10M/月含，无日上限 | https://developers.cloudflare.com/workers/platform/limits/ ；/workers/platform/pricing/ |
| 普通 handler CPU | **10 ms**/HTTP 请求；**Cron 触发也是 10 ms**；等待 `fetch()`/D1 不计 CPU；偶发超限有弹性，持续超限 Error 1102 | 默认 30 s，`limits.cpu_ms` 可到 5 分钟（仅 Paid） | https://developers.cloudflare.com/workers/platform/limits/ ；/workers/wrangler/configuration/ |
| 子请求 | 50/次调用（**含 D1 查询与出站 fetch**） | 10,000 | https://developers.cloudflare.com/workers/platform/limits/ |
| Cron Triggers | 账户 5 个 | 250 | 同上 |
| Workers Logs | 含于 Free：200,000 事件/天，保留 3 天 | 20M/月，7 天 | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| DO 可用性 | Free 只允许 SQLite 后端 DO | — | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| DO 请求 | 100,000/天（含 alarm 调用、RPC） | 1M/月 | 同上 |
| DO 时长 | 13,000 GB-s/天；按 128 MB 计费；出站连接期间对象保持活跃（每连接最长 15 分钟） | 400,000 GB-s/月 | 同上 |
| DO SQLite | 5M 行读/天、100k 行写/天（`setAlarm()` 计一次写）、5 GB | 25B/50M 每月 | 同上 |
| DO 每次调用 CPU | **已核实 30 s**：DO 限制页（2026-06-01 更新，2026-09-28 复核）写明 "30 seconds (default)" 对两个计划相同，仅 Paid 可配到 5 分钟；脚注 4 "每个入站请求把剩余 CPU 时间重置为 30 秒"不区分计划。与 Mail Hero 在 Free 上已在 alarm 内解析 109 封真实 MIME 的事实一致（mail-hero `docs/verification-native.md` 2026-09-27 计数）。Free 的 DO SQLite 单对象上限 1 GB（脚注 3） | https://developers.cloudflare.com/durable-objects/platform/limits/ ；mail-hero `docs/cloudflare-setup.md:19` |
| D1 | 5M 行读/天、100k 行写/天（命中日上限后所有查询报错）、账户 5 GB；**单库 500 MB**；每次 Worker 调用 50 条查询；Time Travel **7 天**（原地恢复） | 25B/50M 每月、10 GB、1000 条、30 天 | https://developers.cloudflare.com/d1/platform/pricing/ ；/d1/platform/limits/ ；/d1/reference/time-travel/ |
| D1 导入 | `wrangler d1 execute <db> --remote --file=<sql>`，文件 ≤5 GiB；去掉 `BEGIN/COMMIT`；单条语句超 100 KB 报 "Statement too long"；`d1 export` 可导出 `.sql`；`d1 time-travel info/restore` 按 bookmark 或时间戳 | — | https://developers.cloudflare.com/d1/best-practices/import-export-data/ ；/workers/wrangler/commands/d1/ |

### 3.3 语言运行时事实（抓取 2026-09-28）

| 主题 | 事实 | 来源 |
|---|---|---|
| Python GA | 2026-09-21 GA，"first-class, fully supported"；GA 去掉了用户代码里的 `to_js` 类转换胶水 | https://blog.cloudflare.com/python-workers-ga/ ；https://simonwillison.net/2026/Sep/21/cloudflare-python-worker/ |
| Python 运行时 | Pyodide 内置于 workerd；部署时执行顶层导入并快照 Wasm 内存；`compatibility_date >= 2026-09-08` 默认 Python 3.14；文档页（2026-09-17 更新）仍要求 `python_workers` 兼容标志 | https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/ ；/changelog/post/2026-09-08-python-workers-314/ ；/workers/languages/python/ |
| Python 冷启动 | 官方：基础 Worker "低于 1 秒"；导入 httpx+fastapi+pydantic 的 Worker 均值 1,027 ms（无快照约 10 s） | https://blog.cloudflare.com/python-workers-advancements/ ；https://blog.cloudflare.com/python-workers/ |
| Python DO/alarm/D1/Cron | DO：`class X(DurableObject)`、`self.ctx.storage.sql.exec(...)`、`setAlarm/getAlarm/deleteAlarm`、`async def alarm(self, alarm_info)`（含 `retryCount`）；D1：`env.DB.prepare().bind().run()/all()/first()`、`batch`；Cron：`async def scheduled(self, controller, env, ctx)`；Python↔JS RPC 自 2026-08-03 | https://developers.cloudflare.com/changelog/post/2025-05-14-python-worker-durable-object/ ；https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/durable-objects/api/alarms.mdx ；https://github.com/cloudflare/workers-py/blob/main/packages/runtime-sdk/tests/bindings-test/src/test_do.py ；/changelog/post/2026-08-03-python-javascript-rpc/ |
| Python 标准库 | 完整 stdlib（含 `hashlib`、`hmac`、`secrets`、`json`），排除 curses/dbm/fcntl 等；`threading`/`multiprocessing` 可导入但不工作 | https://developers.cloudflare.com/workers/languages/python/stdlib/ |
| Python 工具链 | `pywrangler` 只实现 `sync`/`types`，其余命令全部代理给 `npx wrangler`，`dev`/`deploy` 前自动 `sync`；因此 Node + wrangler 仍是必需 | https://github.com/cloudflare/workers-py/blob/main/packages/cli/src/pywrangler/cli.py |
| Python 版本节奏 | workers-py CLI 1.17.4（2026-09-21）；runtime-sdk 1.9.0（2026-09-18），6–9 月约 25 个版本；3.14 在 1.16.3→1.17.1 之间 experimental/default 反复 | https://github.com/cloudflare/workers-py/blob/main/packages/cli/CHANGELOG.md ；.../runtime-sdk/CHANGELOG.md |
| Python 已知问题 | workers-sdk #15841（2026-09-24 开）：Ubuntu 24.04 + wrangler 4.138.0 下 `wrangler dev`/`types` 加载 Pyodide 包失败；python-workers-examples #42：流式 FastAPI 触及 128 MB；大 body 跨 FFI 双拷贝 | https://github.com/cloudflare/workers-sdk/issues/15841 ；https://github.com/cloudflare/python-workers-examples/issues/42 |
| Python 测试 | Cloudflare 自己用未发布的 `testlib`：host pytest 拉起 `pywrangler dev --port --persist-to`；或在 Worker 内跑 pytest；或 `workerd test`。没有 `@cloudflare/vitest-pool-workers` 的 Python 等价物 | https://github.com/cloudflare/workers-py/blob/main/packages/testlib/AGENTS.md ；https://www.npmjs.com/package/@cloudflare/vitest-pool-workers |
| Rust SDK | `worker` 0.8.7（2026-09-25）；README："expect a few rough edges"，D1 为 alpha feature、Queues beta、RPC experimental；130 个开放 issue；SQLite DO 自 0.6.0（2025-06-19）；`--panic-unwind` 需 nightly，默认 panic=abort + 自动重建 | https://crates.io/api/v1/crates/worker ；https://raw.githubusercontent.com/cloudflare/workers-rs/main/README.md ；https://github.com/cloudflare/workers-rs/releases/tag/v0.6.0 ；https://blog.cloudflare.com/making-rust-workers-reliable/ |
| Rust API | `#[durable_object]` + `storage().sql()` + `set_alarm`；D1 `prepare/bind(&[JsValue])/first::<T>/batch`（无事务，#349）；`#[event(scheduled)]`；`Fetch::send_with_signal` + `AbortController`，无 `AbortSignal::timeout` 帮助函数 | https://docs.rs/worker/latest/worker/ ；https://raw.githubusercontent.com/cloudflare/workers-rs/main/examples/abort-signal/src/lib.rs |
| Rust 构建陷阱 | `strip = true` 与 wasm-bindgen ≥0.2.125 冲突（#1014，官方文档页仍推荐）；worker-build 从 GitHub/npm 无校验和下载 wasm-bindgen/wasm-opt/esbuild | https://github.com/cloudflare/workers-rs/issues/1014 ；https://raw.githubusercontent.com/cloudflare/workers-rs/main/worker-build/src/build/target.rs |
| Rust 测试 | 官方："最佳方式是 Miniflare……需要用 JavaScript 或 TypeScript 写端到端测试"；仓库自身用 vitest + miniflare | https://raw.githubusercontent.com/cloudflare/workers-rs/main/test/tests/mf.ts |
| 本地实测（Apple Silicon，workerd，非边缘数字） | Python：热路径 2 KB 0.013 ms / 64 KB 0.295 ms / 256 KB 1.17 ms / 1 MiB 4.57 ms；DO RPC `wake()` 9 ms wall；本地 `cpu_time_ms=0` 不可用。Rust：wasm 内 sha2 1 MiB 10.1 ms、WebCrypto+serde 1.58 ms、JS 孪生 3.6 ms；冷构建 24.8 s、增量 3.1 s；产物 336 KB wasm / 107 KB gzip | 同目录 `pyworkers/bench/`、`rust-probe/`（脚本与日志） |

## 4. 十二项决策

### 4.1 决策 1：语言 = Python，备选 Rust，不写 TypeScript

**先回答 owner 的问题："Python 会不会慢？"——对 Todofy 不会。** 每天约 100 次 webhook，典型载荷几十 KB，Python 热路径 CPU 远低于 1 ms；契约上限 1 MiB 本地 4.6 ms，边缘 CPU 若慢 1.5–3 倍则 7–12 ms（推断），只有这个极端才接近 Free 的 10 ms。v2 的设计把校验/hash/D1 写入放进 DO `/ingest`（30 s CPU），Worker 只做 Bearer 与体积检查，于是 10 ms 与语言无关。Gemini/Todoist 的 10–20 秒是等待，不计 CPU。

| 维度 | Python（Pyodide，GA 2026-09-21） | Rust（workers-rs 0.8.7） |
|---|---|---|
| 官方状态 | GA，"first-class"；文档仍要求 `python_workers` 标志 | 官方语言页无 beta 警告；README 自述 rough edges，D1 alpha feature |
| DO SQLite + alarm | 有，Cloudflare 自测覆盖 `setAlarm/getAlarm/deleteAlarm`、alarm 触发、`blockConcurrencyWhile`；本地 bench `stub.wake()` 9 ms | 有，本地探针 alarm 触发并写行 |
| D1 | `prepare/bind/run/all/first/batch`，行是 dict | `prepare/bind(&[JsValue])/first::<T>/batch`；每个查询要一个 `Deserialize` 结构体；无事务 |
| Cron `scheduled` | 有（四参数） | 有（`--test-scheduled` 验证） |
| 热路径 CPU 2 KB / 64 KB / 1 MiB（本地） | 0.013 / 0.295 / 4.57 ms | wasm 内 hash 0.04 / 0.50 / 10.1 ms；WebCrypto+serde ≈0 / ≈0 / 1.58 ms |
| 生产 CPU | 未验证（本地 `cpu_time_ms=0`）；推断 1 MiB 7–12 ms | 未验证；WebCrypto 路径推断 <5 ms |
| 冷启动 | 官方 <1 s（基础）/1,027 ms（httpx+fastapi+pydantic） | 未测；0.4 MB wasm，推断远低于 1 s |
| 产物 | Pyodide 在运行时；stdlib-only 时几乎为零；pydantic+jsonschema+httpx 共 8.9 MB | 336 KB wasm / 107 KB gzip |
| 构建 | 无编译；`pywrangler sync` 打包依赖 | 冷 24.8 s、增量 3.1 s；CI 3–6 分钟（推断） |
| 测试 | 无 vitest-pool-workers；纯逻辑在宿主 CPython 跑 pytest；运行时测试 = pytest 黑盒打 `pywrangler dev`（真实 D1/DO/alarm/cron） | 纯逻辑 `cargo test`；官方集成测试 = JS/TS + Miniflare；pytest 黑盒同样可行（本地 bench 即如此） |
| 工具链 | uv + Python 3.14 + Node/wrangler | rustup + wasm32 target + worker-build + Node/wrangler |
| 稳定性风险 | SDK 一周前 GA、三个月 25 个版本；#15841 `wrangler dev` 在某 Ubuntu 环境加载 Pyodide 失败 | `strip=true` 陷阱；无校验和下载工具；`panic=abort` 丢内存状态（D1 状态不受影响） |
| 代码量（推断） | ≈ TS 的 0.7–0.8 倍 | ≈ TS 的 1.3–1.6 倍 |
| 相对 v1 TS 方案的额外工作量（推断） | +2–3 天（测试夹具、JWT/WebCrypto 接线） | +3–5 天（样板、夹具、CI） |

**决定：Python。** 理由：Todofy 是约 3,000 行的 SQL/JSON/状态机/prompt 代码，owner 的现有栈是 Go + Python（newsletter、Mail Hero 备份收集器、`scripts/test_mail_inbox_integration.py` 都是 Python），Python 的 f-string prompt、`hashlib`/`hmac`、pytest 直接对口；Rust 对一个纯 I/O 等待的应用带不来速度收益，却带来 30–60% 的额外代码、3 秒编辑循环和"官方集成测试要写 TS"的尴尬。两者都不是"clearly production-ready"到零风险：Python 的风险是新（GA 一周）与测试工具缺位，Rust 的风险是社区级 SDK 与样板。Python 的风险可以在第 1 天用一次 spike 验证并有明确回退，所以选 Python。

**明确不需要 TypeScript 的任何部分。** 研究没有发现 Python 做不了的事：DO、alarm、D1、cron、secrets、`fetch`、WebCrypto（经 `js.crypto.subtle`）都有官方路径。Node 与 wrangler 仍在工具链里（`pywrangler` 代理给它），但 owner 不写一行 TS/JS；Mail Hero 的 `security.ts`（用 `jose` 的 `createRemoteJWKSet`/`jwtVerify`，`security.ts:119-123`）、coordinator、CI 配置生成器都不能复用，全部用 Python 重写。

**Python 的五条护栏：**
1. 钉版本：`compatibility_date = "2026-09-08"`（Python 3.14），`compatibility_flags = ["python_workers"]`，`workers-py`、`workers-runtime-sdk` 在 `pyproject.toml`/`uv.lock` 锁定，wrangler 在 `package.json` 锁定（≥4.142.0，本地验证过的版本）。
2. 运行时零第三方包：契约校验、日报 JSON 校验、渲染都用 stdlib 手写（今日 `mail_inbox.go:67-122` 的规则本来就是手写的）。pydantic/jsonschema 只有在 spike 证明 Pyodide 3.14 下能导入后才允许进入（本地只验证了解析与打包，未验证运行时导入）。
3. 热路径不解析：Worker `fetch()` 只做 `MAINTENANCE_MODE`、精确一个 `Authorization: Bearer`、SHA-256 常量时间比对、`Content-Type`、`Content-Length ≤ 1 MiB`，然后 `stub.fetch()` 转发给 DO `/ingest`。
4. 一切 async；出站超时用 `js.AbortSignal.timeout(ms)` 传给 `workers.fetch(..., signal=...)`（推断可行，spike 项）；不用 `threading`。
5. Access JWT 用 `js.crypto.subtle`（`importKey("jwk")` + `verify("RSASSA-PKCS1-v1_5")`）验证 RS256，JWKS 取自 `<issuer>/cdn-cgi/access/certs` 并在 isolate 内缓存；不引入 `cryptography`/PyJWT（未验证运行时，且是大 wheel）。

**回退到 Rust 的精确触发条件（任一成立即切换，第 1–2 天的 spike 决定）：**
- T-Py-1：在 GitHub `ubuntu-24.04` runner 上，`uv run pywrangler dev` 无法启动并通过一个含 DO alarm + D1 + `/__scheduled` 的最小运行时测试（#15841 类故障），且一个工作日内无法绕过。
- T-Py-2：`workers.fetch` 无法用 `AbortSignal` 实现真正的取消（Gemini 60 s/Todoist 14 s 超时必须真正中止连接，否则 DO 时长与 6 连接上限被占用）。
- T-Py-3：1 MiB 载荷经 DO `/ingest`（`json.loads` + 校验 + WebCrypto hash + D1 batch）在 128 MB 内失败或 CPU 超 30 s（几乎不可能）。
- T-Py-4：`js.crypto.subtle` 从 Python 验证 RS256 不可行。
切换后不变的东西：架构、D1 schema、DO 表、状态机词汇、GitHub Actions 形状、**pytest 黑盒运行时测试**（对 Rust 同样有效）；变的只有源码目录、单元测试（`cargo test`）和 CI 的构建步骤（rustup + wasm32 + worker-build，`opt-level="z"`/`lto`/`codegen-units=1`，绝不 `strip=true`，hash 走 `web_sys::SubtleCrypto`）。

### 4.2 决策 2：把 `todofy.db` 与 `inbox.sqlite` 迁入 D1

**源数据（只读事实，来自任务说明与仓库）：** `./data/todofy/todofy.db` = 76,374,016 字节，GORM 表 `database_entries`（`gorm.Model` + `ModelFamily`、`LLMModel`、`Prompt`、`MaxTokens`、`Text`（完整邮件文本）、`Summary`、非唯一索引 `HashId`；`database/database.go:42-51`；`Write` 按 hash 上写保留原 `CreatedAt`；无 DELETE）。`./data/todofy-mail/inbox.sqlite` = 160 KB + 4 MB WAL，表 `mail_inbox_events`（PK `(source_id,event_id)`，状态词汇见 `mail_inbox.go:239-274`）与 `mail_inbox_reminders(day PK)`。截至 2026-09-28 生产收件箱 complete 108、ignored 1、其余 0（mail-hero `docs/verification-native.md`）。`database_entries` 行数未知（不能读生产库）；按每行文本 + prompt 约 20–40 KB 推断约 2,000–4,000 行（**推断**）。两者的连接键是 `hash_id = "mailhero-v1-" + sha256(source_id + "\0" + event_id)`（`mail_inbox_worker.go:300-307`）；更早的 CloudMailin 时代行 `hash_id` 是 `sha256(prompt + content)`（`handle_updatetodo.go:46-47`），与任何事件无关。

**目标表（并入 `migrations/0001_init.sql`，见 §5.2）：** `mail_events`（账本，`imported=1`，`payload=NULL`）、`mail_reminders`、`summaries(event_id PK, created_at, subject, summary, model, task_id, imported)`、可选 `legacy_mail_text(event_id PK, created_at, text, expires_at)`。列映射：

| 源 | 目标 | 规则 |
|---|---|---|
| `mail_inbox_events.{source_id,event_id,payload_hash,state,task_id,attempt_count,last_error_code,created_at,updated_at}` | `mail_events` 同名列，`payload=NULL`、`summary=''`、`todo_body=''`、`crashes=0`、`next_attempt_at=0`、`imported=1` | 拒绝 `source_id ≠ mail-hero-personal`；`payload_hash` 必须是 32 字节 BLOB；非终态行存在时仅告警（切换前必须排空） |
| `mail_inbox_reminders.{day,state,task_id,attention_count,attempts,last_error_code,created_at,updated_at}` | `mail_reminders`，`subject=''`、`body=''` | 只为"当日不重发"的去重语义 |
| `database_entries.{created_at,summary,llm_model,hash_id}` | `summaries.{created_at(epoch),summary,model(枚举号→模型名),event_id,subject(从 `**SUBJECT: …**` 行解析),task_id(从账本连接),imported=1}` | `deleted_at IS NULL`；同 `hash_id` 多行取 `updated_at` 最新；`mailhero-v1-*` 能连接账本的用真实 `event_id`，连不上的与 CloudMailin 时代行用 `legacy:<hash>`；默认跳过 CloudMailin 时代行（`--include-cloudmailin` 才导） |
| `database_entries.text` | `legacy_mail_text` | **仅 `--include-text`**；默认不导 |
| `database_entries.{prompt,max_tokens,model_family}` | 不迁 | prompt 是常量的副本，`max_tokens` 语义错位（v1 B9） |

模型枚举号到名字的映射来自 protos `proto/todofy/large_language_model.proto`（`Model` 枚举，0 = 未指定；12 = `gemini-3.8-flash` 等），在删除 proto 前把映射表固化进脚本（同目录 `dbmig/legacy_to_d1.py` 已含）。

**工具（已在 scratchpad 写好并在合成数据上跑过，尚未进仓库）：** `dbmig/legacy_to_d1.py`（stdlib，只读打开源库 `?mode=ro`，输出 `01-ledger.sql`、`02-reminders.sql`、`03-summaries.sql`、可选 `04-legacy-text.sql`、`manifest.json`；每行一条 `INSERT … ON CONFLICT DO NOTHING`，无 `BEGIN/COMMIT`/`PRAGMA`，单条语句 ≤90,000 字节；从不打印行内容）与 `dbmig/verify_d1.py`（用 `wrangler d1 execute --json` 按 `(created_at,event_id)` keyset 分页读回，重新计算账本与摘要的规范化 SHA-256，与 manifest 比对，输出 PASS/FAIL）。合成数据（40 封 Mail Hero 行 + 8 封 CloudMailin 行 + 重复 hash + 空 hash + 一条 120,000 字的超长文本）上：账本 40 条、摘要 51 条、全文 50 条 + 1 条因超过 100 KB 语句上限被跳过并写入 manifest 警告。**本地 D1 导入与 `verify_d1.py` 的 PASS 未留下证据**（scratch 的本地 D1 状态里只有 1 条提醒行），实施时必须在本地 D1 上重跑并记录。两个脚本进仓库 `tools/legacy_migration/` 并配 pytest（合成 SQLite fixture）。

**超长文本的处理（脚本待补）：** 单条 SQL ≤100 KB 是 D1 硬限，D1 行上限 2,000,000 字节；Mail Hero 路径的 `text` ≤256 KiB，CloudMailin 路径截断在 50,000 字节（`utils/cloudmailin.go:48-50`）。对 >90 KB 的文本，脚本改为先 `INSERT` 前 80 KB，再用若干条 `UPDATE legacy_mail_text SET text = text || '<chunk>' WHERE event_id=?` 追加，每条 <100 KB；不需要任何 Worker 端点。

**隐私与保留（owner 决定，本文默认）：**
- 默认：账本全部、提醒全部、摘要全部导入（`imported=1` 的摘要**不**参与 90 天清理，只由 owner 显式删除）；全文不导，Mail Hero 已按 7/30 天保留原件，旧缓存是无界 PII 归档（A7）。若 owner 想留一份，建议在 mini-PC 上 `gpg --symmetric` 加密归档后离机保存，而不是进 D1。
- 可选 `--include-text`：全文进 `legacy_mail_text`，`expires_at = created_at + LEGACY_TEXT_RETENTION_DAYS`（默认 90 天，`0` 表示永久），由 §5.3 的每日清理按 `expires_at` 索引删除。76 MB 全文 + 若干 MB 摘要在 Free 单库 500 MB 内，但会占 Mail Hero 共享的账户 5 GB 的约 1.5%，且 D1 Time Travel 快照与未来的备份体积都随之增大。owner API 提供 `GET /api/v1/legacy_text/:event_id`（Access 保护）读取。
- 摘要含邮件内容摘要，本身就是产品要保留的数据（日报窗口需要）。

**容量/额度核算（Free）：** 账本约 110 行 + 索引 ≈ 330 行写；摘要按 3,000 行推断 ≈ 6,000 行写（含 `summaries_created` 索引）；全文 3,000 行 + 分块 UPDATE 约 4,000 行写；合计 <15,000 行，远低于 100k 行写/天，导入当天不需要停 Mail Hero。`wrangler d1 execute --file` 上限 5 GiB，SQL 文件总大小约 80–100 MB（推断）。

**流程（切换日 C5，owner 在 mini-PC 与本机执行，脚本只读源库）：**
1. 旧栈已停（§7 C4）。`sqlite3 ./data/todofy-mail/inbox.sqlite ".backup '/root/mig/inbox-backup.sqlite'"`、`sqlite3 ./data/todofy/todofy.db ".backup '/root/mig/todofy-backup.db'"`（`.backup` 会合并 WAL，得到一致副本；源文件不动）。
2. `python3 legacy_to_d1.py --inbox inbox-backup.sqlite --legacy todofy-backup.db --out out --source-id mail-hero-personal [--include-text]`；核对 `manifest.json`：`state_counts` 应等于旧 `/api/v1/mail_inbox` 的计数（当前 complete 108 / ignored 1），`warnings` 为空。
3. 把 `out/` 拷到有 wrangler 登录的 owner 本机（scp；不经聊天）。记录导入前书签：`npx wrangler d1 time-travel info todofy --json`。
4. 依次 `npx wrangler d1 execute todofy --remote --file=out/01-ledger.sql`、`02-reminders.sql`、`03-summaries.sql`（可选 `04-legacy-text.sql`）。`ON CONFLICT DO NOTHING` 使重跑安全。
5. `python3 verify_d1.py --manifest out/manifest.json --remote --db todofy` → 两表 PASS；再 `SELECT state,count(*) FROM mail_events WHERE imported=1 GROUP BY state` 与 manifest 对照。
6. 删除本机 `out/`；mini-PC 上的 `/root/mig/` 与原数据目录随旧栈保留 30 天。

这是决策 11 手工步骤清单之外**新增的一次性手工步骤**（`d1 execute`/`verify` 不是 deploy），只在切换日执行一次。

**回滚：** 任一 PASS 失败 → `DELETE FROM summaries WHERE imported=1; DELETE FROM legacy_mail_text; DELETE FROM mail_events WHERE imported=1; DELETE FROM mail_reminders WHERE created_at < <cutover_epoch>`（都走索引，行写计数可控），或 `npx wrangler d1 time-travel restore todofy --bookmark <步骤 3 的书签>`（7 天内有效，原地覆盖，每库 10 分钟内最多 10 次）。源 SQLite 文件在 mini-PC 上保留 30 天，可重导。

**409 连续性收益：** 导入账本后，Mail Hero 若对旧事件做"普通重试"（同 `event_id` 同字节），新 Todofy 会命中已导入行并回 204 不重复建任务；"新事件重发"则是新 `event_id`，照常处理。若不导入账本，旧事件重试会被当成新事件再建一次 Todoist 任务——这是导入账本不可选的原因。

### 4.3 决策 3：Workers Free，不升 Paid；Containers 移出

**纠正 owner 第三点的一个数字：限制是 10 毫秒 CPU，不是 10 秒。** 它只作用于普通 `fetch()`/`scheduled()` handler；等待 Gemini/Todoist 在任何计划都不计 CPU；在 DO alarm 里只受 15 分钟 wall 与每日 13,000 GB-s 时长额度约束（20 秒一次调用 = 2.5 GB-s）。所以"既然等 Gemini 不算 CPU 就不必付费"方向正确，前提是把工作放对位置。

**每日预算（Free 上限；Todofy 按 §5.3 模型：每封 1 webhook + 1 DO ingest + 约 3 次 alarm（摘要、建任务、续排空），`*/10` cron 唤醒 144 次，日报 2 次 Gemini，清理 1 次；无 DAG。Mail Hero 数字来自 mail-hero `docs/verification-native.md` 2026-09-27 段（优化后每维护周期 D1 170–200 行、DO 82 行/15 分钟）与推断。全部为推断算术。）**

| 计量项（Free 每日上限） | Todofy @100 | Todofy @300 | Todofy 最坏 @300（每封 Gemini 回退 90 s + Todoist 45 s） | Mail Hero（观测/推断） | 合计 @300 典型 | 占比 |
|---|---|---|---|---|---|---|
| Workers 请求（100,000） | ≈275（100 webhook + 144 cron + ≈30 API） | ≈475 | ≈475 | ≈650（推断） | ≈1,100 | ≈1% |
| DO 请求含 alarm（100,000） | ≈550（100 ingest + 300 alarm + 144 wake + 报表/清理） | ≈1,350 | ≈1,350 | 计入上行 ≤650 | ≈2,000 | ≈2% |
| DO 时长 GB-s（13,000） | ≈300（100×22 s×0.125=275 + wake/报表 25） | ≈850 | ≈5,100（300×135 s×0.125） | ≈400（推断：解析 + 20 s 投递 + 432 次维护 alarm） | ≈1,250（最坏 ≈5,500） | 10%（最坏 42%） |
| D1 行写（100,000） | ≈2,100（每封约 20 行含索引） | ≈6,100 | ≈6,100 | ≤10,000（推断，含索引与触发器） | ≈16,000 | ≈16% |
| D1 行读（5,000,000） | ≈5,500（每封约 40 行 + wake 432 + UI ≈1,000） | ≈13,500 | ≈13,500 | 优化后 3–4 万；优化前 16 万（`verification-native.md` 2026-09-27） | ≈5 万（保守按优化前 ≈17.5 万） | 1%（保守 3.5%） |
| DO SQLite 行写（100,000） | ≈1,000（每封 8 行：3 次 setAlarm、预算 2、限流 1、control 2；+144 cron setAlarm） | ≈2,600 | ≈2,600 | 1–2k（每次 setAlarm 计 1 写） | ≈4,500 | ≈5% |
| DO SQLite 行读（5,000,000） | ≈1,500 | ≈4,000 | ≈4,000 | ≈8k（82 行/15 分钟）；优化前 28 万 | ≈1.2 万（保守 ≈28.5 万） | <1%（保守 6%） |
| Cron Triggers（5/账户） | 1 | 1 | 1 | 0（`cloudflare/wrangler.native.toml` 无 `crons`） | 1 | 20% |
| Workers Logs 事件（200,000） | ≈5,000 | ≈12,000 | ≈12,000 | 0（`observability.enabled=false`） | ≈12,000 | 6% |
| D1 存储（单库 500 MB / 账户 5 GB） | `mail_events` 约 2 KB/行（payload 清空后）→ ≈73 MB/年 | ≈220 MB/年 | — | Mail Hero 只存索引 | 分库 | 300 封/日约 2 年到 500 MB；导入全文 +76 MB |

结构性事实：一个串行 DO 全天常开 = 86,400 s × 0.125 GB = 10,800 GB-s < 13,000，Todofy 单对象不可能独自超出时长额度；两个 coordinator 同时满负荷才会（21,600），在 ≤300 封/日下不可能。串行吞吐 300 × 22 s ≈ 1.8 小时/天。

**Free 强加的设计约束（v2 已采纳）：**
1. Worker `fetch()`/`scheduled()` ≤10 ms CPU → webhook 校验/hash/写库进 DO `/ingest`；cron 只调 `/wake`。
2. 每次调用 ≤50 子请求且含 D1 查询 → 每步 alarm 约 5 条 D1 + ≤3 次出站；页脚查找分页 ≤10 页/次。
3. 所有账本查询必须走索引且有界（Mail Hero 2026-09-27 前正是因每 10 分钟的全表聚合逼近 5M 读/天）。日上限是**账户级**：一旦命中，Todofy 与 Mail Hero 同时停摆到 00:00 UTC，Mail Hero 的入站邮件处理也会失败且来源不保证重投（mail-hero AGENTS.md §3）。
4. 接受：Time Travel 7 天、Logs 3 天、单库 500 MB（约 2 年后需要归档/滚动 `mail_events`）、5 个 cron 用 1 个、没有 `limits.cpu_ms`。
5. `[observability] enabled = true`（Free 含 200k 事件/天，Todofy 用不到 10%），日志只记 ID/状态/计数/错误码。

**必须升 Paid 的精确触发条件（任一成立才升，且先修无界查询）：**
- T-Paid-1：账户级 D1 行读 >3.5M/天、或 D1 行写 >70k/天、或 DO 行读 >3.5M/天、或 DO 请求 >70k/天，连续 2 天（Cloudflare 仪表盘/GraphQL 只读核查）。
- T-Paid-2：生产出现 Error 1102（CPU 超限）于 Worker handler 且已把全部解析移入 DO 后一周内再次出现。
- T-Paid-3：DO alarm 在 Free 上被证实只有 10 ms CPU（alarm 处理正常载荷时 1102）；此时 Mail Hero 也必须升级，因为它在 alarm 里解析 MIME。今天的证据说不是。
- T-Paid-4：owner 需要 >7 天的 D1 Time Travel 或 >3 天日志（策略需求，不是技术需求）。
- T-Paid-5：持续 >300 封/日（Mail Hero 的 `INGEST_DAILY_MESSAGE_LIMIT=300` 也要一起提高）或某个 D1 库 >400 MB。
- T-Paid-6：账户需要 >5 个 cron。

**Containers（一句话）：** Containers 只在需要 Linux 进程或原生依赖时才值得，且要求 Workers Paid（https://developers.cloudflare.com/containers/pricing/ ，抓取 2026-09-27）；Todofy 一旦不保留 Go 二进制就没有这类需求，v2 不再考虑。

### 4.4 决策 4：直接切换

去掉 v1 的四阶段灰度与 ≥7 天浸泡，改为：构建 → 一次性引导 → CI 部署 → 当天切 Mail Hero 目标与 newsletter env → 旧栈停机保留 30 天。Mail Hero 在接收时冻结每个事件的目标版本、从不重定向旧事件（AGENTS.md §3；`0001_native.sql:59-70`），所以切换是干净分割；账本导入（§4.2）保证旧事件的普通重试也能被识别。详细步骤、验证清单与回滚见 §7。

### 4.5 决策 5：一个 Worker

确认：一个 Worker（`todofy`）托管 webhook、owner API、newsletter API、cron；一个 SQLite DO 类 `TodofyCoordinator` 固定实例 `inbox-v1`；一个 D1 库 `todofy`。没有 sidecar Worker、没有 Service Binding、没有容器、没有 Queues/Workflows/KV/R2。

### 4.6 决策 6：protos 仓库的改动

事实（只读核实，2026-09-28）：`protobuf` 分支 `proto/todofy/` 有 5 个文件共 523 行（`database.proto` 导入 `large_language_model.proto`，`dependency.proto` 导入 `todoist.proto`）；`proto/newsletter/editorial.proto` 327 行，不导入任何 todofy proto。`main` 分支有 `go/todofy/`（10 个 `.pb.go` + `go.mod/go.sum`）与 `go/newsletter/`（已存在，`go 1.24.0`）。todofy 是 `go/todofy` 的唯一消费者（`go.mod:14`，`v0.0.0-20260905055718-6737c6ee634e`）。`python/build.py:19` 只编译 `proto/newsletter/editorial.proto`；wheel 不含任何 todofy 内容。

`generate-go-modules.yml` 对 `go/todofy` 的两处依赖：`setup-go` 的 `go-version-file: go/todofy/go.mod` 与 `cache-dependency-path: go/todofy/go.sum`；"Seed new newsletter module" 步骤把 `go/todofy/go.mod` 改名复制为 `go/newsletter/go.mod`，但只在 `go/newsletter/go.mod` 不存在时执行——它已存在，所以该步骤已是空操作。`scripts/generate-go-proto.sh`（main）遍历 `proto/` 下所有 `.proto`，删除 `proto/todofy` 后自然不再生成 `go/todofy`，但脚本从不删除旧产物。

**顺序（三个 PR，缺一不可，先解耦再删）：**
1. protos `protobuf` 分支 PR（切换前即可合并）：`generate-go-modules.yml` 改为 `go-version-file: go/newsletter/go.mod`、`cache-dependency-path: go/newsletter/go.sum`，删除 seed 步骤。PR 触发同一 workflow 验证（`paths` 含该文件）。
2. todofy 切换 PR 合并（§7）后，`go/todofy` 再无消费者。
3. protos `protobuf` 分支 PR：删除 `proto/todofy/`，README 去掉 Gemini 模型目录与 `go/todofy` 示例（示例改 `go/newsletter`）。合并后 workflow 只生成 `go/newsletter`；`publish-python.yml` 因 `paths: proto/**` 会多发一个 `python-v0.1.0.devN` 的 wheel（内容仅 provenance 不同），可接受或与下一次 newsletter 变更合并。
4. protos `main` 分支 PR：删除 `go/todofy/`（生成脚本不会自动删）。Go module proxy 里的旧伪版本不受影响，也无人再引用。

**没有 proto 值得保留为新 Todofy 的契约。** 新 Todofy 的外部契约只有两个：入站 `mail.received.v1`（mail-hero `api/mail-received-v1.schema.json`，JSON Schema，由 Mail Hero 拥有）和出站给 newsletter 的两个 JSON 形状（`newsletter/src/newsletter/todofy.py:211-332` 的解析器定义）。后者在 todofy 仓库以 `api/summary-v1.schema.json`、`api/recommendation-v1.schema.json` 记录并由 pytest 固定。`large_language_model.proto` 里的 Gemini 模型目录与"3.8 → 3.7 → 3.5-lite"回退策略迁到 todofy `docs/` 与 `GEMINI_MODELS` 变量；模型枚举号→名字的映射固化进迁移脚本（§4.2）后即可删除。

### 4.7 决策 7：DAG 功能整个去掉

从架构、schema、流程、预算和工作量中删除：`dependency/` 移植、DAG reconcile alarm、`dag_runs` 表、`DAG_*` 变量、`/api/v1/dependency/*` 五条路由（`main.go:183-187`）、bootstrap、`EnsureLabels`/`UpdateTaskLabels`/`ListLabels`。**Todoist 用途缩小为三件事：** `POST /api/v1/tasks` 建任务（不带 `labels`）、`GET /api/v1/tasks?project_id=…&cursor=…` 只读分页做页脚查找（步骤 B′）、每日提醒任务的创建。Todoist 调用量约 100–110 次/天，远低于今日客户端的 1000/15 分钟窗口（`todo/internal/todoist/client.go`）。DO 每次 alarm 的子请求预算因此更宽松。

### 4.8 决策 8：CloudMailin 已停用

owner 确认 Mail Hero 已替代 CloudMailin。删除 `/api/v1/update_todo`（`main.go:182`；`handle_updatetodo.go`）与 `utils/cloudmailin.go`（含测试），不做兼容层，不返回 410。Mail Hero `docs/todofy-integration.md:50` 的"迁移期间保留"文字随 §7 C9 的文档 PR 一起删除。迁移脚本默认跳过 CloudMailin 时代的摘要行（§4.2）。

### 4.9 决策 9：Todoist 幂等（已决定）

建任务走 REST v1 `POST https://api.todoist.com/api/v1/tasks`（今日 `DefaultBaseURL`，`todo/todoistapi/types.go:4`），继续发送确定性 `X-Request-Id = "todofy-" + sha256(subject\0todo_body\0from)[:28]`（`todo/todo.go:169-178`；`client.go:410`）作为**无害附加项，永不依赖它去重**。安全来自四层：(1) `todo_body` 在 `summarized` 时冻结，同事件每次重试字节一致；(2) `todo_unknown` 永不自动重发；(3) 进入 `todo_unknown` 约 2 分钟后、以及 owner 任何重发之前，先做只读页脚查找（`GET /api/v1/tasks` 分页，描述含 `Mail Hero event: <id>`），恰好一条 → `todo_created`，否则保持并记 `lookup_not_found|lookup_failed`；(4) 只有 owner 显式 `task_not_created` 才重发，且重发前再次执行 (3)。不用 Sync API `item_add`。v1 的 R1 关闭。

### 4.10 决策 10：直接删老代码

todofy 仓库用**一条分支、一次合并**完成替换（分支内可分多个提交：加 Worker → 加测试与 CI → 删 Go 树 → 文档），主干任何提交都不同时含两套栈。删除清单：`main.go`、`grpc.go`、`handle_*.go` 及测试、`mail_inbox*.go` 及测试、`mail_content_policy_test.go`、`main_test.go`、`llm/`、`todo/`、`database/`、`dependency/`、`utils/`、`sut/`、`scripts/`、`testutils/`、`templates/`、`testdata/`（仅 Go 用的）、根 `Dockerfile`/`entrypoint.sh`、`docker-compose.sut*.yml`、`docker-compose.test.yml`、`.dockerignore`、`Makefile`、`go.mod`/`go.sum`、`.golangci.yml`、`.codecov.yml`、`coverage.*`、`.github/workflows/{ci,reusable-build,reusable-integration-test,reusable-lint,reusable-security,reusable-sut-test,reusable-test}.yml`、`env/`（Go 服务的示例 env）。重写 `README.md` 与 `architecture-diagram.md`。合并前必须先落地工作区里另一任务对 `utils/consts.go` 推荐 prompt 的未提交修改（或直接把最终 prompt 文本写进 Python 常量并用测试固定），否则删 Go 树会丢掉它。VPS 上的四个容器在切换日 `docker compose stop`，保留 compose 块与数据目录 30 天仅供回滚，然后随 self-host-on-vultr 清理一并删除（§7）。GHCR 上的 `todofy`、`todofy-llm`、`todofy-todo`、`todofy-database` 包在 30 天后归档/删除。

### 4.11 决策 11：部署只走 GitHub Actions

`.github/workflows/native.yml`：`checks` job（单元 + 真实绑定运行时测试 + `deploy --dry-run`）在每个 PR 与 main push 上运行；`deploy` job `needs: checks`，`if: github.ref == 'refs/heads/main' && (push || workflow_dispatch)`，`environment: production`，不取消的并发组；`d1 migrations apply --remote` → `deploy` → `/health` 的构建 SHA 断言。永不手工 `wrangler deploy`。手工步骤穷举：一次性引导（`wrangler d1 create`、Access 应用与 service token、`production` environment 与 `CF_API_TOKEN`、`wrangler secret put`）、一次性数据导入（§4.2，本文新增）、切换日的 Mail Hero UI 点击与 newsletter env 编辑。运维开关（`MAINTENANCE_MODE`、`PROCESSING_PAUSED`、`FORCE_PAUSE_TODOIST`）改 GitHub variable 后 `workflow_dispatch` 重发，不用 wrangler。细节见 §6。

### 4.12 决策 12：仅计划；测试工具按 Python 写明

本文不写代码。Python 下"单元 + 运行时测试"的具体含义见 §6.2：单元 = 宿主 CPython 上的 pytest 跑 `src/todofy/core/`（不导入 `workers`/`js`）；运行时 = pytest 黑盒拉起 `uv run pywrangler dev --test-scheduled --persist-to <tmp>`（workerd 内真实 D1/SQLite DO/alarm/cron）+ 本地假 Gemini/假 Todoist HTTP 服务；dry-run = `uv run pywrangler deploy --dry-run`。

## 5. 目标架构

### 5.1 拓扑与绑定

```
Mail Hero Worker ──HTTPS POST mail.received.v1 (Bearer, Idempotency-Key)──▶ todofy Worker fetch()  [Python, ≤10 ms CPU]
      认证 + Content-Type + ≤1 MiB ──stub.fetch('/ingest', 原始字节)──▶ TodofyCoordinator DO  [30 s CPU]
      DO /ingest: 严格校验 → WebCrypto SHA-256 → D1 batch(INSERT … ON CONFLICT DO NOTHING; SELECT payload_hash) → 204/409 → setAlarm(now)
TodofyCoordinator DO（SQLite，固定实例 inbox-v1）alarm()：每次一步、串行
      pending ─Gemini(≤90 s)─▶ summarized ─Todoist(≤45 s)─▶ complete(+summaries 行)
      + todo_unknown 只读页脚查找(+2 min) + 提醒声明(每 UTC 日一次) + 日报预计算(每日) + 保留清理(每日)
Cron */10 * * * * ─▶ scheduled() ─▶ COORDINATOR /wake   （丢失 alarm 的兜底；10 ms CPU 内只做一次 DO 调用）
Newsletter(mini-PC) ─Basic─▶ GET /api/summary | /api/recommendation?top=N ─▶ 读 D1 daily_reports
Owner ─Cloudflare Access(JWT 在代码中再验证)─▶ /api/v1/mail_inbox*, /api/v1/legacy_text/:id
```

| 绑定/配置（`wrangler.toml`） | 用途 |
|---|---|
| `main = "src/todofy/entry.py"`，`compatibility_date = "2026-09-08"`，`compatibility_flags = ["python_workers"]` | Python 3.14 运行时（§3.3） |
| `DB`（D1 `todofy`，`migrations_dir = "migrations"`） | 账本：事件、提醒、摘要、日报、owner 动作、认证失败计数、可选旧文本。与 Mail Hero 的 D1 完全分离 |
| `COORDINATOR`（DO 类 `TodofyCoordinator`，`[[migrations]] tag="v1" new_sqlite_classes`，实例 `inbox-v1`） | 入站校验/写库、串行执行器、alarm 调度、热计数器 |
| `[triggers] crons = ["*/10 * * * *"]` | 只调用 `/wake`（账户 5 个 cron 用 1 个） |
| `routes = [{pattern = "todofy.ziyixi.science", custom_domain = true}]`，`workers_dev = false`，`preview_urls = false` | Custom Domain 才能被 Mail Hero 同 zone fetch 命中（§3.1） |
| `[observability] enabled = true` | Workers Logs，Free 200k 事件/天、3 天 |
| vars | `MAIL_SOURCE_ID=mail-hero-personal`（必须等于今日 `TODOFY_MAIL_SOURCE_ID`，self-host compose `:231`）、`ACCESS_ISSUER/AUDIENCE/OWNER`、`ACCESS_OWNER_ALIASES`、`GEMINI_MODELS=gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite`、`GEMINI_DAILY_TOKEN_BUDGET=3000000`、`TODOIST_DEFAULT_PROJECT_ID`、`REPORT_DEFAULT_TOP=5`、`REPORT_PRECOMPUTE_UTC=13:30`、`REMINDER_ENABLED`、`LOOKUP_DELAY_MS=120000`、`LEGACY_TEXT_RETENTION_DAYS=90`、`MAINTENANCE_MODE`、`PROCESSING_PAUSED`、`FORCE_PAUSE_TODOIST`、`BUILD_SHA` |
| secrets（owner 一次性 `wrangler secret put`） | `MAIL_WEBHOOK_TOKEN_SHA256`、`MAIL_WEBHOOK_TOKEN_PREVIOUS_SHA256`（可选）、`GEMINI_API_KEY`、`TODOIST_API_KEY`、`REPORT_BASIC_AUTH_SHA256`（`user:password` 的摘要）、`REPORT_BASIC_AUTH_PREVIOUS_SHA256`（可选） |

三个运维开关：`MAINTENANCE_MODE=true` → `/hooks/mail` 回 503 + `Retry-After`（Mail Hero 视为瞬态并退避，`pipeline.ts:468-471`）、停 alarm、拒绝 owner 写入；`PROCESSING_PAUSED=true` → 照常接受并提交，不执行；`FORCE_PAUSE_TODOIST=true` → 继续摘要，行停在 `summarized`。三者镜像为 GitHub variables（同 mail-hero `docs/ci-cd.md` 规则）。本地开发 `DEV_FAKES=true`（假 Gemini/Todoist 基址）与 `DEV_AUTH_BYPASS=true` 只在 loopback 生效，CI 配置生成器永不输出。

### 5.2 数据模型

D1（`migrations/0001_init.sql`，草图；相对 v1 去掉 `dag_runs`，增加 `imported`、`legacy_mail_text`）：

```sql
CREATE TABLE mail_events (
  source_id TEXT NOT NULL, event_id TEXT NOT NULL,
  payload_hash BLOB NOT NULL, payload TEXT,                  -- complete/ignored 后置 NULL
  state TEXT NOT NULL CHECK(state IN ('pending','summarizing','summarized','todo_sending',
        'todo_unknown','todo_created','complete','ignored','failed_summary')),
  summary TEXT NOT NULL DEFAULT '', summary_model TEXT NOT NULL DEFAULT '',
  todo_body TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
  todoist_request_id TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0, crashes INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '',
  imported INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_id, event_id));
CREATE INDEX mail_events_due ON mail_events(state, next_attempt_at, created_at);
CREATE INDEX mail_events_active ON mail_events(source_id, created_at, event_id)
  WHERE state NOT IN ('complete','ignored');
CREATE TABLE mail_reminders (day TEXT PRIMARY KEY, state TEXT NOT NULL,   -- sending|created|unknown|failed
  task_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, body TEXT NOT NULL,
  attention_count INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE summaries (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  subject TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '',
  imported INTEGER NOT NULL DEFAULT 0);
CREATE INDEX summaries_created ON summaries(created_at);
CREATE TABLE daily_reports (day TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('summary','recommendation')),
  top_n INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  task_count INTEGER NOT NULL, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
  computed_at INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '', PRIMARY KEY(day, kind, top_n));
CREATE TABLE owner_actions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, event_id TEXT, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE auth_failures (hour TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE legacy_mail_text (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  text TEXT NOT NULL, expires_at INTEGER);                  -- 仅在 owner 选择导入全文时有行
CREATE INDEX legacy_mail_text_expires ON legacy_mail_text(expires_at) WHERE expires_at IS NOT NULL;
```

状态与错误码词汇与今日一致（`mail_inbox.go:239-274`），owner runbook（`README.md:262-268`）继续有效；`summary_model` 由 proto 枚举改为模型名字符串。payload ≤1 MiB、摘要封顶 64 KiB、`todo_body` 128 KiB，单行远低于 D1 2,000,000 字节，不需要 R2。`summaries` 非导入行 90 天清理；`mail_events` 行永不删除（契约要求账本 ≥90 天；约 2 年后再议归档）。

DO SQLite 只放可重建的计数器与时刻表：`control(id=1, next_reminder_check, next_report, next_maintenance, todoist_blocked_until)`、`llm_usage(day PK, reserved_tokens, used_tokens, calls)`（3M/日预算，调用前预留、按 `usageMetadata.totalTokenCount` 结算）、`todoist_calls(minute_bucket PK, count)`、`report_requests(hour_bucket, count)`、`schema_version`。DO 存储丢失时计数器从零开始、时刻表默认"立即到期"、账本在 D1 完好。D1 不开读复制，保证 DO 的读-CAS 序列强一致。

### 5.3 流程

**接收 `POST /hooks/mail`**（两段）。Worker `fetch()`：① `MAINTENANCE_MODE` → 503；② 恰好一个 `Authorization: Bearer`，`hashlib.sha256` 后 `hmac.compare_digest`（含 `_PREVIOUS`），否则 401；③ `Content-Type` 非 JSON → 415，`Content-Length` 缺失或 >1 MiB → 413（缺失时按 1 MiB 上限读取并拒绝超出）；④ `await stub.fetch("https://do/ingest", body=原始字节, headers={Idempotency-Key})`，原样返回 DO 的状态码。DO `/ingest`：⑤ 严格校验 `mail.received.v1`（`mail_inbox.go:67-122` 的规则，含 storage-v1 可选字段、`additionalProperties` 忽略），`Idempotency-Key` 必须等于 `event_id` → 400；⑥ `js.crypto.subtle.digest("SHA-256", bytes)`；⑦ 一次 D1 `batch()`：`INSERT … ON CONFLICT DO NOTHING` 然后 `SELECT payload_hash`，hash 相同 → 204，不同 → 409，D1 错误 → 503；⑧ `setAlarm(min(现有 alarm, now))`。204 只在提交后发出；alarm 丢失时 10 分钟 cron 兜底。Mail Hero 每版本超时默认 20 秒（`pipeline.ts:459-461`），此路径为毫秒级 D1 写入。

**DO `alarm()`**（模仿 mail-hero `coordinator.ts:164-222`）：① `running` 守卫；② `MAINTENANCE_MODE` → `setAlarm(now+1 天)`；③ 在任何外部调用前先写持久看门狗 `setAlarm(now+120 s)`；④ 崩溃恢复：`summarizing` → `pending` 且 `crashes+1`，三次 → `failed_summary/processing_interrupted_limit`；`todo_sending` → `todo_unknown/interrupted_todo_call`；提醒 `sending` → `unknown`；⑤ 取一条到期行（`state IN ('pending','summarized') AND next_attempt_at<=now ORDER BY created_at LIMIT 1`，走 `mail_events_due`），CAS `UPDATE … WHERE state=?` 且 `meta.changes==1`；⑥ 执行一步；⑦ 下一 alarm = min(下一到期行、`control.*`、待查找的 `todo_unknown`)，刚处理过一行则 +1 秒连续排空。每次 alarm ≤5 条 D1 查询 + ≤3 次出站，远低于 Free 的 50 子请求。

**步骤 A：摘要**（`pending→summarizing→summarized|failed_summary`）：`needs_review` 或 `html_omitted` 且正文为空 → `failed_summary/mail_needs_review`，不调 LLM（`mail_inbox_worker.go:186-192`）。预留 `ceil(bytes/2)+4096` token，超预算 → `postpone(pending,'llm_budget_exhausted')`。Gemini 经 `workers.fetch`：`systemInstruction`=逐字的 `DefaultPromptToSummaryEmail`，用户回合=截断提示文案（`:145-154`）+ 显式分隔块内的正文；按 `GEMINI_MODELS` 顺序，每模型 `AbortSignal.timeout(60 s)`，整步 90 秒；空输出=失败。分类：429 → `llm_quota`（瞬态，尊重 `Retry-After`）；5xx/超时/网络 → `summary_failed`（瞬态，7 天内重试）；400/401/403 → `llm_request_rejected`（12 次后放弃）。渲染用 f-string（修 B1，黄金测试断言无 HTML 实体）：FROM/TO/DATE/SUBJECT + 摘要 + `\n\nMail Hero event: <event_id>`，`\s#[a-zA-Z0-9]{1,10}\s` 替换为单个空格；同时计算 `todoist_request_id`。CAS 到 `summarized`，`attempt_count=0`。

**步骤 B：建任务**（`summarized→todo_sending→complete|todo_unknown|summarized`）：前置检查 `FORCE_PAUSE_TODOIST`、`control.todoist_blocked_until`、`todoist_calls`。`POST /api/v1/tasks`（`content`、`description`、`project_id`，**无 `labels`**），`X-Request-Id` 见 §4.9；每次尝试 14 秒、最多 3 次（429/502/503/504/超时）、总预算 45 秒、1 MiB 体积上限。结果分类：2xx 且有 `id` → 一次 D1 batch：`UPDATE … state='complete', task_id, payload=NULL, summary='', todo_body=''` + `INSERT INTO summaries`；400/404 → `summarized`+退避，`todoist_rejected`；401/403 → `summarized`，`todoist_auth_blocked`，`todoist_blocked_until=now+6 h` 整阶段暂停；429 或 5xx 用尽 → `summarized`+`Retry-After`/退避；500、超时用尽、发出后网络错误、2xx 无 id → `todo_unknown/todo_result_unknown`，永不自动重试。

**步骤 B′：`todo_unknown` 只读跟进**：进入 `todo_unknown` 后 `LOOKUP_DELAY_MS`（默认 2 分钟）触发；`GET /api/v1/tasks?project_id=<默认项目>&cursor=` 分页（≤10 页，每页 20 秒超时）检索描述含 `Mail Hero event: <id>` 的活动任务，恰好一条 → `todo_created`（等价 owner 的 `task_created`），否则保持 `todo_unknown` 并记 `lookup_not_found|lookup_failed`。owner `task_not_created` 重发前再次执行同一查找。没有 `AUTO_RESOLVE_UNKNOWN`（v1 的自动重发开关已删）。

**每日提醒**：每 10 分钟随 wake 检查；attention = `failed_summary`/`todo_unknown` 或非终态且超过 6 小时（`:383-386`）；在 D1 用 `INSERT … ON CONFLICT(day) DO NOTHING` 先声明再调用；冻结的主题/正文只含 ID、状态、码、时间（`:668-690`）；结果 `created`/`failed`（每小时重试 ≤5 次，仅限不可能已建任务的错误类）/`unknown`（当日不再发）。正文里的指引更新为新域名与 Access 方式。

**日报预计算与 newsletter API**：`REPORT_PRECOMPUTE_UTC=13:30`（早于 newsletter 的 07:00 America/Los_Angeles，self-host `newsletter-trigger/crontab:5`）读最近 24 小时 `summaries`（含导入行，切换当天即有数据）；0 行 → `status=empty_window` 并保留今日的英文回退句（`handle_summary.go:41-42`，兼容）；否则 Gemini 用 `DefaultPromptToSummaryEmailRange`，推荐用 `DefaultPromptToRecommendTopTasks` + `responseMimeType=application/json` + `responseSchema`（手写校验 ≤N 项、rank 唯一、标题 ≤200 字），无效 → `status=model_output_invalid, tasks=[]`。`GET /api/summary` → `{summary, task_count, time_window_hours:24, status, computed_at, window_start, window_end, model}`；`GET /api/recommendation?top=1..10`（默认 3） → `{tasks[{rank,title,reason}], model, task_count, status, computed_at}`。取 ≤26 小时内最新一行；没有则按需计算但封顶 40 秒（newsletter 客户端 45 秒单次、无重试，`newsletter/src/newsletter/todofy.py:347`），超时返回上一份并标 `stale`。每小时 30 次请求上限。

**保留清理**（每日一次 alarm，每次 ≤5 条 DELETE，各带 `LIMIT`）：非导入 `summaries` >90 天、`daily_reports` >90 天、`owner_actions` >180 天、`auth_failures` >30 天、`legacy_mail_text` 按 `expires_at`；`mail_events` 不删。

### 5.4 幂等、重试与超时汇总

| 情形 | 行为 |
|---|---|
| 重复 webhook，同字节 / 异字节 | 204 无工作 / 409（含导入的旧账本行） |
| webhook 时 D1 不可用 | 503 → Mail Hero 退避重投同字节 |
| 提交后 alarm 丢失 | 10 分钟 cron 唤醒；行仍为 `pending` |
| isolate 在 Gemini 期间被驱逐 | 下次 alarm 见 `summarizing` → `pending`，`crashes+1`，3 次 → `failed_summary/processing_interrupted_limit` |
| isolate 在 Todoist 期间被驱逐 | `todo_unknown/interrupted_todo_call` → B′ 查找 → owner |
| Gemini 429/5xx/超时 | `1 min×2^min(n,8)`（封顶 256 分钟），12 次且 7 天后放弃 |
| Todoist 401/403 | 阶段暂停 6 小时，行留在 `summarized`，attention 显示 `todoist_auth_blocked` |
| Todoist 超时/500/无 id | `todo_unknown`，2 分钟后只读查找，永不自动重发；次日提醒 |
| owner `task_not_created` 重发 | 先查找；同冻结正文 → 同 `X-Request-Id`（附加项）；冻结请求 + 人工确认才是保护 |
| 提醒 | D1 先声明后调用；`unknown` 当日不重发 |
| 预算 | `llm_usage` 先预留；耗尽则推迟不丢弃 |
| DO 存储丢失 | 计数器归零，时刻表立即到期，账本在 D1 |
| Free 日额度命中 | D1/DO 操作报错 → alarm 抛错由平台退避重试（≤6 次），行状态不变；webhook 回 503 → Mail Hero 退避；00:00 UTC 恢复 |

超时：Gemini 每模型 60 秒/整步 90 秒；Todoist 每次 14 秒×3/总 45 秒；页脚查找每页 20 秒；按需日报 40 秒；Worker `fetch()` 毫秒级。

### 5.5 认证

**Mail Hero → Todofy：公网 HTTPS + Bearer，契约不变。** Mail Hero 的产品规则是通用消费者契约：精确公网 HTTPS 域名白名单、Bearer/Basic（AGENTS.md §3；`security.ts:81-92`）。Custom Domain 让同 zone `fetch()` 无需 binding 即可到达（§3.1），Mail Hero 自身在 Custom Domain 上（`deploy/generate-ci-config.mjs:61`）并从 DO 里用全局 `fetch` 投递（`pipeline.ts:461`）。Mail Hero 侧只需：GitHub 变量 `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` 增加新域名（`native.yml:96`；`generate-ci-config.mjs:24-25`）并重新部署，再在 UI 新建目标。第二层 Access Service Auth 可后加，但默认同 zone fetch"绕过 Cloudflare 安全设置"，是否真被 Access 拦截需先用合成事件验证；切换日**不**给 `/hooks/*` 配 Access（避免 v1 R8 的 302 阻断）。

**Owner API：Cloudflare Access + 代码内 JWT 验证。** 一个自托管 Access 应用覆盖 `todofy.ziyixi.science/api/v1/*`（加上 React owner UI 后应改为覆盖整个 UI 主机名，并把 `/hooks/mail` 与 newsletter 端点放到同一 Worker 的第二个 Custom Domain，即 `todofy-hooks.ziyixi.science`，见 `docs/ui-and-portal-research.md` §2.4），复用 Mail Hero 的两条 Allow 策略（按 IdP 的精确邮箱，无 Bypass，mail-hero `docs/cloudflare-setup.md:109-111`）。Python 侧用 `js.crypto.subtle` 校验 RS256 签名、issuer、audience、`exp`/`iat`、`email` ∈ {owner, ≤8 个别名}，JWKS 来自 `<issuer>/cdn-cgi/access/certs`；Access 配错时失败关闭。mutation 需 `X-Todofy-Admin-Action`（沿用 `mail_inbox_worker.go:706`）。owner 用 curl 时走 Access service token（Service Auth 策略）。

**Newsletter：过渡期 Basic（仅存 SHA-256，常量时间比对）+ 每小时失败锁定（20 次后该小时回 429）。** newsletter 客户端不支持 service token 头（`todofy.py:335-430`），所以 `/api/summary`、`/api/recommendation` 暂在 Access 之外。

### 5.6 可观测性

`[observability] enabled = true`（Free 200k 事件/天、3 天）；日志只记 ID、状态、计数、安全错误码、HTTP 状态码，绝不记正文、prompt、响应体或带 key 的 URL（mail-hero AGENTS.md §0）。`GET /health`：D1 可读且最老到期行 <1 小时才 200，并返回 `build`。`GET /api/v1/mail_inbox?view=recent|attention` 保持今日响应形状（`:443-476`）并加 `budget`、`next_alarm`、`todoist_blocked_until`。每日 Todoist 提醒任务仍是不依赖流水线自身健康的告警通道。账户设置 Cloudflare 计费通知（Free 上无账单，但 R2 由 Mail Hero 使用）。生产 CPU 时间在切换后一周内从 Workers Logs 的 `cpuTime` 只读核查一次（Worker `fetch()` 与 DO `/ingest`、alarm 三类），记入验收文档。

## 6. 仓库结构、测试与 CI/CD

### 6.1 仓库布局（切换 PR 合并后的 main）

```
todofy/
  pyproject.toml  uv.lock            # requires-python >=3.12（宿主 3.14 与运行时对齐）；dev: pytest, httpx；runtime: 无第三方包
  package.json  package-lock.json    # 仅 wrangler（钉版本）
  wrangler.toml                      # 本地/测试基线；生产配置由 CI 生成
  wrangler.test.toml                 # 运行时测试：DEV_FAKES/DEV_AUTH_BYPASS/短退避 vars
  migrations/0001_init.sql
  src/todofy/core/                   # 纯 Python，不导入 workers/js：contract.py, render.py, backoff.py, classify.py,
                                     #   prompts.py, report_schema.py, request_id.py, access_claims.py
  src/todofy/worker/                 # entry.py(Worker + scheduled), coordinator.py(DO), ledger.py(D1), gemini.py,
                                     #   todoist.py, access_jwt.py(js.crypto.subtle), health.py, api.py, reports.py
  tests/unit/                        # 宿主 CPython pytest
  tests/runtime/                     # 黑盒 pytest：拉起 pywrangler dev + 假 Gemini/Todoist
  tests/fakes/                       # gemini_fake.py, todoist_fake.py（可播种，移植 sut/fakes 思路）
  tools/legacy_migration/            # legacy_to_d1.py, verify_d1.py + 合成 fixture 测试
  tools/smoke_webhook.py             # 切换日 owner 手工冒烟（401/415/413/400/204/204/409）
  deploy/generate_ci_config.py  deploy/test_generate_ci_config.py
  api/summary-v1.schema.json  api/recommendation-v1.schema.json
  docs/  README.md  architecture-diagram.md  LICENSE
  .github/workflows/native.yml
```

### 6.2 测试工具（决策 12）

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元（宿主 CPython 3.14，`uv run pytest tests/unit`，秒级） | pytest；`core/` 不导入 `workers`/`js` | 契约校验器（含 storage-v1 字段与内容策略）；渲染黄金测试（`&`、`<`、`'`、`"`、中文，断言无实体、页脚存在、`#tag` 清洗）；退避表；`X-Request-Id` 确定性；Todoist/Gemini 结果分类；日报 JSON 校验；三段 prompt 文本固定；Access claims 检查（签名验证以外的部分）；迁移脚本对合成 SQLite 的输出与 manifest；配置生成器（`python -m unittest`） |
| 运行时（真实绑定，`uv run pytest tests/runtime`，目标 ≤5 分钟） | session fixture：① 在 loopback 起假 Gemini/假 Todoist（`http.server`，可用控制端点播种响应/延迟/状态码，记录收到的请求体）；② `npx wrangler d1 migrations apply DB --local --persist-to <tmp> --config wrangler.test.toml`；③ `uv run pywrangler dev --config wrangler.test.toml --port <空闲> --persist-to <tmp> --test-scheduled`，轮询 `/health`；测试用 `httpx` 打 Worker；alarm 是真实的但 `BACKOFF_BASE_MS=200`、`LOOKUP_DELAY_MS=500`、`WATCHDOG_MS=2000` 缩短；cron 用 `GET /__scheduled?cron=*/10+*+*+*+*` | 401/415/413/400；首投 204 且 `pending`；同字节重放 204 不建第二行；异字节 409；alarm → 假 Gemini → `summarized` → 假 Todoist → `complete` 且正文含页脚、无 `labels`；Todoist 503×3 → `summarized` 重试；Todoist 超时 → `todo_unknown` → 假 Todoist 列表含页脚任务 → `todo_created`；不含 → 保持 `todo_unknown` 且不再 POST；401 → 阶段暂停；`needs_review` → `failed_summary`；`summarizing` 中断（通过控制端点让假 Gemini 挂起并重启 dev server）→ `pending` → 3 次后 `processing_interrupted_limit`；提醒每 UTC 日一次且 `unknown` 不重发；四种 reconcile；日报预计算 + `empty_window` + `model_output_invalid` + 40 秒封顶；保留清理含 `legacy_mail_text`；DO 存储清空（删除 persist 目录中的 DO 文件后重启）与 alarm 丢失 → cron 自愈；`MAINTENANCE_MODE`/`PROCESSING_PAUSED`/`FORCE_PAUSE_TODOIST` 三开关；owner API 在 `DEV_AUTH_BYPASS` 下的形状。只用 `f8c1e9a0-…` 风格的合成 fixture |
| 部署前 | `uv run pywrangler deploy --dry-run --config …`（代理到 `wrangler deploy --dry-run`，前置 `sync`；推断 flag 透传，spike 核实，否则改为 `uv run pywrangler sync && npx wrangler deploy --dry-run`） | 打包与配置有效性 |
| 备用夹具 | 若 `pywrangler dev` 在 CI 不稳定：改用 Cloudflare 自己的 `workerd test` + `.wd-test` capnp 配置（testlib 未发布，需自建约 1 天） | 同上 |

与 Mail Hero `cloudflare/test/native-runtime.test.mjs:60-72`（vitest-pool-workers 的 `outboundService` 假服务、alarm 快进）相比，Python 夹具更慢、更黑盒，但覆盖同一组场景，且对 Rust 回退同样有效。

### 6.3 GitHub Actions（`native.yml`，镜像 mail-hero 同名文件的形状）

```
name: Native CI and deploy
on: pull_request; push: branches [main]; workflow_dispatch
permissions: contents: read
concurrency: {group: todofy-native-${{ github.ref }}, cancel-in-progress: false}     # mail-hero native.yml:12-14
env: {CI: 'true', WRANGLER_SEND_METRICS: 'false'}

checks (ubuntu-24.04, timeout 20 min):
  actions/checkout@<sha> (persist-credentials: false)
  actions/setup-node@<sha> (node 26, cache npm)                # wrangler
  astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9 # v9.0.0，protos publish-python.yml 已用同一 SHA
  npm ci
  uv sync --frozen
  uv run python -m unittest discover -s deploy -p 'test_*.py'
  uv run pytest tests/unit
  uv run pywrangler sync                                       # 生成 python_modules/（stdlib-only 时为空）与 pylock.toml 校验
  uv run pytest tests/runtime                                  # 拉起 pywrangler dev：真实 D1/DO/alarm/cron
  uv run pywrangler deploy --dry-run --config wrangler.toml

deploy (needs: checks; if: github.ref == 'refs/heads/main' && (push || workflow_dispatch);
        environment: production (url: https://${{ vars.TODOFY_PUBLIC_HOST }});
        concurrency: {group: todofy-production, cancel-in-progress: false}; timeout 15 min):
  同上的 checkout/setup-node/setup-uv/npm ci/uv sync
  uv run python deploy/generate_ci_config.py        # vars → wrangler.production.ci.json (0600，只打印变量名)
  uv run pywrangler deploy --dry-run --config wrangler.production.ci.json
  npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.production.ci.json   # CLOUDFLARE_API_TOKEN 来自 secrets.CF_API_TOKEN
  uv run pywrangler deploy --config wrangler.production.ci.json
  curl -fsS https://$TODOFY_PUBLIC_HOST/health | python3 -c '断言 build == GITHUB_SHA'  否则 job 失败
  if: always(): rm -f wrangler.production.ci.json
```

`deploy/generate_ci_config.py` 是 mail-hero `deploy/generate-ci-config.mjs:21-62` 的 Python 孪生：按正则校验每个变量（账户 32 hex、D1 UUID、issuer `https://*.cloudflareaccess.com`、audience 64 hex、邮箱、域名、布尔、整数、`HH:MM`），输出 `name/main/compatibility_date/compatibility_flags/workers_dev=false/preview_urls=false/vars/d1_databases/durable_objects/migrations/triggers/routes(custom_domain)/observability`；永不输出 `DEV_FAKES`/`DEV_AUTH_BYPASS`。所有 action 用 commit SHA 固定（A8）。**没有 Go、没有镜像构建、没有 registry、没有服务器步骤。**

| 类别 | 名称（仅名称） |
|---|---|
| 仓库/environment variables | `CLOUDFLARE_ACCOUNT_ID`、`TODOFY_D1_DATABASE_ID`、`TODOFY_D1_DATABASE_NAME`、`TODOFY_PUBLIC_HOST`、`TODOFY_MAIL_SOURCE_ID`、`TODOFY_ACCESS_ISSUER`、`TODOFY_ACCESS_AUDIENCE`、`TODOFY_ACCESS_OWNER`、`TODOFY_GEMINI_MODELS`、`TODOFY_GEMINI_DAILY_TOKEN_BUDGET`、`TODOFY_TODOIST_DEFAULT_PROJECT_ID`、`TODOFY_REPORT_DEFAULT_TOP`、`TODOFY_REPORT_PRECOMPUTE_UTC`、`TODOFY_REMINDER_ENABLED`、`TODOFY_LOOKUP_DELAY_MS`、`TODOFY_LEGACY_TEXT_RETENTION_DAYS`、`TODOFY_MAINTENANCE_MODE`、`TODOFY_PROCESSING_PAUSED`、`TODOFY_FORCE_PAUSE_TODOIST` |
| `production` environment secrets | `CF_API_TOKEN`（限本账户：Workers Scripts 编辑、D1 编辑、`ziyixi.science` zone 的 Workers Routes/Custom Domains、账户设置读；无 Billing，同 mail-hero `docs/ci-cd.md:40`）、`TODOFY_ACCESS_OWNER_ALIASES` |
| Worker secrets（owner 本机 `wrangler secret put`，CI 永不读取） | `MAIL_WEBHOOK_TOKEN_SHA256`、`MAIL_WEBHOOK_TOKEN_PREVIOUS_SHA256`、`GEMINI_API_KEY`、`TODOIST_API_KEY`、`REPORT_BASIC_AUTH_SHA256`、`REPORT_BASIC_AUTH_PREVIOUS_SHA256` |

**迁移与回滚：** D1 迁移只前向、只增量，在旧版本 Worker 仍服务时执行；迁移成功但部署失败则重跑 workflow。DO 表由 DO 自身 `CREATE TABLE IF NOT EXISTS` + `schema_version` 处理。代码回滚 = revert 提交让 CI 重发（不用 `wrangler rollback`，保持"只走 Actions"）；数据不回滚，D1 Time Travel 7 天可原地恢复。风险发布前先把 `TODOFY_PROCESSING_PAUSED=true` 并 dispatch。

### 6.4 第 1–2 天的 spike（决定 Python 还是回退 Rust）

在同一分支上先提交一个最小 Worker：`/hooks/mail` → DO `/ingest` → D1 → alarm 调用假 Gemini → `/__scheduled`；配 3 个运行时测试与 CI `checks`。验证 §4.1 的 T-Py-1…4：`pywrangler dev` 在 `ubuntu-24.04` runner 上可用；`AbortSignal` 真正取消 `workers.fetch`；1 MiB 载荷经 `/ingest` 通过；`js.crypto.subtle` 能验证一个用本地生成密钥签名的 RS256 JWT。全部通过才继续写其余代码；任一失败且一天内无法绕过，改用 Rust（保留 D1 schema、测试与 CI 形状）。

## 7. 直接切换计划

原则：只有实际跑过的才写"通过"（mail-hero `docs/verification-native.md` 规则）；不读取真实邮件、token 或数据库内容；凭据与 UI 操作由 owner 执行；旧栈在 30 天内随时可回。

### 7.1 切换前（无生产变化，可分散在几天内）

| # | 谁/哪里 | 动作 |
|---|---|---|
| P1 | owner 本机（一次性引导） | `npx wrangler d1 create todofy` → id 填 GitHub 变量；创建 Access 应用 `todofy.ziyixi.science/api/v1/*`（复用 Mail Hero 的 Allow 策略）+ Service Auth 策略与 service token；创建 GitHub `production` environment（限 main）并放入 `CF_API_TOKEN`、`TODOFY_ACCESS_OWNER_ALIASES`；填全部 `TODOFY_*` 变量（`TODOFY_TODOIST_DEFAULT_PROJECT_ID` 直接指真实项目，`TODOFY_PROCESSING_PAUSED=false`） |
| P2 | owner 本机 | 生成新的 webhook Bearer token（如 `openssl rand -hex 32`）与 newsletter Basic 凭据，本机计算 SHA-256；首个 CI 部署成功后 `wrangler secret put` 六个密钥（`wrangler secret put` 本身会触发一次同代码的新版本，不是 deploy）。明文只进 Mail Hero UI 与 mini-PC 的 env 文件，不进聊天 |
| P3 | Mail Hero 仓库 | GitHub 变量 `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS=daily.ziyixi.science,todofy.ziyixi.science` → `workflow_dispatch` `native.yml`（Mail Hero 自己的 CI 部署） |
| P4 | protos 仓库 | §4.6 第 1 步 PR 合并 |
| P5 | todofy 分支 | 全部代码 + 测试 + CI；spike 通过；另一任务的推荐 prompt 修改已固化；`checks` 绿 |
| P6 | self-host-on-vultr PR（准备好不合并） | 四个 todofy 服务加 `profiles: ["todofy-legacy"]`（`update.sh:11` 的 `docker compose up -d` 不再拉起它们）；`tests/test_newsletter_deployment.py:323-324` 与 `tests/test_newsletter_maintenance.py:159` 的服务名断言去掉四个名字；`env/todofy.env.example` 删除；README 注明 30 天回滚窗口 |

### 7.2 切换日（owner，约 2–3 小时）

| # | 动作 | 通过标准 |
|---|---|---|
| C1 | 合并 todofy 分支到 main → CI `checks` → `deploy`（0001 迁移、部署、`/health` SHA 断言）；P2 的 `secret put`；再 dispatch 一次 deploy 确认 `/health` 200 | Actions 运行链接；`/health` 返回 `build == 合并 SHA` |
| C2 | Mail Hero UI：暂停投递（目标暂停或全局暂停） | UI 显示暂停 |
| C3 | 旧 Todofy 排空：`GET https://daily.ziyixi.science/api/v1/mail_inbox?view=attention`（Basic）→ `attention_count=0`，`pending/summarizing/summarized/todo_sending=0`；有剩余先在旧侧 reconcile | 2026-09-28 已是 complete 108 / ignored 1 / 其余 0 |
| C4 | mini-PC：`docker compose stop todofy todofy-llm todofy-todo todofy-database`（不 `rm`）；合并并部署 P6 的 self-host PR（其 `docker compose up -d` 不会再拉起四者） | `docker ps` 无四个容器；其余容器 ID 不变 |
| C5 | 数据导出/转换/导入/校验（§4.2 步骤 1–6） | `verify_d1.py` 两表 PASS；`state` 计数与 C3 一致 |
| C6 | owner 本机 `tools/smoke_webhook.py`（token 从环境变量读）对 `https://todofy.ziyixi.science/hooks/mail` 跑 401/415/413/400/204/204/409 七例；合成事件用 `f8c1e9a0-…` 风格 ID 与 `needs_review=true`（不触发 LLM/Todoist） | 七例状态码全对；D1 出现一行 `failed_summary/mail_needs_review` |
| C7 | Mail Hero UI：新建目标 `https://todofy.ziyixi.science/hooks/mail`（Bearer，P2 的 token，超时默认 20 秒，只存摘要）；点"测试"（**真的会 POST 并走完整 LLM+Todoist 路径**）；设为当前目标；恢复投递 | Mail Hero 显示 204；Todofy 行 `complete` 且有 `task_id`；Todoist 真实项目出现一条带 `Mail Hero event:` 页脚、无 HTML 实体、无标签的任务（owner 手动删除） |
| C8 | mini-PC：编辑私有 `env/newsletter.env`：`TODO_API_BASE=https://todofy.ziyixi.science`、`TODO_API_USER`、`TODO_API_PASSWORD`（键已存在，`env/newsletter.env.example:31-33`）；`docker compose up -d --no-deps newsletter`；手工 `curl -u … /api/summary` 与 `/api/recommendation?top=5`；一次错误密码确认 401（勿达 20 次锁定） | 两端点 200、`Content-Type: application/json`、`time_window_hours=24`、`status` ∈ {`ok`,`empty_window`}；`model` 为模型名字符串 |
| C9 | 文档：Mail Hero PR 更新 `docs/todofy-integration.md`（新域名、Access、删除 CloudMailin 段落）；`docs/cloudflare-setup.md` 不需要改预算表述（仍是 Free） | PR 合并 |
| C10 | 首封真实邮件（等待即可，不制造） | Mail Hero delivered → D1 `complete` → Todoist 任务带页脚 |

### 7.3 切换后一周内（只读核查）

Workers Logs 的 `cpuTime`：Worker `fetch()`、DO `/ingest`、alarm 各取 p50/p99 记入验收文档；Cloudflare 仪表盘的 D1/DO 日行读写与 §4.3 预算表对照；连续两期 newsletter 来自新端点；一次故意错误 `TODOIST_API_KEY`（改 secret）→ `todoist_auth_blocked` → attention → 次日恰一条提醒任务 → 改回（可选，owner 决定是否演练）；Access 下 owner API 的浏览器与 service token 访问；protos §4.6 第 3、4 步 PR。

### 7.4 回滚（30 天内任何时刻，约 15 分钟）

1. Mail Hero UI：把当前目标切回旧目标（`daily.ziyixi.science` 仍在白名单、旧目标未归档）。
2. mini-PC：`docker compose --profile todofy-legacy up -d`（四个容器与数据目录原样）。
3. mini-PC：还原 `env/newsletter.env` 三个键，`docker compose up -d --no-deps newsletter`。
4. todofy：`TODOFY_PROCESSING_PAUSED=true` → dispatch（不删 Worker、不删 D1）。
回滚期间已投递到新 Worker 的事件留在 D1；如需让旧栈处理，用 Mail Hero 的"新事件重发"投给旧目标（旧收件箱视为新事件）。

### 7.5 30 天后退役（随 self-host-on-vultr 清理）

self-host-on-vultr PR：删除四个服务块、10003 端口、两个 bind mount；删除 `./data/todofy`、`./data/todofy-mail`（owner 可先做一次加密归档）、`/root/mig/`、`env/todofy.env*`、`env/todofy-mail-webhook.env`；本地残留镜像与 `~/todofy-releases`。Tunnel：删除 `daily.ziyixi.science → localhost:10003` 与 DNS 记录。Mail Hero：归档旧目标；`MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` 移除旧域名并 dispatch。GHCR：归档/删除四个包。offen 备份服务不再扫到 Todofy 数据。退役顺序守则：先确认 Mail Hero 无指向旧目标的在途投递，再删域名（v1 R15）。

## 8. 成本、风险与未决

### 8.1 月成本（Workers Free）

| 项目 | 用量（推断算术） | 费用 |
|---|---|---|
| Workers / DO / D1 / Cron / Logs / Custom Domain / Access（Zero Trust Free 50 用户） | §4.3 表，各项占 Free 日额度 1–16%，最坏 42% | **$0** |
| Gemini / Todoist | 外部，与今日相同（每日约 100 次摘要 + 2 次日报，无 DAG 后 Todoist 调用减少） | 不变 |
| **合计** | | **$0/月**（Mail Hero 的 R2 订阅与其预算提醒不变） |

护栏（token 预算、Todoist 1000/15 分钟、日报 30 次/小时、清理限额）都不是账单硬上限；Free 上没有账单，但账户级日额度命中会让 Todofy 与 Mail Hero 同时停摆到 00:00 UTC——这是 Free 的真实代价，用有界查询与 §4.3 的触发条件管理。

### 8.2 风险与未决

| # | 风险 / 未决 | 缓解或需要谁决定 |
|---|---|---|
| R1 | Python Workers GA 一周；SDK 与 wrangler 快速迭代；#15841 类环境故障 | 钉版本；第 1–2 天 spike（§6.4）；四个精确回退触发条件 → Rust |
| R2 | `workers.fetch` 的取消/超时语义未实测 | spike T-Py-2；不可行则回退 Rust（`AbortController` + `Delay` 已验证） |
| R3 | 生产 CPU 时间未验证（本地 `cpu_time_ms=0`） | Worker 热路径不解析；切换后一周只读核查 `cpuTime`；T-Paid-2 |
| R4 | DO 每调用 30 s CPU 在 Free 上（已按限制页核实，§3.2） | 生产上仍以切换后一周的 `cpuTime` 只读核查为准；若被证伪则两者同时升 Paid（T-Paid-3） |
| R5 | 账户级日额度是两个应用共享的 | 所有查询走索引且有界；仪表盘核查；T-Paid-1 |
| R6 | 新域名选择 | 建议 `todofy.ziyixi.science`；owner 决定 |
| R7 | Access Service Auth 是否对同 zone Worker→Custom Domain fetch 生效未见文档 | 切换日不配；后续用合成事件实验；不生效则文档明确 Bearer 是唯一层 |
| R8 | 两处状态（D1 账本 + DO 计数器/时刻表） | D1 唯一真源，DO 可重建，cron 独立唤醒；运行时测试覆盖 DO 清空与 alarm 丢失 |
| R9 | DO 在外部调用中被驱逐 | 与今日 SIGKILL 暴露相同；崩溃计数 3 次封顶 + 提醒 + B′ 查找 |
| R10 | Access 配错到共享域名覆盖 `/hooks/mail` → Mail Hero 见 302 → 路由类阻断 | 任何 Access 变更后用合成事件验证；owner API JWT 失败关闭 |
| R11 | newsletter 契约漂移：`model` 由枚举名变模型名、推荐不再回退原文、窗口锚定在预计算时刻 | 字段只增不删；暴露 `status`；C8 手工核对；newsletter 解析器容忍未知字段（`todofy.py:211-332`） |
| R12 | Gemini 从 Cloudflare 出口的延迟/区域错误未知 | 模型回退链、60/90 秒超时、7 天瞬态重试窗 |
| R13 | prompt 注入是产品固有属性 | `systemInstruction` + 分隔块 + 手写 schema 校验；模型输出永不当指令 |
| R14 | 单对象串行吞吐（≈22 秒/封） | 当前量级足够（300 封≈1.8 小时）；需要时允许每次 alarm 处理 N 步 |
| R15 | `CF_API_TOKEN` 范围不足（Custom Domain 需 zone 权限） | 首次部署会大声失败而非静默 |
| R16 | 直接切换没有浸泡期：首个真实错误在生产暴露 | 运行时测试覆盖全部状态迁移；C6/C7 合成冒烟；30 天回滚窗；Mail Hero 自身的退避重投让瞬态错误不丢邮件 |
| R17 | 旧数据导入：真实 `database_entries` 行数与文本长度分布未知 | 脚本按 manifest 报告跳过数；分块 UPDATE 处理 >90 KB；导入前记录 Time Travel 书签 |
| R18 | 全文导入的隐私与容量 | 默认不导；导则带 `expires_at`；owner 决定 |
| R19 | 另一任务对推荐 prompt 的未提交修改 | 合并前固化为 Python 常量并用测试固定（决策 10） |
| R20 | 无 UI 时 owner 操作体验 | Access service token 或 `cloudflared access curl`；可选后续加静态 attention 页 |
| R21 | 备份：Free 只有 7 天 Time Travel，不承诺 RPO/RTO | 后续把 `wrangler d1 export` 接入 Mail Hero 备份收集器模式（mail-hero AGENTS.md §7） |
| R22 | protos 顺序错误：先删 `proto/todofy` 会让 `generate-go-modules.yml` 的 `setup-go` 找不到 `go/todofy/go.mod` | §4.6 严格三步顺序 |

### 8.3 工作量（推断）

约 11–14 个专注工程日，无日历浸泡期：spike + 脚手架/D1/`/ingest`/校验器与单元测试 2–3 天；DO 执行器（alarm、恢复、Gemini/Todoist 客户端、状态机、B′ 查找、提醒、预算）与运行时夹具 4–5 天；owner API/Access(WebCrypto)/reconcile/health 1–1.5 天；日报与 newsletter 端点 1 天；迁移脚本补全（分块、pytest）与本地 D1 演练 1 天；CI/CD 与引导文档 1 天；切换、验证、三个仓库的 PR 1 天。预期约 2,500–3,500 行 Python（含测试），一个 Worker，零容器，零 TypeScript。相对 v1：DAG 移除省 2 天、无灰度省约 1 天、Python 夹具与 JWT 接线多 2–3 天、数据迁移多 1 天。
