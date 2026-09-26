# 运行、备份与恢复

Mail Hero 把原始邮件和交付队列放在同一个 PostgreSQL 数据库。默认 Cloudflare 入口里，Worker 先把原件及字节数暂存到私有 R2；Mail Hero 读完整个 HTTP body、核对字节数并提交 PostgreSQL 后才回复匹配 ingest ID 的 204，Worker 才清理 R2 副本。长度不符返回可重试的 503，不保存接收记录。此后解析或 webhook 失败会保留在收件工作台。`已交付`只说明消费者已以 2xx 持久接管，不说明 Todofy 已创建任务。可选的旧公网 SMTP 入口在数据库提交后才向上游返回最终 250。

## 日常检查

- 收件箱检查解析失败、需要处理的邮件和最早待交付时间。
- 投递记录查看 event ID、HTTP 尝试和下次重试；普通重试保留同一事件。新事件重发可能再次触发消费者业务。
- 设置页检查实际收信地址、容量、强制暂停、备份时间与真实来源到达时间。Cloudflare 入口还应检查 Worker Metrics/错误、R2 `pending/` 积压以及 Worker `GET /status` 的暂停/隔离样本；该接口只扫描有限对象，不能当成全桶精确总数。运行日志不应含正文、地址、认证值或响应全文。
- `docker compose --env-file deploy/runtime.env -f deploy/compose.yaml ps` 看容器状态；`/health/ready` 是数据库连通性检查，不是 Cloudflare 邮件入口或消费者业务的证明。

改收信地址需协调受限 `deploy/runtime.env`、Worker `RECEIVE_ADDRESS`、Email Routing 精确规则和每个来源邮箱的转发地址；切换过程中须先验证新路径，再撤旧规则，避免漏件或双重自动业务。修改 webhook URL、模式或限流在 UI 完成，历史队列仍按创建时的目标版本发送。

