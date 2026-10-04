# Bootstrap 与漂移恢复验收

本轮实现配置生成、Cloudflare 创建/采用、凭据初始化、固定 VPS bundle、GitHub 发布证据、typed daemon 修复和操作手册。
现环境上线先检查，再开放常规自动修复。当前分支开发中，仅登记已完成的检查。

| 范围 | 证据 | 状态 |
| --- | --- | --- |
| 换账户/域名/仓库 | cloud-config 测试；当前生成与 Wrangler/ID 文件等价 | 本地通过 |
| 真实 Cloudflare | 只读检查 10 Worker 的资源、变量、路由；服务 props 在 provider 读回省略时无法核实；Relay 新 BUILD_SHA 待发布 | 现环境已核对可读字段 |
| VPS typed reconcile | 229 tests、197 subtests；proto 合同检查 | 本地通过 |
| Fleet 观测和操作提示 | 对账 UI、分类和过期观测测试 | 本地通过 |
| 首建/采用/重复/中断 | bootstrap 34 tests、infra 104 tests；实际采用 5 个已有对象，后续重复运行无变更 | 合成检查及现环境采用通过；空环境留待后续 |
| 全量 CI、两次发布 | Actions、真实 SHA/digest/namespace、Fleet/Home | 待验收 |
| 隔离漂移、无差异不重启 | 7 项 CF API 边界、4 项真实 SDK HTTP/SSA 边界测试；旧计划、暂停和状态保护 | 合成隔离测试通过；真实环境待验 |
| 宿主入口恢复 | 固定 bundle 校验、接受版本、Secrets/PVC/账本保留回归 | 本地通过；真实宿主故障演练未做 |
| 真实空账户、干净 VPS | 独立环境端到端演练 | 留待后续 |
| 全部历史数据跨账户恢复 | 数据、密钥、冻结副作用对账 | 留待后续 |

结果同步到本页与 [HANDOFF](../HANDOFF.md)。模拟测试、实际发布、个人业务和历史恢复分别记录。

发布守卫：407 项 Python 测试通过（1 项本机条件跳过），Cloudflare 发布工具 22 项、完整 secrets-map 19 项通过。
新工作流通过 actionlint。Watch 的 props 省略误报已修复，Relay 的新增 BUILD_SHA 待首次发布。

实际采用过程验证了中断继续：标准导入仅登记缺失对象，未改变实际权限。
FlowDay 的 for_each 导入依赖在本机 OpenTofu 复现并修复；非 Worker audience 导出过滤后清单生成通过。
随后只更新生产 INFRA_TFVARS，现有应用密钥保留。provider 的空 selector 兼容例外见 [infra](../infra/README.md)。
