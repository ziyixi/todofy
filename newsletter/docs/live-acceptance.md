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

`make setup` 按仓库根 `.python-version`（Python 3.14.7）和唯一的 `uv.lock` 选择 Newsletter 成员安装，包含共享 Model Router 客户端、dev 工具组及 GitHub Release 分发的 `ziyixi-protos==0.1.0.dev7`；可能下载解释器或依赖，但不会访问账号。`make check` 覆盖锁一致性、Ruff 80列/Google公开文档/模块导入、AST结构门禁、严格mypy与离线测试；`make format` 单独格式化Python。发布包与loopback服务另用上面的build/smoke。`make proto-check` 校验已安装公共 wheel 的代码、stub、descriptor hash、来源清单及发行版本；不依赖 sibling protos 仓库或 protoc，也不在 newsletter 内生成代码。不能运行的验收项单独标记，不应通过跳过来宣称完整通过。

这里的 `make build` 只构建 Python 包，不发布镜像。Docker 验收须另行检查 daemon、构建和运行：镜像只在构建阶段从同一锁安装运行依赖及共享 Model Router 客户端，不带 dev 工具，不在服务启动时解析或下载依赖。锁定工具链不会搬动或读取已有 `.env` 和提供方凭据。

## 需要准备什么

| 用途 | 当前代码读取的配置 | 获取与权限 |
| --- | --- | --- |
| 采集、总编及补查 | `NEWSLETTER_MODEL_ROUTER_URL`、`NEWSLETTER_MODEL_ROUTER_TOKEN`、`NEWSLETTER_MODEL` | 使用 Newsletter 专用的 Router 机器 token；提供方登录不进入本应用。 |
| Todofy 事件概述 | `TODO_API_BASE`、`TODO_API_USER`、`TODO_API_PASSWORD` | 使用现有 Todofy Basic Auth 用户，对应 Todofy 部署的 `ALLOWED_USERS`。不需要把 Todoist token 交给 newsletter。 |
| Notion 双库 | `NOTION_TOKEN`、`NOTION_MATERIALS_DATA_SOURCE_ID`、`NOTION_EDITIONS_DATA_SOURCE_ID` | 专用 internal connection 只授权这两个数据库，需要 Read/Insert/Update content，关系目标均须可访问。无需用户资料或评论权限。 |
| Resend 投递 | `RESEND_API_KEY`、`NEWSLETTER_FROM_EMAIL`、`RECIPIENT_EMAIL` | 可复用现有 key；新建时优先只允许 Sending access 并限制发件域名。发件地址使用已验证域名，收件人由用户明确确认。 |
| 服务 HTTP 鉴权 | `NEWSLETTER_EDITOR_TOKEN`、`NEWSLETTER_SEND_TOKEN` | 完成 `make setup` 后，用 `.venv/bin/newsletter token` 分别在本机生成两个不同随机值（各至少24字符），无需第三方账号。只准备内容的触发器仅持 editor token；用户明确授权每日投递时，独立 cron 容器另持 send token，不获得供应商密钥。ingest 角色及其旧环境变量已退休。 |

newsletter 不直接调用 Gemini。Todofy 自己负责其服务器上的 `GEMINI_API_KEY`；读取事件推荐/概述可能触发 Gemini，不能当成没有成本的数据库查询。

凭据不要发在聊天、截图、命令行参数、Git、镜像或日志里。现有仓库位于 Google Drive 同步目录；**新增登录缓存与联调密钥放到同步目录之外**。不要覆盖已有 `.env`，新服务也不会自动加载它。准备完成后只告知私有文件/目录的位置和非秘密的数据库链接。

## Model Router 连接

设置 `NEWSLETTER_MODEL_ROUTER_URL` 和 Newsletter 专用的 `NEWSLETTER_MODEL_ROUTER_TOKEN`，通过正规密钥配置流程保存 token。Newsletter 不需要本机模型登录目录、SDK 或提供方 API key；账号由 Router 的执行层维护。默认公共模型名为 `models/sol-6-1`，历史冻结运行的模型值由 Router 兼容解析，不改写历史。

启动预检只读取配置模型目录，确认生成、短会话和网页研究能力；不会执行模型。`make smoke-codex` 保留原发布命令名，当前只用假 HTTP transport 检查共享客户端，既不启动 SDK 也不访问真实账号。真实搜索、来源打开和完整采编仍需另行授权验收。

一次采编使用一个总期限固定的短会话，并在原期限内最多补查一轮。来源必须对应 Router 实际观测的打开 URL（校验仅忽略 fragment）；模型文字不能替代网页观察。退出时等待远端关闭确认；关闭失败会保留排空活动，重启后先核对远端清理，不能据本地进程退出推断模型已结束。

## Notion：专用测试数据库

按 [Notion说明](notion.md) 创建 internal connection、两个数据源并授权，再显式执行 schema setup。
旧单库摘要适配器已移除；残留的 `NOTION_DATA_SOURCE_ID` 会被忽略。

参考：[创建 internal connection](https://developers.notion.com/guides/get-started/internal-connections)、[权限范围](https://developers.notion.com/reference/capabilities)、[查找 data source ID](https://developers.notion.com/reference/retrieve-a-data-source)。整期入口 `POST /v1/runs` 在 live 配置要求启用 Notion；新选题DAG先将证据与已审版本持久化到SQLite，Notion作为后台镜像单独验收，不再是发信前置条件。旧冻结整期刊期的处理见[工作流说明](workflow.md)。内部fixture或直接调用编稿函数不能冒充整条指令采集链路通过。

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
2. **真实连接预检**：启动读取 Router 的配置模型目录、Notion 数据源 schema 和 Todofy public health；不调用模型或发送邮件。账号、schema及本地运行依赖错误拒绝启动；新选题DAG允许临时Notion/Todofy供应商故障以degraded状态启动，实际内容和投影仍须单独验收。公开 health 不证明 Todofy Basic Auth 有效，Notion 可读不证明可写，模型目录不证明搜索工具可用；后续真实请求另验。只输出通过/失败，不回显敏感响应。
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
