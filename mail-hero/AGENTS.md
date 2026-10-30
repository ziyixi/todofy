# Mail Hero 开发约束

遵循根 AGENTS.md。此处只保留 Mail Hero 的运行与合同边界；当前操作入口见 [README](README.md)、[设置与恢复](docs/cloudflare-setup.md)和[原生备份](docs/native-backup.md)。

## 范围与存储

- 保持 Workers Free、D1、私有 R2、SQLite Durable Object Alarm 和同 Worker 的 React Assets。只有一个固定收信地址；不恢复 Go/PostgreSQL、VPS collector、邮箱轮询或多租户平台。
- Email handler 精确校验 envelope 与原件上限，先持久登记任务并完成流式 R2 保存，再结束接管。MIME 解析放在 DO Alarm，普通 Worker 不整件缓冲或解析。
- D1 保存索引、不可变目标 revision、事件身份、attempt 和 UI 幂等记录；R2 保存原件、解析内容、附件和冻结 payload。三种存储之间没有跨服务事务，每一步都要可恢复、可去重，删除不能被晚到解析复活。
- SQLite DO 使用持久任务和 Alarm；不能依赖内存 timer。后台、盘点、清理与恢复查询必须有界并走索引。D1 的 50-byte LIKE/GLOB 模式边界要有显式回归，键前缀使用范围查询。
- 新邮件冻结容量/保留策略；历史 NULL 策略须 owner 预览确认后才纳入。失败、在途和未处理邮件不能为腾空间而清理。当前的分阶段安全终态与已处理异常规则在 `lifecycle.ts` 及其测试维护。

## 解析与交付

- 原件最大 25 MiB；附件、正文、嵌套和 parts 均保留当前预算。正文截断和附件省略必须透明标记，`needs_review` 阻止自动业务。连续三次解析中断后保留原件，等待显式重解析。
- MIME、HTML、附件与响应均不可信；不执行附件、不跟踪远程图片，不猜测嵌套内容。原件可保存、解析完成、消费者持久接管和下游业务成功分别记录。
- `mail.received.v1` 的 IDL 与合同在根 `proto/`、`contracts/`。事件冻结 `event_id`、精确 bytes 和 endpoint revision；所有重试复用它们。只有明确“新事件重发”生成新身份。
- 消费者 2xx 只表示持久接管。网络/429/5xx、路由类宽限、认证阻断、自动复查次数和重试窗口沿用 `pipeline.ts` 的持久策略；不得用换 ID、删账本或静默重放处理 unknown。
- 出站只允许配置中的精确公网 HTTPS host，不跟随重定向，且有独立 Bearer/Basic 认证。URL 静态检查不证明 DNS/TLS 或消费者可用；发送测试事件会实际调用目标。

## API、身份与配置

- owner API 为 `mailhero.ui.v2`，使用共享转码器、生成客户端、etag/update_mask/filter 和明确错误原因。Access、Origin、mutation CSRF 在读取正文前验证；字节流下载保留私有响应头。
- `packages/edge-auth` 通过 `workspace:*` 编译进应用。Mail Hero 保留自己的精确 owner 匹配、nbf 0秒、首个 `CF_Authorization` cookie、仅 loopback 的本地绕过与 CSP；改前核对共享 SPEC。
- CSRF 是固定非空头；旧 v1/旧 CSRF 兼容截至日期以根 [历史表](../docs/history.md) 为准，不能提前移除。`CREDENTIAL_KEY` 继续承担既有加密和动作签名职责。
- 唯一生产来源为 `wrangler.toml` 顶层；不添加 `[env.*]`、`keep_vars` 或并行生产配置。个人值由 secrets-file 注入，运维开关及 BUILD_SHA 经包装器校验。普通 deploy 不得绕过包装器。
- 暂停投递继续归档；维护模式还停止新入站与管理写入。原生备份租约继续接收下一快照的新邮件，不能与维护模式混用。

## 备份与运维

- 每日备份复用现有 DO Alarm 和私有 BACKUP_STORE。最长30分钟一致性租约、有界分步复制、完整读回/引用校验与 durable commit 通过后，才登记成功并轮转7每日+4每周。
- 新副本是普通 v2 文件，不新增加密、公钥或秘密；旧 v1 密文恢复保持兼容。`native-work/<id>/` 只是临时工作清单，不改变冻结恢复格式。Worker secrets 不导出。
- 恢复到新空资源并保持隔离/停发，保留 event ID 和 payload，应用最新删除清单，再与消费者对账 unknown；不自动激活。具体文件合同由 `native-backup-format.ts` 和离线恢复器维护。
- Ops 只经同账户 service binding，不新增公共路由。status 有界只读；shed 只推迟已登记的非关键维护，不能推迟收件、解析、投递、重试或备份。canary 带固定标记，不产生真实业务副作用。

## 检查与发布

- `bazel test //mail-hero:check` 汇总类型、lint、unit、真实 workerd、CPU、Web/预算、合同和恢复检查；`bazel build //mail-hero` 得到编译后的发布归档。
- CPU 测试保持独占并及时释放隔离区；只用合成邮件、JWT、fake consumer 和隔离状态。私有内容及生产 API 输出不进入 fixture、日志或文档。
- Actions 在同一 green SHA 上提升编译归档，独立发布本应用；不在发布阶段从源码重新打包，也不导入 Todofy 的代码或数据库。共享包/IDL 使用者由实际依赖闭包选中。
- Golden 变更须由真实 payload builder/codec 更新并同提交审阅，冻结 legacy bytes 不重写。离线、部署、真实来源转发、消费者业务与灾难恢复分别验收，证据见[日期记录](docs/verification-native.md)。
