# Personal Cloud · 个人云

我日常使用的一组应用，用来规划工作、整理邮件、保存浏览记录和跟进信息。
应用、接口和基础设施放在同一个仓库中维护。

[English](README.en.md) · [文档](docs/README.md) · [部署与重建](docs/rebuild.md)

## 日常使用

| 应用 | 用来做什么 |
| --- | --- |
| [Tasks](tasks/README.md) | 把 Goals 关联到任务，用 Plan 安排本周工作、Focus 执行与计时、GTD 回顾完成和耗时。 |
| 邮件 | [Mail Hero](mail-hero/README.md) 收件，[Mailsort](mailsort/README.md) 按优先级分拣 Gmail，[Todofy](todofy/README.md) 生成摘要。邮件在 Tasks 的 Mail 中查看，由我决定是否收进 Inbox 创建任务。 |
| [Recall](recall/README.md) | 保存浏览活动、网页文字和截图，按时间线或全文搜索找回；旧内容归档到 Dropbox 后仍可读取。 |
| [Watch](watch/README.md) | 监视网页变化，保存正文和截图证据，供自己或代理继续判断、跟进。 |
| [Newsletter](newsletter/README.md) | 搜集和审校公开资料，生成并发送每日简报；在[控制台](newsletter-console/README.md)查看刊期和运行记录。 |
| 网站与链接 | 从 Notion 发布[个人网站](website/README.md)，用 [Links](links/README.md) 管理短链接。 |

## 代理与监控

- [Personal MCP](personal-mcp/README.md) 让 Dots 使用 Tasks、Mail、Recall 和 Watch，通过工作记录与事件订阅继续跟进。
- [Home](dashboard/README.md) 查看服务、用量和异常；[Fleet](fleet/README.md) 查看 VPS、后台服务和实际发布状态。

## 如何运行

日常应用托管在 Cloudflare。VPS 的 k3s 运行 Newsletter、[Codex Gateway](codex-gateway/README.md) 和[部署服务](platform/README.md)。
[Model Router](model-router/README.md) 为应用提供统一的模型调用、请求记录和用量统计。
[Storage](storage/README.md) 通过独立的 Dropbox 应用目录保存应用文件，提供按应用隔离的 HTTP 读写接口。

应用各自管理数据和发布，共享接口与必要的基础代码。[Bazel](docs/bazel.md) 固定工具链并按依赖构建、检查；
GitHub Actions 发布受影响的服务，Home 和 Fleet 核对实际运行状态。

服务边界见[架构](docs/architecture.md)，完整开发入口见[服务目录](docs/service-catalog.md)。

## 开发

先读 [HANDOFF](HANDOFF.md)、[协作规则](AGENTS.md) 和目标应用的 README；工具安装见[开发环境](docs/dependencies.md)。

```sh
bazel build //tasks
bazel test //tasks:check
```

其他应用同样使用 `//应用名` 和 `//应用名:check` 作为构建、检查入口。
发布流程见 [CI/CD](docs/ci-cd.md)，其余说明从[文档导航](docs/README.md)查找。
