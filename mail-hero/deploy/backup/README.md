# Mail Hero 原生备份与恢复

Mail Hero 每天由自己的 Cloudflare Durable Object Alarm 备份到私有 `BACKUP_STORE`。**新备份直接保存文件，不再增加应用层加密或恢复密钥**；不需要 VPS、Docker、k3s 或额外的调度服务。桶不公开，下载仍须通过专用机器身份鉴权。

备份包含 Mail Hero 的 D1 数据/schema、R2 原件/正文/附件/冻结 webhook payload 及 metadata、待处理与容量状态、删除清单。范围不包含服务器系统、其他应用、来源邮箱或 Worker secrets；恢复时仍需匹配的 Worker 配置。旧 v1 加密包保持可读。

## 自动备份

`NATIVE_BACKUP_ENABLED` 控制是否启用；`NATIVE_BACKUP_AT_UTC` 默认每天 **04:17 UTC**。执行器分批复制，每个文件保存后完整读回并校验 SHA-256，全部通过后才登记成功。失败不会替换最近一次成功记录，重试与清理都有边界。

快照使用最长 30 分钟的 DO 租约，期间暂停解析、交付、清理和管理写入。新邮件仍能接收，切点之后的原件进入下一份快照；超时不能登记成功。只保留已验证快照，按最近 7 个不同 UTC 日和 4 个不同 ISO 周轮转，v1/v2 共用保留策略。

v2 路径为 `snapshots-v2/<日期>/<ID>/`。`manifest.json` 保存文件长度、SHA 和快照版本；`source-manifest.json` 保存原 R2 key、ETag、custom/HTTP metadata 及数据库块信息。`proof=native_readback_verified` 表示存储读回校验通过，独立恢复验收另行记录。

主数据和备份位于同一 Cloudflare 账户；需要账户外副本时可下载到本机。R2 免费量由账户共享，容量保护不是账单硬上限。配置与发布规则见 [Cloudflare 设置](../../docs/cloudflare-setup.md)。

## 下载到本机

通过本机安全配置提供专用 `BACKUP_TOKEN` 和 Access 机器身份 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`，不要放进命令参数或日志。不需要 Cloudflare 管理 token、R2 S3 key、GPG 或新的密钥。

以下命令在本目录运行。父目录须为 owner-only `0700`，目标目录必须不存在；下载内容包含邮件正文，应放在自己的私有目录中。

```sh
python3 native_backup.py list --origin "$MAIL_HERO_ORIGIN"
python3 native_backup.py download --origin "$MAIL_HERO_ORIGIN" \
  --backup-id "$BACKUP_ID" --destination /private/recovery/mailhero-backup
```

下载会核对文件数量、长度和 SHA，同时保存刚取得的 `latest-deletions.json`；全部成功后才发布本机目录。把输出的 `receipt_sha256` 独立保存，它用于恢复时检查整份下载是否改变；无需记住或保存新的密码。

## 隔离恢复

```sh
python3 native_backup.py restore \
  --bundle /private/recovery/mailhero-backup \
  --receipt-sha256 "$SAVED_RECEIPT_SHA256" \
  --latest-deletions /private/recovery/mailhero-backup/latest-deletions.json \
  --destination /private/recovery/new-isolated-mailhero
```

恢复只操作新本机目录，不联网、不覆盖生产资源。它核对 receipt、全部文件、源 manifest、数据库引用及 metadata，然后复用原恢复器的 SQL 完整性、删除与暂停规则。原事件 ID 和冻结 payload 保留，进行中的投递标为待对账；不自动触发消费者业务。

如果使用的是以前下载的备份，先刷新删除清单，再把新路径传给恢复命令：

```sh
python3 mailhero_backup.py deletions --origin "$MAIL_HERO_ORIGIN" \
  --output /private/recovery/latest-deletions.json
```

不要把快照内的旧删除记录当成当前清单。未提供最新清单时，结果明确标为 `quarantined_missing_latest_deletions`；提供后为 `isolated_requires_reconciliation`。两种情况都保持 **`activation_allowed=false`**。

恢复输出有 `database.sqlite`、`database.sql`、`r2/`、保留原 key/metadata 的 `r2-objects.json`、`coordinator-control.json`、`restore-state.json` 和 `native-backup-proof.json`。`build_sha` 用于定位仓库版本；包内不包含源码或 Worker secrets。

真正上线恢复仍需单独核对：导入新空 D1/R2、使用匹配的 Worker 配置、重建 DO 调度与容量状态、按原 event ID 对账未知交付，再明确解除暂停。离线检查通过不能当作已完成生产灾难恢复或已建立 RPO/RTO。

## 旧 v1 加密包

仅旧 `.tar.gz.gpg` 包仍需原恢复私钥和 GnuPG。旧工具、格式和已有备份不改动，也无需重启旧收集器：

```sh
python3 mailhero_backup.py restore \
  --archive /private/recovery/legacy-snapshot.tar.gz.gpg \
  --archive-sha256 "$SAVED_ARCHIVE_SHA256" \
  --gpg-home /private/recovery/keyring \
  --latest-deletions /private/recovery/latest-deletions.json \
  --destination /private/recovery/new-isolated-legacy
```

## 合成验证

在 `mail-hero/` 执行：

```sh
python3 -m unittest discover -s deploy/backup -p 'test_*.py' -v
```

原生测试不依赖 GPG，覆盖原子下载、文件与清单损坏、重复/缺失/多余文件、路径穿越、符号链接、最新删除记录、冻结事件及缺少仍被数据库引用的对象。旧版 GPG 验证只属于旧格式。生产备份、独立恢复和部署证据见 [验收记录](../../docs/verification-native.md)。
