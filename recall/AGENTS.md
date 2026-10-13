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
- **多设备与手机**：独立安装使用自己的设备 ID 和队列；新增的具名上传口令可独立停用，现有共享/Worker secret 口令继续有效。三条机器路由不扩展。Orion 文件包与 Chrome 包共用采集核心；手机按页面可见性采集，不把 API 缺失当作前台证明，不假定 iOS 后台定时运行。正文和截图沿用隐私规则，原生 WebP 不可编码时可用同预算的 JPEG。不增加配对服务或按设备备份。实机未验行为须明确留待 owner，见 `docs/mobile.md`。Orion 采集改动先用现有 WebKit 检查实际构建的 probe/capture、自动 Alarm、IndexedDB、图片和 gzip 消费结果；手写 probe 返回值或仅检查函数调用不能代替这条链路。
- **连接与口令名称**：同名安装只在 UI 折叠，不合并设备 ID 或历史。`DeleteDevice` 只删除无访问、无快照且 `queued_count=0` 的连接元数据；离线时间不能作为删除依据。实际 ingest 可重新登记连接，request ID 重放不能再次删除。`UpdateMachineToken` 只修改显示 label，保留 ID、摘要、创建时间、旧口令宽限期和 Worker secret；不建立口令与设备绑定。
- **Dropbox 备份**：归档由 alarm 写进 owner 自己的 Dropbox 应用文件夹（App folder，`backup.ts`、`dropbox.ts`），NAS
  用自带的 Dropbox 同步，NAS 与 owner 的 Mac 上不运行 recall 的代码。连接只用 App key 与 OAuth 2 PKCE（无 app secret）；
  refresh token 只存在对象里，从不返回、不进日志；回调 `GET /api/dropbox/callback` 在 Access 后面，state 一次有效、15 分钟
  过期，不需要 Bypass。只增不删：从不调用 Dropbox 的删除或移动；blob 用 `add` 写一次，日文件、`VERSION`、`state.json`
  整体覆盖；遇到 429 / `too_many_write_operations` 按 Retry-After 或退避重试；每次 pass 受子请求（40）、墙钟与渲染行数
  约束。改动这些时运行 `test/runtime/archive.test.ts`（假 Dropbox）与 smoke。
- **快照与保留窗口**（owner 2026-10-11）：前台累计 10 秒首次采集，之后复用一分钟 tick 补采；同一次访问的文字未变、截图无明显变化时省略重复快照，不再按天限制。Document 可带可见区域 WebP 或原生 JPEG，复用现有上传、R2 和 Dropbox 归档；
  截图继承正文的站点和密码页排除规则，文字脱敏不处理图片像素。
  `Settings.text_retention_days` 默认 7，7–3650 或永久（不设），同时适用于正文和截图文件。只有页面仍有效、
  Dropbox 已连接且最近一次没有失败、当前连接已确认快照全部 blob 的内容哈希、日期文件已写入并由 state.json 覆盖时，
  才由现有有界清理移出 R2。保留 documents、访问、seq 和搜索索引；索引仍受现有容量预算限制。
  Owner 点开归档快照时用既有 Dropbox 下载能力读取，文件不回填 R2；缺失或断连返回明确原因。
  改动保留、归档或 blob 路由时运行相关既有 retention/runtime/smoke 检查。
- **Workers Free，$0**：不加 cron、D1、KV、Queues 或 Workflows；调度只用 `RecallState`（实例 `recall-v1`）的
  `setAlarm()`。fetch handler 只做路由、鉴权与一次对象调用（10 ms），从不解析上传、搜索或 feed；blob 路由直接读 R2，
  只在 R2 没有对象时才问对象。每日写入预算（20,000 行，之后 429）、每日读取预算（1,500,000 行，之后搜索拒绝；
  feed 在 1,000,000 行停）、索引预算（500 MiB 正文 / 850 MiB 数据库）与搜索的读取上限（`candidates_capped`）只能有意
  调整并在提交中写明原因；改动摄取、存储、搜索或 API 时运行 `test/runtime/cpu.test.ts` 与 `test/runtime/scale.test.ts`
  （两年规模下每条路径读取的行数）；预算（`deploy/bundle-size.mjs`、`web/scripts/js-budget.mjs`）只能有意提高。
- **变更 feed 是公开合同**：`contracts/recall-archive-v1` 由 recall 拥有。feed 是记录行自己的 `seq`（压缩：修订移到新
  seq，删除留下一个 `pages/<id>` 墓碑），`feed_id` 标识 feed，seq 从不复用。本次 owner 明确选择在现有 v1 内追加截图字段与 blob role、取消每日采样限制并将热窗口改为 7 天；
  保留旧字段与历史字节可读，不为未使用的外部消费者增加版本迁移。其余格式变更继续遵循合同。改 IDL 后运行 `proto/` 的 `npm run schema`，
  并让 `proto/test/recall-archive.test.ts`、`worker/test/archive.test.ts`、`test/runtime/archive.test.ts` 与
  `worker/test/smoke/` 一起通过（归档的日文件、`state.json` 与 `VERSION` 逐字节等于合同的 `fixtures/archive/`）。
- **接口**：owner API 是 `proto/recall/ui/v1`，扩展的上传是 `proto/recall/ingest/v1`（扩展只用生成的 wire 类型，
  bundle 里没有 protobuf 代码），feed 是 `proto/recall/archive/v1`；改 proto 时运行 `proto/` 的 lint、api-lint 与 breaking。
  扩展、Worker、UI 与 Dropbox 归档之间的一致性由 `worker/test/smoke/smoke.mts`（`npm run test:smoke`）端到端检查。
- **部署**：Worker 只由 CI 的 `Recall deploy` 经 `deploy/deploy-vars.mjs` 部署；不要手动 `wrangler deploy`，本地开发只用
  `wrangler.test.toml` 与 `recall/.dev.vars`（`DEV_DROPBOX_ORIGIN` 只在本机回环、开发绕过开启时生效）。扩展从不部署：
  CI 构建产物，main 上每个新版本发布为 GitHub Release `recall-extension-v<version>`；agent 下载它，用
  `npm run install-extension -- <zip>` 放进固定文件夹，owner 只做首次的点击（`extension/README.md`）。
  owner 的设置步骤只有点击，不要求 owner 运行命令。
