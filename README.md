# Personal Cloud · 个人云

把收邮件、任务、论文、网页监视和个人网站放在一个仓库里维护。
Home 是日常入口；各服务独立运行、独立发布，共享接口和必要的基础代码。

One repository for personal mail, tasks, papers, web watches and the website.
Home is the daily starting point. Services run and release independently, sharing contracts and a small runtime.

## 服务 · Services

| 服务 / Service | 用途 / Purpose | 运行环境 / Runs on | 开发入口 / Start here |
| --- | --- | --- | --- |
| Home | 查看服务、业务链路和配额 / Service health, flows and quotas | Cloudflare Worker + DO | [dashboard/](dashboard/README.md) |
| Mail Hero | 收件箱与可靠 webhook / Inbox and reliable webhooks | Cloudflare Worker + D1 + R2 + DO | [mail-hero/](mail-hero/README.md) |
| Todofy | 邮件转任务、摘要和提醒 / Mail to tasks, summaries and reminders | Cloudflare TS gateway + Python core + D1/DO | [todofy/](todofy/README.md) |
| Lab | 论文雷达 / Paper radar | Cloudflare Worker + AI + D1/DO | [lab/](lab/README.md) |
| FlowDay | 时间块、计时与回顾 / Time blocks, timers and reviews | Cloudflare Worker + D1 | [flowday/](flowday/README.md) |
| Links | 私人短链接 / Personal short links | Cloudflare Worker + D1 | [links/](links/README.md) |
| Watch | 网页变化收件箱 / Web change inbox | Cloudflare Worker + DO | [watch/](watch/README.md) |
| Website | Notion 驱动的个人网站 / Personal website from Notion | Cloudflare static assets + relay | [website/](website/README.md) |
| Newsletter | 生成并发送简报 / Build and send the newsletter | VPS k3s, separate image | [newsletter/](newsletter/README.md) |
| Fleet | VPS、daemon 与发布状态 / VPS, daemons and release status | Cloudflare Worker + DO | [fleet/](fleet/README.md) |

Cloudflare 托管日常应用；VPS 的 k3s 运行 Newsletter 和独立的部署 daemon。
GitHub Actions 主动通过鉴权 API 更新经测试的镜像，Fleet 和 Home 查看实际运行状态。
发布状态、业务健康和观察数据的新鲜度分别显示。首次安装和数据恢复见 [重建说明](docs/rebuild.md)。

Cloudflare hosts the daily applications. VPS k3s runs Newsletter and an independent deployment daemon.
Actions pushes tested images through an authenticated API; Fleet and Home show observed runtime state.
Release progress, business health and observation freshness stay separate. See [rebuild](docs/rebuild.md).

## 从这里开始 · Getting started

1. 查看 [HANDOFF](HANDOFF.md)：正在做什么、合并顺序、待验收和待 owner 处理的事项。
   Read HANDOFF for active work, merge order, outstanding verification and owner actions.
2. 阅读根 [AGENTS.md](AGENTS.md)，以及目标应用自己的规则与 README。
   Read the repository rules and the target application's instructions and README.
3. 进入目标应用目录，按它的说明安装、开发与检查；本地只使用本地绑定和合成数据。
   Work in the application's directory; follow its commands and use local bindings and synthetic data.

```sh
cd mail-hero    # 或 / or todofy, dashboard, lab, flowday, links, watch, website, newsletter, fleet, platform
```

仓库没有“一条命令启动所有服务”的要求。Cloudflare TypeScript 应用安装时生成 proto；Todofy 的 Python 代码由 `uv` 构建时生成。
不要提交生成代码或把本地开发连接到生产数据库。

There is no requirement to start every service together. Cloudflare TypeScript installs generate proto code;
Todofy's Python build generates it through `uv`. Generated code is not committed; development uses local data.

## 仓库地图 · Repository map

| 目录 / Directory | 责任 / Responsibility |
| --- | --- |
| [proto/](proto/README.md) | 接口定义、固定工具链、JSON 编解码与 HTTP 客户端 / IDL, pinned tooling, JSON codecs and HTTP runtime |
| [contracts/](contracts/README.md) | 跨服务语义、Schema、固定字节测试样本 / Cross-service semantics, schemas and golden payloads |
| [packages/edge-auth/](packages/edge-auth/README.md) | 编译进应用的共享鉴权 / Shared authentication compiled into applications |
| [infra/](infra/README.md) | Cloudflare 资源与权限 / Cloudflare resources and permissions |
| [platform/](platform/README.md) | VPS 发布 daemon、k3s 清单和监控 / VPS deployment daemon, k3s manifests and monitoring |
| [config/](config/README.md) | 可迁移的公开配置 / Portable public configuration |
| [tools/](tools/) | 测试、构建和部署工具 / Test, build and deployment tools |
| [.github/workflows/](.github/workflows/) | 检查、独立发布与基础设施流程 / Checks, independent releases and infrastructure workflows |

应用不互相导入代码。邮件接管、任务创建、部署成功是不同阶段，Home 分别呈现它们的证据。

Applications do not import one another. Mail acceptance, task creation and a successful deployment
are separate stages; Home shows their evidence separately.

## 发布 · Releases

在分支完成检查，合并同一个通过 `CI gate` 的提交，再由 GitHub Actions 发布受影响的服务。
部署权限、生产配置、回退和镜像更新见 [CI/CD](docs/ci-cd.md)。

Check a branch, merge that exact green SHA, and let GitHub Actions release the affected services.
See CI/CD for deployment permissions, production configuration, rollback and image updates.

## 文档 · Documentation

- [导航 / Documentation guide](docs/README.md)：按任务找文档 / Find the right document for the job.
- [架构 / Architecture](docs/architecture.md)：服务和数据边界 / Service and data boundaries.
- [服务目录 / Service catalog](docs/service-catalog.md)：可校验的服务声明 / Validated service declarations.
- [发布 / CI/CD](docs/ci-cd.md)：检查、发布和生产配置 / Checks, releases and production settings.
- [历史 / History](docs/history.md)：迁移记录、兼容期限与不能丢的证据 / Migrations, compatibility dates and retained evidence.
- [交接 / HANDOFF](HANDOFF.md)：当前工作与实际验收 / Current work and recorded verification.

这是公开仓库。密钥、私人邮箱、真实邮件、Notion 内容与个人任务不进入代码、测试样本或日志。

This repository is public. Keep secrets, private addresses, real mail, Notion content and personal tasks
out of source, fixtures and logs.
