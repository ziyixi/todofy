# 真实联调：凭据与验收边界

当前离线测试不是完整的线上验收。联调分为「真实采编、暂不发信」和「批准后的真实投递」，不把收到 API 200 当成内容质量或收件成功。以下是可重复的准备步骤；仅阅读或执行工具链检查不会启动真实采编、Notion 写入或发信。登录和供应商验收的实际进度以当次验收报告为准。

## 先统一运行环境

在仓库根目录使用项目要求的 `uv 0.12.10`，不要混用手工 pip 安装和其他虚拟环境：

```sh
make setup
make check
make build
make smoke
make smoke-codex
```

`make setup` 按 `.python-version`（Python 3.12.14）和唯一的 `uv.lock` 执行锁定安装，包含 Codex extra、dev 工具组及 GitHub Release 分发的 `ziyixi-protos==0.1.0.dev7`；可能下载解释器或依赖，但不会访问账号。`make check` 覆盖锁一致性、Ruff 80列/Google公开文档/模块导入、AST结构门禁、严格mypy与离线测试；`make format` 单独格式化Python。发布包与loopback服务另用上面的build/smoke。`make proto-check` 校验已安装公共 wheel 的代码、stub、descriptor hash、来源清单及发行版本；不依赖 sibling protos 仓库或 protoc，也不在 newsletter 内生成代码。不能运行的验收项单独标记，不应通过跳过来宣称完整通过。

这里的 `make build` 只构建 Python 包，不发布镜像。Docker 验收须另行检查 daemon、构建和运行：镜像只在构建阶段从同一锁安装运行依赖及 Codex extra，不带 dev 工具，不在服务启动时解析或下载依赖。锁定工具链不会搬动或读取已有 `.env` 和专用登录缓存。

## 需要准备什么

| 用途 | 当前代码读取的配置 | 获取与权限 |
| --- | --- | --- |
| Codex 指令采集、总编及补查 | `NEWSLETTER_CODEX_HOME`、`NEWSLETTER_MODEL` | 在运行服务的机器上完成专用 ChatGPT 登录；不是 OpenAI API key。登录目录只供该服务使用，持久化且可写。 |
| Todofy 事件概述 | `TODO_API_BASE`、`TODO_API_USER`、`TODO_API_PASSWORD` | 使用现有 Todofy Basic Auth 用户，对应 Todofy 部署的 `ALLOWED_USERS`。不需要把 Todoist token 交给 newsletter。 |
| Notion 双库或显式旧测试 inbox | `NOTION_TOKEN`、`NOTION_MATERIALS_DATA_SOURCE_ID`、`NOTION_EDITIONS_DATA_SOURCE_ID`；旧单库才用 `NOTION_DATA_SOURCE_ID` | 专用 internal connection 只授权指定数据库。双库需要 Read/Insert/Update content，关系目标均须可访问；旧单库摘要只需 Read/Insert。无需用户资料或评论权限。 |
| Resend 投递 | `RESEND_API_KEY`、`NEWSLETTER_FROM_EMAIL`、`RECIPIENT_EMAIL` | 可复用现有 key；新建时优先只允许 Sending access 并限制发件域名。发件地址使用已验证域名，收件人由用户明确确认。 |
| 服务 HTTP 鉴权 | `NEWSLETTER_EDITOR_TOKEN`、`NEWSLETTER_SEND_TOKEN` | 完成 `make setup` 后，用 `.venv/bin/newsletter token` 分别在本机生成两个不同随机值（各至少24字符），无需第三方账号。只准备内容的触发器仅持 editor token；用户明确授权每日投递时，独立 cron 容器另持 send token，不获得供应商密钥。ingest 角色及其旧环境变量已退休。 |

newsletter 不直接调用 Gemini。Todofy 自己负责其服务器上的 `GEMINI_API_KEY`；读取事件推荐/概述可能触发 Gemini，不能当成没有成本的数据库查询。

