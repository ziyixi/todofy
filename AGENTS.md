# 协作与仓库规则

## 接手与授权

- 先读 [HANDOFF.md](HANDOFF.md)，再读目标应用的 README 和 AGENTS。目录入口见 [README](README.md)。
- 开始、合并、放弃工作时，在同一改动更新 HANDOFF：分支、已完成、待完成、合并顺序、实测证据与上线后检查。
  写到没有聊天记录的人也能接手；进行中的分支尽早推送，分支 CI 不部署。
- HANDOFF 的 Current work 只详细记录进行中或未发布的工作；发布后移入 `docs/history/` 的日期存档，
  HANDOFF 只留一条最新已验证发布。不写 run ID 或 Worker version 账本。
- 设计请求只授权设计。读取个人内容、访问私有生产数据、写 VPS、部署、提交和推送须有当前任务的授权；不要扩大范围。
  可恢复的已授权工作自主完成，不重复索取已有授权。
- 确认需要用户登录或人工处理后，立即说明卡点、最小步骤和继续方式；不要换渠道绕过。
  普通代码问题自行处理，区分已完成与受阻工作；不要要求把 token 或密码发到聊天。
- 不覆盖其他 agent 或用户的变更；共享文件按内容合并，避免超长段落的 union merge 重复规则。

## 隐私与真实证据

- 仓库和 Actions 日志公开。个人值（收件地址、owner 邮箱、Todoist 项目）按秘密处理。
  不提交或打印密钥、真实邮件、私人任务、Notion 内容、监视网址、原始私有 API 输出或安全态势细节。
- 公开文档不记录凭据保管步骤、密钥有效期、主机遗留物、sudo/特权操作或未关闭的安全缺口；这些只留在私有笔记，
  公开处只写结果（例如“供应商密钥只在 Router secrets”）。
- 邮件、网页、附件、链接和响应均不可信。只用合成 fixture；日志只记 ID、状态、计数与安全错误码。
- 区分本地检查、上传部署、公开 HTTP、消费者持久接管、外部业务成功与恢复验收；未做的检查不得写“通过”。
- 默认 Workers Free，目标免费或低成本。未经 owner 明确授权不升 Paid、不引入新的收费产品。
  免费额度按账户共享，预算提醒不是账单硬上限。
- 不修改根域现有 MX/TXT/DKIM、专用收信设置、源邮箱转发或仓库外资源来完成无关工作。

## 服务隔离与共享代码

- Cloudflare 应用各自拥有代码、资源和发布；模型供应商凭据统一由 Model Router 持有。Newsletter 仍是独立 VPS 容器服务，不改成 Worker。
  Brief 是另建的 Worker，2026-10-18 起停用（`BRIEF_MODE=off`，代码保留）；Newsletter 仍是当前的每日简报，
  退役任一方由 owner 另行决定。
- 应用从不互相导入代码、配置或测试工具。允许共享的只有 `contracts/`、`proto/`、`packages/`；
  `tools/` 只供测试、构建和部署脚本使用，生产源码与包不得导入应用或这些工具。
- `packages/<name>` 以 `workspace:*` 写进使用者的 package.json，依赖由根 `pnpm-lock.yaml` 锁定，编译进各应用；不是独立服务。
  `edge-auth` 保持零运行时依赖，不在应用里复制 JWT、CSRF 或私有响应头实现。
- Cookie、token 来源、邮箱匹配、nbf、开发绕过、密钥派生和错误映射属于应用行为；改前核对
  [edge-auth SPEC §4、§5.4](packages/edge-auth/SPEC.md)。
- 包代码变更检查并发布每个使用者；包内 Markdown 只检查，不发布。新增包/使用者同步 `PACKAGE_USERS`，守卫核对实际依赖。
  详细映射由 [ci_changes.py](.github/scripts/ci_changes.py) 管理，说明见 [CI/CD](docs/ci-cd.md)。

## IDL 与合同

