# watch：规则

在 `watch/` 内工作时，除根目录 [`AGENTS.md`](../AGENTS.md) 外还适用以下规则。设计见 [`docs/design.md`](docs/design.md)。

- **Workers Free，$0**：不开启任何付费产品，不添加 cron、D1、KV、Queues 或 Workflows。`WatchState`（实例 `watch-v1`）的 SQLite 保存配置、变化和证据索引；有界页面证据与截图只保存在私有 `EVIDENCE_STORE` R2 中，调度只用 `setAlarm()`；alarm 出错要捕获并重新设定，每次 API 调用在没有 alarm 时补设。
- **CPU 与预算**：fetch handler 只做 Access、CSRF 和一次对象调用（每请求 10 ms）；其余工作都在对象中（每次调用 30 s）。每次 alarm 至多 40 个外部请求、24 MiB 正文、8 分钟。页面文字不可信：掩码与解析的每个重复都要有上界并锚定（对任何字符类的长串都是线性的）。修改抓取、解析或流水线时运行 `test/runtime/cpu.test.ts`，预算只能有意提高并在提交中写明原因（`deploy/bundle-size.mjs`、`web/scripts/js-budget.mjs`）。
- **SQLite 行数也是预算**：Workers Free 下整个账户的 SQLite Durable Object 每天 500 万行读、10 万行写（与 Mail Hero 共享）。按 watch 的查询必须走能限定范围的索引（`changes (watch_id, state, id)`），alarm 只清理本次产生变化的 watch，全局表每小时、所有 watch 每天一次；修改存储或流水线时运行 `test/runtime/rows.test.ts`，并更新 `docs/design.md` §8 的估算。
- **抓取礼节不可放宽**，且每个跳转目标同样适用（同一个 hop gate）：robots.txt 默认遵守（5xx、无应答或被策略拒绝的跳转视为不允许）；每主机同时一个请求（对象内的主机锁，alarm 与预览共用）、请求间隔约 30 秒；遵守 Retry-After 与 429/503 退避，忙碌或退避中的主机只推迟检查、不算失败；同一网址 15 分钟内不再抓（检查与预览都算）；默认只 https；拒绝 IP 字面量、本地后缀、`ziyixi.science` 及其所有子域和本账户的 workers.dev 子域（`url-policy.ts` 的 `OWN_SUFFIXES`）；逐跳检查跳转；2 MB、每个请求 15 秒（计时器必须清除）。从不绕过人机验证页面。分享链接 `/new#u=` 只填入网址，owner 点“预览”前不抓取。
- **浏览器层**（Browser Run）：owner 可用既有 `fetcher = BROWSER` 选择渲染页面并保存截图，HTTP 保持默认；浏览器检查间隔至少 6 小时，保持每日 480 秒的自有账本。保留逐跳政策、主机节流和页面预算，不使用 keep_alive、不绕过人机验证；配额用尽显示为“今日 JS 配额已用完”，从不显示为“无变化”。截图失败与正文失败分别记录，不能伪装成完整证据。
- **隐私**：被监视的 URL、页面文字、选择器和 diff 都是 owner 的个人数据，只在对象与私有证据桶中、经 Access 访问。原始页面 HTML 从不在 UI 执行；页面正文、链接和元数据只按文字显示，截图只显示已保存的图像。日志只记 ID、状态、计数和错误码；`observability` 的调用日志与 traces 保持关闭。
- **测试只用合成数据**：页面来自 `worker/test/fake-sites.ts`（Miniflare 的 outbound service）或本机回环的 `test/runtime/serve-fake-sites.ts`；测试从不访问真实第三方网站，时钟一律注入（`DEV_MANUAL_ALARMS`、`step(now)`、`setClock`）。
- **失败从不等于“无变化”**：健康检查失败都有原因码；检查在抓取后抛出的错误记为 `INTERNAL_ERROR`，同样计入失败并逐步拉长重试间隔；连续 3 次为 BROKEN（每轮失败只进一次每日摘要），14 天自动暂停。每个被抑制的变化都要保存原因；待确认的变化从不被无声丢弃（忽略行、改设置、确认抓取失败都有去处）。
- **私有 MCP**：`WatchApi` binding 只按 `props.access = read/read-write` 开放生成API，默认拒绝；公共转发删除内部标记，事件feed仅binding可读。`intent`供Dots读取，判定留在工作记录，不改Watch基线或自动学习忽略行。`notify_policy = NONE`仍写确认/健康事件，但不创建Tasks或计入投递积压；已有监视不改默认。冻结有界前后文并关联变化前后快照；页面证据按需读取，明确未记录、过期、失败和截断，不能从缺失证据推断无关。截图和页面文字从不进入 Tasks 通知。
- **接口**：owner API 是 `proto/watch/ui/v1`（AIP 风格，经共享转码器与客户端）；改 proto 时运行 `proto/` 的 lint、api-lint 与 breaking。AI 判断只保留接口，不调用模型。
- **部署**：只由 CI 的 `Watch deploy` 经 `deploy/deploy-vars.mjs` 部署（W2 起；在 `Tasks deploy` 之后，本次选中的 Tasks 发布须成功，面板在它之后）；不要手动 `wrangler deploy`，本地开发只用本地绑定。`wrangler.toml` 的 `ACCESS_AUDIENCE` 是 `infra/` 创建的 Access 应用 "watch" 的 AUD，包装脚本仍拒绝全零占位符。部署后 CI 无法看到 alarm 是否已设定，按 `README.md` "Deploy" 手动核对。
- **通知**（`docs/design.md` §7）：只经 `TASKS` binding（Tasks 的只建任务入口 `TaskInbox`，`source = "watch"`）在 Tasks 创建任务；任务只含 owner 起的名称、触发类型、次数与本应用 `/watches/<id>` 链接，从不含页面文字、被监视的 URL 或变化摘要（页面内容不可信，可能针对读任务的助手）。本应用每日至多 10 条任务（紧急至多 9 条，留一条给摘要）；请求连同随机 `request_id` 先在事务中冻结再发送，以同样字节重试，TaskInbox 按 `request_id` 幂等；日志只记行 ID、类型、计数与错误码。
- **备份**（[`docs/backup.md`](docs/backup.md)）：`WatchState` 每天 11:23 UTC 自己把全部表和快照引用的证据对象写入私有 `BACKUPS`（`watch-backups`），保留最新 30 个完整备份；保留策略只在代码里，不用 R2 生命周期规则。新表默认进入备份，只有纯缓存可排除，写进 `EXCLUDED_TABLES` 并在文档说明理由。备份进行中调度与 owner 写入等待（`BACKUP_RUNNING`），空存储不备份。恢复只进空存储，在对象内分步校验每个部分的 SHA-256，先恢复证据再恢复行；完成前拒绝其他写入，不重发旧通知、不重放事件游标。改存储表、证据或备份时运行 `test/runtime/backup.test.ts` 与 `restore.test.ts`，并更新 `docs/backup.md`。