凭据不要发在聊天、截图、命令行参数、Git、镜像或日志里。现有仓库位于 Google Drive 同步目录；**新增登录缓存与联调密钥放到同步目录之外**。不要覆盖已有 `.env`，新服务也不会自动加载它。准备完成后只告知私有文件/目录的位置和非秘密的数据库链接。

## Codex：服务专用登录

`make setup` 已从锁定的 Codex extra 安装 SDK 和配套 runtime，不需要额外拿一个 OpenAI API key。本机测试可在 newsletter 仓库终端运行以下命令；它们由用户显式执行登录，不会开始采编或发信。已经完成此专用登录时只核对 `login status`，无需重复登录：

```sh
export NEWSLETTER_CODEX_HOME='/Users/ziyixi/Library/Application Support/newsletter/codex-auth'
mkdir -p "$NEWSLETTER_CODEX_HOME"
chmod 700 "$NEWSLETTER_CODEX_HOME"
NEWSLETTER_CODEX_BIN="$(.venv/bin/python -c 'from codex_cli_bin import bundled_codex_path; print(bundled_codex_path())')"
env CODEX_HOME="$NEWSLETTER_CODEX_HOME" "$NEWSLETTER_CODEX_BIN" \
  -c 'cli_auth_credentials_store="file"' \
  -c 'forced_login_method="chatgpt"' login
```

终端会打开官方登录流程。在无浏览器服务器上，最后一个命令可用 `login --device-auth`，并按提示在自己的浏览器输入一次性代码；账号或工作区可能需要先启用 device code login。服务器需使用自己的服务目录和身份，不复制本机日常使用的登录状态到多个并发主机。检查登录可在同一命令最后使用 `login status`。

上述环境覆盖只作用于该子进程，不修改个人全局 Codex home。不要把 `config.toml`、hooks、plugins、自定义 skills 或个人 `AGENTS.md` 放进专用登录目录；现有总编适配器会拒绝它们。runtime 自己创建的 `skills/.system` 不要删除：服务使用固定版本的 `SKILL.md` 路径逐项禁用，并在同一 SDK 连接查询实际状态，只允许预期内置技能且全部 disabled；异常即在模型调用前失败。用户或系统的 `.agents/skills`、`/etc/codex/skills` 也不应进入此专用服务环境。默认模型为 `gpt-6-sol`，必须通过真实账号确认可用性；不会悄悄切成 API 付费或假稿。

SDK 会把 `config.env` 合并到父进程环境。服务先清空密钥，再通过隔离 Python 启动器以精确白名单 `execve` 配套 runtime，避免空的桌面 override 被 runtime 当成有效配置。`make smoke-codex` 不使用账号或模型，在临时目录验证被污染的启动环境及连续两次启动，可发现单纯模拟 SDK 无法覆盖的握手/缓存兼容问题。

固定的 0.156.1 runtime 继续使用 `features.code_mode_host` 提供 hosted web tools；这不是启用 shell、插件或自定义技能。2026-09-05 的真实对照曾恢复 `search` / `openPage` 事件；升级 runtime 后仍需核查实际工具事件，登录或启动 smoke 成功不能代替搜索验收。补查引用必须对应观测到的打开 URL（仅忽略 fragment）；模型不能自行换成 canonical 链接或去掉参数，需要先打开新 URL。结构化输出的栏目、图表和来源类型与业务校验共享枚举。

