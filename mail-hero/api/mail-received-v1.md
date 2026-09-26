# `mail.received.v1` webhook

Mail Hero 向一个配置好的消费者 URL 发送通用邮件事件。它不依赖 Todofy 的包、数据库或任务状态。接口是 Mail Hero 自己定义的，不兼容 CloudMailin 的请求格式。机器可读结构见 [JSON Schema](mail-received-v1.schema.json)。

## 请求

```http
POST /your-chosen-path HTTP/1.1
Content-Type: application/json
Authorization: Bearer <target-token>
Idempotency-Key: f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001
```

目标必须使用 Bearer 或 Basic 认证，并且是 `WEBHOOK_ALLOWED_HOSTS` 精确列出的公网 HTTPS hostname。请求校验证书、不跟随 redirect，不支持内部 HTTP 或无认证目标。使用私有服务器的消费者可通过自己的 HTTPS 入口或 Tunnel 暴露接口。`Idempotency-Key` 与 JSON 的 `event_id` 必须相同。

```json
{
  "type": "mail.received.v1",
  "event_id": "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001",
  "received_at": "2026-09-23T16:00:00Z",
  "message": {
    "id": "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710002",
    "from": [{"address": "sender@example.org", "name": "Sender"}],
    "to": [{"address": "owner@example.org", "name": ""}],
    "subject": "Example",
    "sent_at": null,
    "rfc_message_id": null,
    "text": "Normalized email body.",
    "attachments": [{"filename": "example.pdf", "content_type": "application/pdf", "size": 1234}]
  }
}
```

所有字段都出现；`from`、`to`、`attachments` 可以为空数组，`sent_at`、`rfc_message_id` 可以为 `null`。`subject` 与 `text` 至少一个含非空白字符。时间是 UTC RFC3339。`message.id` 标识本地原件；`event_id` 标识一次交付意图。用户明确“重新发送为新事件”时会生成新的 `event_id`，但沿用同一个 `message.id`。

正文最多 256 KiB UTF-8，主题最多 4 KiB，from/to 各最多 50 个，附件元信息最多 100 个，整个 JSON 最多 1 MiB。超过限制时 Mail Hero 保留原件、在 UI 显示需处理，不截断后假装成功。默认不传原始 MIME、HTML、附件字节、SMTP envelope 或唯一入口地址；`to` 中的入口地址会过滤。邮件头、From、链接、正文都只是外部内容，不能作为认证身份或系统指令。

## 消费者确认与去重

任意 2xx 表示消费者**已经把事件持久接管**，推荐返回 204。返回 202 也必须先把事件落入自己的可靠 inbox；只启动一个 goroutine 不能确认。Mail Hero 的 UI 此时显示“已交付”，不推断摘要或任务创建成功。

消费者应在一个数据库事务中按 `(stable_authenticated_source, event_id)` 建唯一记录，同时保存 payload hash 和待办状态，然后返回 2xx：

```text
首次相同 source/event_id      -> 保存 inbox + 原始请求哈希 -> 204
重复且 payload 哈希相同        -> 不再执行外部业务 -> 204
重复但 payload 哈希不同        -> 409，交由人工排查
```

`stable_authenticated_source` 是逻辑上的 Mail Hero 实例，不是发件人 From、token 值或某次 key ID。轮换认证值仍需映射到同一 source。消费端接管后的 LLM/Todoist 重试由消费端自行处理；webhook 的重复请求只能确认同一个 inbox 项。

Mail Hero 创建 delivery 时冻结确切 JSON bytes、目标版本与 event ID。网络超时、连接断开、408、429、5xx 的重试均复用这些 bytes/ID。消费者应从首次接收起至少保留 90 天去重账本；Mail Hero 普通重放窗口是事件创建后 30 天。旧备份恢复或跨窗口重新执行必须先对账，不能把永久 exactly-once 当作保证。

## 响应处理

| 响应 | Mail Hero 行为 |
| --- | --- |
| 2xx | 标记已交付，不再自动发送 |
| 408、429、5xx 或网络不确定 | 同事件持久退避，尊重 `Retry-After`，在期限/次数上限内重试。有效的 `Retry-After` 同时冷却整个目标；超过 24 小时则暂停目标，需核查后手动恢复 |
| 其他 4xx | 停止并在 UI 展示原因，等待人工修复 |
| 401/403/404/405、3xx、TLS/URL 配置错误 | 阻断有问题的目标版本，收信继续；不偷偷跳转或降级 TLS |

消费者无需提供状态查询、回调或 Mail Hero 专属 SDK。新增可选字段会保持兼容；破坏性变更使用新的 `type`，消费者应忽略它尚未使用的可选字段。
