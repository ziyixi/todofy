# Todofy 评审与 Cloudflare 迁移方案

> 日期 2026-09-28。依据：todofy `6c46ed4`（main）、mail-hero `5d2b625`、self-host-on-vultr `bcad459`、protos `protobuf` 分支的只读阅读；三份代码评审、三份平台事实简报、三份候选设计及两位评委的打分。所有仓库、主机和 Cloudflare 均未改动；未读取任何 env/token/数据库/真实邮件。平台事实的抓取日期均为 2026-09-27。标注"推断"的内容未经直接验证。文中 `file:line` 未加仓库前缀时指 todofy 仓库。

## 1. 结论摘要

**推荐：把 Todofy 重写为一个 TypeScript Worker + 一个 SQLite Durable Object 执行器 + D1 账本，不使用 Cloudflare Containers，不保留 Go 代码。** 两位评委独立打分后都选了这个方案（各 45/50），Containers 方案 32/31，Workflows 方案 31/34。

理由只有三条。第一，Todofy 的全部工作是等待两个慢 HTTPS API（Gemini 10–20 秒、Todoist 约 1 秒），每天约 100 次；这是纯 I/O 等待，在 Workers Paid 上不计 CPU，DO alarm 有 15 分钟 wall time，Worker 与 Mail Hero 的 `MailCoordinator`/`inbox-v1` 形状完全一致（mail-hero AGENTS.md §1）。第二，代码里真正有价值的部分很小：Mail Hero 收件箱状态机（`mail_inbox.go`、`mail_inbox_worker.go`，约 1,200 行）本身就是一个 DO 设计；Todoist 客户端策略（670 行）、纯逻辑 DAG 分析器（`dependency/` 约 780 行）、三段 prompt 都可以 1:1 移植；其余（gRPC、protos、database 服务、四个 Dockerfile、Compose）本来就该删。第三，Containers 只有在需要 Linux 进程或原生依赖时才值得，Todofy 没有；它还会引入第三种运行时、Docker 构建、非事务性发布和镜像回滚问题。

**owner 需要接受的事项：**

- 账户升级到 Workers Paid（$5/月），这是账户级的：Mail Hero 也进入 Paid 计费（用量仍远低于包含额度，预期 $0 增量），其 AGENTS.md §0 "目标 $0/月 Workers Free" 与 `docs/cloudflare-setup.md` 的预算文字需要文档层面更新。
- Todofy 换一个新的公网域名（建议 `todofy.ziyixi.science`，最终由 owner 决定）。旧域名 `daily.ziyixi.science` 不能靠 Worker route 接管：Cloudflare 规定 Routes 不能作为同 zone `fetch()` 的目标，Mail Hero 的投递正是同 zone 的 Worker `fetch()`（见 §4）。因此 Mail Hero 需要改一个 GitHub 变量并新建目标，newsletter 需要改一次私有 env。
- 一次性的手工引导（约 1 小时）：建 D1、建 Access 应用、建 CI token、用 `wrangler secret put` 设 5 个密钥。此后所有发布都是 push 到 main。
- 删除旧的 CloudMailin 路径 `/api/v1/update_todo`（推断 CloudMailin 已停用，需 owner 确认）；DAG 的"重写所有任务标题"bootstrap 默认关闭。
- Todoist `X-Request-Id` 是否真正去重仍未在文档中证实；设计不依赖它（`todo_unknown` 永不自动重发），但 owner 应用一个一次性项目验证一次。

## 2. Todofy 现状评审

Todofy 是一个单用户、每天约 100 封邮件的流水线，却被打包成 4 个 gRPC 微服务（网关 `main.go:119-149` 拨 4 个 insecure 客户端，`grpc.go:60`；"dependency" 地址其实就是 todo 地址，`main.go:212-214`）。四个二进制在一个 Go module 里、由同一 CI 从同一提交构建 4 个镜像（`.github/workflows/reusable-build.yml:46-59`）、共用一个 env 文件（self-host `docker-compose.yml:227,242,252,262`），从未独立扩缩。拆分带来的只有成本。真正设计良好的是 Mail Hero 收件箱：先持久再回 204、字节级 hash 幂等、CAS 状态迁移、`todo_unknown` 永不自动重试、每 UTC 日一次的提醒任务（`mail_inbox.go:365-394`；`mail_inbox_worker.go:58-73,269-279,559-666`）。本地实测 `go build`/`go vet` 通过、语句覆盖 83.3%，但断言强度偏低（`mock.Anything` 上百处，同义反复测试）。

### 2.1 已确认发现（按严重程度）

