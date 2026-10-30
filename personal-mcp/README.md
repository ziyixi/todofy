# Personal MCP

私人 Dots 工具、持久工作记录和事件订阅。一个 Worker、一个 SQLite DO；Access 负责 OAuth。任务、邮件和浏览
内容留在原应用，MCP 保存继续工作所需的范围、状态和引用。

```sh
bazel test //personal-mcp:check
bazel build //personal-mcp
```

## 能做什么

- Work：读取上下文、创建工作、静默 checkpoint、报告与导出。
- Watch：指派监视、读取变化证据和实际截图，关联 Work 后由 Dot 判断意义。
- Tasks/Plan/Focus：经原生 API 收集、修改、安排和完成；不改变真实日期来实现日队列。
- Mail/Recall/Home：授权范围内读取、收进 Inbox、检索活动、查看截图与内容无关状态。

具体工具与权限以目录及[Dot skill](plugin/skills/personal-cloud/SKILL.md)为准。业务写入需要 owner 指令或明确
授权的持续职责；日期、承诺、完成、删除由 owner 决定。不确定写入沿用原 request ID 和内容，不盲目再做一次。

## 订阅和继续工作

`task.changed`、`task.must_start`、`mail.ready`、`service.attention`、`work.attention` 从当前状态开始，不回放全部
旧内容。订阅前已有的待处理报告从 Work context 读取。Watch 证据变化成为关联 Work 的报告，没有另一套公开
Watch 通知协议。

DO Alarm 只轮询有订阅的来源，冻结投递内容并保留原有有界重试。回调 accepted 只说明接收端接受，不代表 Dot
完成工作。Checkpoint 不通知；显式 report 可以通知。见[工作记忆](docs/work-memory.md)。

## 边界与运维

私有 service bindings 分别连接 Tasks、Todofy Mail、Watch、Recall 和 Home，并使用声明的访问权限。MCP 不保存
源应用正文、SDK context，也不运行服务端模型。协议复用官方 MCP SDK 与 Standard Webhooks。

日备份和恢复不重放业务副作用。正常发布走同一 green SHA 的 main Actions，在来源入口就绪后发布。扩展工具目录
后刷新现有私人插件，保留 App/OAuth 身份。连接路径与实际验收分别见：

- [连接](docs/connection.md)、[验收](docs/verification.md)
- [备份与恢复](docs/backup.md)、[协作规则](AGENTS.md)
- [根构建/依赖](../docs/bazel.md)、[CI/CD](../docs/ci-cd.md)

测试使用真实 workerd/SQLite 和本地签名回调，只含合成数据。构建、类型与测试脚本委托 Bazel；交互式本地开发不
连接生产。一次投递或本地 fixture 不能代替真实 Dots 的继续工作证据。
