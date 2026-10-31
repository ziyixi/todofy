# Mail Hero 备份写入验收

## 改动范围

每日 04:17 UTC、30 分钟租约、普通 v2 快照及旧 v1 恢复保持不变。
新备份的对象清单、已校验文件和删除清单放在私有 R2 临时文件；每批只更新一次 DO 游标。
临时文件使用两个交替位置，保存成功后才推进游标，终态移除。没有新增服务、数据库、密钥或部署参数。
已有邮件和已验证备份不做迁移或清空；原有 7 每日 + 4 每周轮转规则保持不变。

## 同一数据前后比较

基线为 `459bf7da2b738fccecb93212a324a2dd56f60daf`。
在真实 workerd SQLite DO、D1、R2 绑定中，每组创建 100 或 1,000 个合成 R2 对象，
连续备份两次。第二次沿用同一 DO 和同一批源对象，以包括旧实现清理前次账本的成本。
源对象仅含 `synthetic-N`，D1 没有真实邮件或投递记录。

| 对象数 | 次数 | 旧 DO 写入 | 新 DO 写入 | 减少 |
| --- | --- | ---: | ---: | ---: |
| 100 | 首次 | 717 | 123 | 82.8% |
| 100 | 同 DO 第二次 | 776 | 81 | 89.6% |
| 1,000 | 首次 | 5,457 | 186 | 96.6% |
| 1,000 | 同 DO 第二次 | 6,434 | 153 | 97.6% |

DO 数值包含 SQLite `rowsWritten`（已含索引修改）及每次 `setAlarm`。
首次包含冷启动建表和容量盘点；这不是仅统计 INSERT 次数，也不是生产整日账单的降幅。
生产升级后的首轮还会清理上一版留在 DO 的临时清单；它不删除 R2 备份或邮件，稳定后的写入再按新路径计量。
1,000 对象重复备份的 SQL 写入由 6,361 降为 80，Alarm 写入仍为 73。
D1 仍为一次 freshness 写入；总 R2 调用增加不到 1%，没有把节省的 DO 写入变成逐对象 R2 进度文件。

复现合成配额审计：

```sh
bazel test //mail-hero/cloudflare/test:native-backup-runner-runtime_test \
  --test_env=MAILHERO_BACKUP_QUOTA_AUDIT=1
```

同一测试固定了 DO 写入上限，并检查新备份不向三个旧逐对象 SQL 账本写入，
以及结束后没有遗留 R2 工作文件。运行时版本为 Node 26.9.0、Miniflare 5.20260926.0-alpha、workerd 1.20260926.1。
计费口径：[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)、
[SQLite 写入与索引](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

## 恢复与中断验证

使用本次真实 runner 生成的合成 v2 快照，通过现有 Python 下载格式和恢复桥还原至新目录，
核对原件、冻结 payload、metadata、message/event ID、payload hash，以及停发和待对账状态。
旧 v1/v2 Python 恢复测试 11 项通过；没有改动恢复工具或最终快照格式。

另验证复制中断后重启继续同一备份、删除清单页中断不重复登记、marker 失败不提前更新时间、
新入站不混入旧 cut、25 MiB 流式复制，以及 2,500 对象在原租约内完成。

## 2026-10-26 发布证据

`d1a6e526c7e5de5138ef750a13decd8b439db9c6` 完成分支/main检查与对账，07:06:50 UTC的发布回执验证源码一致；07:30:56 UTC Home只读状态正常。每日时间、容量和运维开关保持原值。

当次没有额外触发生产备份或清理邮件；该表是合成存储实测，不能推作整账户账单或后续自然备份结论。生产观察只取构建、阶段、时间和计数，不下载邮件/备份内容。
