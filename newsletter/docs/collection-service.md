# HTTP 接口与运行约定

服务把“准备内容”和“发送邮件”分开。通常由 `newsletter-trigger` 负责调用；需要接入其他系统时，可以直接使用以下 HTTP 接口。

## 地址与权限

业务接口的请求体和响应使用 JSON，字段名为 `snake_case`；预览接口返回 HTML。消息定义来自公共 proto，但服务不启动 gRPC 端口。

| 用途 | 请求 | 所需 token |
| --- | --- | --- |
| 启动一期采编 | `POST /v1/runs` | editor |
| 查询进度 | `GET /v1/runs/{id}` | editor |
| 获取已经生成的简报 | `GET /v1/editions/{id}` | editor 或 send |
| 查看该期 HTML 预览 | `GET /v1/editions/{id}/preview` | editor 或 send |
| 发送该期简报 | `POST /v1/editions/{id}/send` | send |
| 健康检查 | `GET /healthz` | 无需鉴权 |

除健康检查外，请在请求头中携带 `Authorization: Bearer <token>`。两个 token 必须不同，且各至少 24 个字符；只负责生成内容的调用方不应持有 send token。

生产 Compose 不开放宿主机端口，触发器通过私有 Docker 网络访问 `http://newsletter:8080`。标准客户端仅在显式设置 `NEWSLETTER_ALLOW_INTERNAL_HTTP=1` 时接受这个内部地址；访问公网服务须使用固定 HTTPS 地址，不跟随重定向。不要把 token 放进 URL 或日志。

## 生成一期

例如，为某一天创建一个固定的请求键：

```http
POST /v1/runs
Authorization: Bearer <editor-token>
Content-Type: application/json

{"request_key":"daily-2026-09-09","issue_date":"2026-09-09"}
```

服务返回 `202` 和运行 `id`，表示任务已被接受，尚未完成。之后用这个 ID 查询：

```http
GET /v1/runs/<run-id>
Authorization: Bearer <editor-token>
```

当 `state` 为 `ready` 时，用返回的 `edition_id` 获取简报和预览。`blocked` 或 `failed` 表示本次未正常完成，应先查看状态和诊断，不要直接请求发送。处理步骤和失败后的行为见 [工作流说明](workflow.md)。

调用方只提交日期和请求键，不能通过这个接口替换指令、模型、文件路径或收件人。服务会保存本次使用的配置快照，后续配置更新不影响已经开始的运行。

同一日期、同一请求键重复提交会返回原运行。网络超时不等于任务失败：先查询已有状态，必要时仍使用原键重试，不要换键重新搜集。

## 查看预览并发送

用 `GET /v1/editions/<edition-id>` 获取该期数据，其中 `rendered.render_hash` 对应已经生成并保存的邮件内容。发送请求需要带上这个值：

```http
POST /v1/editions/<edition-id>/send
Authorization: Bearer <send-token>
Content-Type: application/json

{
  "id": "<edition-id>",
  "request_key": "<本次发送的固定请求键>",
  "expected_render_hash": "<rendered.render_hash>"
}
```

请求路径与正文中的 ID 必须一致。发送给谁、用什么发件地址由服务端配置决定，调用方不能覆盖。真实邮件投递还需开启 `NEWSLETTER_ALLOW_SEND=true` 并配置 Resend；持有 token 本身不代表可以绕过这些限制。

普通投递每天最多尝试一次，重复请求不会再次调用邮件服务。结果不明时会保留 `unknown` 状态，不能通过换键、删记录或重启服务重发。邮件服务接受请求，也不等于邮件已经到达收件箱。

逐题恢复和修订验证邮件属于管理员操作，不提供 HTTP 入口，参见 [维护指南](maintenance.md)。

## 调度、存储与启动检查

- 服务不自带 cron。现有部署的外部触发器每天按洛杉矶时间 07:00 启动，运行预算 90 分钟，客户端最多等待两小时。
- 同一个 SQLite 数据目录只能由一个服务进程占用。不要启动多个 Uvicorn worker，也不要把真实数据放在云同步目录。
- SQLite 保存运行、内容和发送记录；Notion 在后台同步材料与简报。Notion 暂时不可用不会阻塞新流程的邮件投递，旧刊期仍遵循其保存时的规则。
- 启动前检查本地存储、依赖、proto、模板和中文绘图资源；真实模式还检查专用 Codex 登录、模型目录及已启用的 Notion、Todofy 连接。
- 本地运行条件或授权配置错误会使启动失败。Notion、Todofy 的临时网络故障可以降级运行并记录诊断，详情见 [接入指南](live-acceptance.md)。

健康检查通过只说明服务可以接收任务，不证明后续模型额度充足、来源可读或邮件一定送达。需要实际调用模型检查输出格式时，使用另行授权的 [供应商兼容检查](provider-acceptance.md)，不把它当作普通启动步骤。

GitHub 的 [手动触发工作流](../../.github/workflows/newsletter-daily.yml) 是另一种可选调用端：仅准备内容，不定时运行，也没有发信权限。使用它之前需要服务具有可访问的 HTTPS 地址；私有 Docker 部署无需启用它。