Cloudflare Worker 对已经保存到 R2、但尚未被本地确认的邮件按同一 ingest ID 补投。短暂断网、HTTP body 截断或 Mail Hero 停机时，先看 R2 积压是否增长；恢复后核对同一 ID 的 204 与对象清理。Worker 若发现 R2 中的 `raw_size` 与对象实际大小不符，会隔离原件，不盲目推送。401/403 通常表示 Service Auth 或入站 Bearer 配置问题，需修好并显式解除暂停；格式/大小等永久错误进入隔离，不能靠更换 ID 盲目重放。Cron 每 5 分钟扫描有界批次，配置变更最多可能要 15 分钟传播；大积压要持续观察而非假定一轮清空。[Cron 文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

R2 `pending/` 不设置按天自动删除。对象已从 R2 删除仅表示本地曾确认接管；本地数据库仍要单独备份。若从旧 PostgreSQL 快照恢复，Worker 可能再次补投当前 R2 对象：保留 ingest ID 去重，并先检查旧快照时点以后已经交接或消费的事件。Cloudflare 在成功写 R2 **之前**发生的失败不受这套本地去重/补投机制覆盖，需以真实入口故障演练和 Email Routing 记录核查。

`retention_days` 默认是 `null`，此时不自动删除邮件内容。首次启用或缩短保留天数时，设置页先预览当前符合条件的邮件数量及预计可清理字节数，再由用户确认。预览令牌绑定当前 owner、设置版本与所选天数，10 分钟后失效；期间设置若被修改，需重新预览。数量只是当时的快照，不锁定邮件，后台真正执行时可能不同。延长保留期或关闭自动清理无需预览确认。

设置天数后，后台最多每批清理 100 封已过期、解析成功且安全终结的邮件：仅归档且没有交付事件，或所有交付事件均已确认的邮件。解析失败、待发送、发送中、重试中、失败或取消的事件会继续保留以供排查。清理原件、解析内容、冻结请求和响应预览后仍保留无正文的去重与事件账本；旧备份中的内容按独立保留期到期。策略由后台周期执行，不是保存设置时同步完成。

## 离机备份

`deploy/backup.sh` 在数据库容器里执行 `pg_dump -Fc`，把一致性转储写到部署主机的受限临时目录，再用 restic 加密上传。脚本只在 restic 成功后更新 UI 的 `last_backup_at`。转储文件包含真实邮件内容；默认成功上传后删除本地明文转储。运行前配置一个**专用** restic 仓库和可读的密码文件：

```sh
export RESTIC_REPOSITORY=sftp:backup-host.example.org:/backup/mail-hero
export RESTIC_PASSWORD_FILE=/secure/path/mail-hero-restic-password
export MAIL_HERO_BACKUP_DIR=/srv/mail-hero/temporary-dumps
export MAIL_HERO_OFFSITE_CONFIRMED=true
./deploy/backup.sh
```

可以选择现有第二设备、SSH 存储或**另一个专用** R2 桶等 restic 支持的后端；不能把 Worker 的暂存桶当数据库备份。后端凭据通过主机正规配置注入，不放进仓库或命令行参数。`MAIL_HERO_OFFSITE_CONFIRMED=true` 是部署者核对目的地与主机独立后的声明，脚本无法从仓库 URL 自动证明容灾。首次使用需要先执行 `restic init`。脚本保留 7 个 daily 和 4 个 weekly 快照，并按 `mail-hero` 标签分组；不要让其他应用共享这个专用仓库。安排每日系统定时器或 cron，并检查退出码与最近成功时间。

`./deploy/backup.sh --local-only` 只生成本机 `.pgdump`，不会更新 UI 的离机备份时间，不能当作容灾。空闲磁盘必须容纳一次未压缩邮件库、pg_dump 转储、WAL 和备份临时空间。凭据加密主密钥 `deploy/secrets/mail-hero-key`、数据库口令、Worker 入站 token、Tunnel/Access 配置和 restic 恢复密码需要**单独可取的安全副本**；把所有恢复钥匙只放在它们自己加密的 restic 仓库中会无法恢复。

定期在隔离环境还原一份快照，检查 PostgreSQL 可以启动、消息/交付行数、原件下载与凭据解密。只有完成过离机恢复演练，才能声称达到 RPO/RTO 目标。

## 恢复到空数据库

恢复旧备份可能重新出现“尚未交付”的事件，而消费者当时可能已经处理过。先把 `MAIL_HERO_FORCE_SEND_PAUSED=true` 写入 `deploy/runtime.env`，并保持消费者的 event ID 去重账本。恢复脚本只接受**空数据库**，发现已有业务表就退出，不覆盖现有邮件。

1. 在隔离主机或新的 Compose 项目准备与备份兼容的 PostgreSQL 18、原收信配置和必要密钥。暂时不要把恢复实例接到现有 Tunnel/Worker，也不要启用旧公网 SMTP 25。
2. 从 restic 将一份 Mail Hero 快照恢复到受限目录，找到 `.pgdump` 文件；记录快照时间与预计丢失窗口。
3. 确认 `deploy/runtime.env` 强制发送暂停，然后运行 `./deploy/restore-empty.sh /secure/path/snapshot.pgdump`。脚本停止应用、检查转储目录并在空库内用单事务 `pg_restore` 导入。它不会自动重启应用或解除暂停。
4. 启动应用但仍保持暂停，核对恢复库的邮件、目标版本、event ID、尝试历史与消费者 inbox。对结果未知的在途事件，先对账；超过 30 天重放窗或接收方去重账本有效期的事件不得盲目恢复发送。
5. 完成检查后才重新接入 Tunnel/Worker、逐步解除强制暂停并观察 R2 积压和业务交付；若选择旧 SMTP 模式，再单独恢复 SMTP 入口。

内容删除不会立即从旧 restic 快照消失；快照按自己的保留期到期。`pg_restore` 的成功不证明 Worker 能收件、消费者幂等、真实邮箱能到达或浏览器登录有效，这些需要独立验收。

## 入口凭据和升级

默认 Cloudflare 路径不需要主机 SMTP 证书。定期检查 Tunnel token、Access Service Token 与 Worker 入站 Bearer token 的有效期及轮换步骤。当前入站 Bearer 只有单一有效值；轮换要安排短暂维护窗口，协调更新本地文件与 Worker Secret。窗口中尚未确认的原件应留在 R2；若出现认证暂停，确认新值生效后通过 Worker `/resume` 恢复，并用合成邮件验证 204/去重，不能清空 `pending/`。

下列 SMTP 证书操作仅适用于 `deploy/compose.smtp.yaml` 的旧公网 SMTP 模式：

SMTP 证书续期后更新 `deploy/certs/fullchain.pem` 与 `privkey.pem`，重启 app：

```sh
docker compose --env-file deploy/runtime.env \
  -f deploy/compose.yaml -f deploy/compose.smtp.yaml restart app
```

外部用 `openssl s_client -starttls smtp -connect mx.in.example.org:25 -servername mx.in.example.org` 检查主机实际出示的证书。短暂停机时上游会按各自政策重试；不要把它当作无限期保证。

应用升级先执行并确认离机备份，固定要部署的镜像版本，再单独更新 Mail Hero Compose 项目。`serve` 自动运行嵌入式 goose 迁移；也可在停 app 后运行 `docker compose ... run --rm app migrate`。迁移失败应停止应用，不自动降级 schema。PostgreSQL 大版本升级需单独评审和演练，不能仅改 Compose 的 major tag。不要调用会停掉或清理 Todofy 等其他项目的全栈升级脚本。
