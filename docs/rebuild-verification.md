# Bootstrap 与漂移恢复验收

本轮实现配置生成、Cloudflare 创建/采用、凭据初始化、固定 VPS bundle、GitHub 发布证据、typed daemon 修复和操作手册。
现环境上线先检查，再开放常规自动修复。下面区分本地测试、实际发布和仍需演练的部分。

| 范围 | 证据 | 状态 |
| --- | --- | --- |
| 换账户/域名/仓库 | cloud-config 测试；当前生成与 Wrangler/ID 文件等价 | 本地通过 |
| 真实 Cloudflare | 全量发布后核对 10 Worker 的资源、变量、路由及版本；服务 props 在 provider 读回省略时无法核实 | 现环境已核对可读字段 |
| VPS typed reconcile | 229 tests、197 subtests；proto 合同检查 | 本地通过 |
| Fleet 观测和操作提示 | 对账 UI、分类和过期观测测试 | 本地通过 |
| 首建/采用/重复/中断 | bootstrap 34 tests、infra 104 tests；实际采用 5 个已有对象，后续重复运行无变更 | 合成检查及现环境采用通过；空环境留待后续 |
| 全量 CI、两次发布 | 首次全量发布及独立 Website；第二次 VPS 发布；按变更范围保留未改动 Worker 的成功版本 | 现环境两次发布通过 |
| 隔离漂移、无差异不重启 | 实际 CF cron/binding 漂移与恢复、真实 k3s SSA/409、两版生产 clean repair 的 Pod UID/generation 对照 | 实际验收通过，范围见下文 |
| 隔离 DNS 漂移 | 固定 provider 合成 plan 与分类器通过；物理 fixture 的只读准备检查返回 403，未创建记录 | 真实 DNS 恢复待验；生产 DNS 检查已通过 |
| 宿主入口恢复 | 固定 bundle 校验、接受版本、Secrets/PVC/账本保留回归 | 本地通过；真实宿主故障演练未做 |
| 真实空账户、干净 VPS | 独立环境端到端演练 | 留待后续 |
| 全部历史数据跨账户恢复 | 数据、密钥、冻结副作用对账 | 留待后续 |

结果同步到本页与 [HANDOFF](../HANDOFF.md)。模拟测试、实际发布、个人业务和历史恢复分别记录。

发布守卫：407 项 Python 测试通过（1 项本机条件跳过），Cloudflare 发布工具 22 项、完整 secrets-map 19 项通过。
新工作流通过 actionlint。Watch 的 props 省略误报已修复，Relay 的新增 BUILD_SHA 已实际发布。

## 首次实际发布

`adaa835` 的 [分支 CI](https://github.com/ziyixi/todofy/actions/runs/37191723503)通过后，同一 SHA 进入 main。
[全量发布](https://github.com/ziyixi/todofy/actions/runs/37192028704)、
[Website 独立发布](https://github.com/ziyixi/todofy/actions/runs/37192071431)和
[发布后对账](https://github.com/ziyixi/todofy/actions/runs/37192262241)均成功。
对账的 Worker 构建、写 secrets 和部署步骤全部跳过。Fleet 读回配置一致、两个 workload 的目标与实际 SHA/digest 一致、generation 10、Newsletter 1/1 和四项 daemon 运行中。
Home 的构建为 `adaa835`，已有提醒关闭状态保留。以上证明部署和观测，不代表新增真实业务任务或历史恢复验收。

CI 新增官方固定 digest 的临时 k3s API 测试，核对真实 SSA、409 所有权冲突和 Secret/PVC 对象保留。
本机没有可用 Docker engine，该测试本机跳过；随后在 GitHub 的 Platform checks 实际通过。
API-only 集群没有节点，不证明 Pod 就绪、挂载卷数据或宿主恢复。

## 第二次实际发布与修复

`4f1306b` 的 [完整分支 CI](https://github.com/ziyixi/todofy/actions/runs/37193088127)通过后，同一 SHA 进入 main。
[第二次发布](https://github.com/ziyixi/todofy/actions/runs/37193606971)、
[发布后检查](https://github.com/ziyixi/todofy/actions/runs/37193806220)和
[无差异修复](https://github.com/ziyixi/todofy/actions/runs/37194048785)成功。
两个镜像和固定 bundle 已发布；未改动的 Workers 继续使用 `adaa835` 的独立成功记录。
检查读回九个 Worker 应用及 VPS 均为 clean、差异为零。
修复前后，三项固定 Deployment 的 generation 均为 11，三个业务 Pod 的 UID 与重启计数均不变。

10:00 UTC 的实际 Fleet 回执核对 `4f1306b` 的两项目标/实际 SHA、digest、generation 11，Newsletter 1/1，四项 daemon 运行中。
Home 在同一时段显示暂无未处理提醒，原有提醒关闭状态保留。
GitHub Deployment 回执仅在真实身份核验后记录；CI 绿色状态、容器构建和个人业务成功分别判断。

## 隔离漂移的实际范围

Cloudflare 测试只创建三个随机测试 Worker，关闭公开路由、workers.dev 和 preview，不带数据或 secrets。
将测试 cron 与 service binding 分别改成不同值后，真实 reader 准确报 `SCHEDULE_CHANGED` 和 `BINDING_TARGET_CHANGED`；
用固定 Wrangler 重新应用原配置后，API 读回差异为零。所有测试 Worker 按精确 ID/归属核对后删除，并验证不存在。
这证明配置检测和重新应用，不证明 cron 的实际执行传播时间或 provider 省略的 service props。

临时 k3s 使用固定官方镜像，只运行真实 API。实际 SDK 验证 Deployment 的安全上下文、卷引用、readiness path 与镜像恢复；
dry-run 不改变 ConfigMap resourceVersion、Deployment UID/generation；其他 manager 的字段冲突返回 409；Secret/PVC 对象保留。
暂停、旧计划、CAS、账本和排空身份保护另有回归测试。宿主不可达后的固定恢复入口仅完成本地验证，尚未人为停止生产宿主来演练。

常规自动修复已在上述发布/检查/clean repair 通过后启用。Access、密钥、字段归属、持久资源身份变化和人工暂停继续按手册停止或要求明确处理。
真实空账户、干净 VPS、完整历史迁移和物理 DNS 恢复仍单列待验。

实际采用过程验证了中断继续：标准导入仅登记缺失对象，未改变实际权限。
FlowDay 的 for_each 导入依赖在本机 OpenTofu 复现并修复；非 Worker audience 导出过滤后清单生成通过。
随后只更新生产 INFRA_TFVARS，现有应用密钥保留。provider 的空 selector 兼容例外见 [infra](../infra/README.md)。
