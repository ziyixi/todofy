# 请求记录备份与恢复

Router 每天 04:47 UTC 把已完成的请求记录和仍在保留期内的输入/输出复制到私有
`model-router-backups`。统计由这些记录还原。首次 Home/Ops 读取会启动第一份备份。

每个 metadata 页最多 100 行、gzip 保存；每个正文步骤最多复制 10 个对象。DO 只保存一个小 cursor，
不按对象建立 SQLite 清单。正常调用继续执行，新开始的请求留给下一份备份。它是分页日志副本，
不承诺整个数据库的同一时刻快照。

```text
daily/YYYY-MM-DD/requests/00000.ndjson.gz
daily/YYYY-MM-DD/bodies/requests/<app>/<request-id>.json
daily/YYYY-MM-DD/complete.json
```

只有最后写出的 `complete.json` 表示这份复制完成。它包含页数、记录数、正文数、字节数和时间。
缺失应保留的正文会让本次备份失败，已有完成副本不覆盖。桶内对象七天后过期；正文在备份中最长
可能保留约十四天，这是 owner 选择的范围。没有另加加密格式、hash 清单或备份执行框架。
供应商 key、HTTP 凭据、SDK state、短会话和正在执行的调用不在备份内。

Home 沿用 Ops 的 `last_backup_at` 和 `backup_age_seconds`；超过 26 小时没有完成备份会显示 `backup_stale`。
失败后可从 Cloudflare Alarm 错误查原因，下一天的触发会开始新的日期副本；不要把没有完成标记的目录用于恢复。

## 恢复

在本机完成正规的 Wrangler 登录，使用 Node 26。数据目录必须在 checkout 外。
以下命令只下载指定日期的完成副本，输出计数，不打印正文：

```sh
node model-router/tools/backup-restore.ts download --date YYYY-MM-DD --out /private/path/router-backup
```

先通过正常 IaC/bootstrap 准备一个新空 D1 和新私有 R2 桶；对新 D1 应用本仓库的 Router migrations。
建立只指向这个 D1 的独立 Wrangler config，绑定名为 `DB`。停止调用方并保持 Router maintenance 后执行：

```sh
node model-router/tools/backup-restore.ts restore --in /private/path/router-backup \
  --config /private/path/restore.toml --bucket model-router-restore-bodies
```

工具核对页数、记录数、正文数与总字节，拒绝非空目标表和原生产/备份桶名称；按原 key 写正文、按原列写
记录，再核对恢复数量。保留原正文过期时间，不启动任何模型调用。中断后重新建立空目标再执行即可。
确认新资源和计数后，经正常 Actions 修改绑定并恢复处理。API key 不在备份中，需要按部署手册单独配置。

测试用合成记录检查分页、本地 workerd 的真实 D1/R2 复制，以及新空 SQLite/正文桶恢复；
生产备份完成记录与实际云端恢复演练分别记录在根验收文档。
