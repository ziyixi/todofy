# 内容配置，不重建镜像

内容现属于公开的 `ziyixi/todofy` monorepo。`main:newsletter/content-config/`
是可编辑源码，
`published:bundle.json` 是通过已测试引擎校验的发布产物，不另建配置仓库或 PyPI 包。
配置版本自动使用 monorepo Git commit SHA，无需手动增加版本号。旧部署同步器的
`ziyixi/newsletter` 来源不自动改变；后续须显式迁移唯一同步器，不能同时启用两套。

## 日常修改

1. 修改 `content-config/` 中需要调整的文件。
2. 提交并 push 到 `main`。纯配置改动仅运行配置工作流；代码改动仍运行完整 CI 和镜像构建。
3. 等待配置工作流成功。同步器每900秒匿名读取 `published` 的一个固定 commit，
   下载整包并用当前部署引擎重新验证；通过后原子切换活动指针。
4. 下一次新触发采用新版本。正在运行的采集、汇编、渲染及重放使用原冻结快照；
   旧邮件、Notion 档案和发送账本都不会被重新生成或改写。

配置 CI 用实际 `Newsletter image publish` job 已成功的固定
`ghcr.io/ziyixi/todofy-newsletter:service-<monorepo commit>` 镜像进行离线检查，不调用模型、
Notion 或邮件。只有整体 CI 绿色或镜像 job 被跳过时，不把该提交认作已发布引擎。
发布任务的仓库内置 `GITHUB_TOKEN` 只用于写入产物分支；服务器不持有此 token，
匿名拉取公开资源不需要 GitHub 密钥或 SSH 登录。

| 文件 | 可修改的内容 |
| --- | --- |
| `editorial.yaml` | 公共选题、研究主体、深读、研究候选数量上限 |
| `workflow.yaml` | 已注册节点、依赖和有界预算 |
| `discovery/*.md` | 现有八个搜集方向的题材要求 |
| `discovery/_sources/ai-ml.md` | AI/ML 公开信源入口，不是白名单或质量认证 |
| `researcher.yaml` | 研究员每期抓取的公开订阅源登记表（可选），见下文 |
| `prompts/discovery.md`、`prompts/selection.md` | 候选发现与全局取舍策略 |
| `policy/*.md` | 编辑要求、显式读者偏好；不依赖聊天 memory |
| `templates/edition.html.j2` | 受限邮件 HTML 模板 |

除上表规定路径外的文件不会发布。说明文档放 `docs/`，不要把 `.env`、token、
私有事件、服务器路径或登录缓存放入公开配置。安全规则、供应商权限、收件人、发信开关、
鉴权和模型运行环境不属于内容配置。新增节点类型、消息字段或引擎能力仍需更新代码／镜像。

## 新闻优先的默认预算

```yaml
max_public_items: 6
max_research_items: 1
max_deep: 1
max_research_candidates: 10
```

这些是上限，不是填满目标：最多6个公共话题，研究主体（含分类不明）最多1个，
全篇最多1个深读，30条候选池内研究／未知主体最多10条。
八个搜集方向不减少；论文仍可进入材料库、观察清单及后续调查，但不自动获得刊出版面。
新闻应解释旧局面、发生了什么、谁受影响，不把一串新数字称为突破。
当前读者偏好让科技的实际变化更容易入选，同时保留重大国际新闻；这属于选题排序，
不是必须填满的栏目配额。独立世界新闻检索方向仍会运行，研究主体上限不变。
论文改成新闻标题或公司公告不会因此变成非研究；引用论文作新闻背景也不自动算研究。
规则能限制数量，不能保证模型的每次语义判断正确；真实质量需通过后续实际简报评估。

预算还必须满足 DAG 容量：公共话题不超过 selection.max_tasks，深读不超过 story_plan.max_deep，
研究候选不超过候选池容量。引擎当前支持公共话题1–8、研究0–话题数、深读0–2、
研究候选0–60；超范围在激活前拒绝，不到发信时才卡住。

## 研究员订阅源

`researcher.yaml` 登记约 35 个公开订阅源：arXiv 检索、Hugging Face Daily Papers、
AI 机构与作者博客、Nature/Science 及地球物理、地震学期刊，以及美联储新闻稿。
它取代原先代码里固定的三个元数据源，并从已退役的 Brief 移植而来；文件头写明 Brief 最后的提交，
被删掉的条目（新闻标题源、仅作信号的源、站点地图、USGS 和停用条目）可从那里找回。
字段说明写在文件头；未知字段、YAML 锚点和标签会被拒绝，`direction` 必须是现有的
`discovery/<id>.md`，最多 80 个源，文件不超过 100 KB。

每期 07:00 运行时，`feeds` 节点读取随运行冻结的这份登记表，每个源抓一次：

- 只抓登记的 HTTPS 地址，不跟随跳转、不重试；同一主机串行并留间隔（arXiv、Crossref 3 秒，其他 1 秒），
  最多同时访问 4 个主机。每次请求 15 秒、按源限制字节数；节点在自身时限前 15 秒停止，保留已完成的源。
- arXiv 检索最近 4 天提交的论文，Crossref 取最近 7 天登记的期刊文章；其余源默认只保留 7 天内且有日期的条目。
  关键词、`requires_abstract` 和历史去重在本地完成，不调用模型。
- 同一作品来自多个源时按身份合并，`name` 不同才算独立来源。排序依次看独立来源数、Hugging Face 当天点赞分位、
  日期和登记顺序；每个方向轮流取各源，最多 20 条，交给对应方向的搜集模型。
