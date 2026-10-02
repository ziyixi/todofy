# 发布排空合同 v1

Newsletter 继续使用独立 VPS 进程、专用可刷新的 Codex 登录目录和原 SQLite。
monorepo 新镜像为 `ghcr.io/ziyixi/todofy-newsletter`；源码与发布入口现在属于 Todofy monorepo。
本合同用于以后按固定 digest 升级该服务，本次入仓不升级 VPS，不调用模型或发信。

## 排空的含义

`begin` 在 SQLite 的同一写事务里关闭入口；每个新 HTTP run、发送、Worker
step、Notion 投影和本地 Notion intake 在领取或写入前先登记活动。已登记的活动
自然完成并写回原账本；后续 step 暂停。采编 DAG 可能跨多个 step，排空不要求整期
跑完。queued 任务与已冻结输入、原 run/event/request key 保留，恢复后按原状态继续。

`freeze` 同时核对活动账本和实际 submitting/running 账本，而非仅检查旧
`admin status` 的 `busy=false`。需为零的记录包括：活动、运行中刊期、包投影、
workflow attempt、Notion create/append，以及邮件 submitting。扫描、Notion
PATCH、上传、模型等待和本地渲染由外围活动覆盖。冻结回执包含队列与 unknown 数量，
不含邮件正文、提示词、模型输出、供应商响应或登录信息。

正常结束但供应商结果为 unknown 的活动已经停止在本机执行，可以冻结；unknown
原账本不改写为成功，也不授权重发。SDK close 失败/超时或清理被取消时，即使普通模型 timeout 已转成业务失败，
原活动也持久记为 uncertain，不能被 Worker 的异常处理正常返回抹掉。
对 cancelled/SystemExit 等中断，活动同样记为
uncertain，继续阻止 freeze。只有服务取得原有独占目录锁、确认旧进程已经退出后，
启动恢复才把残留活动记为 interrupted，并由原恢复逻辑保存供应商 unknown。
这避免取消 `to_thread` 等操作后误称后台工作已结束。异常情况下须停止旧服务及其子进程（容器退出或受管理的进程组），在
同一数据库重启并保持 gate，再重新核对冻结；不能删活动记录或另启第二进程绕过锁。

gate 与操作回执没有 TTL，不会因为请求超时、进程重启或一天过去自动恢复。
`begin` 同键重复返回原操作；已 resumed 的旧键不会创建新一轮 drain。
不同活动操作冲突；旧 resume 不能解除新的 drain。每次发布使用新的稳定操作键。
重复 freeze 返回第一次冻结的快照。`resume` 可以明确放弃正在等待的 drain，
或在成功升级后恢复领取；不会生成新 run、批准发送或重放 unknown。

## 私有机器 HTTP 接口

沿用既有 `NEWSLETTER_SEND_TOKEN` Bearer 身份，editor token 无此权限。
不新增 owner UI、公共入口、跨应用导入或共享 proto。调用端只允许私有网络或
HTTPS；token 只放环境或正规 secret store，不放 URL、参数、日志或聊天。

| 接口 | 输入 | 成功行为 |
| --- | --- | --- |
| `GET /internal/deployment/drain` | 无 body | 一致读取当前状态与计数 |
| `POST /internal/deployment/drain/begin` | `{"request_key":"release-<commit>"}` | 持久关闭接单和领取 |
| `POST /internal/deployment/drain/freeze` | 同上 | 在实际在途为零时持久冻结 |
| `POST /internal/deployment/drain/resume` | 同上 | 仅恢复对应操作，并唤醒 Worker |

POST 仅接受 `application/json`，最多 1024 bytes，只允许唯一 `request_key`。
键为 1–128 个可打印 ASCII 非空白字符。不接受额外字段、重复键、布尔/数字键或
任意动作。输出版本 `version:1`，含 `request_key`、`state`、`busy`、`inflight`、
`unknown`、`queued`；状态为 active/draining/frozen/resumed。计数不是供应商对账。
状态 GET 对 frozen gate 给出当前计数；freeze 的持久回执是原冻结时刻的快照。

| 状态码 | 含义 |
| --- | --- |
| 200 | 读取或转换成功；发布器仍须核对请求键及 frozen 状态 |
| 400 / 413 / 415 | 输入不合法、过大或内容类型错误 |
| 401 | 身份不具备 send 权限 |
| 404 | 未知机器动作 |
| 409 `deployment_busy` | 仍有活动，允许按同键有界轮询 freeze |
| 409 `deployment_conflict` | 操作键冲突；不能轮询绕过或换键取消别人的 drain |
| 503 `deployment_draining` | 新业务 run/send/维护请求被 gate 拒绝，Retry-After 30 秒 |

业务查询、预览和健康检查仍可用。`/healthz` 200 表示进程健康，不代表 gate 已恢复；
正常 frozen 服务仍健康。POST run 的同键重复在 drain 期间也拒绝，恢复后返回原回执。

## CLI 与升级顺序

CLI 调用运行中的 API，不另开 SQLite writer，不启动 provider 或 worker。
环境为 `NEWSLETTER_SERVICE_URL` 和 `NEWSLETTER_SEND_TOKEN`。
默认 origin 为本机 `http://127.0.0.1:8080`；容器私网可用 `http://newsletter:8080`；
其它主机必须 HTTPS。客户端不跟随重定向，不继承代理，响应上限 64 KiB。

```sh
newsletter admin drain status
newsletter admin drain begin --request-key 'release-<完整commit>'
newsletter admin drain freeze --request-key 'release-<完整commit>' --wait --timeout 7200
# 核对输出确为对应 key 的 frozen，并记录 unknown / queued 计数。
# 暂停唯一外部触发器与配置同步器，备份并停止旧进程，切固定镜像 digest。
# 保留相同 data/auth/config 挂载；新进程独占同一数据目录并仍处于 frozen。
newsletter admin drain status
# 核对新版本、健康、存储/配置身份与回执后，显式恢复：
newsletter admin drain resume --request-key 'release-<完整commit>'
```

客户端严格核对完整固定响应字段、version 的整数类型、非负整数计数、busy 与
inflight 一致性、对应操作键及允许状态。freeze 必须 frozen 且 busy=false；begin
不接受 resumed 回执；额外正文/内容字段、布尔计数或错误状态均失败。

freeze 只有 `deployment_busy` 会重试，每次约 2 秒、受 timeout 限制。超时或网络
失败退出非零，保留 drain；不会取消模型、自动 resume 或继续更新镜像。需要放弃
本次升级时，先核对版本与对应 gate 再用同键 resume。`begin` 输出 resumed 表明
操作键已经用过，发布器必须拒绝，不能把它当新 drain。

SQLite schema 只增加三个 `deployment_*` 表，不重写采编、发送或 Notion 账本。
备份需包含整个既有 data、WAL/SHM、冻结材料与配置快照；恢复仍遵守原 unknown
对账要求。回退前核对目标版本的 schema 兼容性。**旧版 c3d622d 没有 drain gate**，
会忽略这些新增表；不能把 gate 当成旧版的暂停能力。首次从旧版升级或回退旧版时
仍需停唯一触发器、等待真实在途、停止旧服务并备份，再按旧维护指南操作。

## 本地验证边界

`tests/test_deployment_drain.py` 使用合成 SQLite、mock editor/mail 与 HTTP transport，
覆盖 admission/begin 竞态、排队保留、当前 step/send 完成、unknown、取消后禁止冻结、
持久 gate 的重启恢复、重复/过时键、权限与严格 body、轮询和超时不恢复。
这不证明生产 Codex 子进程、Notion、Resend、VPS 升级或真实恢复已经验收。
