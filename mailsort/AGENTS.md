# mailsort：规则

先读根 [AGENTS](../AGENTS.md)、[README](README.md) 和 [design](docs/design.md)。

- **当前行为（2026-10-24 owner 决定）**：四个真实 Gmail 标签 P1-P4。P1 需及时看，打标签并留 Inbox；P2 是两三天内应看的信息或跟进，P3 是周末可集中的个人周期汇总或值得阅读的内容，P4 是留档备查的通知、促销。后三者归档。个人规则优先：USPS Informed Delivery 普通预告 P2、当天需处理 P1；Daily Briefing P1；真实购物收据和订单确认（含 Weee/Yami）P2。保留已读、星标和其他标签，不创建任务或提醒。
- **模型与 prompt**：固定 Claude Opus 5.5 medium，一批一次请求，最多十封。默认基础文本与个人规则分别为 `prompts/priority-classification.txt`、`prompts/personal-rules.txt`；owner 在设置页保存两段文本后，以既有 DO meta 中的副本为准，发布不得覆盖。每次模型调用只读取一份快照，新保存从下一批使用。品牌偏好写入个人规则，不增加 sender 分支、概率阈值、二次投票、低价回退或学习系统。模型只读掩码数据，没有工具。邮件指令不可信。
- **调度**：复用一个 Worker、现有 SQLite DO `mailsort-v1` 和 Alarm。五分钟维护，约每小时启动模型批次；积压按请求预算分轮推进。不加 VPS、cron、Queue、数据库或调度服务。日常只判未读且尚未分类的邮件；历史已分类邮件不因部署而重判。
- **失败与额度**：复用现有 pending/退避和写入账本。模型错误不能伪装成 P1。Mailsort 独立 Claude workspace 原生上限 $20/UTC 月；应用记录实际返回的 token 和标价费用，记录达到 $20 后也停止新调用。额度拒绝保留待处理到下月。不要为费用增加预留、租约、二级账本或通用 provider 框架。
- **缓存**：稳定的基础提示词、个人规则在前，变化的邮件和时间在后。仅连续批次显式缓存两段系统文本，TTL 五分钟；普通小时单批不开缓存。不补文本凑长度，不缓存邮件块，不增加预热请求或心跳。费用按实际返回的未缓存输入、缓存写入、缓存读取和输出分别计算，输入总计包含三种输入，不能用开启参数冒充命中证据。
- **Gmail 封闭表**：只有 `worker/src/gmail.ts` 访问 Google，每次经过 `checkRequest`。消息写入只动本应用 P 标签与 INBOX，先记意图。保留原 request ID、撤销和既有 run/day 写入上限；正常到限额等待。绝不开放邮件删除、trash、send、filters、settings、forwarding、batchModify 或系统标签删除。
- **一次性旧操作**：已完成的 P1-P4 初始化、标签合并、旧概率和账本保留历史含义。显式未读整理和旧重判入口继续沿用既有 owner 授权与边界，不能自动启动。新回复按 message ID 独立判断，不按 thread 去重。
- **个人使用边界**：不为模型运行期间少见的手动改标签增加额外核对或并发状态机。保留处理前的普通标签检查及原有写入重试。
- **历史学习**：旧例子、回放和决策保持可读；停止主动 embedding、弱学习、双视图和回放模型任务。旧 UI 启动回放时明确拒绝，不静默执行旧模型。不要重写原预测或冻结 fixture。
- **密钥**：Gmail grant 和 `ANTHROPIC_API_KEY` 只从 owner 本机写入 Worker secret，不进入 GitHub、CI、聊天或日志；部署包装器拒绝并保留这些字段。账户配置操作遵守当前任务授权。
- **隐私**：主题最多200字符，正文最多12,000字符。邮箱与长数字掩码、链接只保留域名。正文按需发送给 Anthropic，不进日志或 fixture；Ops 只有计数、时间和安全错误码。保留期修改同提交更新网站 `/privacy/mailsort`。
- **保留期**：决策内容14天、旧待审14天、非内容决策/账本180天、旧回放7天、每日计数400天；历史例子最多2000条，可删除。保留最近一个未读批次的 ID/进度，不存其正文。off 模式也清理。
- **接口与 UI**：根 `proto/mailsort/ui/v2`、共享转码器/客户端。IDL 用根工具生成，做 lint/API lint/breaking/schema。三页概览、分级、设置；旧数据明确标历史，不把 neuron、fallback 或学习额度当当前状态。
- **验证与发布**：合成 Gmail/Claude、独立 Gmail 操作表、workerd SQLite、真实模型路径 CPU、UI 和 Wrangler smoke。保持 Workers Free、40 外部请求/轮和有界读取。分支完整 CI gate 后以同 SHA 经 main 发布；部署、真实模型请求、实际 Gmail 写入分别验收。