| # | 严重度 | 发现 | 证据 | 迁移后 |
|---|---|---|---|---|
| A1 | 高 | 4 个明文、无认证、开启 reflection 的 gRPC 服务与 flowday/slash/stirling/unami 等第三方 `:latest` 镜像同在 `allexport` 网络；`QueryRecent` 向任何调用者返回全部邮件正文 | `grpc.go:60`；`utils/grpc.go:30-32`；`todo/todo.go:195,203`；`database/database.go:117-154`；self-host `docker-compose.yml:220-268` | 消失（无内部网络） |
| A2 | 高 | 密钥经 argv 传递且四个容器共用一个 env 文件：面向公网的网关持有它不用的 Gemini/Todoist key | `llm/entrypoint.sh:5`；`todo/entrypoint.sh:5`；self-host compose `:227,242,252,262` | 消失（Worker secrets） |
| A3 | 高 | prompt 注入零缓解：prompt 与不可信正文直接拼接，无 systemInstruction、无输出 schema；模型输出进 Todoist 后又被 `/api/summary`、`/api/recommendation` 当作数据再喂入第二个 prompt；解析失败时把原文当推荐项返回 | `llm/llm.go:70,162`；`handle_summary.go:34-38`；`handle_recommendation.go:86-101,124-136` | 部分：结构性缓解（§5.4），性质不变 |
| A4 | 高 | 网关 handler 把 `*gin.Context` 当 gRPC context：无 deadline、无取消（gin 未开 `ContextWithFallback`）；`http.Server` 无超时；`/api/recommendation` 最坏约 70–196 秒，超过 Cloudflare 代理 125 秒 → newsletter 收到 524 | `handle_recommendation.go:104-116`；`handle_summary.go:50`；`main.go:163,281`；`llm/llm.go:119,174-182` | 消失（日报预计算） |
| A5 | 高 | 旧 CloudMailin 路径同步执行 LLM+Todoist+写库，先建任务后写缓存，失败返回 500 诱发重试；hash 随 prompt 变化 → 重复任务；两条路径重复了模板/正则；SUT 只覆盖旧路径，生产路径 `/hooks/mail` 在 CI 里只走 `ignored` 分支 | `handle_updatetodo.go:28,46-47,126,145`；`utils/utils.go:18,72-85`；`sut/tests/sut_test.go:105-199`；`scripts/test_mail_inbox_integration.py:46,89` | 消失（不移植） |
| A6 | 高 | 状态碎片化：网关一个 SQLite（收件箱）、database 容器另一个 SQLite（路径由客户端指定），worker 第三阶段仅为把结果复制到后者；token 预算、Todoist 限流、HTTP 限流都是进程内存，重启即清零 | `mail_inbox.go:185-225`；`grpc.go:185-189`；`database/database.go:53-72`；`mail_inbox_worker.go:286-324`；`llm/token_tracker.go`；`client.go:35-38,526-543` | 消失（单一 D1 + DO 计数器） |
| A7 | 高 | 旧"缓存"是无保留期的全文邮件归档：两条路径都写 `Text`，`database.go` 里没有任何 DELETE；收件箱完成后清空 payload 的卫生被下游抵消，Mail Hero 的 7/30 天保留策略无法传导 | `database/database.go:42-51`；`handle_updatetodo.go:140`；`mail_inbox_worker.go:305,316` | 消失（只存摘要，90 天） |
| A8 | 高 | CI 供应链：所有 action 用可变 tag（含 `tj-actions/changed-files@v46`，2025-03 曾被 tag 重指向劫持）；`gosec -no-fail` 永不阻断；大多数 job 无 `permissions:`；多镜像推送 `cancel-in-progress: true` 可产生半套 `:latest` | `ci.yml:43,49`；`reusable-security.yml:22-23`；`reusable-build.yml:20-22,73-76` | 消失（复制 Mail Hero `native.yml` 形状） |
| A9 | 高 | 公网 Tunnel 域名上直接 BasicAuth：认证失败不限流，两个 LLM 成本端点在限流器之外；凭据泄露即可从公网烧掉 3M token/日预算 | `main.go:174-180`；`utils/utils.go:66-85`；`llm/llm.go:32-35` | 部分：Access + 锁定（§5.5） |
| B1 | 中 | `html/template` 渲染 Markdown 任务描述：`&`、`<`、`'`、`"` 以 HTML 实体到达 Todoist，`<removed tag>` 变成 `&lt;removed tag&gt;`（本地小程序复现）；测试故意两种输出都接受 | `handle_updatetodo.go:7,103`；`mail_inbox_worker.go:11,158`；`handle_updatetodo_test.go:322-325` | 消失（模板字面量） |
| B2 | 中 | Todoist 超时预算错配：网关 40 秒 < 客户端 3×14 秒+0.75 秒=42.75 秒；且所有错误（含 400/401/403、缺 key）都压平为终态 `todo_unknown`；token 过期时每封邮件都变成一次手工对账 | `mail_inbox_worker.go:263,269-278`；`client.go:26,59-63,460-483`；`todo/todo.go:120-125,158` | 消失（§5.3 分类） |
| B3 | 中 | `todofy-database` 只在网关启动时调用 `CreateIfNotExist` 后才有句柄；database 单独重启后仍报 SERVING 但所有调用 `FailedPrecondition`；`Write` 的 nil `Schema` 会 panic（无 recovery 拦截器）；`depends_on` 方向反了；后端用 `:latest` | `database/database.go:53-72,76-86`；`grpc.go:174-194`；`utils/grpc.go:34-38`；self-host compose `:243-244,253-254,259,265-266` | 消失 |
| B4 | 中 | 无优雅关闭：三个 entrypoint 不 `exec`，`/bin/sh` 是 PID 1，每次 `update.sh` 都以 SIGKILL 结束；Todoist 调用中被杀 → `todo_unknown` | `main.go:281`；`llm/entrypoint.sh:3`；`todo/entrypoint.sh:3`；`database/entrypoint.sh:3`；`todo/todo.go:214` | 消失（靠启动恢复规则） |
| B5 | 中 | `/health` 无条件 200；生产 compose 无 healthcheck/内存限制/日志轮转；发布=手抄 digest 到 compose 再 ssh 跑整栈 `update.sh` | `main.go:166-172`；`reusable-build.yml:73-88`；self-host `update.sh` | 消失 |
| B6 | 中 | 收件箱与缓存卷在 mini-PC 上无备份作业（README 要求备份）；丢失即无法凭 Todofy 自身恢复 | self-host compose `:233,264`；`README.md:260` | 消失（D1 Time Travel 30 天） |
| B7 | 中 | 按字节截断 UTF-8：50,000 字节截断中文邮件约三分之二概率切在 rune 中间；CountTokens 每次缩 10% 循环反复调用网络 | `utils/cloudmailin.go:48-50`；`llm/llm.go:174-182`；`client.go:513` | 消失 |
| B8 | 中 | DAG 调度器嵌在 todo gRPC 服务里：每 30 分钟全量扫描活动任务，bootstrap 在启动时重写所有未键任务标题；`MarkGraphDirty` 是 stub、`TodoistService` 无调用者、`VerifyWebhook` 未实现 | `todo/todo.go:201,209-211`；`todo/dependency_service.go:150-187,333-339,342-379` | 重构（Cron + 默认关 bootstrap） |
| B9 | 中 | proto 契约健康度差：死枚举（`Popullate` 拼错）、4 个被忽略字段、11/18 个 Model 值已弃用、`max_tokens` 语义错位；发布要跨仓库再生成 | protos `todo.proto:6-20,31-40`；`large_language_model.proto:16-39,66-67`；`llm/consts.go:7-19`；`go.mod:14` | 消失（不移植 protos） |
| C1 | 低 | 发送方可控的静默丢弃：主题以 `[Todofy System]` 开头即 `ignored`、清空 payload、不进 attention | `mail_inbox_worker.go:193-202`；`utils/consts.go:7` | 消失（不移植该规则） |
| C2 | 低 | 错误响应回显上游错误文本；gRPC 状态码被 `%v` 压平为 Unknown | `handle_updatetodo.go:87,128,147`；`llm/llm.go:103`；`todo/todo.go:158` | 消失 |
| C3 | 低 | 镜像 root 运行、`alpine:latest`、无校验和下载 `grpc_health_probe` | 四个 Dockerfile；`llm/Dockerfile:39,53-55` | 消失 |

### 2.2 值得保留的东西

收件箱 DDL 与状态词汇（`mail_inbox.go:239-274`）、hash/409 语义、`source_id` 固定、启动恢复规则（`:289-311`）、退避 `1 min×2^n` 封顶约 4 小时与 12 次/7 天放弃（`mail_inbox_worker.go:75-105`）、`todo_unknown` 语义、完成后清 payload、attention 视图与每日提醒（`:383-386,559-666`）、reconcile 动作（`:703-782`）、90/40/15 秒的阶段预算；Todoist 客户端的重试分类、`Retry-After`、14 秒超时、1 MiB 体积上限、游标分页、`EnsureLabels`；`todofy-<sha256(subject\0body\0from)[:28]>` 请求 ID（`todo/todo.go:169-178`）与 `Mail Hero event: <id>` 页脚（`mail_inbox_worker.go:168-172`）；三段 prompt（`utils/consts.go`，注意另一任务对推荐 prompt 的未提交修改）与模型回退顺序（`llm/consts.go:21-25`）；`dependency/` 的解析器、分析器、环检测、标签 diff 及其测试向量；newsletter 依赖的两个 JSON 形状；SUT 的"可播种假 Gemini/假 Todoist"思路。

## 3. Cloudflare 平台事实（截至 2026-09-28，抓取日期 2026-09-27）

