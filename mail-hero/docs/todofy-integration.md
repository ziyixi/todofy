# Mail Hero → Todofy

Mail Hero 向 `https://daily.ziyixi.science/hooks/mail` 发送通用 `mail.received.v1`。Todofy 独立发布，不依赖 Mail Hero 的代码、数据库或 Cloudflare 账户。双方只共享 webhook 合同和专用 Bearer 认证值。

## 持久接管与业务状态

Todofy 主容器挂载独立 inbox 目录，使用 SQLite WAL 和 FULL synchronous。首次接收先提交事件 ID、确切请求 bytes 的哈希及待办状态，再返回 204。相同事件与 bytes 的重复请求只确认已有记录；相同事件但不同 bytes 返回 409。认证值轮换不改变稳定来源 `mail-hero-personal`。

后台先持久保存摘要，再请求现有 Todoist 服务，最后写入原摘要缓存。Todoist 调用结果不确定时进入 `todo_unknown`，需要人工对账，不会自动重复创建任务。成功后保留去重账本，清除 inbox 的正文副本。详细恢复接口见 Todofy README 的 Mail Hero 部分。

Mail Hero 的“已交付”只代表 Todofy 已接管。完整成功还要核实 Todofy 状态 `complete` 和实际任务 ID。

## 两个发布流程

- Mail Hero：`ziyixi/mail-hero` 的 GitHub Actions 执行原生检查、UI 构建、D1 migration 和 Worker deploy，使用既有 Free 资源。参见 [CI/CD](ci-cd.md)。
- Todofy：`ziyixi/todofy` 的 CI 通过后向 GHCR 发布 `sha-<commit>` 镜像。部署仓库 `ziyixi/self-host-on-vultr` 将主服务固定到 `ghcr.io/ziyixi/todofy@sha256:<digest>`，服务器只拉取和重建 `todofy`。不会随本次邮件接入重建三个现有 gRPC 服务。

服务器 Compose 的主服务配置包含：

```yaml
environment:
  TODOFY_MAIL_INBOX_PATH: /var/lib/todofy-mail/inbox.sqlite
  TODOFY_MAIL_WEBHOOK_TOKEN_FILE: /run/secrets/todofy-mail-webhook-token
  TODOFY_MAIL_SOURCE_ID: mail-hero-personal
volumes:
  - ./data/todofy-mail:/var/lib/todofy-mail
  - ./env/todofy-mail-webhook.env:/run/secrets/todofy-mail-webhook-token:ro
```

token 文件是单行随机认证值，权限 0600，虽以 `.env` 结尾但不作为 `env_file` 加载。文件属于私有部署材料，不能进入 Git。旧 CloudMailin 接口在迁移期间保留。

## 原邮箱切换与验收

1. 先向 `inbox-mail-hero@inbox.ziyixi.science` 发送一封无隐私测试信，主题使用独特标记，例如 `Mail Hero Todofy test 20260926`。
2. 逐层核对：Mail Hero 原件保存与解析 ready → 对应 webhook 204/已交付 → Todofy inbox complete → Todoist 中一个对应任务。相同事件的重投不能多建任务。
3. 验收通过后，由 owner 在各原邮箱的正规设置里，把 CloudMailin 转发目标替换成 Mail Hero 地址，保留源邮箱副本。不要同时把同一封邮件长期转发给两条业务入口，它们的事件身份不同，无法跨入口自动去重。
4. Gmail/Exchange 的转发验证邮件可能需要 owner 点链接或验证码；收到普通测试信不等于自动转发配置已完成。

历史 archive 邮件不会因为开启自动投递而自动补发。无需为了本次验收重发原来的 `Test` 归档邮件。

## 暂停与回滚

先在 Mail Hero 设置中暂停投递，再处理 Todofy 回滚。保持 inbox 目录、token 和稳定来源标识不变；镜像回滚不删除持久目录。服务器的更新命令只针对主服务：

```sh
docker compose pull todofy
docker compose up -d --no-deps todofy
```

旧镜像没有 inbox 路由时，保持 Mail Hero 暂停；恢复兼容镜像后继续同一事件，不生成新事件逃避对账。不要执行全栈 `update.sh`、`down` 或 prune。

新增 inbox 数据和认证文件需要纳入一致备份；不能仅复制正在写入的 SQLite 主文件而丢掉 WAL。现有备份目录覆盖不代表已经验证了停写快照和恢复，本轮不声称恢复验收通过。
