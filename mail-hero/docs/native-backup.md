# Mail Hero 每日备份

每天由 Mail Hero 的现有 DO Alarm 把一份配套快照复制到私有 `BACKUP_STORE`。
没有新增服务、加密、公钥、密文分块或 VPS 依赖。

## 备份哪些东西

| 数据 | 位置 | 备份内容 |
| --- | --- | --- |
| 邮件索引、配置和投递记录 | D1 | schema 和有界分页数据 |
| 等待解析、重试、配额及 intake 边界 | SQLite DO | 恢复所需控制状态；不是复制内存或 timer |
| 邮件原件、正文、附件、冻结 payload | `MAIL_STORE` R2 | 原字节、原 key、HTTP/custom metadata |

数据库里没有正文和附件，所以完整 Mail Hero 备份需要配套的 R2 文件。
代码和公开配置由同一 `BUILD_SHA` 对应的 Git 提交保留；Worker secrets 不导出到快照。
恢复新账户时按[秘密清单](../../docs/rebuild.md#secret-inventory)单独恢复原密钥和凭据。

## 只需三个设置

| 设置 | 来源 | 默认 |
| --- | --- | --- |
| `MAIL_HERO_NATIVE_BACKUP_ENABLED` | GitHub production variable，随正常 Actions 发布 | `true` |
| `NATIVE_BACKUP_AT_UTC` | `wrangler.toml` | 每日 `04:17` UTC |
| `NATIVE_BACKUP_MAX_BYTES` | `wrangler.toml` | 单次全部副本5GiB |

既有 `BACKUP_STORE` binding 继续使用。无需新增 secret 或付费产品。
关闭自动开关不会取消正在进行的复制；仍可明确请求一次备份。

## 一次执行的流程

1. 取得最长30分钟一致性租约，等待在途业务/API写入排空；暂停解析、投递、清理和管理修改。
   新邮件继续保存，属于下次快照；不用停止源邮箱转发。
2. 复制 D1/DO 与 R2 文件；临时清单放在 R2，DO 每批只保存一次小游标。大对象流式复制，重启继续同一份快照。
3. 检查大小、hash及数据库引用；完整后写 manifest 和成功记录，再恢复正常处理。
4. 成功后才轮转：保留7个不同UTC日及4个不同ISO周；旧 v1 副本同样保留兼容。

### 每次 Alarm 做多少

一次 Alarm 工作满10秒、复制或读回满8MiB后不再开始新的一步（进行中的一步做完，例如一组里最后一个较大的对象）；
R2/D1调用至多400次（其中D1查询至多20次），剩余额度不够一步时也停下。下一次 Alarm 约1秒后。
Workers Free 对一次 DO 调用的限制是30秒CPU、15分钟、1,000次Cloudflare服务子请求（D1查询至多50次），
每次 Alarm 都远低于这些限制。
预算未用完就接着做下一步：数据库导出页不再限每次8页，对象清单页、删除清单页和引用检查也不再每次一页。
对象每组6个同时复制，每个4次R2调用（两次读源、写入、读回校验）。完成记录在内存中合并，
每次 Alarm 结束才把清单保存到 `native-work/<backup-id>/` 的 R2 临时文件，并更新一次 DO 游标。
两个交替文件保留当前批次与上批次，最终成功或失败清理后移除；不会在最终快照目录增加格式外文件。
原先逐对象写入、删除的 SQLite 清单不再用于新备份，D1 小分页的导出索引保持不变。
组内失败不前进游标，已完成文件随该批次保存，重启后接着复制。

2026-10-19起每日备份因 `native_backup_lease_expired` 失败：旧版每次 Alarm 固定最多8步，
对象清单、删除清单和引用检查每次一页。对象数增长后耗时随之增长（10-04 1,008个19分钟，
10-13 1,483个27分钟，10-18 1,903个28分钟），终于超过30分钟租约。
同一合成快照（625封邮件、2,500个对象，`test/native-backup-runner-runtime.test.mjs`）
从415次 Alarm（复制313次、引用检查70次、对象清单24次）降到33次（复制26次）。
即使每次都用满10秒、间隔约1秒，33次也约7分钟。按旧版生产速度（每个对象约0.5秒）估算，
2,500个对象约需8分钟；以下一次真实快照的完成时间为准。

临时故障在原租约内重试，超时释放业务暂停；完整重跑最多进入下一日周期。
缺文件/坏配置/超容量等结构错误暂停自动整批重跑，显示安全错误码，等待明确重试。
只有完整复制成功才更新 `last_backup_at`；Home 的过旧告警据此恢复，不能用部署成功替代。

## 查看与恢复

机器接口沿用既有 Backup Bearer + Access身份，前缀为 `/api/internal/backup`：

| 接口 | 作用 |
| --- | --- |
| `GET /native/status` | 当前phase、安全错误码、下次时间、是否需要人工重试 |
| `POST /native/run` | `{version:2,request_id:<UUID>}` 请求一次；同ID去重 |
| `GET /artifacts/list-v2` | 已完成副本清单 |
| `GET /artifacts/list-v2-objects`、`GET/HEAD /artifacts/object` | 已鉴权下载，精确路径、no-store/nosniff |

另有 `GET /writers` 列出 API 写入租约，`POST /reconcile-writer` 只在维护模式下按精确 ID 清理遗留租约。
旧 v1 收集器的采集接口（begin、status、各导出、finish、cancel）已删除；快照导出只由 DO 内的执行器调用。

[下载/恢复工具](../deploy/backup/README.md)把快照保存到新的私有目录，校验后恢复到隔离目录。
新版不需要GPG。旧 v1 加密包仍使用原来的GPG恢复命令。
恢复保留 event ID/payload、应用及目标停发；取得最新删除清单并对账后，才另行导入新Cloudflare资源。
当前实际部署、成功快照及恢复测试分别记录在 [HANDOFF](../../HANDOFF.md)。

私有桶副本可以恢复应用误删/损坏；整个账户迁移需另行下载副本及保存秘密。
轮转与容量检查用于控制成本，免费额度按账户共享；不自动升级Workers Paid。

## 当前验收（2026-10-03）

`5837c0c` 分支及main完整CI通过，Mail Hero/Home发布通过。真实快照于23:06 UTC完成：
1,031文件、37,723,651字节，完成marker存在、数据库成功时间同步，下次04:17 UTC。
Home刷新后已清除备份过旧故障。当前数据复制成功，不代表5GiB满量或全新账户恢复演练完成。

## DO 写入验收

同一 workerd 合成数据、同一 DO 连续备份两次：1,000 个 R2 对象的第二次备份，
DO 写入从 6,434 降至 153（约减少97.6%）；包含索引写入和 `setAlarm`，不只统计 SQL 语句数量。
这不是生产账单的降幅；真实邮件处理仍会写 DO。R2 调用总量只小幅变化，D1 写入仍为一次 freshness 更新。
新快照已用现有 Python 恢复工具还原合成邮件、metadata 和原 event ID，恢复后保持停发。
具体数据、环境与发布记录见 [备份写入验收](backup-write-verification.md)。
