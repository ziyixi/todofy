# Mail Hero → Todofy

Mail Hero 的 Todofy 目标为 `https://daily.ziyixi.science/hooks/mail`，Bearer 认证，发送通用 `mail.received.v1`。Todofy 是这个 webhook 的独立消费者：与 Mail Hero 同在单仓库（`todofy/`）和同一 Cloudflare 账户，但不导入 Mail Hero 的代码，不读它的 D1、R2 或 DO，独立发布。双方只共享 [`contracts/mail-received-v1`](../../contracts/mail-received-v1/mail-received-v1.md) 和一个 Bearer 认证值；两者共用账户级 Workers Free/D1 免费额度。

## Todofy 现在是什么

2026-09-29 起 Todofy 全部运行在 Cloudflare Workers Free 上（旧 Go 服务、gRPC 容器与 CloudMailin 接口已退役）：

- Worker `todofy`：TypeScript 网关，负责主机、认证、静态资源和 cron。收到 webhook 时只做认证与头部检查，把未读的请求体通过 JS RPC 交给 core。
- Worker `todofy-core`：Python，承载唯一的 SQLite Durable Object `TodofyCore`（实例 `inbox-v1`），它是账本唯一写入者和调度者，负责 D1、Gemini 摘要与 Todoist 任务。
- D1 数据库 `todofy`，以及保存每周 D1 备份的私有 R2 桶 `todofy-backups`。

架构与状态说明见 [Todofy README](../../todofy/README.md)，接口以 [`owner-api-v1.openapi.yaml`](../../todofy/api/owner-api-v1.openapi.yaml) 和 [`gateway/src/hooks.ts`](../../todofy/gateway/src/hooks.ts) 为准。

## 投递目标与认证

- `POST /hooks/mail` 在 `TODOFY_HOOKS_HOSTS` 的每个主机上提供；这些主机都是网关 `todofy` 的 Custom Domain，行为相同。2026-09-29 已确认 `daily.ziyixi.science`（Mail Hero 现有目标）是其中之一；Todofy 部署说明中的 `todofy-hooks.ziyixi.science` 是否在生产列表里，本文未核实。hooks 主机只提供 `POST /hooks/mail`、newsletter 的 `GET /api/summary` 与 `GET /api/recommendation` 和 `GET /health`，其他请求一律 404。
- hooks 主机不在 Cloudflare Access 之后，Mail Hero 发往它不需要 `ACCESS_SERVICE_ORIGIN`/`ACCESS_CLIENT_*`。
- 网关只保存 Bearer 值的 SHA-256（gateway secret `MAIL_WEBHOOK_TOKEN_SHA256`，轮换期间可加 `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS`），以常数时间比较；Todofy 不保存认证值本身。按 Todofy 部署说明，认证值只在 Mail Hero 目标（加密）和 owner 的密码管理器里。
- 轮换顺序：Todofy 先把新摘要设为当前、旧摘要设为 `_PREVIOUS`，再在 Mail Hero 目标页“轮换凭据”（它重新加密该目标下同源、同认证类型的全部 revision 的凭据，并清除认证阻断），最后删除 `_PREVIOUS`。此流程未在生产演练。
- 若把目标改为 `todofy-hooks.ziyixi.science`：先确认它在 Todofy 的 `TODOFY_HOOKS_HOSTS` 中，且 `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` 包含它（两者的当前值本文均未核实）。改 URL 会生成新 revision，已冻结的事件仍发往原 revision 的 URL。

## Todofy 的响应与 Mail Hero 的处理

网关依次检查：是否已配置摘要 secret → Bearer → 维护开关 → `Content-Type` → 声明的 `Content-Length`；之后 DO 读取请求体（上限 1 MiB）、按合同解析、核对 `Idempotency-Key`，写入 D1 后才回 204。Mail Hero 的分类见 [`pipeline.ts`](../cloudflare/src/native/pipeline.ts) 的 `deliverJob` 和合同的“响应处理”一节。

| Todofy 返回 | 含义（错误码） | Mail Hero 行为 |
| --- | --- | --- |
| 204 | 新事件已提交 D1；或相同 `event_id` 与相同 bytes 的重放，不做新工作 | 已交付；清除该 revision 的可复查阻断 |
| 400 | `invalid_payload`：不符合合同，或 `Idempotency-Key` 缺失/重复/不等于 `event_id` | 其他 4xx：投递失败，不自动重试，UI 显示 `http_400` |
| 401 | `unauthorized`：Bearer 缺失或摘要不符（维护期间也先返回它） | 立即阻断目标 revision，不自动复查；轮换凭据或 owner 解除阻断 |
| 404 | `not_found`：主机不在 `TODOFY_HOOKS_HOSTS` 或路径不对 | 路由类：30 分钟宽限，之后阻断并每 6 小时复查，最多 8 次 |
| 409 | `event_conflict`：同一 `event_id` 已存有不同 bytes | 其他 4xx：失败，不自动重试 |
| 413 | `payload_too_large`：超过 1 MiB（合同同样限制整个 JSON 1 MiB） | 其他 4xx：失败 |
| 415 | `unsupported_media_type`：不是 `application/json` | 其他 4xx：失败 |
| 503 | `maintenance`（带 `Retry-After: 600`）、`not_configured`（未设置摘要 secret）、`unavailable`（DO 或 D1 失败） | 暂时失败：同一 bytes 持久退避（30 秒起倍增，上限 6 小时），尊重 `Retry-After`；自动最多 48 次或事件创建后 7 天，之后需手动重试（30 天内） |

