# Newsletter

把每天值得了解的事，整理成一封中文简报。

源码现位于 Todofy monorepo 的 `newsletter/`，仍作为独立 VPS 服务和
`ghcr.io/ziyixi/todofy-newsletter` 镜像发布。原部署与数据不会因入仓自动切换；
来源与迁移边界见 [入仓记录](docs/import-source.md)，发布前使用
[持久排空合同](docs/deployment-drain.md)。

Newsletter 是一个可自托管的私人日报服务。它按你设定的方向搜集资料，筛选选题、阅读来源、核对信息，再写成带背景解释和参考链接的邮件。重点是讲清楚**发生了什么、与过去有什么不同、为什么值得关注**，让你不用逐篇点开原文，也能有所收获。

## 它能做什么

- 关注世界大事、产业变化和科技进展，也保留有价值的 AI/ML 及跨学科研究。默认以新闻为主，最多 6 个公共话题，其中研究类最多 1 个；不为凑数填满版面。
- 为重要话题补充背景、调查和图表。图表有自己的解释，参考链接留给想继续阅读的人。
- 把候选材料和每日简报分别存进两个 Notion 数据库，方便之后查阅；不要求你每天手动整理。
- 可接入 Todofy，在邮件最后附上经过筛选的个人事件。
- 通过配置调整关注方向、内容配比和邮件模板，不必每次都重新构建镜像。

基本流程：

```text
外部触发 → 搜集与选题 → 调查与审校 → 生成简报和预览 → 邮件投递
```

搜集和审校使用 Codex。模型仍可能漏掉重要信息或理解有误，来源检查和自动测试不能保证每篇内容都正确。

## 先看看效果

需要 Git、Make 和 **uv 0.12.10**。Linux 还需安装中文字体，例如 Debian/Ubuntu 的 `fonts-noto-cjk`；macOS 可使用系统中文字体，也可通过 `NEWSLETTER_CHART_FONT` 指定字体文件。

在终端运行：

```sh
git clone https://github.com/ziyixi/todofy.git
cd todofy/newsletter
make setup
make demo
```

`make setup` 安装锁定的 Python 3.12 环境和依赖。演示完成后，打开终端给出的 `preview.html` 路径即可查看样张；文件保存在 `.artifacts/` 下。

**演示使用示例材料，不需要密钥，也不会调用模型、写 Notion 或发送邮件。** 生成的 `.eml` 只是本地邮件文件。

## 部署自己的日报服务

推荐按 [self-host-on-vultr 的部署指南](https://github.com/ziyixi/self-host-on-vultr/tree/main/newsletter) 运行：它提供 Linux/amd64 的 Docker Compose 配置、独立定时触发器，以及内容配置同步器。本仓库的 `compose.yaml` 仅供本地演示，不是生产配置。

首次部署需要准备：

| 项目 | 用途 |
| --- | --- |
| 服务专用的 Codex 登录目录 | 搜集、写作和审校；使用 ChatGPT 登录，不是 OpenAI API key |
| Notion 集成授权和两个数据库 | 分别保存材料、简报档案 |
| Resend key、发件地址和收件地址 | 投递邮件 |
| 两个独立的服务 token | 一个用于启动采编，另一个用于批准发送 |
| Todofy 地址和凭据（可选） | 获取个人事件；不需要向 Newsletter 提供 Todoist token |

配置项见 [.env.example](.env.example)，账号准备和首次联调见 [接入指南](docs/live-acceptance.md)，Notion 建库步骤见 [Notion 配置](docs/notion.md)。应用不会自动加载 `.env`，应由部署工具传入环境变量；密钥、登录目录和真实数据请放在 Git 仓库及云同步目录之外。

首次接入时，先生成一期并查看预览，确认收件地址和内容后再启用自动发送。**升级已有服务时保留原数据库**，不要按首次部署步骤换成空库。

### 手动触发或接入其他定时器

在配置好服务地址和 token 的调用端运行：

```sh
# 生成一期并等待完成，不发邮件
newsletter-trigger --wait --timeout 7200

# 生成一期，完成后发送；需要额外的 send token
newsletter-trigger --send --timeout 7200
```

调用端需要 `NEWSLETTER_SERVICE_URL`、`NEWSLETTER_EDITOR_TOKEN`；发送时还需 `NEWSLETTER_SEND_TOKEN`。这些值从进程环境读取，不要写入命令参数。`make setup` 后，本地可用 `uv run --locked --extra codex newsletter-trigger` 代替上面的命令名。

也可以通过 HTTP 接入。采编和发送是两个独立操作，`POST /v1/runs` 本身不会发信。完整请求示例及权限见 [接口说明](docs/collection-service.md)。

服务自身没有定时任务。现有部署由外部定时器在每日 **07:00（America/Los_Angeles）** 启动，采编预算 90 分钟，调用端最多等待两小时，为 09:30 前到达留出余量；外部服务或邮件系统的延迟仍可能影响实际时间。

## 调整内容

日常编辑集中在 [content-config/](content-config/)，无需改 Python：

| 想调整什么 | 修改哪里 |
| --- | --- |
| 关注哪些领域、从哪些信源开始找 | `discovery/` |
| 选题数量、论文比例、深读数量 | `editorial.yaml` |
| 写作要求和读者偏好 | `policy/` |
| 搜集、筛选的提示词 | `prompts/` |
| 邮件排版 | `templates/edition.html.j2` |
| 处理步骤、依赖和时间预算 | `workflow.yaml` |

上表路径均相对于 `content-config/`。只改这个目录并推送到 `main` 后，GitHub 会校验并发布配置，不重建镜像。已部署的同步器每 15 分钟从公开仓库拉取一次，不需要 GitHub 密钥。通过检查的配置只影响下一次新运行，不会改写已有简报；更新失败时继续使用上一版。详见 [配置更新与回退](docs/content-config.md)。

## 开发与维护

项目采用 Python、FastAPI 和 SQLite，使用 uv 管理依赖。SQLite 保存完整运行记录和发送账本，Notion 是便于阅读的副本，不会把手工修改同步回服务。

```sh
make check    # Ruff、mypy、结构检查和离线测试；与 CI 相同
make format   # 格式化 Python 代码
make smoke    # 本地 HTTP 全流程测试，模拟外部服务，不发真实邮件
make build    # 构建 Python 安装包
```

代码在 `src/newsletter/`，测试及基准材料在 `tests/`，可重复使用的验证工具在 `scripts/`。接口消息来自公共 [protos 仓库](https://github.com/ziyixi/protos) 发布的 Python wheel，本仓库不生成 protobuf。

- [开发指南](docs/development.md)：代码分工、检查规则和扩展方法。
- [工作流说明](docs/workflow.md)：采编、保存进度、失败处理和 token 统计。
- [内容评测](docs/evaluation.md)：比较选题和写作质量，不把测试通过当成内容好。
- [维护指南](docs/maintenance.md)：停机维护、备份、升级和回退。
- [发布排空](docs/deployment-drain.md)：关闭接单、保留队列、冻结与显式恢复。

维护命令与服务共用目录锁。发送结果不明时，应先核对记录，不能换请求键或删除账本来重发。