ChatGPT 登录使用订阅访问，但仍受额度、模型和工作区权限限制；并非无限免费。官方总体推荐 API key 用于自动化，而私有自动化登录需要维护可刷新的登录缓存。见 [OpenAI 登录文档](https://learn.chatgpt.com/docs/auth)、[私有自动化登录说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth)。

## Notion：专用测试数据库

当前双库部署按 [Notion说明](notion.md) 创建并授权两个数据源、显式执行schema setup。
下面步骤仅用于仍明确选择旧单库摘要适配器的隔离联调，不代表当前双库的权限或归档能力：

1. 在 Notion Developer portal → Internal connections 创建一个 newsletter 测试 connection；从 Configuration 取得 Installation access token，安全保存为 `NOTION_TOKEN`。
2. 给 connection 配置上表所需内容权限，并在 Content access 只授权专用测试数据库；也可从该数据库的 Connections → Add connection 授权。不开放其他个人页面。
3. 打开数据库设置 → Manage data sources → 对应数据源的菜单 → Copy data source ID，保存为 `NOTION_DATA_SOURCE_ID`。它不是页面 ID、视图 ID，也不一定等于数据库 ID。
4. 保留数据库默认的标题属性即可，不必创建一堆自定义列。当前实现只写材料摘要、来源和 workflow 元数据，不读取你在 Notion 的修改，也不写 Todofy 私人事件。

参考：[创建 internal connection](https://developers.notion.com/guides/get-started/internal-connections)、[权限范围](https://developers.notion.com/reference/capabilities)、[查找 data source ID](https://developers.notion.com/reference/retrieve-a-data-source)。整期入口 `POST /v1/runs` 在 live 配置要求启用 Notion；新选题DAG先将证据与已审版本持久化到SQLite，Notion作为后台镜像单独验收，不再是发信前置条件。旧冻结图保留原门槛。内部fixture或直接调用编稿函数不能冒充整条指令采集链路通过。

## Resend：最后才启用

在 Resend Dashboard 的 API Keys 管理或创建 key；不知道旧 key 值时可新建，不要为测试撤销生产 key。确认 Domains 中发件域已验证，给出需要使用的发件地址、收件地址即可。参考：[API keys](https://resend.com/docs/dashboard/api-keys/introduction)、[验证域名](https://resend.com/docs/dashboard/domains/introduction)。

尚未授权投递的独立联调使用 `NEWSLETTER_MAIL=fake`、`NEWSLETTER_ALLOW_SEND=false`，不调用 `/send`，只落地 HTML、纯文本及 PNG。`fake` 是非真实投递后端，不代表可以擅自执行模拟发送。数据库在首次启动绑定投递后端、发件人与收件人，不能把这样的测试数据库直接切成生产 Resend 数据库。

正式部署须创建全新的 live 数据目录，从第一次启动就配置用户批准的最终 Resend 目标；先不启动 cron，只调用触发器 `--wait` 验证采编及冻结预览，最后再执行批准的 `--send`。用户明确授权每日自动发送时可启用独立 cron，否则保持仅准备模式。单次测试与每日投递的授权范围分别记录，不能从「全部测试」推导无限发送。

上段是首次建站流程，不是现有服务升级时更换数据库的理由。现有服务升级须保留全部
投递台账、冻结内容与既有目标；普通升级不新增真实测试邮件。特殊修订验证只用
停服务且持有同锁的 `newsletter admin send-verification`，不能从HTTP调用。
其批准、备份和回退条件见 [维护说明](maintenance.md)。

## 分阶段验收

1. **离线与 HTTP**：`make check`、公共 proto 生成一致性、`make build` 与 `make smoke`；覆盖类型、依赖锁、鉴权、恶意材料、坏 JSON、超时、去重、重启恢复和冻结 hash。不调用生产失败场景来制造错误。
2. **真实连接预检**：启动检查专用 Codex 账号/模型目录、Notion 数据源 schema 和 Todofy public health；不调用模型或发送邮件。账号、schema及本地运行依赖错误拒绝启动；新选题DAG允许临时Notion/Todofy供应商故障以degraded状态启动，实际内容和投影仍须单独验收。公开 health 不证明 Todofy Basic Auth 有效，Notion 可读不证明可写，模型目录不证明搜索工具可用；后续真实请求另验。只输出通过/失败，不回显敏感响应。
3. **少量真实采编**：只发一次 `POST /v1/runs`，服务自行扫描指令目录并冻结快照，真实搜索/打开原文；再把同一幂等键重发，验证没有多次采集。观察各方向的完成/缺口、Notion 投影、总编补查和自足中文成稿；人工逐值核验图表及引用。AI/ML 与其他学科分别检查，Todofy 独立在文末，失败不拖垮公共稿件。不能由测试脚本手工投稿来替代此验收。
4. **Notion 与服务韧性**：在专用数据库创建有限条材料、核对投影；本地验证重启后仍能取冻结预览、重复请求不多投影或重取 Todofy。Notion 结果不明时先核对，不自动重试；测试记录不自行删除。
5. **邮件预览**：HTML、纯文本、CID 图像、长标题/长理由、无图、无 head 样式、桌面/手机；内容与最终批准 hash 一致。
6. **一次真实投递（另行批准）**：核对 Resend 接受/送达状态及实际收件；检查用户使用的 Gmail / Apple Mail / Outlook、手机及深色模式。没有使用的客户端或未取得截图的项目明确标未验，不声称全客户端兼容。
7. **部署验收（确认目标后）**：Docker 构建、只读根文件系统/非root运行、缺依赖时拒绝启动、持久化目录/登录刷新、TLS/服务鉴权、重启和日志脱敏。由外部调度器触发，服务无 cron。部署前确认旧 GitHub daily 的 schedule 已停用，避免重复；本地改 workflow 不会改变线上调度，不为联调擅自部署或推送。

## 发布前的阅读体验验收

不能只用一篇完整深读证明发布质量。至少检查一次混合刊期：深读失败后保留的已审简讯、成功的其他学科解读，以及明确暂缓的选题同时存在。以下检查针对最终冻结的 HTML / 纯文本和组件审计；不在冻结后补写正文或强行添加图表。

- **题材与层级**：AI/ML、其他科学、世界事务等沿用各自已审 `kind`；每题有独立分类、标题、完整段落和紧邻正文的限制，不重新合并成“今日简讯”，也不把简讯标成深读。暂缓选题留在 publication coverage 中，不能无记录消失。
- **个人内容最后**：Todofy 在全部公共稿件、图表、阅读介绍和来源之后；用量小字可在其后。个人事项不进入公共来源列表，也不因 Todofy 不可用而宣称“没有新事件”。
- **有图路径**：只有独立审核通过的实际数据才出图。人工逐值对照来源，确认单位、期间、比较口径与缺失值；冻结 HTML 的 `cid:newsletter-chart` 必须与 MIME / Resend 附件 `newsletter-chart` 对应，PNG 字节一致。浏览器预览中的 data URI 不得替代邮件 CID 或混入邮件 HTML。
- **无图路径**：查持久化 StoryResult 的 chart assessment，区分 `not_present` 与 `blocked`；拒绝图表时保留其 findings / issues。正常无图不等于渲染失败，无图 HTML 不留空 `<img>`、CID 或 PNG 附件，不虚构数字填位，也不在读者正文添加未经证实的省略理由。
- **页脚与体积**：非缓存输入 = 输入 − 缓存输入；缓存输入、非缓存输入、输出互斥相加为总量，不把缓存再次加到总输入。缺少调用用量必须标为部分统计，Todofy/Gemini 未计入也须说明，不换算成订阅额度百分比。记录最终 HTML 的 UTF-8 字节数（不是字符数）；离线八题代表样张采用 90 KiB 的保守回归预算，但这不是所有内容或 Gmail 客户端永不截断的保证。真实 Gmail 收件另检查完整末尾与图像；客户端不可用时标 `NOT TESTED`。

`tests/test_reader_acceptance.py` 将上述组合中的批准 / 拒绝 / 未提供图表三种路径串到离线 writer/reviewer、持久化 publication、renderer 和本地 `.eml`，并验证重复模拟请求不产生第二封文件。测试材料、数值及用量均明确为虚构；它不调用供应商、不制造线上图表、不向真实地址发信，不能替代真实采编或 Gmail 收件验收。

验收报告应区分 PASS / FAIL / NOT TESTED，并列出模型调用数、已写入的测试页面、模拟/真实投递数和剩余限制。不得把 mock 成功、模型自审或浏览器截图当成真实调查质量和客户端投递的证明。
