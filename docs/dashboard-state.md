# Dashboard 状态与操作

Home 汇总服务状态和提醒；Fleet 核对 VPS 的进程、发布版本与观测时间。遇到异常先看具体服务、检查时间和下一步操作。
旧页面提交后台工作操作时若要求刷新，刷新后重新选择服务。

## Newsletter

运行健康、最近发送记录和历史待核对记录分别显示：

| 状态 | 含义与操作 |
| --- | --- |
| 进程正常、队列为空 | 当前服务在运行，不证明每一条历史操作已经完成 |
| 邮件服务已接管 | 最近发送记录收到 provider 的接管回执；最终到达收件箱仍需邮箱端确认 |
| 发送被拒绝 | 查看 Newsletter 的发送配置和 provider 错误，处理后再按业务流程重试 |
| 投递逾期（警告） | 没有投递记录、最近接管超过 28 小时，或结果未确认超过 2.5 小时；核对每日 07:00（洛杉矶）任务 |
| 可能有副作用的待核对记录（警告） | 邮件投递、采编记录或 Notion 写入缺少确定结果；先核对实际邮件和 Notion，避免直接重发 |
| 其余待核对记录（提示） | 只有运行中断或工作流步骤缺少结果；计数保留显示，不形成提醒 |
| 暂停、不可达或观测过旧 | 按 Fleet 的发布与运行状态处理，刷新取得新的回执 |

已收到邮件可以与历史待核对记录同时存在。页面保留各类数量，提醒可以关闭。
关闭仅记录 owner 已处理这次提醒，保留原业务状态，也不会重发邮件。

28 小时覆盖 24 小时、夏令时 1 小时、2 小时 05 分的任务期限和余量；发送被拒绝时只显示拒绝提醒。
历史待核对记录不使 Newsletter 变为降级。

Newsletter 为首次观察到的待核对记录分配单调递增的 `unknown_revision`；最近发送记录的时间是该记录的更新时间。
`newsletter_unknown` 现为提示，不再形成 Home 提醒，按批次关闭只对此前已有的提醒有意义；
可能有副作用的提醒暂按 Home 的通用规则关闭与恢复。

## 按服务延后后台工作

在运维页选择具体服务，再点“延后 24 小时”或“恢复”。只影响选中的服务，页面同时显示目标与实际回执。
下发失败时处理显示的原因；下一次巡检会重试。没有回执时，不能认为设置已经执行。

| 服务 | 延后的工作 | 继续执行 |
| --- | --- | --- |
| Mail Hero | 原件对账、保留期清理、金丝雀和告警历史清理，每项最多延后 48 小时 | 收件、解析、投递、重试 |
| Todofy | 新一轮每周备份、过期数据清理和趋势统计；清理与统计最多延后 72 小时 | 邮件处理、进行中的备份；备份过旧时仍启动备份 |
| Lab | 定时抓取、嵌入、排序、简报生成、来源解析和清理 | 手动阅读、决定与发送 |
| Watch | 定时网页检查间隔延长到至少一天，延后每日维护扫描 | 手动检查、变化确认与通知 |

手动延后 24 小时后自动结束。“恢复”同时暂停该服务的自动延后，直到下一个 00:00 UTC；确认框显示本地时间。
自动策略在配额达到 80% 时延后非关键工作，降到 70% 以下时解除。每个服务的手动设置独立保存。
Newsletter 和 Fleet 没有此能力，不显示操作按钮。

## 资源登记

应用资源以各应用的 `wrangler.toml` 为准，账户和已核验资源身份在 [resources.toml](../config/resources.toml)。
应用 binding 之外的 R2 桶在 [account-resources.toml](../config/account-resources.toml) 明确登记归属：
`infra-state` 属于基础设施 bootstrap；仓库外的已有桶标为 `external`，不会自动接管。

当前 Worker 列表来自 Cloudflare REST 实际清单，包含没有流量的 Worker。
Analytics 仍可能返回已经退休的 Worker，它们进入历史用量，不再计为当前未登记资源。
Analytics 缺少名称维度的汇总也不会被当作一个真实 Worker。
真实存在且没有登记的对象仍会报告异常，不能通过隐藏行消除。

新增或迁移资源后，在仓库根目录使用 Python 3.11 以上运行：

```sh
python3 tools/service-catalog/catalog.py
python3 tools/service-catalog/inventory.py --generate
python3 tools/service-catalog/catalog.py --check
python3 tools/service-catalog/inventory.py --check
```

提交生成的 `dashboard/worker/src/account-inventory.json` 与对应配置变更。
新增或改名资源时，同步 `dashboard/worker/src/registry.ts` 中的资源名称和归属；
Home 的测试会逐项核对清单，遗漏会阻止 CI 通过。
生成器拒绝未知归属、非法桶名和重复登记；CI 拒绝过期的生成清单。

## 检查实际账户

每天、成功 main 发布后以及手动运行 **Personal cloud reconcile** 时，
“Verify complete account resource registration”检查 Worker、D1、DO namespace 和 R2 的实际身份。
期望对象缺失或出现未登记对象都会失败；无法确认分页已经结束也会失败。
公开 Actions 日志只显示差异计数，不输出 provider 原始响应。

立即检查：

```sh
gh workflow run personal-cloud-reconcile.yml --ref main -f operation=check
```

确认差异归属后，补配置或走 [偏差修复流程](rebuild.md#检查与修复)。
数据库、桶和 namespace 缺失时先按恢复流程处理，不能创建空资源来让检查通过。
清单检查只读，不会采用或删除陌生对象。

CI 能阻止漏提交资源登记；账户内的手动改动要到下一次检查才能发现。
状态来源不可达或观测过旧时，Dashboard 保留“不确定”的提示并显示检查时间，不能用上一次成功代替当前核验。

## 2026-10-04 验收

`8937e61` 的 [分支 CI](https://github.com/ziyixi/todofy/actions/runs/37228587877)、
[main 发布](https://github.com/ziyixi/todofy/actions/runs/37229075275)和
[发布后检查](https://github.com/ziyixi/todofy/actions/runs/37229282583)成功。
新鲜 VPS/Fleet 回执确认实际源码为同一 SHA、发布 generation 为 12，两个镜像 digest 匹配发布目标。

最近发送记录为 `provider_accepted`。34 条历史待核对记录全部属于 `workflow_attempts`，
发送及其余类别为零。线上 Newsletter 运维区域状态正常，提示“最近一次邮件已被邮件服务接管。下一步：无需操作。”
Home 的批次 34 已关闭，刷新后没有未处理提醒或摘要项目；Todofy 最新回执已保存零项摘要。
桌面 Newsletter 行自动增高到 77.1 px，换行后没有溢出；`infra-state` 在月度 R2 用量和 R2 表均正确归属。
本次验收没有触发新的业务发送。

最后的 Home 文案修正 `d4a2aa9` 已通过
[分支 CI](https://github.com/ziyixi/todofy/actions/runs/37230057641)、
[main 发布](https://github.com/ziyixi/todofy/actions/runs/37230332240)和
[发布后检查](https://github.com/ziyixi/todofy/actions/runs/37230452684)。
13:00 本地时间的自然巡检后，浏览器显示 11 个当前 REST Worker 全部登记，包含没有流量的 `ziyixi-website`。
`__unknown__` 和 `ziyixi-apex-redirect` 只出现在独立历史用量区，文案注明当前没有对应资源。
Home 页脚为 `d4a2aa9`，没有未处理提醒、已忽略一项；Newsletter 批次跨新巡检保持关闭。
