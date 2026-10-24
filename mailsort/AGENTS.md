# mailsort：规则

先读根 [AGENTS](../AGENTS.md)、[README](README.md) 和 [design](docs/design.md)。

- **当前行为（2026-10-23 owner 决定）**：四个真实 Gmail 标签 P1–P4。P1 需要及时看或拿不准，打标签并留 Inbox；P2 可等两三天、P3 可等周末、P4 低价值或 FYI，打标签并归档。始终保留原有已读状态。不增加定时搬回 Inbox、提醒或任务创建。
- **模型只判阅读时效**：沿用 Clef/Clef-flash、两次判断、既有置信度和额度；valid none/分歧/低置信度落 P1，不进强制待审。模型错误、超时、预算不足按现有 pending 处理，不能伪装成判断结果。移除模型诈骗/钓鱼问题、可疑分数与可信域门槛，不为金融品牌加例外。Gmail 自己的 Spam 处理不改。
- **每封新回复独立判断**：按 message ID 去重，不因会话以前有标签就跳过新消息。只替换该条新消息已有的本应用优先级，其他标签、星标、已读状态不改。
- **Gmail 封闭表**：只有 `worker/src/gmail.ts` 访问 Google，每个请求先过 `checkRequest`。日常消息写入只增删本应用标签和 INBOX，并对应持久账本。一次性 InitializePriorities 允许 `DELETE /labels/Label_<digits>`，ID 必须属于持久冻结的旧自有标签集合；绝不开放邮件删除、trash、send、filters、settings、forwarding、batchModify 或系统标签删除。修改表同时改独立 fake/table 与拒绝/fuzz 测试。授权仅 gmail.readonly/gmail.modify。
- **一次性替换**：使用现有 owner API、DO 和请求去重，不新建迁移平台。核对旧 ID 与 P1–P4 同名冲突，停新分类，完成已有撤销、取消旧自动写入意图，再移除旧标签。包括隐藏合并身份；未知标签不认领。保留所有邮件、Inbox/已读位置、原始决策和账本。四个新 Gmail ID 读回核对后才开始新分级。中断保留同一进度，404 删除视为已移除。预算内分步，关闭模式与授权继续生效。
- **学习**：替换时清除旧例子、可信域、待审、反馈和回放，刷新例子缓存；旧决策与合并映射不能重新产生例子或进入发件人历史。`priority_started_at` 是新学习和无历史回填的边界，原始旧预测不改写。新 Gmail 纠正继续学习；回放只用新体系已回答样本，遵守当时证据边界，预算不变、不写 Gmail。
- **旧接口**：v2 合同保留旧记录可读；初始化后拒绝旧的创建、改名、归档开关、可信域和标签整理操作。`/api/v1` 的 410 RELOAD_REQUIRED 保留到 2026-11-10，见根历史表。旧整理手册只用于历史记录，不是当前操作路径。
- **密钥与隐私**：Gmail 授权只由 owner 本机 `deploy/mint-token.mjs` 写 Worker，不进入 GitHub、CI、聊天或日志。测试只用合成数据、本地绑定与假服务。生产内容不作 fixture；日志及 Ops 只记 ID、计数和安全错误码，不记主题、发件人、正文或标签名。模型只读掩码文本，没有工具。
- **保留期**：决策内容14天、旧待审14天、非内容决策/账本180天、回放7天、计数400天；例子最多2000条，可由 owner 删除。每天清理，包括 off 模式。改操作或保留期，同提交更新网站 `/privacy/mailsort`。
- **免费与性能**：一个 Worker、现有 SQLite DO/Alarm、Workers AI；不加 cron、D1、R2、KV、Queue 或 Workflow。fetch 只做 Access/CSRF 与一次对象调用；每轮最多40外部请求，模型/每日预算/写入上限继续生效。改流水线运行 runtime CPU 测试；不能靠未进入模型路径的绿色测试代替验收，不能暗改预算。
- **接口与 UI**：owner API 用根 `proto/mailsort/ui/v2` 和共享转码器/客户端；新 IDL 做 lint、API lint、breaking/schema 检查。三页：概览、分级、设置；固定四行说明，不加回通用标签配置或安全审阅流程。例子按需加载，不做高频轮询。
- **发布**：分支完整 CI gate 通过后，同一 SHA 经 main Actions 的 Mailsort deploy。保留既有 Gmail secrets、模式、预算和其他服务。部署与真实标签清理、真实新邮件验收分别记证据，不用假服务宣称生产行为已验证。
