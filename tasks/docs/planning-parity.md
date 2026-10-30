# Todoist Plus → Tasks 功能验收

Plan、Focus、Mail 已由 Tasks 原生承载，旧扩展与连接口令已退役。Tasks 保存任务、规划、日队列和计时，Todofy
保存邮件；浏览器使用同源 owner API，应用之间用私有绑定。

2026-10-18 的只读验收核对了原生设置、队列/计时引用和既有规划状态；旧迁移执行细节保留在 Git，当前行为以
[Tasks 设计](design.md)、[规划就绪/导航](planning-readiness.md)和[验收记录](verification.md)为准。

合成测试覆盖：候选与 Committed 排序/切周、Bets、子任务/Steps/依赖、拖动日安排、完成与计时同批结算、周回顾、
邮件显式转换、读写权限与请求身份。测试使用真实本地 D1/Worker 和隔离浏览器；它们不代表生产 Access、私有绑定
或个人业务已经成功。

```sh
bazel test //tasks:check
```

原任务/队列身份、日期、历史与冻结兼容数据继续保留，不为实现新界面重写。退役背景见
[Todoist Plus 历史](../../docs/history/todoist-plus.md)。
