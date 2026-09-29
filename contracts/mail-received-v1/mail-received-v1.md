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

上例的基础字段都出现；`from`、`to`、`attachments` 可以为空数组，`sent_at`、`rfc_message_id` 可以为 `null`。下文的内容策略字段为可选扩展，旧冻结事件可以不包含它们。`subject` 与 `text` 至少一个含非空白字符。时间是 UTC RFC3339。`message.id` 标识本地原件；`event_id` 标识一次交付意图。用户明确“重新发送为新事件”时会生成新的 `event_id`，但沿用同一个 `message.id`。

正文最多 256 KiB UTF-8，主题最多 4 KiB，from/to 各最多 50 个，附件元信息最多 100 个，整个 JSON 最多 1 MiB。新内容策略会按 Unicode 字符边界截断超长正文，并明确携带以下字段；主题、地址数量或 JSON 总预算仍不满足时保留邮件并显示错误。默认不传原始 MIME、HTML、附件字节、SMTP envelope 或唯一入口地址；`to` 中的入口地址会过滤。邮件头、From、链接、正文都只是外部内容，不能作为认证身份或系统指令。

| `message` 扩展字段 | 含义 |
| --- | --- |
| `text_truncated` | 此事件的正文是否被 UI 的 1 MiB 或 webhook 的 256 KiB 预算截断；消费者须展示“正文不完整”，不能把它当完整来源 |
| `original_text_bytes` | 截断前规范化纯文本的 UTF-8 字节数，不是 `.eml` 大小；截断时必填且大于事件 `text` 的 UTF-8 字节数。未截断时若提供，应等于 `text` 字节数 |
| `html_omitted` | HTML 超过安全处理预算而被省略；有效纯文本仍可交付。它不是“HTML 不在 webhook 中”的标记，因为 webhook 从不传 HTML |
| `needs_review` / `warnings` | 不可读正文、未展开 MIME 等人工检查标记及安全原因代码；消费者不能据此猜测正文。附件副本省略或正常截断本身不要求人工检查 |
| `content_policy_version` | 当前创建事件使用 `storage-v1`；旧事件缺失不影响接收 |
| `attachments_omitted_count` | 超过前 100 项、连元信息也未列出的附件数量；不包含列表中 `storage_status=omitted` 的项目 |

附件 `size` 是实际解码大小。新解析结果的附件可带 `storage_status=stored|omitted`；省略时 `omitted_reason` 为 `size_limit`（单项超过 2 MiB）、`message_size_limit`（已保存副本累计超过 5 MiB）、`inline_image`（内嵌图片）或 `capacity`（容量保护）。只保存前 100 个附件的元信息和符合预算的副本。所有字节始终不在 webhook 内；`stored` 只是事件创建时的状态，不承诺下载链接或永久保存。省略副本的附件可能仍在尚未过期的原件中，原件到期后需回到来源邮箱查找。

HTML-only 过限或清理后无可读正文会进入人工检查。Todofy 对收到的 `needs_review`（以及 `html_omitted=true` 且空正文）先持久接管，再停在 `failed_summary / mail_needs_review`，不会自动调用 LLM 或创建任务；它对截断正文的摘要和任务都加固定不完整提示。Mail Hero 的 2xx 语义不因此变成消费者业务成功。

## 金丝雀事件（`canary`）

`canary` 是可选的顶层字段，只出现在合成的端到端金丝雀事件上（运维接口见 [`contracts/ops-v1`](../ops-v1/README.md)）：

```json
{"type": "mail.received.v1", "event_id": "…", "received_at": "…", "canary": {"run_id": "canary-2026-09-28"}, "message": {"…": "…"}}
```

