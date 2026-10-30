# Fleet / 服务器监控

Fleet 保存 VPS 的有界状态报告，显示 k3s、系统 daemon、Newsletter 和 GitHub 发布回执。
它没有 SSH、远程命令或 Kubernetes 修改权限。Newsletter 仍是独立 VPS 服务。

Newsletter 的未确认数量是六类记录的合计，可能包含历史运行中断及重叠计数，不能当作失败邮件数。
只有投递、采编和 Notion 备份写入的未确认记录，以及每日投递逾期（最近接管超过 28 小时或结果未确认超过 2.5 小时），
才作为警告交给 Home；其余计数只作提示。阈值依据 07:00（洛杉矶）每日任务及夏令时，见 `worker/src/health.ts`。
Fleet 只显示计数；运行、期刊与 Notion 备份的详情在 Newsletter 控制台，按 Newsletter 自己的 SQLite 记录读取。
Fleet 保留只读；提醒的关闭与恢复在 Home 管理。导航地址由本应用 `wrangler.toml` 的公开 `HOME_URL` 与
`NEWSLETTER_URL` 声明（`tools/cloud-config/generate.py` 按公开配置生成），UI 构建时读取；不从观察报告或另一应用的配置推断地址。

Newsletter 的“内容配置”显示生效版本、摘要、上次检查目标、固定摘要、尝试与成功时间及安全错误码。
“与上次检查目标一致”只比较这份观测中的版本和摘要，不证明检查之后没有新发布。配置检查失败或超过
30 分钟未检查会向 Home 提醒；固定版本、等待激活与缺少旧版字段只作提示，不改变进程或每日投递结果。
Home 复用 `NewsletterOps.status()` 的信号与数值时间，版本身份只在 Fleet 显示，不增加远端检查。

- `worker/src/`：独立 HMAC 机器入口、Access owner API、SQLite DO 状态与 Home service bindings；`metrics.ts` 是节点遥测历史。
- `web/`：只读 owner UI，“概览”与“资源”两个标签；每分钟读取缓存观测，资源曲线每五分钟读取一次，不探测服务器。
- `platform/src/personal_cloud/observer/`：非 root k3s CronJob，使用平台镜像每五分钟发送状态与节点数值；只读挂载见 `observer/README.md`。
- `proto/fleet/` 与 `contracts/fleet-report-v1/`：owner API 与机器元数据合同。

机器路径 `/api/internal/fleet/v1/receipt` 单独 Access Bypass，只接受独立密钥签名；其余路径必须 owner JWT。
没有 owner mutation，因此没有 CSRF token 或管理动作。未来增加写操作必须先加入 Origin/CSRF 鉴权。

Fresh ≤10分钟，stale ≤20分钟，之后 missing；k3s 或节点失联也会停止 observer，不能确定故障原因。固定 scope 为 k3s/cloudflared/ssh 和 Newsletter。
`cloudflared_platform` 仅在 `FLEET_EXPECT_PLATFORM_TUNNEL=true` 时监督。只有真实部署 daemon 的当前 ACK 和 SHA、image、request ID
匹配，且 Newsletter worker 健康、gate active 时，部署才就绪。Pod ready 不替代 provider 业务成功。

## Build and check

```sh
bazel test //fleet:check
bazel build //fleet
```

构建/检查脚本使用相同的 Bazel 依赖；交互式开发保持本地绑定。工具安装见[根依赖指南](../docs/dependencies.md)。

## 节点遥测

报告可选携带 `metrics`（`fleet.telemetry.v1.NodeMetrics`）：累计计数原样上报，Fleet 在接收时用同一 boot 的上一份报告算
平均 CPU%（iowait 单列）与网络速率。重启（boot ID 变化）、计数回退、CPU 或网卡数量变化、间隔超过 15 分钟时只记仪表值，
不算速率，图上是缺口而不是零。旧 observer 没有 `metrics` 的报告照常接收；Fleet 先于平台镜像发布。

历史在 SQLite DO 的 `metric_points` 中按节点（`host_key`）分三层，每行存每个序列的和、计数与最大值：
5 分钟点保留 14 天，小时汇总 180 天，日汇总 2 年；单节点约 9,100 行、约 10 MB。每份报告写节点行与三层各一行，
到期行每层每次最多删 32 行且只经主键；workerd 实测稳定状态每份报告 6 行写、16 行读（每天约 1,700 写，Free 为 10 万）。

| 范围 | 读取层 | 步长 | 最多点数 |
| --- | --- | --- | --- |
| `day` | 5 分钟 | 5 分钟 | 288 |
| `week` | 小时 | 1 小时 | 168 |
| `month` | 小时 | 3 小时 | 240 |
| `half_year` | 日 | 1 天 | 180 |
| `two_years` | 日 | 3 天 | 244 |

Owner API（`proto/fleet/ui/v1`）：`GET /api/v1/nodes`、`GET /api/v1/nodes/{node}`（最新样本）和
`GET /api/v1/nodes/{node}:summarizeMetrics?range=&end_time=&metrics=`（每点为步长内 5 分钟样本的均值与最大值，
一次最多读 730 行）。任一上报文件系统用量 ≥90% 沿用现有 `disk_high`；ZFS 上按数据集计算。

Observer 的检查随 `//platform:check`；所有固定状态/遥测测试使用合成数据。生产仅通过 main Actions 发布，
安装与身份配置由根部署流程管理。

Fleet stores bounded VPS observations and release receipts. Its owner UI is read-only; its independent HMAC identity can only
submit telemetry. Missing telemetry remains unknown, and process/readiness checks never claim mail or model success.
