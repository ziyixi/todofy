# 全局协作偏好

- 遇到需要用户协助解决的阻碍，例如 GitHub push 权限、登录或人工确认，在确认原因后立即直接询问用户。
- 明确说明卡点、需要用户执行的最小操作（给出具体命令或步骤），以及用户完成后如何继续。
- 不要连续切换工具或渠道尝试解决已确认需要用户介入的权限或登录问题；等待用户协助后再继续受阻步骤。
- 普通代码问题仍自行处理；可继续不受阻且在授权范围内的工作，并清楚区分已完成和待完成事项。
- 不要求用户把 token、密码等密钥发送到聊天中；请用户在本机或服务的正规登录流程中完成认证。

---

# 单仓库

本仓库包含两个独立的 Cloudflare 应用、它们之间唯一的合同，以及编译进各应用的共享代码包：

- `mail-hero/`：Mail Hero 收件箱与通用 webhook。开发、验收与安全边界见 [`mail-hero/AGENTS.md`](mail-hero/AGENTS.md)，在该目录内工作时它同样适用。
- `todofy/`：Todofy，`mail.received.v1` 的独立消费者。说明见 [`todofy/README.md`](todofy/README.md)、[`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md)、[`todofy/docs/ci-cd.md`](todofy/docs/ci-cd.md) 和 [`todofy/docs/cloudflare-setup.md`](todofy/docs/cloudflare-setup.md)。
- `contracts/`：跨应用合同：`contracts/mail-received-v1/`（JSON Schema、说明和 golden payload）与 `contracts/ops-v1/`（两个应用供运维面板调用的 `Ops` 接口：类型、Schema、fixture 与实施计划）。
- `packages/`：共享代码包，目前只有 `packages/edge-auth/`（Cloudflare Access JWT 校验、签名 double-submit CSRF、私有响应头；TypeScript，仅用 Web Crypto，无运行时依赖）。设计与各应用参数见 [`packages/edge-auth/SPEC.md`](packages/edge-auth/SPEC.md)。

单仓库规则：

- 应用之间从不互相导入代码、包、配置或测试工具；共享的只有 `contracts/` 和 `packages/`。应用读取 `contracts/` 的文件、依赖 `packages/` 的包，不读取另一个应用的目录；包从不导入任何应用。`contracts/` 里的共享代码仅限无依赖、按相对路径导入的文件（`ops-v1/ops-v1.ts` 类型与常量、测试用的 `ops-v1/validate.mjs`）；不在其中放运行时逻辑、包或任一应用的实现。
- 包以 `"file:../../packages/<name>"` 依赖写进使用它的应用的 `package.json` 和 lockfile，由该应用的打包器编译进它自己的 Worker；包从不作为独立 Worker、service binding 或单独发布。`packages/edge-auth` 保持零运行时依赖。
- 包的任何改动都会重新检查**并发布**每个使用它的应用（`.github/scripts/ci_changes.py` 的 `PACKAGE_USERS`，`Shared packages` job 运行包自己的检查）。新增包或新增使用者时同步 `PACKAGE_USERS`，`test_ci_changes.py` 会核对它与各 `file:` 依赖一致。
- 鉴权相关的对外行为（cookie 名、CSRF token 格式与密钥派生、邮箱匹配、nbf 宽限、token 来源、开发绕过、错误映射）是各应用传入 `packages/edge-auth` 的参数（SPEC §4）；改一个应用的参数就是改该应用的行为。不要在应用内重新实现或复制鉴权代码。
- 每个应用独立部署：各自的 `production` 发布 job、Cloudflare 资源、D1、密钥和 concurrency group。一个应用的改动不发布另一个应用；只有它们共同使用的 `packages/` 包改动才会同时发布两者。
- Mail Hero 拥有 `mail.received.v1`。改动 payload 构建器时在 `mail-hero/cloudflare` 运行 `npm run contract:update`，把 `contracts/` 的变更放进同一提交；`Contracts` job 必须在合并前证明 Todofy 仍接受每个 fixture。`contracts/mail-received-v1/fixtures/legacy/` 是历史冻结字节，不能改写。
- `contracts/ops-v1/` 定义两个应用的命名入口 `Ops`（service binding，供同账户内的运维面板 Worker 调用；面板以后另建，尚不存在）。改动须保持：不新增公开 HTTP 路由，默认 `fetch`/`email`/`scheduled` 行为不变；`status()` 只用文档列明上限的索引化 D1 读取，输出只含代码、数字、布尔值、时间和 UI 地址，绝不含邮件内容；`shed` guard 自动过期且只推迟可推迟的清理/安全网，不停止收件、解析、投递、重试或真实邮件处理；带 `canary` 标记的 `mail.received.v1` 事件不能引起业务副作用（Todoist 任务、消息、摘要/newsletter 报告、提醒），也不计入真实邮件的列表和指标；Todofy 只做正常的 Gemini 调用与校验并记录金丝雀结果。修改 Schema、类型或 fixture 时两侧测试同时更新，`Contracts` job 必须通过。
- fixture 的 `event_id`/`message.id` 在所有 fixture（含 `legacy/`）中唯一：消费者按 `event_id` 去重，重复 ID 会让 Todofy 的 runtime 测试得到 409。
- 每个应用的命令都在它自己的目录下运行（`cd mail-hero`、`cd todofy`）。CI 见根 [`README.md`](README.md)。
