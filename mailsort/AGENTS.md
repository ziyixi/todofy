# mailsort：规则

先读根 [AGENTS](../AGENTS.md)、[README](README.md) 和 [design](docs/design.md)。

- **当前行为（2026-10-24 owner 决定）**：四个真实 Gmail 标签 P1-P4。P1 需及时看，打标签并留 Inbox；P2 是两三天内应看的信息或跟进，P3 是周末可集中的个人周期汇总或值得阅读的内容，P4 是留档备查的通知、促销。后三者归档。个人规则优先：USPS Informed Delivery 普通预告 P2、当天需处理 P1；Daily Briefing P1；真实购物收据和订单确认（含 Weee/Yami）P2。保留已读、星标和其他标签，不创建任务或提醒。
- **模型与 prompt**：设置页按 owner 授权持久保存 Claude 与 Codex 两个既有分类选择。当前实现配置为 `models/claude-opus-5-5` medium 和 `models/sol-6-1` medium；后者由 owner 明确要求；经统一 Model Router 调用，实际可用性由真实推理验收，不以静态目录代替。未保存选择时默认 Codex（当前使用的引擎），owner 切换后从下一批使用；不自动回退，不重置模式、提示词或历史额度，不自动重判。两个选择使用同一份基础文本与个人规则，一批一次请求，最多十封。默认文本分别为 `prompts/priority-classification.txt`、`prompts/personal-rules.txt`；owner 保存后以既有 DO meta 副本为准，发布不得覆盖。每次调用只读一份快照。品牌偏好写入个人规则，不增加 sender 分支、概率阈值、二次投票或学习系统。模型只读掩码数据，没有业务工具或网页访问；邮件指令不可信。
- **调度与 gateway**：复用一个 Worker、现有 SQLite DO `mailsort-v1` 和 Alarm。五分钟维护；常规自动分类默认间隔15分钟，在现有设置中持久选择5/15/30/60分钟，两种provider共用。修改只调整已知的常规等待，不改失败退避或额度等待；旧设置只采用一次15分钟默认值。积压按请求预算分轮推进。VPS 订阅 executor 由 Model Router 连接，Mailsort 不拥有该 executor 的认证、进程或调度。不增加 cron、Queue、数据库或第二套调度。日常自动新增候选限于最近48小时、仍在Inbox且没有P1-P4的邮件，不区分已读未读；真实收件时间在分类前校验，未知时间不自动分类。正常批次到期才做有界补漏，不扫描归档或全历史。已接受的pending按首次入队时间固定边界，额度/重试等待不改其时间；有效历史决策不重判。显式unread/旧重判操作仍保持各自边界。
- **失败与额度**：复用现有 pending/退避和写入账本。模型错误不能伪装成 P1，也不切换 provider。按共享 Model Router 错误合同分类：配置/授权错误不计每封尝试、每小时重试，保存设置后立即重试；内容类错误每封最多三次，超时最多七次；故障与容量限制整批延后、不计尝试（5 分钟起翻倍到 1 小时，或按 Retry-After，额度至少 1 小时），成功后重置。已失败的邮件单独重试。只有 Claude 使用独立 workspace 的 $20/UTC 月上限和应用实际 token/标价费用停止条件；额度拒绝等待下月。切到 Codex 保留 Claude 的费用、缓存和错误历史，Claude 月额度不阻止 Codex 调用。Codex 使用既有 ChatGPT 订阅登录，模型可用性和真实推理须另行验证；不使用 API key 或其他模型回退。不要增加费用预留、租约、二级账本或通用 provider 框架。
- **Claude 缓存**：稳定的基础提示词、个人规则在前，变化的邮件和时间在后。从不请求提示缓存（缓存写入的加价高于批次间偶尔复用的节省）；不补文本凑长度，不增加预热请求或心跳。API 若报告缓存读写，费用仍按实际返回的未缓存输入、缓存写入、缓存读取和输出分别计算，输入总计包含三种输入。切换 provider 不清空历史。Codex 用量只由 Model Router 记录，Mailsort 不再保留自己的 Codex 账本。
- **Gmail 封闭表**：只有 `worker/src/gmail.ts` 访问 Google，每次经过 `checkRequest`。消息写入只动本应用 P 标签与 INBOX，先记意图。保留原 request ID、撤销和既有 run/day 写入上限；正常到限额等待。绝不开放邮件删除、trash、send、filters、settings、forwarding、batchModify 或系统标签删除。
- **一次性旧操作**：已完成的 P1-P4 初始化、标签合并、旧概率和账本保留历史含义。标签合并与两个旧重判入口已下线（代码与 Gmail 操作已删除，旧页面调用时提示刷新）；从合并运行中恢复的未完成任务会拒绝除设置外的所有修改。显式未读整理沿用既有 owner 授权与边界，不能自动启动。新回复按 message ID 独立判断，不按 thread 去重。
- **个人使用边界**：不为模型运行期间少见的手动改标签增加额外核对或并发状态机。保留处理前的普通标签检查及原有写入重试。
- **历史学习**：旧例子、回放和决策保持可读；Workers AI embedding、弱学习、双视图和回放代码已删除，新判定不再生成例子并删除该邮件的旧例子。旧 UI 启动回放时明确拒绝，不静默执行旧模型。不要重写原预测或冻结 fixture。
- **模型入口**：所有模型调用只经 `@ziyixi/model-router-client` 与私有 `MODEL_ROUTER` service binding。保留 Claude/Codex 的既有设置、模式、历史和各自计费口径；请求使用公共 model route、通用参数与标准 JSON Schema。Mailsort 不持有 provider key、VPS endpoint、SDK 或厂商请求格式。Router 按已认证 Mailsort caller 选择独立凭据，不能共用 Brief 的 Claude workspace。Gmail grant 仍只由 owner 本机写入；发布不覆盖。配置、实际模型推理与 Gmail 写入分别验收。

- **隐私**：主题最多200字符，正文最多12,000字符。邮箱与长数字掩码、链接只保留域名。依 owner 选择，掩码输入发送给 Anthropic，或经 owner VPS 发送给 OpenAI；不进请求内容日志或 fixture。Gateway 不持有 Gmail 授权，不保存推理 job 或邮件内容日志；Ops 只有计数、时间和安全错误码。保留期修改同提交更新网站 `/privacy/mailsort`。
- **保留期**：决策内容14天、旧待审14天、非内容决策/账本180天、旧回放7天、每日计数400天；历史例子最多2000条，可删除。保留最近一个未读批次的 ID/进度，不存其正文。off 模式也清理。
- **接口与 UI**：根 `proto/mailsort/ui/v2`、共享转码器/客户端。IDL 用根工具生成，做 lint/API lint/breaking/schema。三页概览、分级、设置；旧数据明确标历史，不把 neuron、fallback 或学习额度当当前状态。
- **验证与发布**：合成 Gmail/Claude/Codex、独立 Gmail 操作表、workerd SQLite、模型路径 CPU、UI 和 Wrangler smoke；模型调用使用统一合同与合成 Model Router binding 测试。保持 Workers Free、40 外部请求/轮和有界读取。分支完整 CI gate 后以同 SHA 经 main 发布；Router 与 executor 独立发布。进程 health、部署身份、真实模型请求和实际 Gmail 写入分别验收，不能互相替代。