网络错误、超时和响应丢失同样按暂时失败重试。400、409、413、415 不应出现在正常流量中：Mail Hero 总是发送 `application/json`、`Idempotency-Key` 等于 `event_id`，且 `Contracts` CI 证明 Todofy 接受每个 golden fixture。若出现：

- 400：重试复用冻结 bytes，因此应修 Todofy 使其接受这些 bytes（`fixtures/legacy/` 就是为此保留的旧字节），再在 Mail Hero 手动重试。
- 409：Mail Hero 不会改写已冻结的 bytes，冲突说明 Todofy 账本里有同 ID 的不同内容（例如恢复或导入的问题）。先核对，不要反复重试；确需任务时用“重新发送为新事件”，它生成新 `event_id`，可能再次创建任务。

## 幂等与去重

- Todofy 的唯一键是 `(source_id, event_id)`，`source_id` 为 `TODOFY_MAIL_SOURCE_ID`（默认 `mail-hero-personal`），与认证值无关，轮换不改变它。每行保存请求 bytes 的 SHA-256。
- 同 ID 同 bytes 返回 204 且不唤醒处理；同 ID 不同 bytes 返回 409。从旧 Go 服务导入的账本行同样适用。
- Todofy 的保留清理不删除 `mail_events` 账本行（完成后只清空正文），满足合同至少 90 天的去重要求。
- Mail Hero 的所有重试（包括响应丢失后的 `result_unknown`）复用同一 `event_id` 与 bytes；“重新发送为新事件”才会生成新 ID。

## 共享合同

`contracts/mail-received-v1/` 是两个应用唯一共享的文件：语义说明、唯一的 JSON Schema（Todofy 的 OpenAPI 按相对路径引用）、`fixtures/*.json` golden 请求体（由 Mail Hero 真实的 `parseMail` + `buildPayload` 从合成邮件生成，逐字节固定、无结尾换行）和 `fixtures/legacy/` 冻结旧字节（两侧测试固定其 SHA-256）。

- Mail Hero 拥有该合同。修改构建器后在 `mail-hero/cloudflare` 运行 `npm run contract:update`，检查 fixture diff，并与 `contracts/` 的变更放在同一提交。
- 根 CI 的 `Contracts` job：Mail Hero 逐字节重建每个 fixture；Todofy 用 Schema 校验并用自己的解析器解析每个 fixture（含 legacy）。另外 `Todofy checks` job 的 runtime 测试（`contracts/` 改动时也会运行）把它们 POST 到真实 workerd 网关。不兼容的改动在合并前失败。详见 [`contracts/README.md`](../../contracts/README.md)。

## 接管之后：在 Todofy 对账

Mail Hero 的“已交付”只表示 Todofy 已把事件提交到 D1。之后的摘要、Todoist 失败不回写 Mail Hero，也不出现在 Mail Hero 的提醒里。

- owner 在 Todofy UI `https://todofy.ziyixi.science` 处理（Cloudflare Access 保护整个主机，网关另行验证 JWT；写操作需 CSRF 与 `action_request_id`）。`/attention` 列出需要处理的事件：`failed_summary`、`todo_unknown` 立即列入，其他进行中状态超过 6 小时列入。
- 事件详情只显示该事件允许的动作：`task_created`（填入 Todoist 任务 ID）、`task_not_created`（先查找页脚，找不到才重发冻结请求，可能重复建任务）、`retry_summary`（`failed_summary`，`mail_needs_review` 除外）、`dismiss`（事件变为 `ignored`，不检查 Todoist）。每个动作对所见 version 做比较交换。
- Mail Hero 标记 `needs_review` 的邮件被接管后停在 `failed_summary / mail_needs_review`，不调用 Gemini、不建任务。
- `TODOFY_REMINDER_ENABLED=true` 时，有 attention 事件的每个 UTC 日最多创建一条 Todoist 提醒任务，标题 `[Todofy System] Mail Hero：N 封邮件需要处理`，正文只列事件 ID、状态、错误码和收到时间（最多 20 条），并指向上面的 `/attention` 页面。
- 旧的 BasicAuth `/api/v1/mail_inbox` 接口和 `X-Todofy-Admin-Action` header 已不存在。
- Mail Hero 目标页的“发送测试事件”会真实 POST 到 Todofy。Todofy 不区分测试事件，会像普通邮件一样摘要并创建 Todoist 任务。

## 暂停投递

