# Model Router

先读根 AGENTS、HANDOFF 和本目录 README。

- 应用推理与 owner 查询使用根 `modelrouter.inference.v1` 的独立文件；TS/Python 客户端都由相同 proto 类型和 wire profile 发送。供应商协议只出现在 `worker/src/providers/` 和 VPS 执行层。
- 一个 `router-v1` DO 处理当前个人使用量。独立调用可并发，同一个短会话同时只有一个 turn；不增加通用任务队列或应用工作流。
- HTTP Worker 在读取正文前验证 Access、精确 Origin、自定义头和 JSON 媒体类型，或精确机器凭据。私有 binding 的 `props.app` 决定调用者，禁止用 JSON metadata 代替身份。外部 Newsletter 口令只能调用 Codex 模型；同账户 binding 应用不受此限。
- D1 只存请求元数据、错误码和用量；正文放私有 R2。控制台详情由 owner 显式读取。日志、Home 和 Actions 不输出提示词、结果、邮件、研究 URL 或密钥。
- 输入/输出保留 7 天，元数据 90 天；R2 lifecycle 覆盖未完成的写入。每次普通推理都是新调用，由服务端生成 trace ID；没有客户端去重账本。内容过期不会自动重新执行。
- 供应商未报告的模型或用量保持未知；Codex 订阅可按公开 API 费率显示参考价值，必须与真实 API 估价分栏，不能计入应用的 API 消费。所有应用共用 Router 的 `ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 与 `OPENAI_API_KEY`，不按应用配置 key 或计费档案。供应商 key 是 Router secrets，消费上限设在供应商处；不进入 GitHub、客户端或 VPS。
- Codex 的既有 `gpt-*` 模型 ID 保持有效；OpenAI API 使用 `openai/<native-model>`，两者在目录、请求记录和费用统计中独立。新增模型不改变应用已保存的选择，不做跨供应商自动回退。
- 应用的预算、业务重试、来源审核和发送账本留在应用。修改传输不能丢失部分用量、真实 web observations 或 Newsletter 同会话补问。
- 验证用合成内容、独立 fake 和真实 workerd 绑定。发布和 Linux 容器检查按根 CI；生产验收不重算私人内容。

- 内部推理字段只保留当前业务所需；同次升级所有调用方可直接删字段，不 reserve。时间、状态、保留期只在 owner 查询中出现。
- 每日备份完成记录与保留正文至独立私有 R2，保留七天；不复制 provider key、HTTP 凭据、SDK context，不增加独立备份平台。