| 主题 | 事实 | 来源 |
|---|---|---|
| Workers Paid | $5/月；含 10M 请求、30M CPU-ms；CPU 默认 30 秒，`limits.cpu_ms` 可到 5 分钟；等待 `fetch()` 不计 CPU | https://developers.cloudflare.com/workers/platform/pricing/ ；https://developers.cloudflare.com/workers/platform/limits/ |
| Wall time | HTTP 触发的 Worker 在客户端保持连接期间无时长上限；Cron、Queue 消费者、DO alarm 各 15 分钟；`waitUntil` 只延长到响应后 30 秒；单 isolate 128 MB；单请求 6 个并发出站连接；脚本 64 MiB（2026-09-04 起） | 同上；https://developers.cloudflare.com/workers/runtime-apis/context/ |
| Durable Objects | SQLite 每对象 10 GB；alarm 至少一次执行、失败指数退避最多 6 次、每对象一个 alarm；Paid 含 1M 请求（alarm 计入）、400,000 GB-s、25B 行读、50M 行写、5 GB | https://developers.cloudflare.com/durable-objects/platform/limits/ ；/durable-objects/api/alarms/ ；/durable-objects/platform/pricing/ |
| D1 | Paid 每库 10 GB、每次调用 1,000 条查询、行/字符串/BLOB 2,000,000 字节、100 个绑定参数；含 25B 行读、50M 行写、5 GB；Time Travel Paid 30 天（Free 7 天），原地恢复 | https://developers.cloudflare.com/d1/platform/limits/ ；/d1/platform/pricing/ ；/d1/reference/time-travel/ |
| Cron Triggers | 五段表达式、最小 1 分钟；账户 Paid 250 个 | https://developers.cloudflare.com/workers/configuration/cron-triggers/ |
| Workflows | GA（2025-04-07），Free/Paid 可用；步骤 wall time 无限、CPU 30 秒；`create({id})` 在保留期内重复 id 抛错；实例保留 30 天；Paid 含 500k 步/月 | https://developers.cloudflare.com/workflows/reference/limits/ ；/workflows/build/workers-api/ ；/workflows/reference/pricing/ |
| Queues | 128 KB 消息、`max_retries` 默认 3、DLQ、Paid 保留 14 天；1M 操作/月 | https://developers.cloudflare.com/queues/platform/limits/ |
| Containers | 2026-04-13 GA，仅 Workers Paid；绑定到 DO 类，`sleepAfter` 默认 10 分钟，冷启动常见 1–3 秒，磁盘全部临时，不保证运行时长；`lite`=1/16 vCPU、256 MiB、2 GB；含 25 GiB-h 内存、375 vCPU-min、200 GB-h 磁盘；vCPU 按活跃计费（2025-11-21 起），内存/磁盘按运行时长计费；超额 $0.0000025/GiB-s、$0.00002/vCPU-s、$0.00000007/GB-s | https://developers.cloudflare.com/containers/ ；/containers/pricing/ ；/containers/platform-details/limits/ ；/containers/faq/ |
| Containers 发布 | `wrangler deploy` 先激活 Worker 再推镜像并滚动，不是事务；CI 用 `wrangler containers build --push`；镜像来源限 Cloudflare Registry/Docker Hub/ECR/GAR（GHCR 未列出）；删除的镜像版本无法回退；账户镜像存储 50 GB；无内置自动扩缩 | https://developers.cloudflare.com/containers/configuration/rollouts/ ；/containers/platform-details/image-management/ ；/containers/platform-details/scaling-and-routing/ |
| Containers 与绑定 | 2026-03-26 起容器可通过 `outboundByHost` 处理器以虚拟主机名访问 KV/R2/D1/DO；出站处理器只覆盖 HTTP 80/443 与 DNS | https://developers.cloudflare.com/containers/platform-details/workers-connections/ ；/containers/platform-details/outbound-traffic/ |
| 同 zone 调用 | 同 zone 内一个 Worker 对运行在 **Custom Domain** 上的另一 Worker 的 `fetch()` "无需 service binding 即可成功"；**Routes 不能作为同 zone `fetch()` 的目标**；已有 CNAME 记录的主机名不能创建 Custom Domain；默认同 zone fetch "绕过 Cloudflare 安全设置"，`global_fetch_strictly_public` 标志可改为走前门 | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ ；/workers/configuration/routing/routes/ ；/workers/configuration/compatibility-flags/ |
| Service Bindings | 同账户、零开销、不计费；被绑定的 Worker 必须先部署否则部署失败 | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ |
| Access | Service Token 以 `CF-Access-Client-Id/Secret` 头发送，策略动作须为 Service Auth；JWT 在 `Cf-Access-Jwt-Assertion`，公钥在 `<team>/cdn-cgi/access/certs`；应用可按路径通配（`*`）划分并继承父路径策略 | https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/ ；/cloudflare-one/identity/authorization-cookie/validating-json/ ；/cloudflare-one/access-controls/policies/app-paths/ |
| CI/CD | `cloudflare/wrangler-action@v4` + `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`；`wrangler deploy` 需 Workers 产品范围 Editor；secrets 用 `wrangler secret put`，普通 deploy 保留已有 secret；Workers Logs Paid 含 20M 事件、7 天保留 | https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ ；/workers/authorization/ ；/workers/configuration/secrets/ ；/workers/observability/logs/workers-logs/ |
| 外部 API | Gemini REST `POST /v1beta/models/{model}:generateContent`，`x-goog-api-key` 头，返回 `usageMetadata`；Todoist API v1 统一 Sync v9 与 REST v2，1 MiB POST 上限，429 带 `retry_after`；`X-Request-Id` 去重仅在 REST v2 文档描述（v1 页面未见），可能性"likely" | https://ai.google.dev/api/generate-content ；https://developer.todoist.com/api/v1/ ；https://developer.todoist.com/rest/v2/ |
| Go on Workers | 官方语言为 JS/TS/Python/Rust，Go 仅经 WebAssembly；Workers 单线程无 Web Worker；`syumai/workers-go` 为实验项目。Todofy 依赖 cgo SQLite（`go.mod:10,18`，`CGO_ENABLED=1`，`Dockerfile:34`）和 gRPC 监听，无法直接编译为 WASM | https://developers.cloudflare.com/workers/languages/ ；/workers/runtime-apis/webassembly/ ；https://github.com/syumai/workers-go |

## 4. 方案对比

| 方案 | 要点 | 评委 1 | 评委 2 | 主要问题 |
|---|---|---|---|---|
| **A. 纯 Worker**：TS Worker + 单 SQLite DO 执行器 + D1 账本，无容器 | 与 Mail Hero 同形；复制 `native.yml`；一个工具链 | **45** | **45** | 单对象串行（每封约 22 秒，300 封积压约 2 小时）；owner 无 UI 时需 Access service token 走 curl |
| B. Go 核心进容器：薄 TS Worker + DO 账本 + D1 读模型 + 无状态 Go HTTP 执行器跑在 `lite` 容器 | 复用 Todoist 客户端/prompt/DAG 的 Go 代码 | 32 | 31 | 第三种运行时；Docker 构建；非事务发布与版本偏差；CI token 范围未验证；镜像清理；收件箱状态机反正要用 TS 重写；效果最重 |
| C. Worker + Workflows + D1，无容器 | 每事件一个 Workflow 实例，Cron 修复扫描 | 31 | 34 | 违反 Mail Hero AGENTS.md §1"没有 Workflows"；**切换机制平台层面错误**：用 Worker route 接管 `daily.ziyixi.science/*` 不会截获 Mail Hero 的同 zone `fetch()`，投递会继续流向 Tunnel 原站而 newsletter 打到新 Worker，形成静默脑裂；vitest 对真实 Workflow 实例的支持未验证 |

评委指出并在本方案中修正的事实错误：三份设计都把常开 `lite` 容器超额算成 $4–5/月，实际 vCPU 按活跃计费，内存+磁盘超额约 $1.7–2.0/月（结论不变）；方案 B 说"容器没有绑定"已过时（`outboundByHost` 自 2026-03-26 可用），且 `--platform linux/amd64` 在 wrangler 中已是隐藏/默认；方案 A 把 Access 路径匹配说成"前缀匹配"，实际是通配符+父路径继承；方案 A/B 的按需日报预算（120/60 秒）超过 newsletter 客户端 45 秒超时；D1 Time Travel 在 Paid 是 30 天。

**选定方案 A，并嫁接评委要求的改进：**（1）`todo_unknown` 后约 2 分钟自动做一次只读 Todoist 页脚查找，恰好一条匹配则自动置为 `todo_created`，自动重发仍藏在 `AUTO_RESOLVE_UNKNOWN=false` 之后；（2）CI 发布后 smoke 检查 `/health` 返回的构建 SHA 等于 `GITHUB_SHA`；（3）Worker 只存 Bearer/Basic 的 SHA-256（`*_SHA256`）并配 `*_PREVIOUS_SHA256` 轮换重叠；（4）新增 `PROCESSING_PAUSED`（接受并提交 webhook 但不执行），与 `MAINTENANCE_MODE`（503）、`FORCE_PAUSE_TODOIST` 区分；（5）可选把旧账本的非内容列导入 D1（`imported=1`），可选导入最近 24 小时摘要；（6）BasicAuth 端点每小时认证失败锁定；（7）按需日报计算封顶约 40 秒，否则返回 `status=stale` 的上一份；状态词汇 `ok|empty_window|model_output_invalid|stale`；（8）明确账户级影响与 Time Travel 30 天；（9）`[observability] enabled = true`；（10）在依赖 Access Service Auth 保护 `/hooks/*` 之前，先用合成事件验证同 zone Worker fetch 是否真的被 Access 拦截。

