# brief：规则

在 `brief/` 内工作时，除根目录 [`AGENTS.md`](../AGENTS.md) 外还适用以下规则。设计见 [`docs/design.md`](docs/design.md)。

- **仓库公开，只用合成数据**：测试只用合成站点（`synthetic-*.org` 等）、为测试写的中英文文本、合成密钥与假地址，从不用
  真实文章全文、owner 的邮箱或真实密钥。日志、错误与 ops-v1 只记 ID、计数、状态码与原因码，从不记标题、正文、引文、
  URL、密钥或地址；`observability` 的 invocation logs 与 traces 保持关闭。
- **唯一的模型出口**：生成与 embedding 只经 `@ziyixi/model-router-client` 与私有 `MODEL_ROUTER` binding。应用保留 prompts、mode、调度、业务验收与 calls 账本；Router 负责 SDK、厂商参数、缓存协议、fallback、usage 与凭据。调用前按 `worker/src/limits.ts` 的最坏单价预留，成功按返回的实际费用结算，未知消耗保留预留。拒绝、输出上限、partial usage 和贡献模型均走统一合同。
- **密钥**：应用只持有自身 Resend 等业务密钥，模型凭据属于 Router，Brief 与 Mailsort 的 Claude connection 保持独立。`RESEND_API_KEY` 只由 owner 本机写入，部署不覆盖。不要向用户索取密钥。Resend 仍只经 `worker/src/send.ts` 的账本与幂等键，每天至多一封，unknown 不重发。
- **抓取礼貌**（`docs/design.md` §3.3）：诚实的 User-Agent、按 host 的间隔与 Crawl-delay、429/503 退避、arXiv API 每 3 秒
  至多一次；只有点名 `ziyixi-brief` 的 robots.txt 组适用（owner 2026-10-10 的决定，AI 代理规则不适用）；从不绕过
  付费墙或登录，401/402/403 与过短正文回退到 feed 文本并标 仅摘要。抓取的全文只存于对象内、7 天后删除，归档在
  Access 之后。
- **网页与模型输出不可信**：抓取的文本只作数据；模型的回答先经严格读取，再经代码核对每条引文、名称与数字
  （`worker/src/ground.ts`）；邮件 HTML 由代码渲染、转义，无远程资源；来源行来自注册表，从不来自模型。
- **Workers Free 与预算**：不加 cron、D1、R2、KV、Queues 或 Workflows；调度只用 `BriefState`（实例 `brief-v1`）的
  `setAlarm()`，每步遵守 `worker/src/limits.ts` 的子请求、墙钟与崩溃上限。改动抓取、选择、核对或 API 时运行
  `npm run test:runtime`（含 `cpu.test.ts`、`rows.test.ts` 与端到端的 `dry-run.test.ts`：每天恰好一封）；包大小预算
  （`deploy/bundle-size.mjs`）、行数与 CPU 上限只能有意调整并在提交中写明原因。月度预算与 Console 上限之外不新增收费产品。
- **邮件**：`worker/src/render.ts` 的输出由 `test/golden/email-*` 逐字节固定；有意改动渲染时用
  `UPDATE_GOLDEN=1 npx vitest run test/render.test.ts` 重写并审阅差异。
- **接口**：owner API 是 `proto/brief/ui/v1`；改 proto 时运行 `proto/` 的 lint、api-lint 与 breaking。ops-v1 的答案由
  `worker/test/ops-golden.test.ts` 固定字节。
- **部署**：Worker 只由 CI 的 `Brief deploy` 经 `deploy/deploy-vars.mjs` 部署；不要手动 `wrangler deploy`，本地开发只用
  `wrangler.test.toml` 与 `brief/.dev.vars`。Access 应用 `brief` 与 `brief-feedback` 创建并写入 AUD 之前，`brief` 保持在
  `.github/scripts/ci_changes.py` 的 `CHECK_ONLY` 中（`docs/design.md` §18）。Newsletter 的退役另行决定。
- **归档界面**（`web/`）：标题、正文、引文与文档链接都是不可信文本，只以文本设置，链接只接受 http(s)；只请求本源的
  `/api/*`。改动后运行 `web/` 的 lint、typecheck、test 与 build（JavaScript 预算在 `web/scripts/js-budget.mjs`，只能有意调整）。
