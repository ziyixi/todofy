# 统一调用

Mailsort、Todofy 通过同账户 service binding 调用 Router；Newsletter 使用一个外部调用口令，
只能调用 Codex 模型，其他供应商和向量在登记请求前返回 `MODEL_NOT_ALLOWED`。
Router 选择供应商、调用模型、归一用量，把结果一次返回。应用继续负责提示词、预算、业务重试和工作流。
模型 key 只在 Router；VPS 保留原 Codex 订阅登录。

## 最小接口

普通生成只需要两个字段：

```json
{"model":"gpt-6.1-sol","input":"Summarize this synthetic example."}
```

目前业务需要的可选项只有 `instructions`（含稳定块缓存提示）、`effort`、`max_output_tokens`、
`output_schema_json`、`allow_fallback` 和 `timeout_ms`。Newsletter 的后续 turn 传 `conversation + input`。
没有 temperature、metadata、客户端 request ID、通用消息历史或参数回显。
现有推荐的数组根 Schema 由 Router 内部包装为模型需要的对象，返回前解包并按原 Schema 校验。每次普通调用都是一次新调用；
Router 生成日志 ID，不维护客户端请求去重账本。结果返回 `name`、实际选用的 `model`、`output`、`usage`、
必要的 `error`，以及业务需要的 web observations 和 native fallback writers。

`Embed` 只接收实际模型和一组输入文本，返回有序向量、用量和错误。目录里的模型是供应商原生 ID；
每个条目注明 provider。`gemini-email`、`gemini-report` 属于旧的调用策略，不是可选模型。
Todofy 自己维护邮件与日报的 Gemini fallback 顺序。Gemini 3.7 已自动转到 3.8，当前目录不再重复列它。

应用接口在 `proto/modelrouter/inference/v1/inference.proto`；owner 查询在同包 `console.proto`。
后者负责调用来源、时间、状态、正文保留期和统计。它们不进入普通推理响应。
所有调用方都在 monorepo 内，同次发布可以直接删除不用的字段，不保留空壳和 reserved 字段。

## Newsletter 短会话

只有 Codex 需要保留上下文。Newsletter 先登记一个随机 context name，再发送平铺的创建参数；创建与关闭
只返回确认。一次最多 14 分钟，turn 不续期。同一个 context 顺序执行，仍能在原 SDK thread 内补问一次，
并取得实际 search/open observations。没有查询会话、供应商通用聊天历史或跨重启恢复。

关闭会等待执行清理。失败时 Newsletter 继续保留自己已有的排空记录。Router 的短期归属与截止时间放在
现有 DO storage，SDK context 留在 VPS。到期时网关按同一截止时间自行关闭 SDK context，Router 只删除自己的
归属记录，不再调用 VPS。私有 SSE heartbeat 仅用于保持 Tunnel 请求存活，应用收到最终 JSON。

## 错误原因

执行失败放在结果的 `error`；调用前的拒绝（鉴权、`MODEL_NOT_ALLOWED`、维护、无法登记）用 HTTP
google.rpc.Status，携带同样的原因名。完整清单和 code 在 `inference.proto` 的 `ModelError.reason` 注释里。
调用方按原因分四类处理：

- 配置（暂停，不消耗单条尝试）：`MODEL_AUTH`（含 Gemini 以 400 拒绝的 key）、`MODEL_NOT_CONFIGURED`
  （供应商 404、Gemini 400 `FAILED_PRECONDITION`、缺 key 或路由）、`MODEL_NOT_ALLOWED`、`MODEL_SPEND_LIMIT`。
- 内容相关（单条计数，小上限）：`MODEL_INVALID_REQUEST`（供应商 400/413/422）、`MODEL_INVALID_ANSWER`、
  `MODEL_REFUSED`、`MODEL_OUTPUT_LIMIT`、`MODEL_UNSUPPORTED_TOOL`。
- `MODEL_TIMEOUT` 表示超过期限，包括 Router 自己的截止时间；`MODEL_CANCELLED` 只表示调用方真的取消。
- 基础设施或容量（整轮延后，遵守 `retry_after_seconds`，不消耗尝试）：`MODEL_QUOTA`、`MODEL_RATE_LIMIT`、
  `MODEL_UNAVAILABLE`、`MODEL_BUSY`、`MODEL_MAINTENANCE`、`MODEL_STORAGE_UNAVAILABLE`、`MODEL_EXECUTOR_*`、
  `MODEL_INTERNAL`，以及抛出的传输错误。

未列出的原因按 code 归类：3 为内容相关，4 为超时，7、9、16 为配置，其余为基础设施。

## 记录、图表和费用

D1 保存内容之外的请求记录 90 天，私有 R2 保存输入/输出 7 天。owner 列表不带正文；点击详情才读 R2。
已过期的内容不因查看旧记录而恢复。旧记录及其原请求保持可读，目录和历史索引用真实模型身份。
部署或重置截断的调用会停在 running；每日清理把开始超过 20 分钟的这类记录标为 interrupted，
不重新执行。在此之前 Ops 的 `model_execution_unknown` 在两天窗口内持续可见。
未报告的服务端模型身份继续显示未知，不把配置值冒充供应商回报。

一天视图按小时聚合，较长范围按 UTC 日聚合；图表分模型展示请求、成功/失败、输入/输出和缓存 token。
API 估价与订阅的假设 API 价值分开显示。后者不会进入 Mailsort 的 API 消费账本。
费用按已知请求求小计，另标出未计入的请求数；未知用量不按零计算。供应商在生成前以 4xx 拒绝的调用不计费，
按零用量、零费用记录；超时、停滞和中断的流保持未知。向量走平台配额，不报告 token，不影响 token 完整性。
订阅金额统一按 Standard 文本价折算，SDK 累计 token 不能确定每次内部调用的上下文档位。
金额不包含工具、长上下文、存储、税费或服务档位附加费。
Claude 的 native fallback 按实际 writer 和缓存 TTL 逐段估价。

费率集中在 `worker/src/providers/pricing.ts`，注明官方来源和核对日期。Google Flash 3.8 当前优惠价到
2026-12-31，届时更新这份小表；不增加自动计价服务。

## 备份

首次 Home/Ops 观测会启动第一份备份，以后每天 04:47 UTC 运行。一个 DO cursor 推进少量分页和正文复制，
不暂停推理。D1 完成记录及其仍保留的正文进入独立私有 `BACKUPS` 桶，完成标记最后写入；不复制密钥、
SDK 状态或会话，不重放请求。R2 保留七天，因此备份中的正文最多可能存在约十四天。详见
[备份与恢复](backup.md)。
