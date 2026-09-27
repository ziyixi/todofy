# Mail Hero → Todofy

Mail Hero的Todofy目标为 `https://daily.ziyixi.science/hooks/mail`，使用通用 `mail.received.v1`。Todofy独立发布，不依赖Mail Hero的代码、数据库或Cloudflare账户。双方只共享webhook合同和专用Bearer认证值。

## 持久接管与业务状态

Todofy 主容器挂载独立 inbox 目录，使用 SQLite WAL 和 FULL synchronous。首次接收先提交事件 ID、确切请求 bytes 的哈希及待办状态，再返回 204。相同事件与 bytes 的重复请求只确认已有记录；相同事件但不同 bytes 返回 409。认证值轮换不改变稳定来源 `mail-hero-personal`。

后台先持久保存摘要，再请求现有 Todoist 服务，最后写入原摘要缓存。Todoist 调用结果不确定时进入 `todo_unknown`，需要人工对账，不会自动重复创建任务。成功后保留去重账本，清除 inbox 的正文副本。详细恢复接口见 Todofy README 的 Mail Hero 部分。

Mail Hero 的“已交付”只代表 Todofy 已持久接管（消费者已接受该事件）。完整成功还要核实 Todofy 状态 `complete` 和实际任务 ID。接管之后的摘要或 Todoist 失败不会回写 Mail Hero，也不会出现在 Mail Hero 的提醒里；它们由下面 Todofy 自己的 attention 视图和每日提醒暴露。

## 卡住事件的发现与处理（Todofy 侧）

以下接口都在 Todofy 上，使用 owner 既有的 BasicAuth，响应只含事件 ID、状态、任务 ID、安全错误码、时间和计数，不含主题、地址或正文。

- `GET /api/v1/mail_inbox` 默认（或 `view=recent`）仍返回最新 100 条。`view=attention` 返回全部需要关注的事件，按创建时间排序，最多 500 条：状态为 `failed_summary`、`todo_unknown`，或创建超过 6 小时仍停在 `pending`、`summarizing`、`summarized`、`todo_sending`、`todo_created`。其他 `view` 值返回 400。两种视图都带按状态的 `counts`、`attention_count` 和最近一次每日提醒的状态 `latest_reminder`（没有则为 `null`）。
- LLM 暂时失败（`summary_failed`、`llm_client_unavailable`）继续自动重试，退避上限约 4 小时；失败达到 13 次且事件已超过 7 天才转为 `failed_summary`。`invalid_saved_event`、`summary_render_failed` 等确定性错误保持原来的 13 次规则。
- 处理方式仍是 `POST /api/v1/mail_inbox/<event_id>/reconcile`，带 header `X-Todofy-Admin-Action: reconcile-mail-inbox`，resolution 为 `task_created`、`task_not_created`、`retry_summary` 或新增的 `dismiss`。`dismiss` 必须带 `"confirmed_dismiss": true`，否则 400；只允许从 `failed_summary` 或 `todo_unknown` 执行，其他状态返回 409。成功返回 204，事件变为 `ignored`（错误码 `dismissed_by_owner`），清除 payload、摘要和任务正文，保留去重账本，相同事件重投仍只确认不重做。对 `todo_unknown` 执行 `dismiss` 不会检查 Todoist；应先确认任务是否已存在。

```json
{"event_id":"<event_id>","resolution":"dismiss","confirmed_dismiss":true}
```

### 每日 Todoist 提醒

owner 已选择不接外部告警渠道，改为由 Todofy 在有 attention 事件时，每个 UTC 日最多创建一条 Todoist 提醒任务。inbox 启用时默认开启，`TODOFY_MAIL_ATTENTION_REMINDER=false` 关闭。后台空闲时最多每 10 分钟检查一次，`attention_count` 为 0 时不做任何事。

- 标题为 `[Todofy System] Mail Hero：N 封邮件需要处理`；正文最多列 20 条 `事件 ID · 状态 · 错误码 · 收到时间（UTC）`，超出部分只给数量，再附上面的查询与处理步骤。不含邮件主题、地址或正文。
- 每日状态记录在 inbox 库的 `mail_inbox_reminders` 表，调用 Todoist 前先认领当天并冻结标题和正文。只有确定未创建任务的失败（todo 客户端不可用，或 todo 服务返回 `Unavailable`、`InvalidArgument`、`FailedPrecondition`）会在 1 小时后用同一请求重试，当天最多 5 次。超时、其他错误、没有任务 ID 的响应，以及创建过程中进程中断（重启后）都记为 `unknown`，当天不再重发：宁可当天漏一次提醒，也不重复创建任务。
- 这条提醒本身是真实的 Todoist 任务。它只提示 Todofy 侧的积压，不改变任何事件状态，也不能代替逐条对账。

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

