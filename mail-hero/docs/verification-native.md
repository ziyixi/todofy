# 原生实现验收记录

2026-09-26（以下生产验收时间使用UTC）。此记录区分本地实现、账户部署与生产验收。单封真实纯文本入站已通过；用户测试信到Todofy/Todoist的完整链路、自动转发、生产故障及灾难恢复仍有独立待验收项。

## 已完成

- 实现为 Workers Free、D1、私有 R2、SQLite Durable Object Alarm 和 React Static Assets；没有 Queues、付费 CPU 配置或自建服务器依赖。仓库只保留这条原生实现和相关工具、合同及文档。
- 收件原件持久保存、MIME/中文/附件解析、正文与安全 HTML、收件及交付 UI、通用 webhook、稳定事件重试、限流、删除去重账本及容量保护。
- Access JWT、owner、Origin/CSRF 校验；公网目标 HTTPS 精确域名白名单、禁止重定向，凭据加密且绑定目标版本。
- 初始 archive、暂停消费者交付、不自动过期。入站默认每日 300 封/256 MiB、逻辑容量 5 GiB。
- 独立创建 `mail-hero-bootstrap` Cloudflare account token，30 天有效期；未修改既有 Worker 的凭据与权限。未在仓库保存 token。

## 本地证据

| 检查 | 结果和范围 |
| --- | --- |
| `npm --prefix cloudflare run typecheck` | 通过 |
| `npm --prefix cloudflare test` | 仓库清理后32/32原生测试通过，包含API、核心边界、25 MiB workerd及完整workerd链路 |
| `node --test deploy/test/*.test.mjs` | 2/2 CI配置生成测试通过 |
| `npm --prefix web run build` / `npm --prefix web test` | 构建通过；3/3 前端测试 |
| 原生部署打包 | Wrangler 4.141.0 `deploy --config wrangler.native.toml --dry-run` 通过；541.77 KiB；生产发布另见下表 |
| 完整 workerd 链路 | 实际 D1/R2/SQLite DO；合成邮件保存解析、受保护 API、附件、fake consumer 503 后同事件/同正文重试至 204、删除后重复入站不复活 |
| 恢复和额度边界 | DO 重建后的配额、并发 enqueue 版本、三次解析中断后停止、R2 失败不确认、截断原件拒绝、超大 Retry-After 不溢出 |
| 大邮件 | 精确 25 MiB 的合成 MIME/base64 附件由本地 workerd 解析通过；不是生产 CPU/内存计量证明 |
| 浏览器 | 实际本地 API 的中文收件箱、详情、纯文本/安全 HTML、390px 手机布局；HTML 沙箱为空权限且 CSP 禁止外部资源 |
| 实际入口访问控制 | 未认证静态资源、SPA、API、readiness 均拒绝；仅无内容 liveness 公开 |
| 依赖审计 | Cloudflare 与前端的全量、生产依赖 `npm audit` 均 0 漏洞；Wrangler 4.141.0、Miniflare 5.20260925.0-alpha、Vitest 4.1.11 |

测试只使用合成邮件、本地独立状态和 fake consumer，没有读取真实邮件或调用 Todofy/Todoist。

## 2026-09-26 UTC 云端部署进度

用户已在本机保存独立 token；API 验证 active，到期时间 2026-10-26T23:59:59Z。已成功追加仅作用于 `ziyixi.science` 的 `Zone Settings Write`，原有权限保留；Wrangler 全局 OAuth 未修改。

