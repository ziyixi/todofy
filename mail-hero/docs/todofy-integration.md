# Mail Hero → Todofy

Mail Hero 通过 `/hooks/mail` 发送冻结的 `mail.received.v1`。Todofy 是独立消费者：不读取 Mail Hero 的 D1/R2/DO，也不导入其源码；共享内容只有根合同、IDL和获准的包。当前主机与允许列表以两端提交配置为准。

## 接管边界

Todofy 的 TypeScript 网关先验证主机、机器 Bearer、维护和正文头部，再把请求交给 Python core。core 持久保存来源、event_id 和 bytes 摘要后返回204；真正摘要由自己的账本与 Alarm 推进。模型调用经 Router；Tasks 再从 Todofy 的私有 Mail 入口读取摘要并处理任务。

| 响应 | Mail Hero 的处理 |
| --- | --- |
| 204 | 消费者已持久接管，同ID同bytes重放也成功；不代表模型或任务完成 |
| 400/409/413/415 | 合同、身份冲突或大小/类型错误；不靠自动重试修复 |
| 401/403 | 阻断该revision，等待明确凭据/配置处理 |
| 404/405/重定向 | 沿用有界路由宽限与阻断复查；达到上限后保持阻断 |
| 408/429/5xx或网络结果不明 | 同一event_id、目标revision和bytes持久退避，尊重Retry-After及原窗口 |

事件唯一键是稳定来源与event_id；同ID不同bytes必须冲突。源邮件重放、备份恢复和凭据轮换都不能改写已冻结事件。只有明确“重新发送为新事件”才产生新ID，也可能再次触发业务。

## 合同检查

结构与规则由 [`mail_received.proto`](../../proto/mailhero/webhook/v1/mail_received.proto)和[合同说明](../../contracts/mail-received-v1/mail-received-v1.md)维护。Mail Hero 的真实 builder/codec产生golden，Todofy真实parser消费；legacy fixture保持原字节。IDL不能表达的UTF-8字节和大小一致性规则仍由代码检查。

```sh
bazel test //mail-hero:check //todofy:check //proto:check
```

有意修改IDL或builder时按根proto/合同工具更新生成Schema和golden，同提交审阅并检查所有使用者。Bazel依赖显式声明，不自行推断合同语义。已冻结到R2的事件不重新序列化。

## canary 与测试事件

Ops canary带顶层run_id标记，稳定幂等，沿用真实接管路径。消费者需声明支持，且不能创建真实任务等副作用；仅记录合成处理结果。owner普通“发送测试事件”会实际POST并可能像普通邮件一样处理，不能混同canary。

## 暂停与恢复

- Mail Hero目标暂停、全局send_paused或FORCE_SEND_PAUSED：继续收件解析，暂不发出消费者请求。
- Mail Hero维护模式还停止新入站、管理修改和Alarm，不能用来代替普通投递暂停。
- Todofy PROCESSING_PAUSED：仍持久接管并回204，处理留在Todofy账本。
- Todofy维护：回503并带Retry-After，Mail Hero在原窗口内退避；长维护前可暂停目标。

暂停不延长原重试窗口。unknown或冲突必须按原身份与消费者账本对账，不能换键重发。Mail Hero显示“已交付”后的摘要问题由Todofy/Tasks的只读状态与明确动作处理，不回写为Mail Hero投递失败。

两端独立提升已验证的Bazel发布归档，等待同一main SHA门禁；共享使用者按实际依赖闭包选择。当前认证与部署责任见 [Mail Hero CI](ci-cd.md)及[Todofy README](../../todofy/README.md)。历史2026-09-29切换保留原目标/事件身份，不作为当前线上状态证明；日期证据见[历史摘要](verification-native.md)。