## 已部署版本与验收边界（2026-09-26 UTC）

- Todofy提交`5f0e8c6232b24084a0fed99d975f4b2db5272235`的 [CI run 36261628140](https://github.com/ziyixi/todofy/actions/runs/36261628140)成功，服务器使用`ghcr.io/ziyixi/todofy@sha256:632dba1a1b70ab31667d7bfacffbbd50ef1e1b06dc565c0cc47c66733f831675`。
- 部署仓库提交[`2d529e86fc3a043c04fc76a2410d440bc895c240`](https://github.com/ziyixi/self-host-on-vultr/commit/2d529e86fc3a043c04fc76a2410d440bc895c240)已推送并在服务器fast-forward。只更新主容器，启动时间`18:23:55.711471621Z`；`18:24:17Z`检查healthy，digest及OCI revision匹配。三个gRPC依赖保持9月5日的原启动时间。
- 合成事件`96fe9dea-1a2b-4a04-a793-61b5a99e77d7`在更新后仍只有一条`ignored`记录，处理尝试次数0、task_id为空，证明inbox持久保存；该事件没有调用LLM或Todoist。
- Mail Hero清理提交`c0677406a75ee0de83c673a585b6383ab4860bc8`的 [CI/CD run 36262297081](https://github.com/ziyixi/mail-hero/actions/runs/36262297081)成功，Worker版本`e4fe47d3-61b8-4306-8cc7-d7822afd1c91`，D1没有待应用迁移。

Mail Hero已于`2026-09-26T18:26:05.583Z`通过授权的Cloudflare账户管理及D1原子条件更新激活：settings为forward、`send_paused=0`，目标`7886bda0-502a-438c-bc77-1a1aaf915710`已解除暂停；两者version均为2，当前目标revision为`3a866523-4ca1-4c6f-afae-8f8113406fbf`。Worker的`FORCE_SEND_PAUSED`与`MAINTENANCE_MODE`均为false，允许域名为`daily.ziyixi.science`，原`CREDENTIAL_KEY`绑定保留。这是账户管理与数据库状态核对，未声称进行了UI激活验收。

激活前没有delivery事件，历史archive邮件未补发；新邮件会唤醒DO并进入转发处理。完整用户测试信尚未安排或完成，不能把此配置状态当作LLM/Todoist业务成功。各项证据见 [验收记录](verification-native.md)。

## 原邮箱切换与验收

1. 确认部署就绪，在授权范围内解除强制暂停和目标暂停，选择forward及Todofy目标；同步GitHub中的部署变量，避免下次发布恢复暂停。
2. 向 `inbox-mail-hero@inbox.ziyixi.science` 发送一封无隐私测试信，主题使用独特标记，例如 `Mail Hero Todofy test 20260926`。
3. 逐层核对：Mail Hero 原件保存与解析 ready → 对应 webhook 204/已交付 → Todofy inbox complete → Todoist 中一个对应任务。相同事件的重投不能多建任务。
4. 验收通过后，由 owner 在各原邮箱的正规设置里，把 CloudMailin 转发目标替换成 Mail Hero 地址，保留源邮箱副本。不要同时把同一封邮件长期转发给两条业务入口，它们的事件身份不同，无法跨入口自动去重。
5. Gmail/Exchange 的转发验证邮件可能需要 owner 点链接或验证码；收到普通测试信不等于自动转发配置已完成。

历史 archive 邮件不会因为开启自动投递而自动补发。无需为了本次验收重发原来的 `Test` 归档邮件。

## 暂停与回滚

先在 Mail Hero 设置中暂停投递，再处理 Todofy 回滚。保持 inbox 目录、token 和稳定来源标识不变；镜像回滚不删除持久目录。服务器的更新命令只针对主服务：

```sh
docker compose pull todofy
docker compose up -d --no-deps todofy
```

旧镜像没有 inbox 路由时，保持 Mail Hero 暂停；恢复兼容镜像后继续同一事件，不生成新事件逃避对账。不要执行全栈 `update.sh`、`down` 或 prune。

新增 inbox 数据和认证文件需要纳入一致备份；不能仅复制正在写入的 SQLite 主文件而丢掉 WAL。现有备份目录覆盖不代表已经验证了停写快照和恢复，本轮不声称恢复验收通过。