## 5. 目标架构详细设计

### 5.1 拓扑与绑定

```
Mail Hero Worker ──HTTPS POST mail.received.v1 (Bearer, Idempotency-Key)──▶ todofy Worker fetch()
      ──▶ D1 mail_events (INSERT … ON CONFLICT DO NOTHING + hash 比对) ──▶ 204 / 409
      └─ waitUntil(COORDINATOR /wake)
TodofyCoordinator DO（SQLite，固定实例 inbox-v1）alarm()：每次一步、串行
      pending ─Gemini(≤90 s)─▶ summarized ─Todoist(≤45 s)─▶ complete(+summaries 行)
      + 提醒声明(每 UTC 日一次) + 日报预计算(每日) + DAG reconcile(30 min) + 保留清理(每日)
Cron */10 * * * * ─▶ scheduled() ─▶ COORDINATOR /wake   （丢失 alarm 的兜底；DO 自己安排精确 alarm）
Newsletter(mini-PC) ─Basic─▶ GET /api/summary | /api/recommendation?top=N ─▶ 读 D1 daily_reports
Owner ─Cloudflare Access(JWT 在代码中再验证)─▶ /api/v1/mail_inbox*, /api/v1/dependency/*
```

| 绑定/配置 | 用途 |
|---|---|
| `DB`（D1 `todofy`，`migrations_dir=migrations`） | 账本：事件、提醒、摘要、日报、DAG 运行、owner 动作。与 Mail Hero 的 D1 完全分离 |
| `COORDINATOR`（DO 类 `TodofyCoordinator`，`new_sqlite_classes`，实例 `inbox-v1`） | 串行执行器、alarm 调度、热计数器（`llm_usage`、`todoist_calls`、`control`、`report_requests`、`schema_version`） |
| `[triggers] crons = ["*/10 * * * *"]` | 只调用 `/wake` |
| `routes = [{pattern: "todofy.ziyixi.science", custom_domain: true}]`，`workers_dev=false`，`preview_urls=false` | Custom Domain 才能被 Mail Hero 同 zone fetch 命中（§3） |
| vars | `MAIL_SOURCE_ID=mail-hero-personal`（必须等于今日 `TODOFY_MAIL_SOURCE_ID`，self-host compose `:231`）、`ACCESS_ISSUER/AUDIENCE/OWNER`、`ACCESS_OWNER_ALIASES`、`GEMINI_MODELS=gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite`、`GEMINI_DAILY_TOKEN_BUDGET=3000000`、`TODOIST_DEFAULT_PROJECT_ID`、`REPORT_DEFAULT_TOP=5`、`REPORT_PRECOMPUTE_UTC=13:30`、`REMINDER_ENABLED`、`DAG_ENABLED`、`DAG_RECONCILE_MINUTES=30`、`DAG_BOOTSTRAP_ENABLED=false`、`DAG_EXCLUDED_PROJECT_IDS`、`DAG_GRACE_MINUTES=2`、`AUTO_RESOLVE_UNKNOWN=false`、`MAINTENANCE_MODE`、`PROCESSING_PAUSED`、`FORCE_PAUSE_TODOIST`、`BUILD_SHA` |
| secrets（owner 一次性设置） | `MAIL_WEBHOOK_TOKEN_SHA256`、`MAIL_WEBHOOK_TOKEN_PREVIOUS_SHA256`（可选）、`GEMINI_API_KEY`、`TODOIST_API_KEY`、`REPORT_BASIC_AUTH_SHA256`（`user:password` 的摘要）、`REPORT_BASIC_AUTH_PREVIOUS_SHA256`（可选） |

三个运维开关的语义：`MAINTENANCE_MODE=true` → `/hooks/mail` 回 503 + `Retry-After`（Mail Hero 视为瞬态并退避，`pipeline.ts:468-471`）、停 alarm、拒绝 owner 写入；`PROCESSING_PAUSED=true` → 照常接受并提交，不执行；`FORCE_PAUSE_TODOIST=true` → 继续摘要，行停在 `summarized`。三者都镜像为 GitHub variables，避免下次发布覆盖（同 mail-hero `docs/ci-cd.md` 的规则）。

### 5.2 数据模型

D1（`migrations/0001_init.sql`，草图）：

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
  subject TEXT NOT NULL, summary TEXT NOT NULL, model TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '');
CREATE INDEX summaries_created ON summaries(created_at);
CREATE TABLE daily_reports (day TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('summary','recommendation')),
  top_n INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  task_count INTEGER NOT NULL, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
  computed_at INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '', PRIMARY KEY(day, kind, top_n));
CREATE TABLE dag_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
  task_count INTEGER, updated_count INTEGER, failed_count INTEGER, issues_json TEXT);