- 线索只含元数据（已读范围“仅线索”），摘要和关注理由是固定说明；`venue` 是订阅源名称，
  `source_basis` 由代码写成“研究员订阅源：…（仅元数据，未打开原文）”。
  订阅源正文最多 300 字作为不可信摘录，只放在搜集提示的附注里，不进入候选、候选池或 Notion；
  Crossref 摘要只用于本地筛选，不作为摘录。

搜集模型自己决定打开哪条线索，打开后的候选按原有规则核验并写 `source_basis`；
未打开的线索只能作为仅线索候选，在搜集结果和候选池剩余的研究名额里出现。不增加模型调用、节点类型、
数据表或服务，`workflow.yaml` 中 `feeds` 的时限为 180 秒。

任何源失败时 `feeds` 节点记为 `partial_failure`，其他源的线索照常使用；
节点产物的 `diagnostics` 逐源记录 `<id>:<code>`，代码只有 `ok`、`http_error`、`too_large`、
`parse_error`、`timeout`、`unavailable`、`unsafe_address`、`deadline`，另有 `truncated`、
`undated:<n>`、`invalid_items:<n>` 计数，以及 `registry:absent`、`registry:invalid`、`artifact:trimmed:<n>`。
产物另有 `sources`，按源 ID（几个 arXiv 源同名，所以不用名称）记录代码、解析条目、通过筛选的条目、
分到的线索数和是否截断；合并的线索只计入最先产生它的源。它不占线索的字节预算，也没有节点读取它。
日志只有一行来源、成功、失败和线索数量。地址失效时直接改这份配置。

包内初始基线不含 `researcher.yaml`，离线 demo 和没有该文件的配置不抓取任何订阅源。
旧引擎不认识这个文件：配置若先于新镜像到达，同步器只记录错误并保留上一版，新镜像上线后自动恢复。

## 写作风格

`policy/editorial.md` 同时用于逐题写作和审校，`policy/reader-profile.md` 补充读者偏好。
默认按中文新闻讲清事件和背景，不给每篇例行附上反驳或免责声明。
影响结论的条件在正文就近说明；没有需要额外提醒的事项时，`limitations` 留空。
模板仍完整展示非空说明，但不再加醒目的“阅读边界”框，也不会按关键词删除模型输出。
这些调整不改变选题配比、篇幅预算或事实检查，不新增模型调用和发送门槛。

这里修改的是供服务同步的内容配置，包内初始基线和离线 demo 不随之改变。
离线测试能检查指令传递与渲染保真；模型是否真正讲得清楚，仍需看采用新配置后生成的简报。

## 模板与邮件兼容

模板使用有限 Jinja：if、for、set、非递归宏及少量已有过滤器。不允许 import/include、
任意函数调用、文件／网络访问、脚本、事件属性或 CSS 外部资源。只允许已冻结图表的 CID 图片，
引用链接仍遵循公开 HTTPS URL 规则。HTML源码最多64KiB，渲染输出最多1MiB；循环也有预算。
校验会离线渲染完整和可选栏目缺席两种输入，检查章节、图表解释、来源、阅读卡、私人事件和用量页脚没有丢失。
使用 email-safe 表格和内联样式；不依赖 JavaScript、远程字体或邮件客户端不一致支持的折叠组件。

模板热更新只用于绑定整期运行的邮件。纯渲染不再提供HTTP入口；本地
`rendering.render_edition()` 未提供冻结模板时仍使用包内模板，离线demo同样不会读取
生产活动配置。已有运行继续使用其冻结模板，活动配置损坏不能成为包内模板回退的理由。

## 本地离线检查

```sh
uv run --locked python -m newsletter.config_cli build \
  --source content-config --revision "$(git rev-parse HEAD)" --output /tmp/newsletter-bundle.json
uv run --locked python -m newsletter.config_cli validate \
  --bundle /tmp/newsletter-bundle.json
```

macOS 上 `/tmp` 是符号链接时请用 `/private/tmp/newsletter-bundle.json`。
不需要 `.env` 或 Codex 登录；输出只含 revision、digest 和预算，不输出配置正文或任何凭据。

## 部署、故障与回退

使用 self-host-on-vultr 中的 bootstrap。配置宿主目录由 uid10001拥有，挂给同步器可写，
挂给 newsletter 只读。同步器不挂数据库、业务 `.env` 或 Codex 登录，不暴露端口。
只运行配置同步循环，不创建第二个内容 cron；既有每日07:00洛杉矶调度保持不变。

首次启动必须显式 seed 一个通过验证的包内基线；没有活动配置时服务拒绝启动，
不会偷偷切换旧资源。已有活动版本时 seed 不覆盖。之后网络、限流、下载损坏、模板错误或
引擎不兼容只更新同步错误状态，保留最后可用版本。服务启动和每次新运行仍重新检查活动配置。

本仓库的 K3s 配置同步 Deployment 在启动前，用同一固定 digest 的 Newsletter 镜像
执行 `python -m newsletter.config_sync initialize`。它只在配置卷完全为空时 seed 包内基线；
已有活动配置只校验且不改写。非空目录缺少基线或基线损坏时失败，不自动重置配置。

```sh
docker compose exec -T newsletter-config-sync python -m newsletter.config_sync status
docker compose exec -T newsletter-config-sync python -m newsletter.config_sync once
docker compose exec -T newsletter-config-sync python -m newsletter.config_sync pin <历史digest>
docker compose exec -T newsletter-config-sync python -m newsletter.config_sync unpin
```

pin 会持久化并切换到已保存的版本，后续自动同步不会覆盖人工回退；unpin 后恢复自动追踪。
`status` 区分远端期望 commit、活动源 revision/digest、固定状态、最后成功时间和错误码。
`releases/<digest>/bundle.json` 保存历史不可变版本，`active.json` 只在完整落盘后原子替换。
配置目录纳入现有备份，但回退内容配置不需要也不允许回滚 SQLite 或发送台账。
