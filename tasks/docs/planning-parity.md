# Todoist Plus → Tasks 功能验收

Tasks 内置 Plan、Focus 和邮件。Tasks 保存任务、规划以及 Focus 的每日队列、计时和用时记录，Todofy 保存邮件状态；浏览器只使用 owner Access 和同源 API。

## 实现与覆盖

共享组件位于 `packages/planning-ui`；Tasks 分别用 `PlanningPage` 和 `MailPage` 承载规划与邮件。
下表列出现有的合成覆盖。真实发布、状态转换和只读生产核对另见 [verification.md](verification.md)。
2026-10-18 已在真实 Tasks 中核对原生设置、Plan、Focus、Mail，并确认 FlowDay 完整同步及队列／计时引用不变。
生产核对保持只读；写入动作使用隔离 Worker/D1 和浏览器场景验证。

| 功能 | 原生行为 | 覆盖 |
| --- | --- | --- |
| Plan | Quarter、Month、Week、Committed、工作／生活、等待和提前开始均保存为规划状态；普通标签没有这些含义，设置不再要求标签映射；Committed 在候选列下方单独一行；事项、步骤、快速事项和日历卡片可直接完成，Quick 隐含可单独安排 | Tasks `planning-native.spec.ts`（兄弟排序确认前保持等待）、`plan-completion.spec.ts`（Committed 一行的布局与 Tab 顺序；托盘步骤、日历步骤和事项经 Tasks 完成，日历步骤带它所在的日期，其余带 Focus 的日期，同一次写入里结算队列；失败后用同一请求 ID 和日期重试；完成事项时运行中的后代计时在同一次写入里停止并保存）；共享 `native-planning.test.tsx`、`planner.test.tsx`、`deadlines-ui.test.tsx`；Tasks Worker `planning.test.ts`（规划字段按掩码在 etag 下写入、原样重放、过期 etag 被拒） |
| 本周目标 Bets | 工作／生活目标按周保存；沿用已有编辑与冲突行为 | Tasks `planning-journeys.spec.ts`（按 etag 保存一次）；共享 `weekly-goals.test.tsx`、`bets.test.ts`；Tasks Worker `planning.test.ts`（Bet 按值写入：保存的文字重放，过期 etag 和已结束的周被拒） |
| 子任务与依赖 | 打开原生任务，添加有估时的小步骤，独立设置 Deadline 与提前开始；依赖保存原内部任务身份 | Tasks `planning-journeys.spec.ts`（详情中加依赖、在 Focus 完成前置任务后结清；一次 SetTaskLead 保存 Deadline 与提前天数）；共享 `dependencies-ui.test.tsx`、`dependencies.test.ts`、`add-step.test.tsx`、`api-dependencies.test.ts`；Tasks Worker `planning.test.ts`（依赖成组增删、完成释放等待、不成环、删除的前置任务） |
| 周安排与排序 | 承诺全览、承诺排序（即 Committed 一列的顺序）、切周、步骤排序；卡片整行拖动；拖入某日只改 Tasks 的每日队列（一次 MoveFocusStep）；原生兄弟排序一次原子调用，最多 100 项 | Tasks `planning-journeys.spec.ts`（排入某天、移到另一天各一次 MoveFocusStep，开发服务器 D1 里的队列随之改变；键盘在 Committed 一行左右移动、Esc 复原、向下键把 Week 的卡放进 Committed）、`planning-drag.spec.ts`（按卡片本身 8px 开始拖动、触屏按住 250ms、同一张承诺卡单击选中／双击打开／拖动排序）；共享 `planner.test.tsx`、`optimistic.test.tsx`、`native-order.test.ts`、`api-planning.test.ts`；Tasks Worker `task-reorder.test.ts`、`focus.test.ts`、`planning.test.ts`（Review 泳道顺序） |
| 周回顾 | 保留清单和完成动作；Mail 数量来自待处理摘要，零封显示 0；周一回退修改规划状态 | Tasks `planning-journeys.spec.ts`（回顾链接打开一次清单并清掉参数）；共享 `weekly-review.test.tsx`；Tasks Worker `planning.test.ts`（承诺过了它那周的周一读作每周，周日的选择属于下一周）、`jobs.test.ts`（周日回顾只建一次）、`review.test.ts` |
| Focus | 每日队列、计时和用时记录都在 Tasks；完成是一次 Tasks 写入，同时结算队列和相关计时；默认正计时；每张卡的已用时间打开当天的记录；日／周／月视图和日期切换；“已完成”勾选；今天的步骤整行拖动排序 | Tasks `planning-native.spec.ts`（开始、暂停、完成后队列标为已完成、计时空闲）、`focus-time.spec.ts`（正计时一分钟后完成存成一条记录、“已完成”刷新后不勾选；记录修改、添加和昨天的记录，浮层不移动、375px 不出窗口；周和月的合计、柱子和分组，月的日子打开“日”）、`planning-drag.spec.ts`（今天的步骤整行拖动一次 MoveFocusStep，刷新后保持，记录浮层里不拖动）；共享 `focus.test.tsx`、`focus-entries.test.tsx`、`focus-stats.test.ts`、`render-cost.test.tsx`、`optimistic.test.tsx`、`native-timer.test.tsx`、`native-api.test.ts`、`api.test.ts`、`host.test.tsx`；Tasks Worker `focus.test.ts`、`focus-writes.test.ts` |
| Mail | 新邮件只保存摘要，点 Create task 才由 Tasks 创建 Inbox 任务（2026-10-21 起 Tasks 自己转换，任务 ID 由邮件派生，重试不重复）；分类是可选普通标签／优先级快捷方式，存在 Tasks；删除 Mail 不删已有 Task | Tasks `mail.spec.ts`（开发服务器的合成 Todofy Mail 入口上真实转换）；Tasks Worker `mail.test.ts`（转换、丢失回答后的重试、关联任务移入 Inbox、etag 冲突、分类）；Core `test_mail_entry.py` |
| 无连接口令 | 登录 Tasks 后使用同源 owner API 和私有服务绑定；Mail 不依赖 Plan 设置或 Focus | Tasks `planning-native.spec.ts`；Tasks Worker `mail.test.ts`（`/api/mail/v1/*` 只转发列表、单封和删除，不带浏览器凭据）；Gateway `mail.test.ts`（Mail 入口按 `access` 放行） |

共享组件的测试在 `packages/planning-ui/test/`。Tasks 浏览器场景用一次性 Chromium、本地 D1 上的真实 Tasks Worker，以及 `planning-stub.ts` 合成的规划回答，Focus 用开发服务器自己的 D1；它们证明界面和请求，不证明生产 Access、私有绑定或真实业务写入。

Todoist Plus 扩展、它的连接口令和 hooks 主机上的 `/api/plus/*` 由 2026-10-18 的决定删除，随合并 `claude/tasks-cleanup` 的发布下线，见 [历史记录](../../docs/history/todoist-plus.md)。
