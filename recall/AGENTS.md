# recall：规则

在 `recall/` 内工作时，除根目录 [`AGENTS.md`](../AGENTS.md) 外还适用以下规则。设计见 [`docs/design.md`](docs/design.md)。

- **浏览记录是 owner 最私人的数据**：仓库和 Actions 日志公开，测试只用 example.com/example.org/example.net 上的合成页面、
  为测试写的中英文文本和合成令牌，从不用真实浏览记录、真实 URL 或 owner 的私人名单。日志、错误与 ops-v1 只记请求 ID、
  计数、状态码与原因码，从不记 URL、host、标题或正文；`observability` 的 invocation logs 与 traces 保持关闭。
- **不记录什么由构造保证**（`docs/design.md` §2、§3.7）：扩展 `incognito: not_allowed`、无静态 content script；recall
  自己的页面从不记录；敏感站点（邮件、聊天与 AI 聊天、银行支付、密码管理、控制台与 API 密钥页、账号页）与 owner 的
  只记网站名单只记站点本身，不记路径与标题；
  不保存正文名单、含密码框的页面没有正文。上传前扩展、到达后 Worker 各用 `shared/` 的同一套代码再清洗与过滤一次，
  旧版扩展也不能绕过。Owner 已定的默认值（2026-10-10）：敏感站点只记站点；Google Docs/Drive 链接保留文档 ID。
  不要改变这些默认值；owner 自己的银行与私人站点只放在 UI 的名单里，从不进本仓库。
- **页面内容不可信**：标题和正文只以纯文本显示（`textContent`，`<mark>` 只包查询词），v1 不保存也不显示 HTML；
  搜索词和运算符由 UI 转成类型化字段，服务器从不解析运算符；FTS5 查询的每个词都写成短语并转义引号。
- **机器路由与令牌**：只有三条精确的机器路由（`POST /api/machine/v1/batches`、`GET …/changes`、`GET …/blobs/<path>`），
  Worker 在请求进入对象业务之前先按各自令牌的 SHA-256 摘要校验（常量时间），其他路径 404、其他方法 405。
  Access Bypass 应用只放行这三条（`infra/access.tf` 的 `recall_machine`），不得扩大。令牌由 owner 在 设置 → 插件口令
  生成（`RegenerateMachineToken`，经 Origin 与 CSRF）：RecallState 只存摘要，令牌只在那次响应里出现一次，从不再返回、
  不进请求日志、不进日志（`tokens.ts`）；重新生成时旧令牌保留 24 小时，泄露时 `revoke_previous` 立即作废，停用即删除。
  Worker 把对象里的摘要在内存里缓存一分钟（被拒的令牌每 10 秒最多再问一次对象）；手工放进 Worker secret 的摘要
  （`INGEST_TOKEN_SHA256` 等）仍然有效，部署不覆盖也不删除（`deploy/test/secrets-kept.test.mjs`）。导出令牌可选：
  Dropbox 备份不需要它。机器令牌从不进入 owner API，Access JWT 也不能代替机器令牌。
- **Dropbox 备份**：归档由 alarm 写进 owner 自己的 Dropbox 应用文件夹（App folder，`backup.ts`、`dropbox.ts`），NAS
  用自带的 Dropbox 同步，NAS 与 owner 的 Mac 上不运行 recall 的代码。连接只用 App key 与 OAuth 2 PKCE（无 app secret）；
  refresh token 只存在对象里，从不返回、不进日志；回调 `GET /api/dropbox/callback` 在 Access 后面，state 一次有效、15 分钟
  过期，不需要 Bypass。只增不删：从不调用 Dropbox 的删除或移动；blob 用 `add` 写一次，日文件、`VERSION`、`state.json`
  整体覆盖；遇到 429 / `too_many_write_operations` 按 Retry-After 或退避重试；每次 pass 受子请求（40）、墙钟与渲染行数
  约束。改动这些时运行 `test/runtime/archive.test.ts`（假 Dropbox）与 smoke。
- **Workers Free，$0**：不加 cron、D1、KV、Queues 或 Workflows；调度只用 `RecallState`（实例 `recall-v1`）的
  `setAlarm()`。fetch handler 只做路由、鉴权与一次对象调用（10 ms），从不解析上传、搜索或 feed；blob 路由直接读 R2，
  只在 R2 没有对象时才问对象。每日写入预算（20,000 行，之后 429）、每日读取预算（1,500,000 行，之后搜索拒绝；
  feed 在 1,000,000 行停）、索引预算（500 MiB 正文 / 850 MiB 数据库）与搜索的读取上限（`candidates_capped`）只能有意
  调整并在提交中写明原因；改动摄取、存储、搜索或 API 时运行 `test/runtime/cpu.test.ts` 与 `test/runtime/scale.test.ts`
  （两年规模下每条路径读取的行数）；预算（`deploy/bundle-size.mjs`、`web/scripts/js-budget.mjs`）只能有意提高。
- **变更 feed 是公开合同**：`contracts/recall-archive-v1` 由 recall 拥有。feed 是记录行自己的 `seq`（压缩：修订移到新
  seq，删除留下一个 `pages/<id>` 墓碑），`feed_id` 标识 feed，seq 从不复用。v1 内只做兼容的新增（可选字段、新 kind、
  新 blob role）；其他改动是 `recall-archive-v2`（新路由、新 `VERSION`）。改 IDL 后运行 `proto/` 的 `npm run schema`，
  并让 `proto/test/recall-archive.test.ts`、`worker/test/archive.test.ts`、`test/runtime/archive.test.ts` 与
  `worker/test/smoke/` 一起通过（归档的日文件、`state.json` 与 `VERSION` 逐字节等于合同的 `fixtures/archive/`）。
- **接口**：owner API 是 `proto/recall/ui/v1`，扩展的上传是 `proto/recall/ingest/v1`（扩展只用生成的 wire 类型，
  bundle 里没有 protobuf 代码），feed 是 `proto/recall/archive/v1`；改 proto 时运行 `proto/` 的 lint、api-lint 与 breaking。
  扩展、Worker、UI 与 Dropbox 归档之间的一致性由 `worker/test/smoke/smoke.mts`（`npm run test:smoke`）端到端检查。
- **部署**：Worker 只由 CI 的 `Recall deploy` 经 `deploy/deploy-vars.mjs` 部署；不要手动 `wrangler deploy`，本地开发只用
  `wrangler.test.toml` 与 `recall/.dev.vars`（`DEV_DROPBOX_ORIGIN` 只在本机回环、开发绕过开启时生效）。扩展从不部署：
  CI 构建产物，agent 用 `npm run install-extension` 放进固定文件夹，owner 只做点击（`extension/README.md`）。
  owner 的设置步骤只有点击，不要求 owner 运行命令。
