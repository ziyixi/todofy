# Mail Hero 配置、预算与恢复

应用只使用 Workers Free、D1、私有 R2、SQLite Durable Object Alarm、Assets 与 Access。当前权威配置是 [`wrangler.toml`](../wrangler.toml) 顶层；个人值与开关经[发布包装器](ci-cd.md)注入。资源由根 `infra/` 的受控流程管理，现有部署不重新创建资源或生成新密钥。

## 1. Free 运行边界

普通 email/fetch handler 只做短小校验与流式保存，MIME 解析交给 Alarm。代码保留原件、parts、头部、嵌套、正文和附件预算，不能靠增加 Paid CPU 配置规避边界。25 MiB 是原件接受上限，复杂 MIME 的实际 CPU/内存仍须验证。

本地检查使用 `bazel test //mail-hero:check`，发布归档用 `bazel build //mail-hero`。CPU 回归保持独占，所有 fixture 是合成邮件。官方平台限额与计费以 [Workers](https://developers.cloudflare.com/workers/platform/limits/)、[DO](https://developers.cloudflare.com/durable-objects/platform/limits/)、[D1](https://developers.cloudflare.com/d1/platform/limits/)和[R2](https://developers.cloudflare.com/r2/pricing/)的当前说明为准。

## 2. 预算保护

保持 Free；未经 owner 决定不升级或新增收费产品。账户免费量共享，容量与预算提醒都不是账单硬上限。

- 默认逻辑容量 5 GiB、每 UTC 日 300 封和 256 MiB 原件。DO 在写 R2 前原子预留额度，D1 故障时仍生效；超过预算暂时拒绝接收，不能据此保证上游重投。
- 正文只索引 UTF-8 前16 KiB，UI 必须显示搜索范围；详情仍读取实际保留的内容。
- 失败、待处理和未对账邮件不为腾空间而删除。增长异常先保留来源副本与业务状态，按当前用量核对原因。
- 私有桶不开公开下载。数据、备份与其他项目共同占用账户额度。

## 2.1 保留与历史邮件

新邮件冻结 `raw_retention_days=7`、`content_retention_days=30`、`ledger_retention_days=180` 的策略快照。历史 NULL 策略只有 owner 预览确认后才纳入；缩短期限也要签名预览。

普通计时只在解析成功、无 review/策略错误或活动 claim、且所有要求的交付已确认时建立。原件先到期；其余内容到期走完整删除，保留非内容去重身份。晚到解析和中断删除必须受同一 tombstone/恢复约束。

尚未建立普通时钟、已有策略快照的已处理异常，才适用全局 `resolved_retention_days`（默认60天，可关闭）：无在途工作，最后一次送达之后的交付都已送达或被 owner 取消；从未送达时全部都须 owner 取消。期限不短于当前和冻结的正文期限，正文永久保留时也不清理。重试/取消重新计时，删除前原子复核；未处理失败和后来未取消的失败继续保留。完整谓词与并发回归由 `lifecycle.ts` 及其测试维护。

## 2.2 提醒

提醒通过 Ops signals 进入 Home 的统一运维视图，不再维护独立外部提醒 webhook。进程、容量、待处理、投递和备份新鲜度分别反映实际状态；不含邮件正文、地址或目标 URL。

## 2.3 运维入口（ops-v1）

`Ops` 只经同账户 service binding，默认 fetch/email 行为不变，无新增公共入口。status 是有界只读索引查询。输出与[根合同](../../contracts/ops-v1/README.md)一致。

shed guard 最长36小时，自动失效；仅推迟以下任务，距上次完整执行48小时仍运行到追上积压：

| 工作 | shed 下行为 |
| --- | --- |
| 收件、配额预留、原件、登记 | 保持 |
| 解析、投递、重试、阻断复查 | 保持 |
| 任务修复、容量对账、中断删除续做 | 保持 |
| 提醒、备份、canary 执行 | 保持 |
| `raw_reconcile`、`lifecycle_retention`、`canary_cleanup` | 有界推迟，进行中的盘点仍续页 |

canary 沿用连接测试路径和稳定 run_id，带合同标记。暂停、维护、阻断、无目标或容量不足时不静默排队；消费者必须声明支持，且不能产生真实任务等副作用。owner 的普通连接测试仍会实际 POST 目标。

## 3. 资源与唯一配置

`DB`、`MAIL_STORE`、`BACKUP_STORE`、`COORDINATOR`、Assets、路由与公开 Access 身份都来自提交配置。根资源登记与清单必须一致；不添加并行生产配置、env 分支或 keep_vars。

新环境首次保持 archive 与强制暂停。`CREDENTIAL_KEY` 负责既有密文/动作签名，快照不包含它；修改不是透明轮换。秘密只通过既有私有授权流程提供，公开资料不记录其值或保管步骤。

## 4. Access 与浏览器

UI 在固定 Custom Domain，Worker 另行校验 Access JWT。owner/alias 是同一人的精确身份；不能放宽到所有提供商用户。浏览器写入先校验 Origin/固定 CSRF 头再读正文。下载保持私有、no-store/nosniff，HTML 禁脚本/禁外网。细节由 `security.ts` 与共享 edge-auth SPEC 维护。

## 5. 专用收信子域

只使用获准的专用子域与精确收信规则，不启用 catch-all，不修改根域既有 MX/TXT/DKIM 或主邮箱。DNS、API ready 与控制台显示是不同观察；不能为消除根域提示而重做会覆盖主邮箱的 onboarding。来源转发由 owner 在正规邮箱流程中配置并保留来源副本。

## 6. 验收与消费者

先用合成邮件验证持久接管、中文/MIME、截断/省略、25 MiB边界、故障重试、重复Alarm、删除不复活和鉴权。来源自动转发、实际 Free 用量和真实消费者业务另外验收，不能由本地构建或一次HTTP 2xx推断。

消费者只允许精确公网 HTTPS 目标；Access service identity与业务 Bearer/Basic 各自独立。相同事件/bytes必须持久去重。Mail Hero“已交付”只表示消费者接管；当前 Todofy/Tasks 边界见[接入合同](todofy-integration.md)。

## 8. 原生备份

每日快照复用 DO Alarm，最长30分钟租约暂停解析/交付/清理/API写入，新邮件进入下一份。新副本是普通 v2 文件，不增加加密或恢复密钥；全量读回/引用校验及 durable commit 通过后才登记成功与轮转。具体[格式与接口](native-backup.md)、[下载/恢复](../deploy/backup/README.md)分别维护。

## 9. 隔离恢复

使用新空 D1/R2，不绑定真实入站，强制维护和停发。核对同一版本的 schema、对象字节/hash/metadata、最新删除清单和独立恢复凭据，再重建 DO 调度与容量状态。保留 event_id 和冻结 bytes，对不确定交付与消费者账本对账后才安排切换。

stateful binding 切换需独立审核；生产发布只提升同一编译归档，不临时从源码重打包。D1 Time Travel 仅覆盖 D1，同账户桶也不等于账户外恢复。实际恢复、路由切换和 RPO/RTO 单独取证，历史范围见[验收记录](verification-native.md)。