| 资源 | 已核实状态 |
| --- | --- |
| D1 `mail-hero` | 已创建；ID `6c13e4c3-e239-42fb-a7a4-96810fa8d7dc`，WNAM；三项迁移完成 |
| R2 `mail-hero-store` | 已创建，Standard；未启用公开桶地址 |
| Worker `mail-hero` | 首次 GitHub 登录验收版本 `45185591-07d7-4c5d-9776-5eabc3e805fc`；后续发布见下文；尚无生产请求 CPU/内存验收证据 |
| 运行密钥 | `CREDENTIAL_KEY` 已安全生成、权限受限本机保存并装入新 Worker secret；未写入仓库 |
| UI | Custom Domain 已绑定 [mail-hero.ziyixi.science](https://mail-hero.ziyixi.science)；`workers_dev` 与预览 URL 均禁用 |
| Access | 应用 `ebd92116-4d51-4d90-923a-068b05b7e05a` 绑定 UI，原 Gmail 策略 `018f1a13-1a1b-4cf6-a470-c865c4577851` 保留；新增 GitHub 策略 `eea00ced-7de7-4094-a705-c9741d835b7c` 同时要求本人经 Test 核实的精确邮箱和 GitHub 提供商；audience 保持不变 |
| 浏览器访问 | 未认证请求到达 Access；本人 GitHub 登录已实际成功进入线上 `/setup`，受保护的配置、D1 和调度状态查询成功，固定收件地址及暂停状态正常显示。OTP 入口保留，未单独重测；未读取私人邮件 |
| 收信子域 | `inbox.ziyixi.science` 已启用，API 返回 `enabled: true`、`status: ready`，ID `1732b14db00946c684b8705a0fdd051d`；Settings → Subdomains 明确显示 Enabled、DNS Locked |
| 精确收信规则 | `64ebbe06caa64beaa47c8589db9e785c` 已启用：`inbox-mail-hero@inbox.ziyixi.science` → Worker `mail-hero`；catch-all 仍禁用，未更改 |
| 公共 DNS | `dig` 已查到收信子域的 Cloudflare MX（18 `route2.mx.cloudflare.net`、26 `route1.mx.cloudflare.net`、92 `route3.mx.cloudflare.net`）及 Cloudflare SPF；根域仍为优先级 10 的 `mx01.mail.icloud.com` / `mx02.mail.icloud.com` |
| 部署初始化状态 | `archive`、retention NULL、logical_bytes 0、容量 5GiB、messages 0、endpoints 0；消费者强制暂停 |
| 真实单封收件 | 用户发送的 `Test` 于 `2026-09-26T04:47:58.569Z` 入站；解析 ready，无错误，arrival_count 1，archive，delivery_count 0；R2 原件可读且大小/摘要与 D1 相符，UI 中文正文正常 |

生产配置在 gitignored `cloudflare/wrangler.native.production.toml`。GitHub owner 登录、受保护页面及用户发送的一封真实纯文本邮件的入站、存储、后台解析与 UI 展示已验证。这不覆盖自动转发、大邮件、故障重试和恢复。

此次子域启用前，先核对限定子域的 DNS 预览：待添加的三条 MX 和一条 SPF 都仅作用于 `inbox.ziyixi.science`。随后调用 `POST /zones/{zone_id}/email/routing/dns`，body 为 `{"name":"inbox.ziyixi.science"}`，成功返回上述 ready 状态，再次查询 DNS 预览返回 `errors: null`。仅这一步还没有让 UI 的 Subdomains 列表显示已启用；创建规则并刷新后，又在 Settings → Subdomains 添加 `inbox`，才确认 Enabled、DNS Locked。该操作同时开启父级路由标记，并添加 Cloudflare 公共 DKIM TXT `cf2024-1._domainkey.ziyixi.science`。两次核对根域 MX/SPF 都精确一致，现有 iCloud 邮箱未变。

根域 Email Routing 当前为 `enabled: true`、`status: misconfigured`、`skip_wizard: true`，界面会提示根域 MX/SPF Conflicting/Missing，因为根域继续使用 iCloud，只有专用子域交给 Cloudflare。这不应通过删除 iCloud 记录或点击 Add missing records 来“修复”。会替换根域邮件配置的 onboarding 未被执行；`skip_wizard: true` 本身也不是完成子域启用。

剩余步骤：

1. GitHub 登录已通过；如需验证备用入口，可使用原 Gmail 的邮件验证码登录，无需向聊天提供验证码。
2. 单封测试信已收到，实际主题为 `Test`，无附件。补充 HTML、附件、大邮件及各来源自动转发验收；不把普通直接发信等同于 Gmail/Exchange 自动转发。
3. 验证免费计划的实际 CPU/内存用量与故障表现，不能用本地 25 MiB 合成测试替代生产额度验收。
4. 建立并验证独立加密备份及空资源恢复；目前没有自动化的一致原生备份，也未完成灾难恢复演练。D1 Time Travel 不包含 R2、DO 和密钥。恢复旧 D1 与较新 R2 时不能直接解除发送暂停：重新发现的邮件可能丢失原事件身份，需要与消费者账本对账。全新 DO 的恢复扫描需要显式唤醒。
5. 用户按来源邮箱正规流程配置 Gmail/Exchange 转发，保留来源副本，再验收真实来源；消费者接入进度见下文，不能把 HTTP 接管等同于 Todoist 业务成功。

首次云端初始化没有升级 Workers Paid，没有修改既有 `ziyixi-notion-publish` Worker、`vultr-backup` 桶、原有 Access 策略或 iCloud 根域 MX/SPF。Mail Hero 使用本次新增的 owner-only Access 策略。账号既有 R2 本账期显示 $0，仅是此前检查时状态；免费额度共享且 R2 没有本项目可承诺的 $2 硬消费上限。

详细步骤见 [Cloudflare 部署说明](cloudflare-setup.md)。

## GitHub 登录补充验收

2026-09-26 UTC：既有 GitHub IdP Test 成功识别本人身份；新增的 Mail Hero GitHub 策略以精确邮箱 Include 与 GitHub login_method Require 同时匹配，不接受所有 GitHub 用户。应用增加可选 `ACCESS_OWNER_ALIASES`，成功认证始终返回原 canonical owner。

`native-api.test.mjs` 16项认证与API测试通过，覆盖两个alias与主邮箱映射为同一身份、未列出邮箱、大小写差异、错误签名/issuer/audience、过期JWT和缺少主owner的拒绝。这些检查已纳入当前32项原生测试套件。实际GitHub → Access → Mail Hero页面与受保护配置查询另行验证；邮件验收见下节。

## 单封真实测试信验收

用户明确确认测试信已发送后，仅检查该测试信。实际主题为 `Test`，记录 ID `57c203bf-f061-4b82-b517-c52488e9c4b3`，接收时间 `2026-09-26T04:47:58.569Z`，原件 10,744 bytes。

- 生产 D1 为 `ready`、`parse_error=NULL`、`arrival_count=1`、`receive_mode=archive`，无附件、无 delivery。
- 通过已认证线上 UI 打开该详情，中文纯文本正常显示，状态为“已保存 / 可阅读 / 未安排”。详情 API 实际读取私有 R2 的解析 JSON，不仅检查数据库标记。
- 独立读取精确 raw 对象，确认 10,744 bytes 且 SHA-256 与 D1 完全一致；只输出比对结果，检查后移除本机临时副本，云端原件保留。
- 该信没有 HTML 或附件，相应验收不算通过。没有安排 webhook，也未调用 Todofy/Todoist；Gmail/Exchange 自动转发、生产故障重试及完整备份恢复仍待验证。

## Todofy 接入与正式发布（2026-09-26 UTC）

- 现有入口为 `https://daily.ziyixi.science/hooks/mail`，使用专用 Bearer 凭据和稳定来源 `mail-hero-personal`。邮件不会走旧 CloudMailin 格式接口。
- Todofy 已新增独立 SQLite WAL/FULL 持久 inbox，挂载到 `/var/lib/todofy-mail`；204 表示接管完成，业务进度独立查询。
- 合成系统事件 `96fe9dea-1a2b-4a04-a793-61b5a99e77d7` 的公网 HTTP 验收通过：无认证/错误认证 401、首次及相同重复 204、同 ID 不同 bytes 409。内部恰有一条 ignored 记录、task_id 为空；重建主容器后该记录仍存在。该事件未调用 LLM/Todoist。
- 原有 Tunnel、LLM、Todoist 和 database 三个依赖容器保持原启动时间；只重建主 Todofy。旧 CloudMailin 入口保留，来源邮箱转发由用户切换。
- 部署诊断发现 Cloudflare Browser Integrity Check 拒绝 Python 默认客户端标识（1010）。明确 `User-Agent: MailHero/1.0` 后正常。原生投递已加入此标识，并通过真实 workerd 的 503 → 204 重试测试；未关闭 Cloudflare 防护。此项手动发布 Worker 版本为 `b4b99376-9cd9-44d5-affc-8111eff67e1f`。
- 仓库清理后的本地检查通过：32项Cloudflare原生测试、2项CI配置测试、3项UI测试、双方TypeScript和UI build。Todofy race测试属于独立消费者的验证；镜像发布和完整用户测试信链路分别记录，不由Mail Hero测试结果推定。

Todofy提交`5f0e8c6232b24084a0fed99d975f4b2db5272235`的 [GitHub Actions run 36261628140](https://github.com/ziyixi/todofy/actions/runs/36261628140) 已成功，发布镜像为：

```text
ghcr.io/ziyixi/todofy@sha256:632dba1a1b70ab31667d7bfacffbbd50ef1e1b06dc565c0cc47c66733f831675
```

部署仓库提交[`2d529e86fc3a043c04fc76a2410d440bc895c240`](https://github.com/ziyixi/self-host-on-vultr/commit/2d529e86fc3a043c04fc76a2410d440bc895c240)已推送，服务器通过fast-forward取得配置并仅更新Todofy主容器。主容器启动于`2026-09-26T18:23:55.711471621Z`，`18:24:17Z`检查为healthy；实际镜像digest和OCI revision均匹配上述CI产物。三个gRPC依赖容器仍保持9月5日的原启动时间。

CI镜像更新后，合成事件`96fe9dea-1a2b-4a04-a793-61b5a99e77d7`仍恰好一条记录，状态`ignored`、处理尝试次数0、task_id为空。此检查验证inbox跨镜像更新持久保存，没有调用LLM或创建Todoist任务。此检查时Mail Hero仍为archive、目标暂停；随后激活记录如下。

`2026-09-26T18:26:05.583Z`通过已授权的Cloudflare账户管理和D1原子条件更新完成投递激活，未使用UI操作作为验收证据：

- settings为`forward`、`send_paused=0`、version 2，当前目标`7886bda0-502a-438c-bc77-1a1aaf915710`。
- 目标`paused=0`、version 2，冻结配置revision为`3a866523-4ca1-4c6f-afae-8f8113406fbf`。
- Worker为`FORCE_SEND_PAUSED=false`、`MAINTENANCE_MODE=false`，允许目标域名为`daily.ziyixi.science`；`CREDENTIAL_KEY` secret binding保留。
- 激活前delivery总数为0，没有释放任何积压事件，原archive邮件不变；新邮件入站后会唤醒DO并按forward配置处理。

截至该次激活，尚未安排或完成用户测试信的完整业务验收。

HTTP 接管、容器重建存活与 Mail Hero 解析测试不能代替用户测试信经过 LLM 后成功创建 Todoist 任务的验收。当前没有完整备份恢复成功的证据。

## GitHub Actions正式发布记录

首次正式发布提交`aaa444f`的 [GitHub Actions run 36261505007](https://github.com/ziyixi/mail-hero/actions/runs/36261505007) 已成功；Worker版本为`aedd3120-af09-424d-be1d-e57be41dbca9`。

仓库随后按用户要求清除Mail Hero的Go/PostgreSQL服务、中转Worker及主机部署材料；当前验收命令只执行Cloudflare原生和React测试。清理提交`c0677406a75ee0de83c673a585b6383ab4860bc8`的 [GitHub Actions run 36262297081](https://github.com/ziyixi/mail-hero/actions/runs/36262297081)检查及部署均成功，Worker版本为`e4fe47d3-61b8-4306-8cc7-d7822afd1c91`，D1没有待应用迁移。这证明清理后的原生项目已经正式发布；用户测试信到Todofy/Todoist的完整业务链路仍待单独验收。
