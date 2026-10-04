# Fleet / 服务器监控

Fleet 保存 VPS 的有界状态报告，显示 k3s、系统 daemon、Newsletter 和 GitHub 发布回执。
它没有 SSH、远程命令或 Kubernetes 修改权限。Newsletter 仍是独立 VPS 服务。

Newsletter 的未确认数量是六类记录的合计，可能包含历史运行中断及重叠计数，不能当作失败邮件数。
Fleet 保留只读；提醒的关闭与恢复在 Home 管理。导航地址由本应用 `wrangler.toml` 的公开 `HOME_URL` 声明，
UI 构建时读取；迁移 Home 域名时同步更新这一项，不从观察报告或另一应用的配置推断地址。

- `worker/src/`：独立 HMAC 机器入口、Access owner API、SQLite DO 状态与 Home service bindings。
- `web/`：只读 owner UI；每分钟读取缓存观测，不探测服务器。
- `platform/src/personal_cloud/observer/`：非 root k3s CronJob，使用平台镜像每五分钟发送状态；仅挂载系统 bus 和 meminfo 元数据。
- `proto/fleet/` 与 `contracts/fleet-report-v1/`：owner API 与机器元数据合同。

机器路径 `/api/internal/fleet/v1/receipt` 单独 Access Bypass，只接受独立密钥签名；其余路径必须 owner JWT。
没有 owner mutation，因此没有 CSRF token 或管理动作。未来增加写操作必须先加入 Origin/CSRF 鉴权。

Fresh ≤10分钟，stale ≤20分钟，之后 missing；k3s 或节点失联也会停止 observer，不能确定故障原因。固定 scope 为 k3s/cloudflared/ssh 和 Newsletter。
`cloudflared_platform` 仅在 `FLEET_EXPECT_PLATFORM_TUNNEL=true` 时监督。只有真实部署 daemon 的当前 ACK 和 SHA、image、request ID
匹配，且 Newsletter worker 健康、gate active 时，部署才就绪。Pod ready 不替代 provider 业务成功。

本地分别在 `worker/`、`web/` 运行 `npm ci`、lint/typecheck/test。Worker 另运行 `test:runtime`，web 另 build。
Observer 随平台镜像包含共享 proto；在 platform 环境运行 `python -m unittest discover -s tests/observer`，全是合成数据。
生产只能通过 main Actions 发布；首次 Access/身份配置与 VPS 更新由根部署流程管理。

Fleet stores bounded VPS observations and release receipts. Its owner UI is read-only; its independent HMAC identity can only
submit telemetry. Missing telemetry remains unknown, and process/readiness checks never claim mail or model success.
