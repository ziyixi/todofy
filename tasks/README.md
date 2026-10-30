# Tasks

个人任务与执行规划，替代旧 Todoist/扩展组合。Tasks 拥有任务、项目、标签、历史、Plan、Focus、Goals 和 GTD。
Todofy 保留邮件，Tasks 的 Mail 页只在你确认转换时创建任务。

```sh
bazel test //tasks:check
bazel build //tasks
```

## 使用

- 主列表：Inbox、Today、Upcoming、搜索、项目/分区、标签、筛选和完成历史。子任务默认折叠，可原地展开、完成和拖动。
- Task/Subtask 表达结果；Step 表达可执行动作，不出现在普通任务列表。Standalone 安排任务本身，Quick 是短独立动作；Routine 是独立属性。
- Plan：候选看板、完整宽度的 Committed 区和周安排。拖到某天只改日队列，不改真实日期或 Deadline。
- Focus：当天执行、排序、计时和时间记录。支持迷你计时窗；周/月统计在 GTD。
- Goals：年度 Objective/KR 与周 Bets、Tasks 的可选关联。Step 继承父任务关联，完成工作不会自动完成 KR。
- GTD：完成与耗时回顾，区分 Tasks、Steps 和 Routine；统计口径见[说明](docs/gtd.md)。

日历周从周日开始，未完成承诺在周六结束后回到候选。Deadline 的提前窗口和已完成的依赖会把任务浮现到
Parked 待安排，不发送定时提醒。保存主任务关闭详情；保存从父任务打开的子任务/Step 返回父任务。

可安装桌面 PWA，任务数据与写入仍需在线。评论、附件、协作指派、外部日历和语音不在本应用范围内。

## 边界和维护

Worker/D1 是权威状态；前端只用根 proto API。任务、规划属性和依赖共享同一个资源/etag。列表分页且有索引，
计时动画不轮询服务器。Home/Watch 用 create-only TaskInbox；私人 MCP 用声明的 TasksApi 权限。

正常发布只走同一 green SHA 的 main Actions，保留现有依赖顺序、迁移和生产对账。测试使用合成数据，覆盖真实
D1、请求重放、编辑、循环、父子关系、拖动、计时和浏览器界面；不操作原 Todoist 账户。

- [设计和界面](docs/design.md)、[批准的视觉基准](design-qa.md)、[协作规则](AGENTS.md)
- [Goals](docs/goals.md)、[GTD](docs/gtd.md)、[规划就绪与导航](docs/planning-readiness.md)
- [导入](docs/import.md)、[备份/恢复](docs/backup.md)、[验收边界](docs/verification.md)

原任务 ID、历史和数据迁移保持；不维护双向 Todoist 写入。交互式本地开发使用原 local-only 合成服务器和应用
`dev` 命令，构建/检查脚本委托 Bazel。工具与依赖安装见[根指南](../docs/dependencies.md)。
