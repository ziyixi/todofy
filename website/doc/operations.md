# 网站发布与恢复手册

本手册描述仓库已经落下的离线 CI/发布骨架，以及把它连接到真实 GitHub、Vercel、Notion 和域名之前必须完成的人工核对。它不是“已经上线”的记录。

当前边界：本地目录尚未连接可验证的 GitHub 仓库或 Vercel 项目；本轮没有读取账号、调用 GitHub/Vercel API、修改 DNS、绑定域名或部署。`ziyixi.science` 的实际托管、apex/www 指向、证书、邮件 DNS 记录、Vercel 套餐与 Deployment Protection 设置都未验证。Notion 数据源也未连接；仓库当前正式内容模式为 `empty`。

## 工作流现状

### PR checks

`.github/workflows/pr-checks.yml` 仅由 `pull_request` 触发，权限是 `contents: read`，不注入 Notion 或 Vercel 凭据。它在 Node 24 上使用 `package.json` 固定的 pnpm，并执行 `pnpm install --frozen-lockfile`。

检查分为三条可见门禁：

- 无密钥的 format、lint、typecheck、unit checks；
- 显式 `empty` 内容准备、校验、生产构建和本地 Playwright E2E；
- 显式 `fixture` 内容准备、校验、生产构建和本地 Playwright E2E。

两种内容矩阵还会启动本地 `next start`，以 production auth 模式运行与正式发布相同的 deployment contract。`fixture` 只有在 `127.0.0.1`、无 bypass secret 且显式设置一次性测试开关时才允许；正式 verifier 仍拒绝 fixture。移动项目使用 Chromium 的 Pixel 描述符，与 CI 仅安装 Chromium 的设置一致。

`fixture` 是合成测试数据，不来自旧 CUDA 博客，也不证明真实 Notion 权限或文章块已经验收。工作流使用 `pull_request`，不使用 `pull_request_target`。

### Production release

`.github/workflows/production-release.yml` 目前只有 `workflow_dispatch`。刻意没有 `push` 或 `schedule`：真实仓库、项目、保护设置、域名与恢复演练完成前，不得开启自动发布。

正式流程取得单一 concurrency lock，锁内读取最新 `main`，然后依次：

1. 校验手动操作、`main`、确认短语、目标 ID 和受保护环境配置；
2. 读取 GitHub Deployment 状态门禁与最近的真实生产登记表；
3. 运行无密钥检查，并按 `content/site.config.ts` 的 `empty` 或 `notion` 显式准备一次快照；普通 release 的完整身份没有变化时在这里正常结束，不构建、不部署、不写新的成功记录；
4. 拉取已核对的 Vercel production project，拒绝把 Notion 凭据留在 Vercel 环境；
5. 只执行一次 `vercel build --prod`，再用 `vercel deploy --prebuilt --prod --skip-domain` 上传同一产物；
6. 先对 candidate URL 做无凭据负向探测，确认返回 401/403；随后才用 automation bypass 核对 deployment ID、`build-info`、重定向目标、媒体 hash/类型、RSS/sitemap、预期 404 与浏览器部署测试；
7. 写入 `in_progress` GitHub Deployment 记录，再次确认 `main`、candidate、旧 production ID 与状态；
8. promote 已记录的同一个 candidate；若 CLI 超时，持续读取目标项目经认证的 `lastAliasRequest`，直到该次 promote 进入终态，再核对正式域名的 deployment ID，不能把超时当成已取消；
9. 在公开 `SITE_URL` 上不带 bypass secret 复验；成功后才写 `success`；
10. promote 或生产复验失败时，先通过固定 project ID 的 Vercel API 状态等待所有 pending promote/rollback 完成，再仅尝试恢复切换前记录的明确 deployment ID；rollback 自身超时也必须经同一状态与最终 ID 协调，并把本次记录保留为 `failure`/`error`。

生产入口通过 `scripts/release/prepare-production.sh` 读取仓库配置；`fixture` 会被明确拒绝，不能因 Notion 缺密钥或同步失败而回退到 `empty`。普通 release 可勾选 `force_build` 绕过无变化提前结束；bootstrap 与 recovery 本来就始终重建、重测。

GitHub Actions 中使用的 action 已固定到完整 commit SHA，并在旁边注释上游 release 版本。升级 action 时应通过单独 PR 核对上游 release 与 SHA，不把浮动的 `@main` 或 `@vN` 放进发布工作流。

## 首次启用前的配置

### GitHub production environment

创建名为 `production` 的 GitHub Environment。建议启用 required reviewer，并限制只允许 `main`。下列值应在 GitHub 正规设置页面配置；不要发送到聊天、提交到仓库或写进 Actions 日志。

Environment secrets：

