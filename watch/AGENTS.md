# watch：规则

在 `watch/` 内工作时，除根目录 [`AGENTS.md`](../AGENTS.md) 外还适用以下规则。设计见 [`docs/design.md`](docs/design.md)。

- **Workers Free，$0**：不开启任何付费产品，不添加 cron、D1、R2、KV、Queues 或 Workflows。所有数据只在 `WatchState`（实例 `watch-v1`）的 SQLite 中，调度只用 `setAlarm()`；alarm 出错要捕获并重新设定，每次 API 调用在没有 alarm 时补设。
- **CPU 与预算**：fetch handler 只做 Access、CSRF 和一次对象调用（每请求 10 ms）；其余工作都在对象中（每次调用 30 s）。每次 alarm 至多 40 个外部请求、24 MiB 正文、8 分钟。页面文字不可信：掩码与解析的每个重复都要有上界并锚定（对任何字符类的长串都是线性的）。修改抓取、解析或流水线时运行 `test/runtime/cpu.test.ts`，预算只能有意提高并在提交中写明原因（`deploy/bundle-size.mjs`、`web/scripts/js-budget.mjs`）。
- **SQLite 行数也是预算**：Workers Free 下整个账户的 SQLite Durable Object 每天 500 万行读、10 万行写（与 Mail Hero 共享）。按 watch 的查询必须走能限定范围的索引（`changes (watch_id, state, id)`），alarm 只清理本次产生变化的 watch，全局表每小时、所有 watch 每天一次；修改存储或流水线时运行 `test/runtime/rows.test.ts`，并更新 `docs/design.md` §8 的估算。
- **抓取礼节不可放宽**，且每个跳转目标同样适用（同一个 hop gate）：robots.txt 默认遵守（5xx、无应答或被策略拒绝的跳转视为不允许）；每主机同时一个请求（对象内的主机锁，alarm 与预览共用）、请求间隔约 30 秒；遵守 Retry-After 与 429/503 退避，忙碌或退避中的主机只推迟检查、不算失败；同一网址 15 分钟内不再抓（检查与预览都算）；默认只 https；拒绝 IP 字面量、本地后缀、`ziyixi.science` 及其所有子域和本账户的 workers.dev 子域（`url-policy.ts` 的 `OWN_SUFFIXES`）；逐跳检查跳转；2 MB、每个请求 15 秒（计时器必须清除）。从不绕过人机验证页面。分享链接 `/new#u=` 只填入网址，owner 点“预览”前不抓取。
- **浏览器层**（Browser Run）在 v1 中关闭：生产配置不绑定浏览器。若以后开启，只用 `content`，从不使用 `/json`、`/crawl`、截图或 keep_alive，并保持每日 480 秒的自有账本；配额用尽显示为“今日 JS 配额已用完”，从不显示为“无变化”。
- **隐私**：被监视的 URL、页面文字、选择器和 diff 都是 owner 的个人数据，只在对象中、经 Access 访问。日志只记 ID、状态、计数和错误码；`observability` 的调用日志与 traces 保持关闭。
- **测试只用合成数据**：页面来自 `worker/test/fake-sites.ts`（Miniflare 的 outbound service）或本机回环的 `test/runtime/serve-fake-sites.ts`；测试从不访问真实第三方网站，时钟一律注入（`DEV_MANUAL_ALARMS`、`step(now)`、`setClock`）。
- **失败从不等于“无变化”**：健康检查失败都有原因码；检查在抓取后抛出的错误记为 `INTERNAL_ERROR`，同样计入失败并逐步拉长重试间隔；连续 3 次为 BROKEN（每轮失败只进一次每日摘要），14 天自动暂停。每个被抑制的变化都要保存原因；待确认的变化从不被无声丢弃（忽略行、改设置、确认抓取失败都有去处）。
- **接口**：owner API 是 `proto/watch/ui/v1`（AIP 风格，经共享转码器与客户端）；改 proto 时运行 `proto/` 的 lint、api-lint 与 breaking。AI 判断只保留接口，不调用模型。
- **部署**：只由 CI 的 `Watch deploy` 经 `deploy/deploy-vars.mjs` 部署（W2 起；在 `Todofy deploy` 之后，面板在它之后）；不要手动 `wrangler deploy`，本地开发只用本地绑定。`wrangler.toml` 的 `ACCESS_AUDIENCE` 是 `infra/` 创建的 Access 应用 "watch" 的 AUD，包装脚本仍拒绝全零占位符。部署后 CI 无法看到 alarm 是否已设定，按 `README.md` "Deploy" 手动核对。
- **通知**（W3，`docs/design.md` §7）：只经 `TODOFY` binding 以 task-intent-v1 `SOURCE_WATCH` 发给 Todofy；任务只含 owner 起的名称、触发类型、次数与本应用 `/watches/<id>` 链接，从不含页面文字、被监视的 URL 或变化摘要（页面内容不可信，可能针对读任务的助手）。每个来源每日至多 10 条 intent（紧急至多 9 条，留一条给摘要）；intent 先在事务中冻结再发送，以同样字节重试，按 intent ID 幂等；日志只记 intent ID、类型、计数与错误码。