CREATE TABLE owner_actions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, event_id TEXT, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE auth_failures (hour TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
```

状态与错误码词汇与今日一致（`mail_inbox.go:239-274`），owner runbook（`README.md:262-268`）继续有效；`summary_model` 由 proto 枚举改为模型名字符串。payload 按契约 ≤1 MiB、摘要封顶 64 KiB、`todo_body` 128 KiB，单行远低于 D1 2,000,000 字节上限，不需要 R2。`summaries` 只存摘要不存正文，90 天清理；`mail_events` 行永不删除（契约要求账本 ≥90 天）。

DO SQLite 只放可重建的计数器与时刻表：`control(id=1, next_reminder_check, next_report, next_dag_reconcile, next_maintenance, todoist_blocked_until)`、`llm_usage(day PK, reserved_tokens, used_tokens, calls)`（3M/日预算，调用前预留、按 `usageMetadata.totalTokenCount` 结算）、`todoist_calls(minute_bucket PK, count)`（1000/15 分钟，`client.go:31-32`）、`report_requests(hour_bucket, count)`、`schema_version`。DO 存储丢失时计数器从零开始（保守）、时刻表默认"立即到期"、账本在 D1 完好。D1 不开读复制，保证 DO 的读-CAS 序列强一致。

### 5.3 流程

**接收 `POST /hooks/mail`**（Worker fetch，热路径不进 DO，移植 `mail_inbox.go:326-394`）：① `MAINTENANCE_MODE` → 503；② 恰好一个 `Authorization: Bearer`，两侧 SHA-256 后常量时间比对（含 `_PREVIOUS`），否则 401；③ `Content-Type` 非 JSON → 415，>1 MiB → 413；④ 严格校验 `mail.received.v1`（`mail_inbox.go:67-122` 的规则），`Idempotency-Key` 必须等于 `event_id` → 400；⑤ 一次 D1 `batch()`（原子）：`INSERT … ON CONFLICT DO NOTHING` 然后 `SELECT payload_hash`，hash 相同 → 204，不同 → 409，D1 错误 → 503；⑥ `ctx.waitUntil(COORDINATOR.fetch('/wake'))`。204 只在提交后发出；wake 丢失时 10 分钟 cron 兜底。Mail Hero 每版本超时默认 20 秒（`pipeline.ts:459-461`；`0001_native.sql:16`），本处理器只做毫秒级 D1 写入。

**DO alarm()**（模仿 mail-hero `coordinator.ts:164-222`）：① `running` 守卫；② `MAINTENANCE_MODE` → `setAlarm(now+1 天)`；③ 在任何外部调用前先写持久看门狗 `setAlarm(now+120 s)`；④ 崩溃恢复（替代 `mail_inbox.go:289-311` 的启动规则，因 DO 是唯一执行者且一次只做一步，alarm 开始时仍在途的行只可能来自上次中断）：`summarizing` → `pending` 且 `crashes+1`，三次 → `failed_summary/processing_interrupted_limit`；`todo_sending` → `todo_unknown/interrupted_todo_call`；提醒 `sending` → `unknown`；⑤ 取一条到期行（`state IN ('pending','summarized') AND next_attempt_at<=now ORDER BY created_at LIMIT 1`），CAS `UPDATE … WHERE state=?` 且 `meta.changes===1`；⑥ 执行一步；⑦ 下一 alarm = min(下一到期行、`control.*`)，刚处理过一行则 +1 秒连续排空。最坏 300 封/日（Mail Hero 的接收上限）×22 秒≈1.8 小时串行，每次 alarm 最长约 90 秒，远低于 15 分钟。

**步骤 A：摘要**（`pending→summarizing→summarized|failed_summary`）：`needs_review` 或 `html_omitted` 且正文为空 → `failed_summary/mail_needs_review`，不调 LLM（`mail_inbox_worker.go:186-192`）；不移植 `[Todofy System]` 前缀丢弃。预留 `ceil(bytes/2)+4096` token，超预算 → `postpone(pending,'llm_budget_exhausted')`（瞬态类）。Gemini 经 `fetch`：`systemInstruction`=逐字的 `DefaultPromptToSummaryEmail`，用户回合=截断提示文案（`:145-154`）+ 显式分隔块内的正文；按 `GEMINI_MODELS` 顺序，每模型 `AbortSignal.timeout(60 s)`，整步 90 秒；空输出=失败（`:215`）。分类：429 → `llm_quota`（瞬态，尊重 `Retry-After`）；5xx/超时/网络 → `summary_failed`（瞬态，7 天内重试）；400/401/403 → `llm_request_rejected`（12 次后放弃）。渲染用模板字面量（修 B1）：FROM/TO/DATE/SUBJECT + 摘要 + `\n\nMail Hero event: <event_id>`，`\s#[a-zA-Z0-9]{1,10}\s` 替换为单个空格；同时计算 `todoist_request_id`。CAS 到 `summarized`，`attempt_count=0`。

**步骤 B：建任务**（`summarized→todo_sending→complete|todo_unknown|summarized`）：前置检查 `FORCE_PAUSE_TODOIST`、`control.todoist_blocked_until`、`todoist_calls`。`POST https://api.todoist.com/api/v1/tasks`，`X-Request-Id=todofy-<sha256(subject\0todo_body\0from)[:28]>`（主题空则 `(No subject)`，`:258-262`；`todo_body` 已冻结，故同事件每次重试字节一致，"新事件重发"因页脚不同而是新请求）；每次尝试 14 秒、最多 3 次（429/502/503/504/超时）、总预算 45 秒（修 B2）、1 MiB 体积上限。结果分类（修 B2 的压平）：2xx 且有 `id` → 一次 D1 batch：`UPDATE … state='complete', task_id, payload=NULL, summary='', todo_body=''` + `INSERT INTO summaries`（`todo_created` 保留在词汇里但不再是停留态，`cache_write_failed` 不可能出现）；400/404 → `summarized`+退避，`todoist_rejected`；401/403 → `summarized`，`todoist_auth_blocked`，且 `todoist_blocked_until=now+6 h` 整阶段暂停（不再让 N 封邮件变 N 次手工对账）；429 或 5xx 用尽 → `summarized`+`Retry-After`/退避；500、超时用尽、发出后网络错误、2xx 无 id → `todo_unknown/todo_result_unknown`，永不自动重试。

**步骤 B′：`todo_unknown` 只读跟进**（嫁接）：进入 `todo_unknown` 约 2 分钟后，`GET /api/v1/tasks` 分页检索描述含 `Mail Hero event: <id>` 的活动任务，恰好一条 → `todo_created`（等价 owner 的 `task_created`），否则保持 `todo_unknown` 并记 `lookup_not_found|lookup_failed`。自动重发仅在 `AUTO_RESOLVE_UNKNOWN=true` 时发生，默认关。

**每日提醒**：每 10 分钟检查；attention = `failed_summary`/`todo_unknown` 或非终态且超过 6 小时（`:383-386`）；在 D1 用 `INSERT … ON CONFLICT(day) DO NOTHING` 先声明再调用；冻结的主题/正文只含 ID、状态、码、时间（`:668-690`）；结果 `created`/`failed`（每小时重试 ≤5 次，仅限不可能已建任务的错误类）/`unknown`（当日不再发）。正文里的指引更新为新域名与 Access 方式。

**日报预计算与 newsletter API**：`REPORT_PRECOMPUTE_UTC=13:30`（早于 newsletter 的 07:00 America/Los_Angeles=14:00/15:00 UTC，self-host `newsletter-trigger/crontab:5`）读最近 24 小时 `summaries`；0 行 → `status=empty_window` 并保留今日的英文回退句（`handle_summary.go:41-42`，兼容）；否则 Gemini 用 `DefaultPromptToSummaryEmailRange`，推荐用 `DefaultPromptToRecommendTopTasks` + `responseMimeType=application/json` + `responseSchema`（校验 ≤N 项、rank 唯一、标题 ≤200 字），无效 → `status=model_output_invalid, tasks=[]`（不再回退原文）。`GET /api/summary` → `{summary, task_count, time_window_hours:24, status, computed_at, window_start, window_end, model}`；`GET /api/recommendation?top=1..10`（默认 3） → `{tasks[{rank,title,reason}], model, task_count, status, computed_at}`。取 ≤26 小时内最新一行；没有则按需计算但封顶 40 秒（newsletter 客户端 45 秒单次、无重试，`newsletter/src/newsletter/todofy.py:347`），超时返回上一份并标 `stale`，从不编造摘要。每小时 30 次请求上限。

**DAG reconcile**：`dependency/` 作为纯模块移植（`metadata.go:43-128,155-190`；`graph.go:67-89,350-385,431-474`；`consts.go:5-14`；测试向量照搬）。DO 每 `DAG_RECONCILE_MINUTES` 执行：`EnsureLabels` → 分页 `GET /tasks` → 分析 → 最小标签 diff，跳过 2 分钟宽限期内更新的任务（`dependency_service.go:536-539`），单次 5 分钟预算，共享 Todoist 配额，结果写 `dag_runs`。`bootstrap`（重写所有未键任务标题，`:150-187`）由 `DAG_BOOTSTRAP_ENABLED=false` 门控，永不在启动时跑，只按 owner 显式请求执行。丢弃 `MarkGraphDirty`、`TodoistService`、`VerifyWebhook`。

**保留清理**（每日）：`summaries` >90 天、`daily_reports` >90 天、`dag_runs` >30 天、`owner_actions` >180 天、`auth_failures` >30 天；`mail_events` 不删。

### 5.4 幂等、重试与超时汇总

| 情形 | 行为 |
|---|---|
| 重复 webhook，同字节 / 异字节 | 204 无工作 / 409 |
| webhook 时 D1 不可用 | 503 → Mail Hero 退避重投同字节 |
| 提交后 wake 丢失 | 10 分钟 cron 唤醒；行仍为 `pending` |
| isolate 在 Gemini 期间被驱逐 | 下次 alarm 见 `summarizing` → `pending`，`crashes+1`，3 次 → `failed_summary/processing_interrupted_limit` |
| isolate 在 Todoist 期间被驱逐 | `todo_unknown/interrupted_todo_call` → 步骤 B′ 查找 → owner |
| Gemini 429/5xx/超时 | `1 min×2^min(n,8)`（封顶 256 分钟），12 次且 7 天后放弃 |
| Todoist 401/403 | 阶段暂停 6 小时，行留在 `summarized`，attention 显示 `todoist_auth_blocked` |
| Todoist 超时/500/无 id | `todo_unknown`，永不自动重试；次日提醒 |
| owner `task_not_created` 重发 | 同冻结正文 → 同 `X-Request-Id`；Todoist 是否据此去重未证实，冻结请求+人工确认才是真正保护 |
| 提醒 | D1 先声明后调用；`unknown` 当日不重发 |
| 预算 | `llm_usage` 先预留；耗尽则推迟不丢弃 |
| DO 存储丢失 | 计数器归零，时刻表立即到期，账本在 D1 |

超时：Gemini 每模型 60 秒/整步 90 秒；Todoist 每次 14 秒×3/总 45 秒；页脚查找 20 秒；DAG 单次 5 分钟；按需日报 40 秒；webhook 处理器毫秒级（远小于 Mail Hero 20 秒）。

### 5.5 认证

**Mail Hero → Todofy：公网 HTTPS + Bearer，契约不变。** Mail Hero 的产品规则是通用消费者契约：精确公网 HTTPS 域名白名单、Bearer/Basic（AGENTS.md §3；`security.ts:81-92`）；Service Binding 需要 Mail Hero 增加 Todofy 专属代码路径，且被绑定 Worker 必须先部署（§3），违反"不绑定发布周期"（AGENTS.md §0）。Custom Domain 让同 zone `fetch()` 无需 binding 即可到达（§3），Mail Hero 自身就在 Custom Domain 上（`deploy/generate-ci-config.mjs:61`）并从 DO 里用全局 `fetch` 投递（`pipeline.ts:461`）。Mail Hero 侧只需：GitHub 变量 `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` 增加新域名（`native.yml:96`；`generate-ci-config.mjs:24-25`）并重新部署，再在 UI 新建目标。第二层 Access Service Auth（`pipeline.ts:415-417` 已支持 `ACCESS_SERVICE_ORIGIN`）可后加，但默认同 zone fetch"绕过 Cloudflare 安全设置"，是否真被 Access 拦截需先用合成事件验证；若不生效，Bearer 就是唯一有效层，文档要如实写。

**Owner API：Cloudflare Access + 代码内 JWT 验证。** 一个自托管 Access 应用覆盖 `todofy.ziyixi.science/api/v1/*`，复用 Mail Hero 的两条 Allow 策略（按 IdP 的精确邮箱，无 Bypass，`docs/cloudflare-setup.md:109-111`）。Worker 复用 `security.ts:105-129` 的 `authenticate()` 形状独立校验签名、issuer、audience、过期、owner 或 ≤8 个别名；Access 配错时失败关闭。mutation 需 `X-Todofy-Admin-Action`（沿用 `mail_inbox_worker.go:706`）。owner 用 curl 时走 Access service token（Service Auth 策略）。

**Newsletter：过渡期 Basic（仅存 SHA-256，常量时间比对）+ 每小时失败锁定（20 次后该小时回 429）。** newsletter 客户端今天不支持 service token 头（`todofy.py:335-430`），所以 `/api/summary`、`/api/recommendation` 暂在 Access 之外；等 newsletter 发 `CF-Access-Client-Id/Secret` 后切到 Service Auth 并删除 Basic 密钥。

### 5.6 可观测性

`[observability] enabled = true`（Workers Logs，Paid 7 天保留）；日志只记 ID、状态、计数、安全错误码、HTTP 状态码，绝不记正文、prompt、响应体或带 key 的 URL（AGENTS.md §0；今日 `mail_inbox_worker.go:365,660-661` 的纪律）。`GET /health`：D1 可读且最老到期行 <1 小时才 200，并返回 `build`（不同于今日无条件 200）。`GET /api/v1/mail_inbox?view=recent|attention` 保持今日响应形状（`:443-476`）并加 `budget`、`next_alarm`、`todoist_blocked_until`。每日 Todoist 提醒任务仍是不依赖流水线自身健康的告警通道。账户设置 Cloudflare 计费通知。

## 6. CI/CD 与零人工部署

`ziyixi/todofy` 新增 `.github/workflows/native.yml`，逐项镜像 mail-hero 的同名文件：`permissions: contents: read`（`native.yml:9`）、不取消的 concurrency（`:14`）、SHA 固定的 action、PR/push 上的 `checks` job、只在 main push 或手动触发（`:59`）且处于 GitHub `production` environment（`:62-63`）的 `deploy` job，依次 `wrangler deploy --dry-run`（`:107`）→ `wrangler d1 migrations apply DB --remote`（`:115`）→ `wrangler deploy`（`:116`）。

```
checks (ubuntu-24.04, 15 min):
  checkout@<sha>, setup-node@<sha>; npm ci --prefix worker
  node --test deploy/test/*.test.mjs        # 配置生成器 + 契约 JSON Schema
  npm run typecheck && npm test --prefix worker   # vitest-pool-workers：真实 D1/DO 绑定，outboundService 假 Gemini/Todoist
  npx wrangler deploy --dry-run --config wrangler.toml
deploy (needs checks; main push|dispatch; environment production; concurrency todofy-production, no cancel):
  node deploy/generate-ci-config.mjs        # vars → worker/wrangler.production.ci.json (0600，不打印)
  npx wrangler deploy --dry-run --config wrangler.production.ci.json
  npx wrangler d1 migrations apply DB --remote --config wrangler.production.ci.json
  npx wrangler deploy --config wrangler.production.ci.json
  curl https://$TODOFY_PUBLIC_HOST/health → 断言 build == GITHUB_SHA，否则 job 失败   # 嫁接
  if always(): rm -f worker/wrangler.production.ci.json
```

`deploy/generate-ci-config.mjs` 是 mail-hero `deploy/generate-ci-config.mjs:21-62` 的孪生：按正则校验每个变量（账户 32 hex、D1 UUID、issuer `https://*.cloudflareaccess.com`、audience 64 hex、邮箱、域名、布尔、整数），输出 `name/main/compatibility_date/workers_dev=false/preview_urls=false/vars/d1_databases/durable_objects/migrations(tag v1, new_sqlite_classes)/triggers/routes(custom_domain)/observability`，只打印成功或失败的变量名。**没有容器镜像构建、没有 registry、没有服务器步骤。**

| 类别 | 名称（仅名称） |
|---|---|
| 仓库/environment variables | `CLOUDFLARE_ACCOUNT_ID`、`TODOFY_D1_DATABASE_ID`、`TODOFY_D1_DATABASE_NAME`、`TODOFY_PUBLIC_HOST`、`TODOFY_MAIL_SOURCE_ID`、`TODOFY_ACCESS_ISSUER`、`TODOFY_ACCESS_AUDIENCE`、`TODOFY_ACCESS_OWNER`、`TODOFY_GEMINI_MODELS`、`TODOFY_GEMINI_DAILY_TOKEN_BUDGET`、`TODOFY_TODOIST_DEFAULT_PROJECT_ID`、`TODOFY_REPORT_DEFAULT_TOP`、`TODOFY_REPORT_PRECOMPUTE_UTC`、`TODOFY_REMINDER_ENABLED`、`TODOFY_DAG_ENABLED`、`TODOFY_DAG_RECONCILE_MINUTES`、`TODOFY_DAG_BOOTSTRAP_ENABLED`、`TODOFY_DAG_EXCLUDED_PROJECT_IDS`、`TODOFY_AUTO_RESOLVE_UNKNOWN`、`TODOFY_MAINTENANCE_MODE`、`TODOFY_PROCESSING_PAUSED`、`TODOFY_FORCE_PAUSE_TODOIST` |
| `production` environment secrets | `CF_API_TOKEN`（限本账户：Workers Scripts 编辑、D1 编辑、`ziyixi.science` zone 的 Workers Routes/Custom Domains、账户设置读；无 Billing，同 mail-hero `docs/ci-cd.md:40`）、`TODOFY_ACCESS_OWNER_ALIASES` |
| Worker secrets（owner 本机 `wrangler secret put`，CI 永不读取/复制/轮换） | `MAIL_WEBHOOK_TOKEN_SHA256`、`MAIL_WEBHOOK_TOKEN_PREVIOUS_SHA256`、`GEMINI_API_KEY`、`TODOIST_API_KEY`、`REPORT_BASIC_AUTH_SHA256`、`REPORT_BASIC_AUTH_PREVIOUS_SHA256` |

**一次性引导（手工，只做一次）：** 升级 Workers Paid（须在首次部署前，否则容器类配置会 403，纯 Worker 亦需 Paid 的 CPU/DO 额度）；`wrangler d1 create todofy`；创建 Access 应用 `todofy.ziyixi.science/api/v1/*` 与 Service Auth 策略/service token；创建 `production` environment（限 main）并放入 `CF_API_TOKEN`；设 Worker secrets；合并到 main。

**迁移与回滚：** D1 迁移只前向、只增量，在旧版本 Worker 仍服务时执行（同 mail-hero `docs/ci-cd.md`）；迁移成功但部署失败则重跑 workflow，已应用的迁移不重复执行。DO 表结构由 DO 自身在首次访问时 `CREATE TABLE IF NOT EXISTS` + `schema_version` 处理，CI 不碰。代码回滚：`wrangler rollback`/`wrangler versions deploy <previous>`，或 revert 提交让 CI 重发；数据不回滚，D1 Time Travel 30 天可原地恢复账本。风险发布前先 `PROCESSING_PAUSED=true` 排空。本地开发用 `wrangler dev` + 假 Gemini/Todoist 基址（仅 loopback 且 `DEV_FAKES=true` 时生效）与限 loopback 的 `DEV_AUTH_BYPASS`（同 `security.ts:96-100`），CI 生成器永不输出这两项。

**门禁测试：** 单元（node:test + 真实迁移 SQL）：契约校验器含内容策略规则、渲染黄金测试（`&`、`<`、`'`、`"`、中文，断言无实体）、退避表、`X-Request-Id` 确定性、Todoist 结果分类、日报 JSON 校验、`dependency/` 移植向量、三段 prompt 文本固定。运行时（Miniflare 真实 D1+SQLite DO，`outboundService` 假 `generativelanguage.googleapis.com`/`api.todoist.com`，同 mail-hero `cloudflare/test/native-runtime.test.mjs:60-72`）：401/415/413/400；首投 204 且 `pending`；同字节重放 204 不建第二行；异字节 409；alarm → 假 Gemini → `summarized` → 假 Todoist → `complete` 且正文含页脚；Todoist 503×3 → `summarized` 重试；超时 → `todo_unknown` 且不再重试；401 → 阶段暂停；`needs_review` → `failed_summary`；中断的 `summarizing` → `pending` → 3 次后 `processing_interrupted_limit`；提醒每 UTC 日一次且 `unknown` 不重发；四种 reconcile；日报预计算 + `empty_window` + `model_output_invalid` + 40 秒封顶；DAG 环/断依赖/宽限期；保留清理；DO 存储清空与 alarm 丢失场景。只用 `f8c1e9a0-…` 风格的合成 fixture。Go 的 `ci.yml` 在 Go 树删除前继续跑，新 workflow 以 `paths:` 过滤 `worker/**`、`deploy/**`。

## 7. 迁移与切换计划

原则：旧 VPS 栈原样运行到新 Worker 干净服务真实流量 ≥7 天；Mail Hero 在接收时冻结每个事件的目标版本、从不重定向旧事件（AGENTS.md §3；`0001_native.sql:59-70`），所以切换是干净分割，账本数据不需要移动；不读取真实邮件、token 或数据库内容，凭据与 UI 操作由 owner 执行。

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| 0 建设（无生产变化） | `todofy` 仓库新增 `worker/`、`migrations/`、`deploy/generate-ci-config.mjs`、`.github/workflows/native.yml`；Go 代码与 CI 保留；prompt 从 `utils/consts.go` HEAD 复制，另一任务的推荐 prompt 修改落地后同步 | checks 绿 |
| 1 暗部署 | 一次性引导；`TODOFY_TODOIST_DEFAULT_PROJECT_ID` 指向专用**测试项目**，`DAG_ENABLED=false`；合并后 CI 发布 `todofy.ziyixi.science`；Mail Hero：`MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` 加新域名并重发，UI 新建目标（Bearer，新随机 token，只存摘要），用端点"测试"动作（真的会建任务，落在测试项目），**不**选为当前目标；合成事件浸泡 ≥3 天，演练 reconcile 与提醒 | `/health` 200；204/204/409/401 全对；行到 `complete`、任务在测试项目且无 HTML 实体；`/api/summary` 用新 Basic 返回 `empty_window` |
| 2 邮件切换 | 项目 ID 改为真实项目、`DAG_ENABLED` 按需（bootstrap 仍关；若开 DAG 先停 VPS 的 `todofy-todo` 调度，避免两个 reconciler 同时写标签）并发布；可选：在 mini-PC 上 `sqlite3 ".backup"` 后只导出 `event_id, hex(payload_hash), state, task_id, created_at, updated_at`（不含 payload/summary/todo_body）以 `imported=1` 导入 D1，可选导出最近 24 小时摘要；Mail Hero UI：暂停 → 选新目标 → 恢复；观察旧版本投递直到无 pending，旧 Todofy `?view=attention` 为 0 且 pending/summarized/todo_sending 为 0，剩余 `todo_unknown` 在旧侧先处理 | 首封真实邮件：Mail Hero delivered → D1 `complete` 且有 `task_id` → Todoist 任务带页脚 |
| 3 newsletter 切换（≥24 小时后） | mini-PC 编辑私有 `env/newsletter.env`：`TODO_API_BASE=https://todofy.ziyixi.science`、新 `TODO_API_USER/PASSWORD`（键已存在，`env/newsletter.env.example:31-33`）；`docker compose up -d --no-deps newsletter`；手工 `curl -u … /api/recommendation?top=5`；检查 newsletter 代码是否解析 `model` 字段（由枚举名变为模型名） | 连续两期日报来自新端点 |
| 4 退役（≥7 个干净天后） | **self-host-on-vultr**：删除 `todofy/todofy-llm/todofy-todo/todofy-database`（`docker-compose.yml:219-267`）与 10003 端口、两个 bind mount；粉碎 `env/todofy.env`、`.old`、`.20250921`、`env/todofy-mail-webhook.env`；更新 `tests/test_newsletter_deployment.py:323-324` 的服务名断言；`env/todofy.env.example` 只留 newsletter 的 `TODO_API_*`。**数据**：`./data/todofy`（无保留期全文缓存）与 `./data/todofy-mail` 做最后一次加密归档后删除（隐私改善）；清理本地残留镜像与 `~/todofy-releases`。**Tunnel**：在远程管理的 Tunnel 中删除 `daily.ziyixi.science → localhost:10003` 与 DNS 记录，保留其他主机名。**Mail Hero**：归档旧目标；`MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` 移除旧域名并重发；文档 PR 更新 `docs/todofy-integration.md`、`docs/cloudflare-setup.md:3`、AGENTS.md §0 预算表述。**todofy 仓库**：删除 `main.go`、`grpc.go`、`handle_*.go`、`mail_inbox*.go`、`llm/`、`todo/`、`database/`、Go 版 `dependency/`、`utils/`、`sut/`、`scripts/`、`testutils/`、`templates/`、全部 Dockerfile/entrypoint/compose、`Makefile`、`go.mod/go.sum`、Go workflow；重写 README 与架构图。**protos**：归档 `proto/todofy/*`，停止生成 `go/todofy`（todofy 是唯一消费者，`go.mod:14`）。GHCR 包一个月后归档 | 旧栈无遗留 attention；VPS 上无 Todofy 密钥文件 |

数据处置：账本行不迁移（可选导入仅为审计与 409 连续性）；旧 `database_entries` 全文缓存归档后删除；prompt、模型顺序、状态/错误码、提醒文案、reconcile API 原样保留；CloudMailin 路径与 `utils/cloudmailin.go` 丢弃；owner API 的 BasicAuth 换成 Access，Basic 只留给 newsletter 两个端点；DAG bootstrap 默认关。

验证清单（只有实际跑过的才写"通过"，同 mail-hero `docs/verification-native.md` 的规则）：合成 webhook 的 204/204/409/401/413/415；真实 Gemini + 测试项目 Todoist 的端到端 `complete`；`needs_review` 与截断提示；故意错误的 `TODOIST_API_KEY` → `todoist_auth_blocked` → attention → 提醒任务恰一次；`task_not_created` 重发与 B′ 查找；DO 存储清空后 cron 自愈；Access 下的 owner API（浏览器与 service token）；newsletter 两端点用 Basic 与错误 Basic（锁定）；发布后 `/health` 的 SHA；同 zone fetch 是否被 Access 拦截的实验（决定 §5.5 文案）。

## 8. 成本估算、风险与未决问题

### 8.1 月成本（Workers Paid，价格抓取 2026-09-27）

| 项目 | 包含额度 | 预计用量（推断算术） | 费用 |
|---|---|---|---|
| Workers Paid 订阅 | $5/月，10M 请求，30M CPU-ms | webhook ~3k + cron 4.3k + newsletter ~60 + owner 调用 <10k 请求；CPU ≈50 ms×15k≈0.75M ms | **$5.00** |
| DO 请求 / 时长 / SQLite | 1M 请求；400,000 GB-s；25B 行读、50M 行写、5 GB | ≈15k 请求（含 alarm）；邮件 100/日×22 s×0.125 GB + DAG 48×30 s×0.125 ≈14k GB-s/月；<10 MB | $0 |
| D1 | 25B 行读、50M 行写、5 GB | ≈0.3M 读、≈30k 写、<200 MB | $0 |
| Cron、Access（Zero Trust Free 50 用户）、Custom Domain、Workers Logs（20M 事件） | — | 4.3k 触发；1 用户+1 service token；~130k 日志事件 | $0 |
| Gemini / Todoist | 外部，与今日相同 | ~100 摘要/日 + 2 份日报 | 不变 |
| **合计** | | 各维度余量 >30× | **≈ $5.00/月** |

对照：若采用容器方案，常开 `lite` 实例内存+磁盘超额约 $1.7–2.0/月（评委修正后的数字；vCPU 按活跃计费），`sleepAfter=10m` 约 $0.4/月，短 `sleepAfter` 约 $0 但几乎每封邮件付一次冷启动，且仍需 DO/D1 与 Docker 流水线。Paid 计划账户级生效：Mail Hero 的 D1/DO/Workers 用量远在包含额度内（DO 每次 `setAlarm()` 计一次行写，微不足道），预期 $0 增量，但其文档中的 "$0/月" 不再字面成立。应用内护栏（token 预算、Todoist 1000/15 分钟、日报 30 次/小时、DAG 5 分钟、清理限额）都不是账单硬上限；请在账户设置计费通知。

### 8.2 风险与未决问题

| # | 风险 / 未决 | 缓解或需要谁决定 |
|---|---|---|
| R1 | Todoist `X-Request-Id` 去重未在 v1 文档证实（仅 REST v2 提及）；SUT 假服务从未检查 | 设计不依赖它：`todo_unknown` 永不自动重发、`task_not_created` 需 owner 确认、B′ 先查页脚；owner 用一次性项目做一次重复请求实验；不支持则改用 Sync API `item_add` 的 `uuid` |
| R2 | CloudMailin 是否已彻底停用（推断是，来自 Mail Hero 验收记录，只读不可验证） | owner 确认后删除 `/api/v1/update_todo` |
| R3 | DAG 的标题重写 bootstrap 是否还需要 | 默认关，只按 owner 显式请求执行；owner 决定 |
| R4 | 新域名选择（newsletter 要求裸 HTTPS origin、443 端口；Mail Hero 要求精确主机名在白名单） | 建议 `todofy.ziyixi.science`；owner 决定 |
| R5 | Access Service Auth 是否对同 zone Worker→Custom Domain fetch 生效未见文档 | 先合成事件实验；不生效则文档明确 Bearer 是唯一层 |
| R6 | 两处状态（D1 账本 + DO 计数器/时刻表） | D1 唯一真源，DO 可重建，cron 独立唤醒；显式测试 DO 清空与 alarm 丢失 |
| R7 | DO 在外部调用中被驱逐 | 与今日 SIGKILL 暴露相同：Gemini 中断浪费 token，Todoist 中断得 `todo_unknown`；崩溃计数 3 次封顶 + 提醒 |
| R8 | Access 配错到共享域名：若误覆盖 `/hooks/mail`，Mail Hero 见 302 → 宽限期后路由类阻断 | 任何 Access 变更后用合成事件验证；owner API 代码内 JWT 验证失败关闭 |
| R9 | newsletter 契约漂移：`model` 由枚举名变模型名、推荐不再回退原文、窗口锚定在预计算时刻 | 字段只增不删；暴露 `status`；检查 newsletter 仓库对 `model` 的解析 |
| R10 | Gemini 从 Cloudflare 出口的延迟/区域错误未知 | 模型回退链、60/90 秒超时、7 天瞬态重试窗；先合成测量 |
| R11 | prompt 注入是产品固有属性 | `systemInstruction` + 分隔块 + schema 校验降低影响；爆炸半径是任务描述与日报段落；模型输出永不当指令 |
| R12 | 单对象串行吞吐（≈22 秒/封） | 当前量级足够；需要时允许每次 alarm 处理 N 步，模型不变 |
| R13 | `CF_API_TOKEN` 范围不足（Custom Domain 需 zone 权限） | 首次部署会大声失败而非静默 |
| R14 | 仓库过渡期两套栈两个 CI | `paths:` 过滤；退役后尽快删 Go 树 |
| R15 | 退役顺序：旧版本投递未排空就删 `daily.ziyixi.science` 会让它们路由阻断 | 阶段门槛（pending=0、attention=0）；删除后旧版本"unblock"预期失败，答案是"新事件重发" |
| R16 | 另一任务对 `DefaultPromptToRecommendTopTasks` 的未提交修改 | TS 副本在该修改落地后同一 PR 系列同步；prompt 文本用测试固定 |
| R17 | 无 UI 时 owner 操作体验 | Access service token 或 `cloudflared access curl`；可选 +2 天加一个静态 attention/reconcile 页面 |
| R18 | 备份：不承诺 RPO/RTO | Time Travel 30 天；后续可把 `wrangler d1 export` 接入现有 Mail Hero 备份收集器模式（AGENTS.md §7） |

**工作量（推断）：** 约 11–13 个专注工程日 + 1–2 周日历浸泡：脚手架/D1/webhook/校验器与单元测试 2 天；DO 执行器（alarm、恢复、Gemini/Todoist 客户端、状态机、提醒、预算）与运行时测试 3–4 天；owner API/Access/reconcile/health 1 天；日报与 newsletter 端点 1 天；DAG 移植 2 天；CI/CD 与引导文档 1 天；切换、验证、三个仓库的退役修改 1–2 天。预期约 3,500–4,500 行 TypeScript（含测试），一个 Worker，零容器。