| 名称                              | 用途                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                    | CI 调用固定版本 Vercel CLI/REST API；权限仅覆盖目标 scope/project           |
| `VERCEL_ORG_ID`                   | 不可变的 `team_...` 或 `user_...` scope ID                                  |
| `VERCEL_PROJECT_ID`               | 不可变的 `prj_...` project ID，不使用显示名称                               |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 只用于明确 candidate origin 的自动化测试 header                             |
| `NOTION_TOKEN`                    | 仅在正式模式是 `notion` 时需要；read content，且只共享专用 Blog data source |
| `NOTION_DATA_SOURCE_ID`           | 仅在 `notion` 模式需要；不得输出到公开页面或 artifact                       |

Environment variables：

| 名称                 | 用途                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `SITE_URL`           | 已确认的 HTTPS canonical origin，必须与 `site.config.ts` 完全一致 |
| `NOTION_API_VERSION` | `notion` 模式使用，必须与仓库固定值一致                           |
| `BOOTSTRAP_APPROVAL` | 仅首次迁移临时设置为完整 `SITE_URL`；完成后删除                   |
| `RECOVERY_APPROVAL`  | 仅人工恢复临时设置为完整 `SITE_URL`；恢复后删除                   |

内建 `GITHUB_TOKEN` 只给 `contents: read` 与 `deployments: write`，不授予代码写权限。工作流不上传 `.vercel/`、含密钥 env、原始 Notion 响应或私有诊断为 artifact。

仓库必须提交 `pnpm-lock.yaml`。`package.json` 还必须保留 Node 24、固定 `packageManager`，并提供以下命令契约：

```json
{
  "test:deployment": "对 DEPLOYMENT_BASE_URL 跑候选/生产 HTTP 与 Playwright 验收",
  "release:promote": "bash scripts/release/promote.sh",
  "release:rollback": "bash scripts/release/rollback.sh"
}
```

其中 `test:deployment` 应是实际测试实现，不能递归调用 `verify-deployment.sh`。它必须读取 `DEPLOYMENT_AUTH_MODE`，candidate 模式只把 `VERCEL_AUTOMATION_BYPASS_SECRET` 发给 `DEPLOYMENT_BASE_URL` 同源请求；production 模式不得带该 secret。

内容准备必须生成：

- `.generated/release/build-info.json`：从已完成 manifest 与锁定 SHA 生成的预期身份；线上 `/build-info.json` 必须只返回同一组 `codeSha`、`contentHash`、`configHash`、`schemaVersion`，并带 `Cache-Control: no-store`；
- `.generated/content/registry.json`：带 `registryVersion` 的脱敏累计登记表，不含正文、原始 Notion ID、签名 URL或凭据；`content:validate` 与发布 payload 都会要求它和 manifest 的 `candidateRegistry` 深度一致；
- 本次构建消费的已完成快照与内部 manifest。

### Vercel 项目

连接前逐项核对：

