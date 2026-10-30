# Home

个人云的私人首页，提供服务入口、流程状态、Cloudflare 用量/漂移和运维操作。它通过各应用的内容无关 Ops
接口、配置清单和平台元数据观察状态，不读取邮件、任务正文或其他应用数据库。

```sh
bazel test //dashboard:check
bazel build //dashboard
```

## 页面

- 首页：应用、网站和后台服务入口，实际健康状态、提醒和流程摘要。
- 业务流程：各处理阶段与来源、状态和下一步操作。
- Cloudflare：账户用量、Worker/D1/DO/R2 清单和配置差异。
- 操作与记录：支持应用的单独降载、合成 canary、digest 与可关闭的提醒。

每日配置检查比较已提交期望与实际资源；账户操作历史单独显示，不冒充当前漂移。关闭提醒不会修复差异，新事件
仍可提醒。网站可访问与内容同步状态独立；VPS 状态来自 Fleet/daemon，模型请求统计链接到 Router。

## 后台与边界

有界的 HomeState 作业汇集 Ops、共享用量、公开探针、配置差异、合成 canary 和每日运维摘要。Canary 验证 Mail
Hero 投递到 Todofy 的处理链，不代表源邮箱转发、Email Routing 或 MIME 收件已验证。运维摘要用 Tasks 的
create-only TaskInbox；没有私有内容进入 Home 或通知。

服务/流/资源来自现有清单与 Wrangler 配置。前端不维护主机名副本。降载只调用应用声明支持的能力，并保留自动
到期；它不会停收件或替应用修改业务开关。

- [当前视图和 API](docs/design-v2.md)、[存储/后台边界](docs/design.md)
- [设置与运维](docs/setup.md)、[额度口径](docs/limits.md)、[验收记录](docs/verification.md)
- [根 CI/CD](../docs/ci-cd.md)、[服务清单](../docs/service-catalog.md)

发布使用已检查的完整产物，在依赖服务就绪后上传；必须核对同一 main SHA 的 Personal cloud reconcile。
交互式开发保持本地绑定，构建、类型、单元和真实 workerd 检查都由 Bazel 入口执行。
