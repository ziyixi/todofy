# watch：规则

在 `watch/` 内工作时，除根目录 [`AGENTS.md`](../AGENTS.md) 外还适用以下规则。设计见 [`docs/design.md`](docs/design.md)。

- **Workers Free，$0**：不开启任何付费产品，不添加 cron、D1、R2、KV、Queues 或 Workflows。所有数据只在 `WatchState`（实例 `watch-v1`）的 SQLite 中，调度只用 `setAlarm()`；alarm 出错要捕获并重新设定，每次 API 调用在没有 alarm 时补设。
- **CPU 与预算**：fetch handler 只做 Access、CSRF 和一次对象调用（每请求 10 ms）；其余工作都在对象中（每次调用 30 s）。每次 alarm 至多 40 个外部请求、24 MiB 正文、8 分钟。修改抓取、解析或流水线时运行 `test/runtime/cpu.test.ts`，预算只能有意提高并在提交中写明原因（`deploy/bundle-size.mjs`、`web/scripts/js-budget.mjs`）。
- **抓取礼节不可放宽**：robots.txt 默认遵守（5xx 视为不允许）；每主机同时一个请求、页面请求间隔约 30 秒；遵守 Retry-After 与 429/503 退避；同一页面 15 分钟内不再抓；默认只 https；拒绝 IP 字面量、本地后缀和 `ziyixi.science` 及其所有子域；逐跳检查跳转；2 MB、15 秒（计时器必须清除）。从不绕过人机验证页面。
- **浏览器层**（Browser Run）在 v1 中关闭：生产配置不绑定浏览器。若以后开启，只用 `content`，从不使用 `/json`、`/crawl`、截图或 keep_alive，并保持每日 480 秒的自有账本；配额用尽显示为“今日 JS 配额已用完”，从不显示为“无变化”。
- **隐私**：被监视的 URL、页面文字、选择器和 diff 都是 owner 的个人数据，只在对象中、经 Access 访问。日志只记 ID、状态、计数和错误码；`observability` 的调用日志与 traces 保持关闭。
- **测试只用合成数据**：页面来自 `worker/test/fake-sites.ts`（Miniflare 的 outbound service）或本机回环的 `test/runtime/serve-fake-sites.ts`；测试从不访问真实第三方网站，时钟一律注入（`DEV_MANUAL_ALARMS`、`step(now)`、`setClock`）。
- **失败从不等于“无变化”**：健康检查失败都有原因码；连续 3 次为 BROKEN（每轮失败只进一次每日摘要），14 天自动暂停。每个被抑制的变化都要保存原因。
- **接口**：owner API 是 `proto/watch/ui/v1`（AIP 风格，经共享转码器与客户端）；改 proto 时运行 `proto/` 的 lint、api-lint 与 breaking。通知（W3）与 AI 判断只保留接口，v1 不投递、不调用模型。
- **部署**：W2 之前不部署（`CHECK_ONLY`、`UNDEPLOYED`、全零 AUD 占位符）；不要手动 `wrangler deploy`，本地开发只用本地绑定。