- `VERCEL_ORG_ID` 与 `VERCEL_PROJECT_ID` 确实属于预期账号和项目；
- 项目使用 Node 24，production 配置与本地 contract 一致；
- [Rolling Releases](https://vercel.com/docs/rolling-releases) 必须关闭；当前发布与恢复按原子 alias move 设计，受保护工作流会在开始时及每次状态协调时通过 Project API fail-closed 拒绝启用该功能的项目；
- `vercel.json` 的 `git.deploymentEnabled: false` 生效，所有 Git 分支都不会旁路 Actions 自动上线；
- Deployment Protection 为 Standard Protection + Vercel Authentication：生成的 deployment URLs 受保护，正式域名公开；
- automation bypass secret 可用于 candidate，且不会写入 URL、截图或报告；
- Vercel 项目环境中没有 `NOTION_TOKEN` 或 `NOTION_DATA_SOURCE_ID`。同步只发生在 GitHub 的内容准备步骤；
- 套餐实际支持的 rollback 范围已确认。Hobby 只能保证回到紧邻的上一 production deployment，不能承诺任意历史版本。

先在不拥有正式域名的测试项目完整演练 candidate、promote、公开验证、失败回退和 GitHub Deployment 状态写失败。演练成功不等于正式域名已可迁移。

### Notion

保持 `blogSource: "empty"` 时，正式发布不访问 Notion，缺少 Notion secrets 是正常状态。

切到 `notion` 前，用户需在正规 Notion 界面创建 internal integration，只启用 Read content，并只共享专用 Blog data source。至少用一篇真实长文验收 schema、分页、嵌套块、媒体、站内链接和撤稿；fixture 不能替代这个验收。API 版本、data source ID、权限、从非空变全空的确认机制都未在本轮验证。

任何 401/403、schema 变化、不完整分页、未知必要块或媒体下载失败都必须停止发布并保留现网；不得临时改成 `empty` 使流水线变绿。

若可信 baseline 曾有文章、而本次 Notion 的公开集合确实要变成零篇，手动运行时才可勾选一次性的 `allow_empty`，并把确认短语写成 `operation:<canonical-host>:allow-empty`。该开关只放行“非空变全空”这一项，不能绕过权限、schema、分页、媒体或正式内容模式检查；`empty` 模式和 bootstrap 使用该开关会被拒绝。

## GitHub Deployment 状态门禁

所有本站记录使用 `task=website-release`、`environment=production`、固定 commit SHA 与 `auto_merge=false`。payload schema v2 只保存发布身份、candidate/旧 production ID、workflow URL、脱敏 `contentRegistry`，以及供旧版本回退复验使用的 canonical origin、内容模式、空态文案和路由合同。

- 普通 `release`：最新记录必须是 `success`，且其 deployment ID 与公开生产 `build-info` 都匹配；否则停止。
- `bootstrap`：必须完全没有本站 Deployment 记录，并使用显式空登记表开始；不能伪造首条 success。
- `recovery`：最新记录必须不是 `success`。工作流先等待 Vercel pending mutation 结束，再把当前正式 deployment 与阻断记录及较早 success 对照。若当前仍是较早 success，就以它为 baseline；若当前正是状态停在 `in_progress` 的新 candidate，则必须重新验证其 immutable deployment ID、完整 build identity 和记录中的路由合同，并成功重试该记录的 `success` POST 后，才能把它提升为可信 baseline。`failure`/`error` 记录不能走这条协调捷径。随后 recovery 仍重新构建、重新测试，不因身份相同提前退出。
- `in_progress` 长时间未结束、状态缺失、API 读取失败、payload 超限或 schema 不兼容都按阻断处理。
- 无变化或过时候选不得写一个新的 success 来覆盖故障状态。

如果 GitHub 最终 `success` 状态写入失败，即使 Vercel 看起来已经上线，也要保持阻断。使用 `operation=recovery` 后，由受保护工作流执行上述协调：等待 pending mutation、核对公开域名实际 ID、用阻断记录中的 identity 与 verification contract 完整复验，再重试同一 GitHub Deployment 的 success 状态。任何一步不能证明一致都会停止；不要在 GitHub UI 直接把状态改绿。

## 日常手动发布

在 Actions 中选择 `Production release`，ref 只能是 `main`：

1. `operation=release`；
2. confirmation 填 `release:<canonical-host>`，例如 `release:www.ziyixi.science`；
3. 一般保持 `force_build=false`、`allow_empty=false`；只有明确原因才使用前述受控输入；
4. 核对候选测试、Deployment record 与正式域名复验全部成功；
5. 若流程报告 main 已前进，不要 promote 旧候选，重新触发即可。

当前没有定时同步。未来真实 notion 发布与恢复演练稳定后，才可用单独 PR 增加避开整点的 schedule；`empty` 模式定时事件应直接正常跳过。增加 schedule 时仍必须复用同一 concurrency group 和相同门禁，不能另建绕路部署。

## Bootstrap：首次接管正式域名

Bootstrap 不是普通第一次点击。执行前必须完成并留存：

1. 只读盘点旧托管、apex/www、DNS、TLS、邮件记录、全部需处置的旧 URL；
2. 明确 canonical origin、旧 URL 决策表和旧站保留位置；
3. 写出可实际执行的旧站恢复步骤，包括负责人、控制台位置、原 DNS/域名项目归属和验证命令；
4. 在测试项目演练发布与失败回退；
5. 按目标 Vercel 项目的当期指引准备域名，不能使用文档里写死的 IP；
6. 确认 candidate 已在受保护 URL 上通过真实内容验收。

域名绑定、跨项目转移和 DNS 修改仍是人工受控操作，本工作流不会替用户修改它们。只有目标域名已处于可以由该 Vercel 项目 promote 的状态、且旧站恢复操作随时可执行时，才临时设置 `BOOTSTRAP_APPROVAL=SITE_URL`，选择 `operation=bootstrap`，并填写 `bootstrap:<canonical-host>`。

首次项目没有可依赖的同项目旧 deployment。bootstrap promote 后正式核验若失败，工作流会记录 `error`，但跨项目/旧托管恢复必须按预先写好的域名方案人工执行。恢复后保留失败记录，并用 recovery 建立经验证的成功状态；不要删除失败记录来解锁。

## Recovery 与 rollback

当最新 website-release 状态为 failure、error、缺失或长期 in_progress 时，普通 release 会停止。先判断实际线上状态：

- 生产已经恢复到旧 deployment：修复代码/内容/权限后走 recovery；
- 生产仍是坏 candidate：优先恢复记录中明确的 `previousProductionDeploymentId`；
- 生产 ID 已被其他维护者改变：停止自动操作，先协调并重新建立可信状态；
- 首次 bootstrap 跨项目失败：执行旧托管/域名恢复方案，不能假装存在 Vercel rollback ID。

若故障恰好发生在“candidate 已 promote、公开复验已通过、最后 success POST 失败”，不需要先把已经验证的新版本强制切回旧版。设置临时 `RECOVERY_APPROVAL` 后运行 recovery；工作流只会对 `in_progress` 阻断记录尝试受控协调，并在重新证明 deployment ID、身份和完整路由合同后重试原 success 写入。当前 ID 是第三个 deployment、记录已是 failure/error、promotion/rollback 状态无法确认或合同复验失败时，流程保持阻断并要求人工在 Vercel/GitHub 控制台核对，不会伪造 baseline。

自动失败路径调用 `release:rollback` 时会先用固定 `VERCEL_PROJECT_ID` 的认证 API 轮询 `lastAliasRequest`，等待所有异步别名变更结束，再确认 canonical 域名仍指向失败 candidate；若已经稳定回到已知 good target，则只验证、不重复修改；若指向第三个 deployment，则拒绝覆盖。rollback CLI 返回超时不表示取消，脚本会继续读取平台任务状态并重新读取最终 ID；状态或 ID 无法确认时记录为需要人工恢复。恢复后还要在公开域名上核对旧 `build-info` 和完整部署测试。

修复原因后，临时设置 `RECOVERY_APPROVAL=SITE_URL`，选择 `operation=recovery`，confirmation 填 `recovery:<canonical-host>`。Recovery 运行全套内容准备、构建、candidate 与生产测试，并写一条新的 success；完成后删除临时变量。

不要通过以下方式“恢复”：

- 把 `blogSource` 改为 fixture；
- 跳过 candidate/production tests；
- 选择“最近的 URL”而不核对 deployment ID；
- 删除或伪造 GitHub Deployment 记录；
- 在不确认当前 production ID 的情况下 promote/rollback；
- 把 token 放进命令行日志、URL 或聊天。

## 常见故障定位

| 现象                                    | 处理                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| frozen install 失败                     | 提交与 `package.json` 一致的 `pnpm-lock.yaml`；不要在 CI 改用非 frozen 安装          |
| PR empty 成功、fixture 失败             | 修复合成正文的转换/渲染路径；不能删除 fixture 门禁                                   |
| fixture 成功、真实 Notion 失败          | 核对 integration 分享范围、data source schema、API 版本与真实块；保留现网            |
| 无凭据 candidate 不是 401/403           | 停止发布；核对 Standard Protection、Authentication 与 protection exceptions          |
| 带 bypass 的 candidate 401/403          | 核对 automation bypass secret；secret 只发往已由 API 确认归属的 candidate 同源       |
| build-info 不一致                       | 停止 promote；确认 build、deploy、verify 是否使用同一 `.vercel/output` 与快照        |
| main advanced                           | 丢弃过时候选并重新运行，不覆盖新提交                                                 |
| production 验证失败                     | 查看自动恢复结果与 Deployment failure/error；修复后走 recovery                       |
| latest record 卡在 in_progress          | 同时核对 GitHub/Vercel/公开域名，明确真实状态后走 recovery，不手工写 success 掩盖    |
| promote/rollback CLI 超时               | 不立即判断成功或失败；等待对应 `status`，再核对正式域名 immutable deployment ID      |
| 新 candidate 已上线但 success POST 失败 | 走 recovery 的受控协调；完整复验后重试同一记录，禁止手工改绿或跳过合同               |
| rollback 被拒绝                         | 当前 production 已改变、目标不是历史 success，或套餐不支持；停止并按人工恢复方案处理 |

## 仍未验证、不得宣称完成的事项

- GitHub 仓库、branch protection、Environment reviewer 和 Actions 权限是否已经配置；
- 真实 Vercel project/scope ID、Node 设置、域名保护、bypass 与套餐 rollback 能力；
- `www.ziyixi.science` 或 apex 哪个是最终 canonical、当前 DNS/证书和邮件记录；
- 旧站托管位置、可恢复性与旧 URL 的逐项去向；
- Notion integration、data source、字段 schema、真实文章块和媒体权限；
- production `test:deployment` 对全部公开路由、RSS、sitemap、404、canonical、媒体和代表文章的实际覆盖；
- 首次 bootstrap、状态 API 失败、生产复验失败和跨项目恢复的真实演练。

上述边界由账号与域名持有人在正规控制台确认后，才能把 workflow 的“可离线审查骨架”视为可用的生产发布系统。