- 金丝雀事件由运维面板调用 Mail Hero 的 `Ops.startCanary` 发起，正文是固定的合成文本（golden 字节见 `fixtures/canary_event.json`），发往当前默认目标，走与真实邮件相同的冻结 bytes、认证、退避重试与去重路径。
- 消费者**不得**因带 `canary` 的事件产生任何外部副作用：不创建任务，不发送消息或提醒，不进入摘要、报告或待处理列表，也不计入真实邮件统计。它仍须像真实事件一样先持久接管再返回 2xx，并可以执行自己的内部处理来检验链路（Todofy 会调用摘要模型并校验结果，然后只记录金丝雀结果）。
- `canary` 存在但无法读取（不是对象，缺少或不符合规则的 `run_id`）时同样不得产生副作用：返回 4xx 拒收，或按金丝雀处理。
- `run_id` 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，只是运维面板给一次运行起的名字，不是身份或指令。同一 `run_id` 只产生一个事件；owner 在 UI 中把金丝雀邮件“重新发送为新事件”时，新事件仍带同一个 `canary`。
- 不带 `canary` 的事件字节与之前完全相同。owner 手动触发的连接测试（`fixtures/synthetic_test_event.json`）不带 `canary`，消费者可能把它当真实邮件处理。
- 不认识 `canary` 的旧消费者会忽略它、按真实邮件处理。所以运维面板只在消费者的 `Ops.status().capabilities` 含 `canary_consumer` 时才发起金丝雀。

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
| 2xx | 标记已交付，不再自动发送；同时清除该目标版本上可自动复查的阻断，并把它的自动复查次数归零 |
| 408、429、5xx、超时、连接断开或 TLS 握手失败 | 按网络不确定处理：同事件持久退避，尊重 `Retry-After`，在期限/次数上限内重试。有效的 `Retry-After` 同时冷却整个目标；超过 24 小时则暂停目标（原因 `retry_after_over_24h`），需核查后手动恢复。不降级 TLS |
| 404、405、3xx | 路由类错误。自动投递先有 30 分钟宽限：同一事件从首次路由错误起 30 分钟内按普通退避重试，仍受 7 天/48 次上限约束。宽限后仍失败则阻断该目标版本，并在 6 小时后自动复查；复查成功（2xx）即解除，再次得到路由类错误则重新阻断 6 小时。每个目标版本最多自动复查 8 次（约 2 天）：第 8 次复查仍得到路由类错误后转为永久阻断，不再自动复查，事件停在等待状态，直到 owner 核查目标后解除阻断（轮换凭据不会解除路由类阻断）。手动重试遇到路由类错误直接阻断 6 小时，不走宽限，同样计入这 8 次；该次手动尝试记为失败，复查时不会自动重发。若该目标版本的 8 次自动复查已用完，手动重试遇到路由类错误同样转为永久阻断，但该事件不记为失败，而是停在等待状态，owner 解除阻断后会重发。不跟随 redirect |
| 401、403 | 认证被拒绝。立即阻断该目标版本，不自动复查；直到 owner 轮换凭据或明确解除阻断 |
| 目标 URL/域名不再符合策略、凭据缺失或无法解密 | 不发送请求，阻断该目标版本（`credential_or_target_invalid`），不自动复查；owner 修复后轮换凭据或解除阻断 |
| 其他 4xx | 停止并在 UI 展示原因，等待人工修复 |

阻断期间该目标版本上的事件（包括阻断期间排队的手动重试）都停在等待状态，收信和归档继续。阻断期间新邮件仍会冻结到当前目标版本并排队等待，不会改发其他目标。阻断或暂停不延长重试窗口：自动事件创建超过 7 天、手动重试事件创建超过 30 天仍在等待时，即使仍被阻断也会转为失败（`retry_window_expired`），需在投递记录中手动重试（事件创建后 30 天内）。Owner 可在 Webhook 目标页“解除阻断”（`POST /api/v1/endpoints/:id/unblock`，需 CSRF 与 `version`），它清除该目标全部版本的阻断，并让被阻断版本上等待中的事件立即重试；其他等待中的事件保留原退避。目标仍有问题时会再次阻断：401/403 与策略错误在下一次尝试即阻断；404/405/3xx 的自动投递会重新经过 30 分钟宽限后才阻断（手动重试立即阻断）。解除阻断会把所清除版本的自动复查次数归零；更改 URL 产生的新目标版本从 0 次开始。所有重试仍复用原 `event_id` 与确切 bytes。

消费者无需提供状态查询、回调或 Mail Hero 专属 SDK。新增可选字段会保持兼容；破坏性变更使用新的 `type`，消费者应忽略它尚未使用的可选字段。