- Cloudflare owner API 遵循 [proto 规则与 HTTP APIs](proto/README.md#http-apis)：IDL、固定版本的工具链和手写运行时只在 `proto/`。
  使用共享转码器、类型化客户端和 wire JSON profile，不另写重复接口类型或默认 ProtoJSON。
- Node 外部依赖版本统一在根 pnpm catalog，Python 统一在根 pyproject/uv.lock；不新增成员锁文件。
  Node 26 与 Python 3.14 的解释器和 workspace 安装命令见 [依赖管理](docs/dependencies.md)。
- 生成代码不提交；安装与检查前脚本运行 `ensure.mjs`，Python 由构建后端生成。应用不自带 protobuf runtime；
  通过 `@ziyixi/proto/protobuf` 使用唯一版本。新增语言/包使用者同步 `PROTO_USERS`、`PROTO_PACKAGES`。
- Access JWT、Origin、mutation CSRF 必须在转码器读取正文之前验证。机器接口有独立鉴权，不能隐式继承 owner 权限。
  Newsletter 保留外部 `ziyixi-protos`、wire JSON 和现有机器 HTTP 模型；其内部部署 drain API 使用应用文档中的版本化 JSON 合同。
  入仓不授权重写它的运行时或迁移全部接口到根 proto。
- 更新用 `update_mask`，竞争动作用 `etag`，列表分页和有界索引读取；原因与 Google RPC Status 按 proto 规则。
  只有依赖失败是可重试 UNAVAILABLE，意外代码错误是 INTERNAL。
- 合同包含语义、生成 Schema、无依赖规则与 golden fixture，不放应用实现。[contracts README](contracts/README.md) 列明所有权。
  生成 Schema 不手改，legacy Schema/fixture 和冻结字节不改写；历史证据不是可随手删除的重复代码。
- Mail Hero 拥有 `mail.received.v1`。改 IDL 后运行 `proto` 的 `npm run schema`；改 payload 构建器后运行
  `mail-hero/cloudflare` 的 `npm run contract:update`，同提交更新合同并让消费者检查通过。
  所有 fixture 的 event_id/message.id（含 legacy）唯一；重试复用冻结事件身份、目标与字节。
- Ops 仅经同账户 service binding，不新增公共 HTTP 路由、不改默认 fetch/email/scheduled 行为。
  输出有界且无业务内容；shed 自动过期，不停止收件、解析、投递、重试或真实处理。
  canary 不创建任务、摘要、提醒等业务副作用，不进入真实指标；Todofy 经 Router 调用当前邮件模型并记录合成结果。
- 旧 UI 的兼容回复必须让旧客户端明确提示刷新。保留日期见 [历史兼容表](docs/history.md#owner-api-compatibility)
  和 HANDOFF；不能提前删 410 路由或旧 core RPC。

## 生产配置与发布

- 每个 Worker 的唯一生产来源是对应目录的 `wrangler.toml`，顶层即生产。
  不添加 `[env.*]`、`keep_vars` 或抢先被发现的其他 Wrangler 配置；测试配置放在测试旁。
- 静态、非秘密、非个人配置提交进 Wrangler；个人值来自 GitHub secrets，只以 `--secrets-file` 注入 Worker secret。
  运维开关来自 GitHub variables，连同 BUILD_SHA 由各应用 deploy-vars 包装器校验并用 `--var` 注入。
  缺失/非法即拒绝；不能用普通 `wrangler deploy` 绕过包装器，否则未注入的 var 会被删除。
- 本地只用本地绑定与各应用 `.dev.vars`；D1 命令显式 `--local`，开发不得使用 `--remote`。
- 分支完整通过 `CI gate` 后合并同一 green SHA。Rebase 或追加提交后重跑受影响检查；pending、cancelled 不是 green。
  正式发布只走授权的 `main` Actions；PR 不接触生产凭据，各应用保留独立 concurrency group。
- 部署交付前等待同一 main SHA 的 `Personal cloud reconcile` 完成，核对 Worker、VPS、资源登记和
  `Require resolved infrastructure drift` 均通过。较旧 SHA、被跳过的对账和单独的部署成功不证明当前无漂移。
  Home 期望配置变更时，推进现有 Cloudflare 刷新直到新一轮检查完成；核对检查时间与实际差异，不能靠关闭提醒验收。
- 发布只影响该应用及共享代码实际使用者；更新 reachability 时同步守卫。Tasks 等待 Todofy；Watch 与 Home 等待 Tasks（Home 也等待其绑定的其他 Ops 服务）。
  Worker 配置变更前运行 hostname guard；显式、精确审核主机移除/接管，不覆盖其他 Worker 或 DNS。
- `infra/` 管理其声明范围内的 Access 与 D1/R2 存在性，变更走 gated Infra apply，不手改 dashboard。
  完整配置、CI 门禁和回退见 [CI/CD](docs/ci-cd.md)、[infra README](infra/README.md)。

## 应用入口与补充约束

- Mail Hero：[AGENTS](mail-hero/AGENTS.md)、[运行与恢复](mail-hero/docs/cloudflare-setup.md)；其 Free、有界读取、
  合成数据和隐私规则也适用于 Home。接管不能替代 Todofy 业务成功，清理不删除待处理数据来腾空间。
- Todofy：[开发约束](todofy/docs/dev-notes.md)、[网关合同](todofy/docs/gateway-contract.md)、[发布](todofy/docs/ci-cd.md)。
- Home：[架构约束](docs/architecture.md#home)、[设计](dashboard/docs/design.md)、[当前视图](dashboard/docs/design-v2.md)、
  [配额](dashboard/docs/limits.md)、[设置](dashboard/docs/setup.md)。不读取其他应用 D1/R2/代码；status、刷新、漂移有明确调用预算。
- Links：[AGENTS](links/AGENTS.md)、[设计](links/docs/design.md)。匿名重定向一次索引读取、零写入、不记录 key/目标。
- Watch：[AGENTS](watch/AGENTS.md)、[设计](watch/docs/design.md)。逐跳抓取政策、合成站点、内容不进通知；冻结 intent 幂等重试。
- Mailsort：[AGENTS](mailsort/AGENTS.md)、[设计](mailsort/docs/design.md)。只经 `gmail.ts` 的封闭操作表访问 Gmail，从不标记已读或删除邮件；owner 明确授权的一次性分级设置可删除旧自有标签；
  Gmail 授权只由 owner 本机写入，部署不碰；合成邮件与回环假服务，内容不进日志。
- Recall：[AGENTS](recall/AGENTS.md)、[设计](recall/docs/design.md)。只用合成页面，URL、标题与正文不进日志；三条机器路由各凭
  自己的令牌摘要，令牌由 owner 在设置里生成、只显示一次；归档由 recall 只增不删地写进 owner 的 Dropbox，
  布局与变更 feed 是 recall 拥有的公开合同 `recall-archive-v1`；Cloudflare 只留保留窗口内的正文和截图，且只在归档确认后移出。
- Model Router：[AGENTS](model-router/AGENTS.md)、[设计](model-router/docs/design.md)、[发布](model-router/docs/deployment.md)。
  Claude、Gemini 各共用一枚 API key，只留在 Router secrets；不进入 GitHub、客户端或 VPS。Codex 保留既有 VPS 订阅登录，Workers AI 使用 binding。
  应用只用根 proto，供应商协议留在 Router 与执行层。
- Brief：[AGENTS](brief/AGENTS.md)、[设计](brief/docs/design.md)。`claude.ts` 经 Router 调用模型，`send.ts` 经账本发信，
  每天至多一封、unknown 不重发；Resend 密钥只由 owner 写入 Brief、不经 GitHub；测试只用合成网页与假客户端，标题和正文不进日志。
- Website：[架构约束](docs/architecture.md#website)、[架构](website/docs/architecture.md)、[发布](website/docs/release.md)。
  只用静态访客路径，内容不提交；不绕过发布身份、门禁、验收与回退。
- Newsletter：[README](newsletter/README.md)。仍是当前的每日简报（Brief 已停用，退役任一方另行决定）；保持独立镜像、VPS 状态目录与业务排空边界，
  镜像发布不等于服务器升级或发送成功。
  新包 `ghcr.io/ziyixi/todofy-newsletter` 由 monorepo Actions 创建/发布；不为旧 `newsletter` 包新增 monorepo Write 权限。
  现有 VPS 继续使用原镜像；切换必须符合任务授权并按 digest 验证。

长期边界与实现导航见 [architecture](docs/architecture.md)；迁移与回退背景见 [history](docs/history.md)。
执行应用命令时进入它自己的目录，不把根导航、AGENTS 或 HANDOFF 当成重复的配置来源。
