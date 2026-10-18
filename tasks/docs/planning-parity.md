# Todoist Plus → Tasks 功能验收

Tasks 内置 Plan、Focus 和邮件。Tasks 保存任务，Todofy 保存规划与邮件状态，FlowDay 保存每日队列与计时；浏览器只使用 owner Access 和同源 API。旧扩展的连接口令不参与这条链路。

## 实现与覆盖

共享组件位于 `packages/planning-ui`；Tasks 分别用 `PlanningPage` 和 `MailPage` 承载规划与邮件。
下表列出已有的合成覆盖。真实发布、状态转换和只读生产核对另见 [verification.md](verification.md)。

| 功能 | 原生行为 | 覆盖 |
| --- | --- | --- |
| Plan | Quarter、Month、Week、Committed、工作／生活、等待和提前开始均保存为规划状态；普通标签没有这些含义，设置不再要求标签映射 | Tasks `planning-native.spec.ts`；共享 `native-planning.test.tsx`；Core `test_clients_native_tasks.py` |
| 本周目标 Bets | 工作／生活目标按周保存；沿用已有编辑与冲突行为 | 共享 `weekly-bets.spec.ts`；真实原生绑定的 Bets／依赖场景 |
| 子任务与依赖 | 打开原生任务，添加有估时的小步骤，独立设置 Deadline 与提前开始；依赖保存原内部任务身份 | 共享 `dependencies.spec.ts`、`deadlines.spec.ts`；真实 Core → TasksApi → D1 场景 |
| 周安排与排序 | 承诺全览、切周、步骤排序；拖入某日只改 FlowDay 队列；原生兄弟排序一次原子调用，最多 100 项 | 共享 `week-planner.spec.ts`、`native-order.test.ts`；Tasks `task-reorder.test.ts`；真实 Core 批量排序 |
| 周回顾 | 保留清单和完成动作；Mail 数量来自待处理摘要，零封显示 0；周一回退修改规划状态 | 共享 `weekly-review.spec.ts`；Core rollover、GTD 和原生 runtime 场景 |
| Focus | 直接使用已有每日队列和计时身份；Task 完成使用原生 API | Tasks `planning-native.spec.ts`；共享 `focus.spec.ts`；原生完成场景 |
| Mail | 新邮件只保存摘要，点 Create task 才创建 Inbox 任务；分类是可选普通标签／优先级快捷方式；删除 Mail 不删已有 Task | Tasks `mail.spec.ts`；Core `test_scenarios_native_mail.py`、`test_clients_native_tasks.py` |
| 无连接口令 | 登录 Tasks 后使用同源 owner API 和私有服务绑定；Mail 不依赖 Plan 设置或 FlowDay | Tasks 原生宿主和 Mail 浏览器场景；Gateway owner／CSRF／旧连接拒绝检查 |

旧扩展的浏览器场景继续在一次性 Chromium profile 和合成页面中检查共享交互。
这些测试不证明生产 Access、私有绑定或真实业务写入；原生 backend 场景单独使用真实 workerd/D1。

## 本轮退役边界

- 原生模式的 owner `/plus` 旧书签转到配置中的 Tasks 规划设置；跳转前仍验证 Access。旧 Todoist 模式保留原页面。
- Gateway 与 core 均拒绝原生模式的新扩展连接。既有连接行不删除，既有扩展入口已拒绝原生模式访问。
- Tasks 的规划请求由 owner Access、Origin 和 CSRF 校验后经 `Planning` 私有绑定转交；不会把浏览器凭据传给下游，也不会退回扩展 token 或旧任务源。
- CI 停止新 ZIP／GitHub Release 发布；旧 Release 和源代码保留供历史参考，回归用临时扩展构建仍保留。

`todofy/gateway/test/plus.test.ts` 已用合成请求核对旧书签、owner 与内部请求的连接签发拒绝；`todofy/tests/unit/test_plus_cache.py` 核对拒绝后旧连接记录未改变。这里不宣称已完成生产浏览器验收。