先决定要在哪一侧停：Mail Hero 侧停止发送，事件留在 Mail Hero；Todofy 侧照常接收（或让 Mail Hero 重试），事件留在 Todofy D1。

| 开关 | 位置 | 效果 |
| --- | --- | --- |
| 目标暂停 | Mail Hero 目标页 | 只停止发往该目标；收件、解析、归档继续，事件在 Mail Hero 等待 |
| 暂停投递（`send_paused`） | Mail Hero 设置页 | 停止所有消费者投递，其他同上 |
| `FORCE_SEND_PAUSED=true` | GitHub variable `MAIL_HERO_FORCE_SEND_PAUSED` + Mail Hero 发布 | 部署级强制暂停，UI 无法解除；同步 GitHub variable，否则下次发布会覆盖 |
| `TODOFY_PROCESSING_PAUSED=true` | Todofy GitHub variable + Todofy 发布 | 仍回 204（Mail Hero 显示已交付）；不做摘要、任务和每日提醒 |
| `TODOFY_FORCE_PAUSE_TODOIST=true` | 同上 | 仍回 204；摘要继续，事件停在 `summarized`，不建任务、不发提醒 |
| `TODOFY_MAINTENANCE_MODE=true` | 同上 | webhook 回 503 + `Retry-After: 600`，Mail Hero 持久退避重试；owner 写入被拒，alarm 停止 |

- 暂停和阻断都不延长 Mail Hero 的重试窗口（自动 7 天、手动 30 天，见合同）；超过窗口的事件转为失败，需在窗口内手动重试。Todofy 维护会消耗重试次数，预计较长时先在 Mail Hero 暂停目标。
- 不要用 Mail Hero 的 `MAINTENANCE_MODE` 暂停投递：它同时停止入站、管理写入和 Alarm。
- Todofy 每周备份期间 webhook 照常接收，不需要暂停 Mail Hero。

## 发布

两个应用都由根目录 `.github/workflows/ci.yml` 发布：`Mail Hero deploy` 只在 `mail-hero/` 改动时运行，`Todofy deploy` 只在 `todofy/` 改动时运行，两者共同编译进的鉴权包 `packages/edge-auth/` 改动时两者都发布，都等待 `CI gate`（`main` 的 required check）；只改 `contracts/` 时两边重新检查但都不发布。详见根 [README](../../README.md) 与 [CI/CD](ci-cd.md)。

## 切换记录（2026-09-29 UTC）

Mail Hero 的目标配置没有改动：目标仍是 `https://daily.ziyixi.science/hooks/mail`，Bearer 认证值不变。

- 07:49–08:10：停止旧 Go 容器，离线制作一致快照并导出旧数据（`mail_events` 142 行：complete 141、ignored 1；summaries 13,263；legacy_mail_text 13,262，SQL 约 44 MB；0 warnings）。先用真实导出在本地 D1 演练，`verify_d1` 全表通过；再导入远程 D1 `todofy`，`verify_d1 --remote` 每张表 PASS。D1 Free 每天账户共享 10 万行写入（Mail Hero 同样使用），导入含索引约 7.5 万行，因此当天只做了一次远程导入。
- `daily.ziyixi.science` 由 owner 删除 Tunnel CNAME 后改为 Worker `todofy` 的 Custom Domain（当时 `todofy` 还是单个 Python Worker，当天稍后由 TypeScript 网关替换，域名随脚本保留），anycast IP 不变。
- 生产冒烟（真实认证值）：webhook 依次得到 401/415/413/400/204/204（重放）/409，通过。冒烟不覆盖 503 路径。
- Mail Hero“发送测试事件”经真实 Worker 到 Worker 路径到达 Todofy 并 `complete`。真实邮件也已完成，例如事件 `e4a57d8e…`（13:55，经 TypeScript 网关）和 `b3407aca…`（19:29，网关经 RPC 调用 DO）。当天 Todofy 内部从单个 Python Worker 拆为 TypeScript 网关 + Python core，随后改用 RPC；对 Mail Hero 的响应合同不变。
- 旧栈已退役：容器与镜像、Compose 配置块（self-host-on-vultr `00f23f8`）、数据目录和 env 文件均已删除；快照保留在主机 `~/todofy-legacy-2026-09-29`，至 2026-10-29。旧 CloudMailin 接口已随 Go 服务删除；来源邮箱的转发设置本文未核实。
- 单仓库 `55d2d40` 起两个应用都从 `ziyixi/todofy` 发布；Mail Hero Worker 版本 `fc04e12b` 于 21:08 从单仓库部署。原 `ziyixi/mail-hero` 仓库的 workflow 已停用，备份收集器镜像改为发布到 `ghcr.io/ziyixi/mail-hero-backup-collector`。

尚未验证：两个应用共用 Free 额度的一周用量核查（Workers、DO、D1 读写）；Todofy 侧的 newsletter 首次经 RPC 的定时运行和首条 `daily_metrics` 记录。Mail Hero 自身的验收证据见 [验收记录](verification-native.md)。
