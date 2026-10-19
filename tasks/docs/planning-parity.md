# Todoist Plus → Tasks 功能验收

Tasks 内置 Plan、Focus 和邮件。Tasks 保存任务，Todofy 保存规划与邮件状态，FlowDay 保存每日队列与计时；浏览器只使用 owner Access 和同源 API。

## 实现与覆盖

共享组件位于 `packages/planning-ui`；Tasks 分别用 `PlanningPage` 和 `MailPage` 承载规划与邮件。
下表列出现有的合成覆盖。真实发布、状态转换和只读生产核对另见 [verification.md](verification.md)。
2026-10-18 已在真实 Tasks 中核对原生设置、Plan、Focus、Mail，并确认 FlowDay 完整同步及队列／计时引用不变。
生产核对保持只读；写入动作使用隔离 Worker/D1 和浏览器场景验证。

| 功能 | 原生行为 | 覆盖 |
| --- | --- | --- |
| Plan | Quarter、Month、Week、Committed、工作／生活、等待和提前开始均保存为规划状态；普通标签没有这些含义，设置不再要求标签映射；Committed 在候选列下方单独一行；事项、步骤、快速事项和日历卡片可直接完成，Quick 隐含可单独安排 | Tasks `planning-native.spec.ts`（兄弟排序确认前保持等待）、`plan-completion.spec.ts`（Committed 一行的布局与 Tab 顺序；托盘步骤、日历步骤和事项经 Tasks 完成，只有排在当天的步骤按其日期结算；失败后用同一请求 ID 重试；运行中后代按原日期结算）；共享 `native-planning.test.tsx`、`planner.test.tsx`、`deadlines-ui.test.tsx`；Core `test_clients_native_tasks.py`（规划状态重放、过期写入被拒、规划不进任务标签） |
| 本周目标 Bets | 工作／生活目标按周保存；沿用已有编辑与冲突行为 | Tasks `planning-journeys.spec.ts`（按 etag 保存一次）；共享 `weekly-goals.test.tsx`、`bets.test.ts`；Core `test_clients_native_tasks.py`（Bet 的 CAS 与持久化） |
| 子任务与依赖 | 打开原生任务，添加有估时的小步骤，独立设置 Deadline 与提前开始；依赖保存原内部任务身份 | Tasks `planning-journeys.spec.ts`（详情中加依赖、在 Focus 完成前置任务后结清；一次 SetTaskLead 保存 Deadline 与提前天数）；共享 `dependencies-ui.test.tsx`、`dependencies.test.ts`、`add-step.test.tsx`、`api-dependencies.test.ts`；Core `test_clients_native_tasks.py`（依赖持久化、真实完成释放等待、删除的前置任务） |
| 周安排与排序 | 承诺全览、切周、步骤排序；拖入某日只改 FlowDay 队列；原生兄弟排序一次原子调用，最多 100 项 | Tasks `planning-journeys.spec.ts`（只用 FlowDay 队列排入、移到另一天，不触发同步；键盘在 Committed 一行左右移动、Esc 复原、向下键把 Week 的卡放进 Committed）；共享 `planner.test.tsx`、`native-order.test.ts`、`native-api.test.ts`；Tasks Worker `task-reorder.test.ts`；Core `test_clients_native_tasks.py`（100 个兄弟一次原子排序、泳道顺序） |
| 周回顾 | 保留清单和完成动作；Mail 数量来自待处理摘要，零封显示 0；周一回退修改规划状态 | Tasks `planning-journeys.spec.ts`（回顾链接打开一次清单并清掉参数）；共享 `weekly-review.test.tsx`；Core `test_clients_native_tasks.py`（周一回退只改规划、保留下周选择；新一周的第一次写入先在一个 D1 事务里结清旧周）、`tests/unit/test_plus_rollover.py`、`tests/unit/test_native_rollover.py` |
| Focus | 直接使用已有每日队列和计时身份；Task 完成使用原生 API | Tasks `planning-native.spec.ts`；共享 `focus.test.tsx`、`native-timer.test.tsx`、`native-api.test.ts`；Core `test_clients_native_tasks.py`（完成精确重放、只结算已完成的后代） |
| Mail | 新邮件只保存摘要，点 Create task 才创建 Inbox 任务；分类是可选普通标签／优先级快捷方式；删除 Mail 不删已有 Task | Tasks `mail.spec.ts`；Core `test_scenarios_native_mail.py`、`test_clients_native_tasks.py`（转换、分类标签、关联任务已不在、删除不删任务） |
| 无连接口令 | 登录 Tasks 后使用同源 owner API 和私有服务绑定；Mail 不依赖 Plan 设置或 FlowDay | Tasks `planning-native.spec.ts`；Tasks Worker `planning-proxy.test.ts`；Gateway `plus.test.ts`（Planning 通道只放行 Tasks 用到的方法） |

共享组件的测试在 `packages/planning-ui/test/`。Tasks 浏览器场景用一次性 Chromium、本地 D1 上的真实 Tasks Worker，以及 `planning-stub.ts` 合成的规划和 FlowDay 回答；它们证明界面和请求，不证明生产 Access、私有绑定或真实业务写入。Core 场景在 workerd 中连接真实 Tasks Worker 与 D1。

Todoist Plus 扩展、它的连接口令和 hooks 主机上的 `/api/plus/*` 已于 2026-10-18 删除，见 [历史记录](../../docs/history/todoist-plus.md)。
