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
| 原生部署打包 | Wrangler 4.141.0 `deploy --config wrangler.native.toml --dry-run` 通过（当时的模板文件；2026-09-30 起生产配置为 `mail-hero/wrangler.toml`）；541.77 KiB；生产发布另见下表 |
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
| 精确收信规则 | `64ebbe06caa64beaa47c8589db9e785c` 已启用：收件地址（`MAIL_HERO_RECEIVE_ADDRESS`）→ Worker `mail-hero`；catch-all 仍禁用，未更改 |
| 公共 DNS | `dig` 已查到收信子域的 Cloudflare MX（18 `route2.mx.cloudflare.net`、26 `route1.mx.cloudflare.net`、92 `route3.mx.cloudflare.net`）及 Cloudflare SPF；根域仍为优先级 10 的 `mx01.mail.icloud.com` / `mx02.mail.icloud.com` |
| 部署初始化状态 | `archive`、retention NULL、logical_bytes 0、容量 5GiB、messages 0、endpoints 0；消费者强制暂停 |
| 真实单封收件 | 用户发送的 `Test` 于 `2026-09-26T04:47:58.569Z` 入站；解析 ready，无错误，arrival_count 1，archive，delivery_count 0；R2 原件可读且大小/摘要与 D1 相符，UI 中文正文正常 |

当时生产配置在 gitignored `cloudflare/wrangler.native.production.toml`（2026-09-30 起改为提交的 `mail-hero/wrangler.toml`，个人值与开关由 CI 注入，见文末）。GitHub owner 登录、受保护页面及用户发送的一封真实纯文本邮件的入站、存储、后台解析与 UI 展示已验证。这不覆盖自动转发、大邮件、故障重试和恢复。

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

## 完整测试信与凭据延期（2026-09-26）

用户发送的 `Mail Hero Todofy test 20260926` 在18:31:20.980 UTC被接收，原件6,957 bytes，解析ready。事件`b3a7f057-abf4-4b73-86be-447ac040ba96`第一次发送于18:31:25.195返回HTTP204。Todofy中恰有一条对应记录，18:31:29进入complete；精确查询确认Todoist任务`6hf2W46X3Gc8hjV7`存在且主题一致。此项是上述较早“待验证”记录之后的独立完整业务验收。

用户确认后，Mail Hero部署令牌已取消固定到期日，token值与现有权限保留；现有Wrangler登录未更改。其他已核对的R2备份与Tunnel令牌未显示固定到期；GitHub本机OAuth无法据此宣称永不过期。

## storage-v1 本地验证与发布准备

- 原生TypeScript检查通过，完整测试69/69通过，包含真实workerd的D1/R2/SQLite DO绑定、精确25MiB单/多大附件、入站持久处理、生命周期和删除恢复、快照边界、签名成功回执、16MiB加尾块的备份分片上传及读回SHA校验。
- UI TypeScript、7项测试和生产build通过；3项CI配置测试通过。
- 备份工具10项测试通过，包括无网络容器内真实GPG公钥加密、解密、独立SQLite SQL重新载入、最新删除日志应用与隔离恢复。Mac本机无GPG时该项会skip，因此另用包含GPG的隔离工具容器实际执行。服务器Python/GPG可用。
- 自动清理与新投递并发的回归测试通过；终态条件放在同一个tombstone更新内。EXPLAIN验证周期查询使用live/pending部分索引，避免不断扫描永久历史账本。
- Todofy兼容提交`b56112ef5d1d3d0ef5500642885eb920301ef7df`已推送；隔离暂存索引的mail race测试和全量golangci-lint通过。未包含用户的推荐功能改动。
- 已创建独立私有`mail-hero-backups`桶及GitHub production的对应binding变量。恢复私钥仅保存在本机；服务器只接收公钥与已加密应用密钥escrow。

上述不等于生产Free CPU预算、大附件真实邮件、Cloudflare新空资源灾难恢复或定时备份已通过。独立备份机器Access权限仍待具体授权；通知默认仅页面展示。Chrome对状态API返回ERR_BLOCKED_BY_CLIENT，浏览器验收需解除客户端拦截后继续。

首次容量迁移先通过现有已验证提交的[维护发布36266716238](https://github.com/ziyixi/mail-hero/actions/runs/36266716238)暂停旧版本写入；该运行于19:39:11 UTC成功。后续新版本部署、恢复收信及服务器镜像事实另行补录，不能由本地验证推定。

## storage-v1 消费者更新与浏览器验证

- Todofy兼容提交的[GitHub Actions运行36266358399](https://github.com/ziyixi/todofy/actions/runs/36266358399)成功，服务器从GHCR拉取固定digest `sha256:0892e7087bc624cb92d50a4cf92594297f4058403f41c50484dd1858e3998b5b`，OCI revision匹配`b56112ef5d1d3d0ef5500642885eb920301ef7df`。
- 只重建Todofy主容器，启动于19:49:53.255 UTC，健康接口200；三个gRPC依赖仍保留9月5日的原启动时间。更新后上述两个测试事件仍分别恰好一条，合成事件ignored且无任务，用户测试事件complete且任务记录保留。
- 本地真实Miniflare D1/R2/SQLite DO的桌面1365×900和手机390×844页面验收通过。设置的预览、确认和保存实际调用API/CSRF；原件过期隐藏原件下载和重解析，正文截断、HTML省略、附件未保存均可见，省略附件没有下载链接。
- 修复手机附件名称和省略原因的单行裁切，实际截图确认说明完整、已保存附件下载图标可见、无横向溢出；TypeScript/Vite build通过。上述仅使用合成邮件，不代表生产浏览器拦截已经解除。

## storage-v1 生产发布结果

提交`bc63a115fc66b5faa1c1903d3f9f858607cde7c2`的[正式发布36267674090](https://github.com/ziyixi/mail-hero/actions/runs/36267674090)于19:56:04 UTC成功。生产已应用`0006_lifecycle_alerts.sql`，配置核对为原件7天、内容30天、账本至少180天、5GiB容量及策略版本1；历史邮件不自动纳入新期限。新增`BACKUP_STORE`指向私有`mail-hero-backups`，公开桶地址关闭，未完成分片默认7天自动终止。

[退出维护发布36267817083](https://github.com/ziyixi/mail-hero/actions/runs/36267817083)于19:58:36 UTC成功，Worker版本`a6882051-aeb9-4a66-a552-960bda60f448`。随后账户API实查`MAINTENANCE_MODE=false`、`FORCE_SEND_PAUSED=false`；三个必要secret binding均保留，workers.dev及预览URL仍禁用。无认证访问owner overview和backup status均由Access返回302，未放开匿名管理入口。实际维护窗口约19:39–19:58 UTC；期间接收暂停，不假设来源必然重投。

服务器部署仓库现为`785db9dc91faf7fb6b4cc1ed9cdd8379b4d64aa7`，仅拉取了备份安装器源文件，`mailhero-backup.timer`仍为not-found；没有安装或启用定时任务。安装器会先停止调度并拒绝与运行中的备份并发升级，6项离线部署测试通过。

待办边界：专用Access机器身份的新增权限仍待用户确认；生产实际备份、独立恢复及定时运行尚未完成。恢复私钥与应用密钥的加密副本已在受限本机目录生成，但尚无独立离机托管证据。生产浏览器状态API仍受客户端拦截，DO容量基线初始化状态尚未通过认证overview核实；代码会在首次需要容量的调用中有界初始化，完成前拒绝新写入。Free CPU/内存真实用量、此次升级后的新测试信以及新空Cloudflare资源灾难恢复均不由CI通过推定。通知当前仅UI，外部通知目的地未配置。

## 专用备份身份、真实快照与隔离恢复（2026-09-26 UTC）

以下更新上述待办；备份范围仅是 Mail Hero 应用数据及恢复材料，不是主机系统备份。

- 用户确认后，部署令牌仅新增 `Access: Service Tokens Write`，原有12项权限保持；未改变其他 Worker 的授权。专用 Access service token `mail-hero-backup` 使用 `forever` 有效期，并由精确路径 `mail-hero.ziyixi.science/api/internal/backup/*` 的 Service Auth 策略单独放行。owner app 与两条 owner policy 的前后比较一致。
- 实际认证矩阵：Access service credential + 独立 backup Bearer 对 backup status 为200；缺 Bearer 为401；缺 Access service credential 为403。该机器身份访问 owner overview 为302，不能用作 owner 登录。服务器只有专用备份凭据、公钥与加密应用密钥，没有 Cloudflare 管理令牌或恢复私钥。
- 收集/恢复增加所有存活内容引用核验；不能仅对现有文件算 hash 就认为完整。提交 `1e0f48d73dd9aa1dc503a6422461d7a6a6deef87` 的17项真实 GPG 测试通过，[发布运行36268687026](https://github.com/ziyixi/mail-hero/actions/runs/36268687026)成功；生产 Worker 版本为 `43f01ae3-b015-4db5-acf3-3a97dff72759`。
- 首轮演练发现预制应用密钥密文解密后为空。已从现有密钥显式文件重新加密，在断网容器中解密并逐字节核对后，仅替换服务器上的密文；线上 `CREDENTIAL_KEY` 未改变。随后重新执行完整采集和恢复，不以首轮上传成功充当完整恢复成功。
- 最终快照 `360280ed-dd88-4e02-b9b4-514f06d71740` 为21,265 bytes加密归档；服务器完整读回 R2 并校验 SHA，签名 finish 成功。独立恢复设备根据服务器回执再次从 R2 下载并核对 SHA，再获取最新删除清单。
- 在无网络容器的新空目录实际解密恢复：2封邮件、5个对象、1条交付事件，完整对象字节36,974。SQLite integrity/FK、raw/parsed/payload 引用、对象 hash/size、冻结事件身份及 payload bytes、删除清单应用、逻辑容量核对均通过。归档内应用密钥解密后与原密钥一致。恢复副本发送暂停、端点暂停、`activation_allowed=false`，未访问消费者或创建业务任务。
- 备份后在线状态为 `remote_verified`、`paused=false`、未完成上传0、`receipt_sync_pending=false`；D1 `last_backup_at=2026-09-26T20:23:13.351Z`。Worker 维护和强制暂停均为false，应用 `send_paused=0`，三个必需secret binding保留。生产控制快照显示容量基线已初始化，36,974 bytes、上限5GiB。

服务器每日 timer 尚未安装。用户已同意亲自执行需要 sudo 密码的最后安装命令；该命令只安装 Mail Hero 独立定时任务。准备启用的时间为04:17 UTC加最多10分钟随机延迟，保留7个日快照和4个周快照（重合去重，至多11份）。此时已完成真实手动备份与隔离恢复，不能把它表述成定时运行已验证。

该演练是本地隔离恢复，不是恢复到新空 Cloudflare D1/R2/DO 后重新上线的灾难恢复；不据此承诺 RPO/RTO。恢复私钥仍只在本机受限目录，尚无独立离机托管证据。生产浏览器客户端拦截、Free CPU/内存真实用量和升级后的新测试信仍需分别验证；外部通知目的地未配置。

## Compose 备份正式部署（2026-09-26 UTC）

用户要求沿用现有 Docker Compose，自行完成全部部署。本节替代前节待用户执行 sudo/systemd 安装的计划；预检确认旧 timer 为 `not-found`，没有安装过系统定时任务。

- Mail Hero 提交 `97f8886241b5a85d256099b293ada8703bb779c2` 将收集器、Python/GPG及每日调度封装为非root镜像，删除旧systemd示例。服务器部署仓库提交 `97d05665d40da174281c8da03caecd3b9298e6fc` 增加唯一 `mailhero-backup` Compose服务并删除旧主机安装器。应用继续运行在Cloudflare，备份范围不变。
- 非root、断网、只读镜像环境中的29项合成测试全部通过，包括真实GPG加密恢复、失败后持久退避、重启补跑、时钟回拨、进程互斥及取消租约/临时明文清理。7项Compose部署合同检查无skip通过；部署仓库CI也成功。
- [备份镜像发布36271060129](https://github.com/ziyixi/mail-hero/actions/runs/36271060129)、[原生检查与部署36271060119](https://github.com/ziyixi/mail-hero/actions/runs/36271060119)及[部署仓库检查36271267475](https://github.com/ziyixi/self-host-on-vultr/actions/runs/36271267475)均成功。GHCR package为public，匿名读取manifest成功，无需服务器新增GitHub登录凭据。
- 服务器实际拉取并运行 `ghcr.io/ziyixi/mail-hero-backup@sha256:0206ec216c9e16bdf97b2f47c60915858d3696ce32425c76c9e55a06ce4f7f3a`，运行中的OCI revision与上述Mail Hero提交一致。没有在服务器手工构建镜像，没有sudo操作；容器UID/GID为1000，根文件系统只读、无特权模式，不挂载Docker socket，只挂载独立配置和备份状态目录。
- 正式镜像首次 `once` 运行于20:58:39.721 UTC完成：快照 `090dfee3-5933-4f6f-8b02-e0d527e648e7`，加密归档21,547 bytes。上传、完整读回SHA和签名finish通过。随后独立恢复设备再次读回并核验SHA、获取最新删除清单，在断网新空目录实际恢复2封邮件、5个对象、1条交付事件；数据库完整性、对象引用/hash、冻结事件及应用密钥解密比对全部通过。恢复副本保持暂停，未触发消费者业务。
- 20:59 UTC启动每日服务，随后仅重启该容器验证持久状态。21:00 UTC复查为 `running / healthy`，本地health退出0，成功回执未被替换或重复触发，下次调度 `2026-09-27T04:17:00Z`。正常每日04:17 UTC运行，失败约一小时后重试，健康检查只读本地状态。
- 16个既有运行容器的ID、镜像和启动时间与部署前全部一致；新服务之外的13个Compose service及4个network配置保持原值。没有使用 `--remove-orphans`、全栈down或update脚本。备份状态目录没有遗留 `.snapshot-*` 明文目录；本机演练临时解密副本完成核验后清理，加密归档与回执保留。
- 生产备份状态为 `remote_verified`、`paused=false`、无未完成上传或待同步回执；D1 `last_backup_at`等于上述成功时间。Worker维护、强制暂停与应用发送暂停均关闭，必要secret binding保留。当前Worker版本 `9c477d4e-dc59-441e-b0cc-523e63b3982b`。

已验证正式镜像真实备份、隔离恢复、常驻服务健康及重启持久状态；每日04:17 UTC钟点触发尚未到来，不把配置好日程描述为已观察到次日自动运行。仍未演练新空Cloudflare资源的完整上线恢复，私钥的独立离机托管及外部告警目的地保持前述边界。

## 收件停在 pending 的 D1 查询修复（2026-09-26 UTC）

- 经用户授权，线上状态核查确认新收邮件已保存原件，但解析一直为 `pending`，没有生成交付事件。解析前清理查询使用 `parse_cleanup:<UUID>:%`，模式为52 bytes，超过[D1 LIKE/GLOB 的50 bytes限制](https://developers.cloudflare.com/d1/platform/limits/)。生产D1上只使用合成参数的只读表达式复现了 `LIKE or GLOB pattern too complex: SQLITE_ERROR`，无需读取原件即可确认原因。
- 改用精确UUID前缀的主键范围查询；回归测试显式模拟生产模式长度限制，验证清理不会影响相邻邮件ID且使用主键索引。本地SQLite/workerd并不可靠地执行此生产限制，不能只依赖集成测试发现它。
- 收件箱与详情区分待解析、解析中、解析失败，解释正文尚未提取及自动交付需等待解析；已经解析且确实无主题的邮件保持原有显示，重解析失败也不会隐藏此前保留的正文。
- 本地Worker完整测试71项、前端19项、部署配置3项均通过，Worker TypeScript与前端构建通过。真实workerd D1/R2/DO合成链路覆盖Gmail转发格式、中文正文解析及一次自动交付到fake consumer。
- 上述是修复及本地/合成验证；正式Actions发布和生产积压恢复需另行核验，不能由测试通过推定。

### 正式发布与生产恢复结果

- 修复提交 `50beaa148055a466fbd2c4873917e64fd7288515` 的[正式Actions运行36277488298](https://github.com/ziyixi/mail-hero/actions/runs/36277488298)检查与部署均成功；Cloudflare实际部署时间为22:50:37 UTC，Worker版本 `662e587d-42fc-42a1-a565-7e11ddb33e45`。
- 未改生产邮件行、未手动重建事件，也未要求重发。原有Alarm在22:54–22:55 UTC自动恢复三封积压邮件：均为 `ready`，各生成一个已交付事件、一次尝试、HTTP204，无解析或交付错误。
- owner浏览器真实详情确认用户指定测试邮件的主题、原发件人和中文正文完整显示，交付时间线显示一次成功。仅核验该事件的Todofy状态API：恰好一条记录，`state=complete`，无错误码。未输出原件、凭据或其他邮件正文。
- 此结果覆盖本次真实Gmail自动转发到Mail Hero、后台解析、Todofy持久接收及业务状态完成；不推定其他来源、未测试MIME结构或未来容量情况均已验收。

## 维护读取量、阻断自动复查与 Todofy 卡住提醒（2026-09-27 UTC）

用户授权修复分析中的三项高风险问题，并要求推送 GitHub、完成 Cloudflare 与服务器部署。用户选择暂不接外部告警渠道，Todofy 侧每日最多一条 Todoist 提醒。

- 问题与依据：部署前生产 D1 约 46 封在库邮件时每日读取约 16 万行，DO 约 28 万行；`d1 insights` 显示约85%来自每10分钟维护周期（lifecycle候选511行/次、告警快照274行/次、repair 126行/次、retention UPDATE 62行/次），均随在库或历史邮件线性增长，备份 D1 导出的 OFFSET 分页随表大小平方增长。按每天50–100封推算，数周到数月内会超过 Workers Free 每日500万行读取。
- Mail Hero 提交 `87ae06eaece2a00534ec39e925b92a9e3f569fb4`：D1 迁移 `0008_bounded_maintenance` 增加预计算 `lifecycle_due_at`、未结清/到期/缺失到期/待删字节部分索引、`blocked_until`、`blocking_since`，以及由触发器维护的 `app_counters`；维护、告警、overview 只读取到期、未结清或在途行；DO 容量改为 `capacity_totals` 运行总量并每日重算；备份 D1 导出改为 rowid keyset，请求/响应协议不变，现有收集器无需更新。删除内容仍按原锚点与 safe-terminal 在变更租约内复核。
- 404/405/3xx 改为30分钟宽限后阻断目标版本并6小时自动复查，成功即解除；401/403和策略错误仍需 owner 轮换凭据或新增的“解除阻断”（`POST /api/v1/endpoints/:id/unblock`）。`pending_stale` 不再被失败/取消的投递永久点亮；新增仅 UI 显示的 `endpoint_blocked`、`endpoint_paused`、`delivery_failed`、`policy_error` 提醒及全局提醒条。
- 本地验证：Worker 93项（含 workerd 行读取回归：300与3,000在库邮件时每个维护周期约170–200行 D1，overview 23行，DO 约13行；旧代码为3,696与36,096行）、前端39项、部署配置3项、备份 Python 29项（1项需 GPG 在本机跳过）全部通过；Worker 与前端类型检查、构建通过；wrangler 4.141.0 本地应用含触发器的 0008 成功。独立审查覆盖数据安全语义、实测读取量、迁移与部署间隙、回滚兼容、备份导出兼容。
- 正式发布：[原生检查与部署36358925115](https://github.com/ziyixi/mail-hero/actions/runs/36358925115)与[备份镜像36358925146](https://github.com/ziyixi/mail-hero/actions/runs/36358925146)成功。Cloudflare 于23:32:09 UTC部署 Worker 版本 `487e78a9-9d44-4c34-b054-e1926e958735`；远程 D1 迁移列表为 “No migrations to apply”，生产 schema 已含7个新索引、`app_counters`及6个触发器；计数表为109封邮件、108次已交付、0待交付、0失败。Access 登录跳转与未认证 XHR 401 行为不变。服务器备份收集器镜像未变（备份协议未变）。
- Todofy 提交 `6c46ed4f4508950f73456b199d4f6ac175ef533f`（仅网关）：`view=attention`、按状态计数、`dismiss`、LLM暂时失败7天重试窗口、每 UTC 日最多一条不含邮件内容的 Todoist 提醒。[Todofy CI 36358999614](https://github.com/ziyixi/todofy/actions/runs/36358999614) 9个任务全部成功（含 lint、SUT、集成与镜像发布）。另一任务的未提交文件未纳入提交。
- 服务器：部署仓库提交 `bcad459`（[检查36359699599](https://github.com/ziyixi/self-host-on-vultr/actions/runs/36359699599)成功）仅更新网关 digest 为 `ghcr.io/ziyixi/todofy@sha256:78e300ae68026bb8fde3d8a12d8c4038996e57183bbc1a197b1b8a9ed06b91f8` 并更正注释。23:44:39 UTC 以 `docker compose up -d --no-deps todofy` 只重建网关；运行镜像 OCI revision 为 `6c46ed4`，本地及 `https://daily.ziyixi.science/health` 返回200，未认证的 `/hooks/mail` 与 `view=attention` 返回401；其余16个容器 ID 不变，三个 gRPC 后端未改动。
- 生产读取量（Cloudflare GraphQL 15分钟聚合，只读）：部署前每15分钟 DO 约1,400–2,900行（小时峰值2.6万行），部署后第一个完整15分钟桶（23:45）DO 为82行。D1 `insights` 中新维护查询每次只读1–5行（旧查询为62–588行/次）；同桶 D1 总读取主要来自 owner 当时浏览 UI（dashboard统计、列表）。部署前已计时的107封邮件由代码自愈写入 `lifecycle_due_at`，缺失数为0，最早到期 `2026-10-03T23:04:36Z`（原件7天规则）；维护阶段正常轮转，未结清邮件2封。以上核查只读取计数、schema 和维护元数据，未读取邮件内容。
- 尚未验证：生产中的解除阻断、宽限/复查及新提醒条未在浏览器中实际演练（生产目标当前未被阻断）；keyset 备份导出将在下一次04:17 UTC定时备份首次运行；Todofy 每日提醒是否触发取决于是否存在 attention 事件，本次未用 BasicAuth 查询；数周后稳态读取量需按实际邮件量复查。

## 已处理异常清理期限与路由阻断复查上限（2026-09-28 UTC）

- 用户在上一轮上线后追加两项要求：投递失败后已由 owner 处理（重发成功或 owner 取消）的邮件按“略长、可设置”的期限清理；404/405/3xx 自动复查设最大次数（8 次，约 2 天）。
- Mail Hero 提交 `e3320725`：迁移 `0009_resolved_retention_rechecks` 增加 `app_settings.resolved_retention_days`（默认60天；迁移时取 max(60, 正文期限)，正文不清理时为 NULL）、`messages.resolved_at` 与 `endpoint_revisions.blocked_rechecks`。已处理异常只在无进行中交付、最后一个已送达交付之后的交付都已送达或由 owner 取消（从未送达时全部由 owner 取消）、且有策略快照时成立；期限自最后一次处理起算，并取全局期限、当前正文期限及邮件自身正文期限中最长者；删除标记在同一语句内重新核对规则与到期时间。未处理的失败、进行中交付、NULL 策略历史及已开始普通计时的邮件不改用此期限。开启或缩短需要预览确认。路由类阻断每次进入6小时冷却计1次，最多8次；之后保持阻断直到 owner 解除，成功、解除或轮换凭据清零。
- 默认值说明：此期限随迁移对现有设置生效，这是用户在会话中明确要求的；不过只有新 Worker 的清理扫描才会记录 `resolved_at`，因此最早也要在部署约60天后才会发生按此规则的删除，owner 可在此之前于设置页修改或关闭。
- 本地验证：Worker 113项（含 workerd 真实 D1/R2 的已处理清理、并发重发不误删、关闭/延长期限的竞态、8次复查后永久阻断等）、前端58项、部署配置3项、备份29项（1项因无 GPG 跳过）全部通过；类型检查、构建与本地 wrangler 迁移通过。独立审查发现并修复了 NULL 策略历史误删、无尝试的后续处理不更新锚点、已处理期限短于邮件自身正文期限、迁移默认值低于正文期限阻塞设置保存等问题。
- 正式发布：[原生检查与部署36365274830](https://github.com/ziyixi/mail-hero/actions/runs/36365274830)与[备份镜像36365274921](https://github.com/ziyixi/mail-hero/actions/runs/36365274921)成功；Cloudflare 于01:16:47 UTC部署 Worker 版本 `f8a8acec-8859-4a6d-9507-b0013978e7f8`，远程迁移列表为 “No migrations to apply”，生产设置为正文30天、已处理异常60天，新增列存在；计数与 Access 行为不变。服务器无需变更。
- Todofy attention 核查（owner 自行在本机终端以 BasicAuth 查询，凭据未经助手处理）：`attention_count=0`，`complete` 108、`ignored` 1，其余状态为0，`latest_reminder=null`，与 Mail Hero 已交付108一致。
- 部署后约12分钟复查：新的保留扫描（含已处理异常判定）在生产已运行，`insights` 显示每次平均读取7行；维护阶段正常轮转，当前无被标记为已处理异常的邮件（`resolved_at` 为0，与全部邮件均已送达一致）。以上只读取计数、schema 与维护元数据。

## 投递概览改用浏览器时区（2026-09-28 UTC）

- 用户要求 dashboard 时区与浏览器一致（当前为 PDT）。提交 `9d29025`：前端发送浏览器 IANA 时区 `tz`，Worker 在一次 D1 查询内按该时区的本地日/小时分桶（区间内 UTC 偏移分段作为绑定参数），正确处理 23/25 小时日、重复的回拨小时及 :30/:45 偏移；桶携带 `end`，下钻按实际长度。无 `tz` 的旧请求保持与原 UTC 输出逐字节一致；浏览器时区不可用时回退 UTC。
- 本地验证：Worker 120项、前端64项（另在 `TZ=America/Los_Angeles` 与 `TZ=Asia/Kolkata` 下各跑一次）、部署配置3项通过；审查脚本覆盖418个时区无问题。
- 正式发布：[原生检查与部署36369687379](https://github.com/ziyixi/mail-hero/actions/runs/36369687379)成功，Cloudflare 于02:25:58 UTC部署 Worker 版本 `db94db68-574b-4fed-9622-142be277f694`；未认证访问仍由 Access 拦截。尚未由 owner 在浏览器中实际查看新概览。


## 共享鉴权包 `packages/edge-auth`（2026-09-29，仅本地）

- 改动：`security.ts` 的 Access JWT、CSRF 签发/校验与私有响应头改用单仓库共享包 `packages/edge-auth`（`file:` 依赖编译进 Worker，仅 Web Crypto）；`jose` 移出运行时依赖，只留作测试签发合成 JWT。错误状态、错误码与文案、`mail_hero_csrf` cookie、token 格式和 HKDF 密钥不变；预览 token、`actionHash`、Webhook 凭据加密及备份机器 API 的 Bearer 校验仍是本应用代码。按 `packages/edge-auth/SPEC.md` §4，校验在 jose 基础上收紧：必须有 kid、iat 不得超前60秒、sub 为非空字符串、数值声明必须有限、CSRF 只接受规范签名与整数 exp；Origin 比较改为不区分大小写（浏览器总是发送小写，SPEC §4 #27 待 owner 确认）。
- 本地验证：Worker 143项（新增5项：旧代码签发的 golden CSRF token 经 `handleAPI` 与默认验证器通过；RS256 以外算法、alg none、HMAC 混淆、缺 kid、未知 kid、crit、未来 iat、nbf+5秒、空/缺 sub、缺 iat、1024位 RSA 均为401；certs 500/异常/302/非 JSON 均为401“Access 登录无效或无权限”；token 来源、开发绕过和配置失败的状态与文案；CSRF cookie 属性、声明顺序与 UUID nonce、缺 `CREDENTIAL_KEY` 时签发503/校验403；私有响应头逐字节）、前端64项、部署配置3项、备份29项（1项跳过）通过；类型检查、UI 构建通过；占位生产配置的 Wrangler dry-run 打包含 `packages/edge-auth/src`，不含 jose。
- 未完成：尚未部署；真实 Access 登录（主邮箱与 alias）和一次真实写操作需在发布后由 owner 在浏览器确认，出现401即回滚该提交。

## ops-v1 运维入口（2026-09-29，本地实现，未发布）

- 按 [`contracts/ops-v1`](../../contracts/ops-v1/README.md) 实现 Mail Hero 侧：命名入口 `Ops`（`status`、`setGuard`、`startCanary`、`canaryDelivery`），迁移 `0010_ops_canary`（`messages.canary_run_id` 及部分索引、`alerts.active_since`），协调器 SQLite 中的 guard 与各项清理的上次运行时间，`mail.received.v1` 金丝雀标记由真实 `buildPayload` 写入，投递列表/详情以“金丝雀”标记，`PUBLIC_HOST` 由 CI 从 `MAIL_HERO_PUBLIC_HOST` 生成。
- 本地验证（全部为合成数据，按 CI “Mail Hero checks” 顺序执行）：部署配置3项、备份29项（1项因无 GPG 跳过）、Worker 类型检查及160项测试、前端类型检查与66项测试和构建、占位配置 `wrangler deploy --dry-run`（打包导出 `MailCoordinator`、`Ops`、`default`）均通过。workerd 测试由第二个 Worker 经 `entrypoint = "Ops"` 的 service binding 调用真实入口，覆盖：各输出通过 ops-v1 schema 校验且不含种子邮件的主题、地址、正文或目标主机；`status()` 不超过6条只读 D1 语句，`canaryDelivery` 1条，`setGuard` 0条；guard 幂等、36小时上限、到期自动恢复；金丝雀按 `run_id` 幂等，消费者先收到503再收到204，两次请求字节相同且与 `buildPayload` 构造的金丝雀字节一致；暂停、阻断、仅归档、备份快照、容量不足、维护模式均不创建记录或 R2 对象；7天后清理内容且提醒阶段不超过40条 D1 语句；shed 期间恰好推迟四项清理（各自满48小时后仍运行一次），真实邮件的收信、解析、投递和金丝雀投递不受影响。
- 金丝雀 fixture 的事件编号原为16，与冻结的 `legacy/pre_storage_v1.json` 相同，Todofy runtime 测试因此得到 409 `event_conflict`；已改为17（只改变 `canary_event.json` 的两个 ID），两侧合同测试现在拒绝重复的 `event_id`/`message.id`。
- CI 与文档提交 `5774907` 的干净克隆（2026-09-29，macOS，合成数据，占位配置，无生产调用）：`Changes` 的 `test_ci_changes.py` 28项通过；`Contracts` 各步骤通过（Mail Hero `contract-fixtures`、`ops-contract`、`native-ops` 共37项；Todofy 合同与 ops 单元测试302项；网关 `ops.test.ts` 10项）；“Mail Hero checks”全部步骤通过：部署配置3项、备份29项（1项因无 GPG 跳过）、Worker 类型检查及161项测试、前端类型检查与66项测试和构建、占位配置 dry-run（打包导出 `MailCoordinator`、`Ops`、`default`）。
- 未做：生产部署、真实仪表盘调用、与 Todofy `canary_consumer` 的端到端联调。按 ops-v1 发布顺序，应先发布支持金丝雀的 Todofy，再发布本变更。

## 生产配置提交到 `mail-hero/wrangler.toml`（2026-09-30，本地实现，未发布）

- 改动：删除 `cloudflare/wrangler.native.toml` 与 CI 配置生成器 `deploy/generate-ci-config.mjs`；生产配置即提交的 `mail-hero/wrangler.toml`（顶层即生产，无 `[env.*]`、无 `keep_vars`，`main`/`migrations_dir` 指向 `cloudflare/`），静态值取自当时的 GitHub production variables（只读核对）。`RECEIVE_ADDRESS`、`ACCESS_OWNER`、`ACCESS_OWNER_ALIASES`（GitHub secrets）与 `FORCE_SEND_PAUSED`、`MAINTENANCE_MODE`（GitHub variables）由 `deploy/deploy-vars.mjs` 校验后以 `--var` 注入，缺失或非法即拒绝。生成器的静态校验移到 `deploy/test/wrangler-config.test.mjs`；跨应用检查在 `.github/scripts/test_wrangler_configs.py`。
- 等价性（本地，只对 127.0.0.1 上的模拟 Cloudflare API，无 token、无真实调用；静态值为真实 variables，个人值两侧同为占位）：旧命令（生成器 + `wrangler deploy --config wrangler.native.production.ci.json`）与新命令（`deploy-vars.mjs exec -- wrangler deploy --config ../wrangler.toml`）各发出18个请求，逐一相同；绑定（名称、类型、值、类、桶、D1 ID）集合相同，仅顺序不同（注入的 var 排在最后）；`metadata.package_dependencies` 在新布局中不再发送（`mail-hero/` 无 `package.json`，仅为统计元数据）。上传脚本原始 sha256 `6a69f455…` → `ce2f6501…`，只因 esbuild 的 `// 路径` 注释相对于配置目录；规范化后两侧均为 `b38d2e8a…`。自定义域名、兼容日期、observability、DO 迁移标签与资产清单相同；`d1 migrations apply DB --remote` 的10个请求逐字节相同。
- 未做：生产发布。发布后由 owner 只读核对 `mail-hero` 的绑定与 var 值散列（尤其 `RECEIVE_ADDRESS`）与发布前一致，并在 UI 设置/诊断中确认“唯一收信地址”为 ok。

## 个人值改为 Worker secret，增加 `BUILD_SHA`（2026-10-01，本地实现，未发布）

- 改动：`RECEIVE_ADDRESS`、`ACCESS_OWNER`、`ACCESS_OWNER_ALIASES` 不再以 `--var`（plain_text）发布，而由 `deploy/deploy-vars.mjs secrets` 写入临时 secrets 文件（0600，不覆盖已有文件，CI 结束时删除），经同一次 `wrangler deploy --secrets-file` 成为 Worker secret；`FORCE_SEND_PAUSED`、`MAINTENANCE_MODE` 与新的 `BUILD_SHA`（`GITHUB_SHA`）仍为 `--var`。所有原有的缺失/非法拒绝保持不变；`exec` 另外拒绝没有恰好一个、恰好含这三个合法值的 `--secrets-file` 的发布。空 alias 列表上传为一个空格（`packages/edge-auth` 修剪后视为没有 alias），与面板、Lab 和 Todofy 网关一致。
- Wrangler 4.141.0 源码核对：`--secrets-file` 的条目以 `secret_text` 写入同一个按名字索引的绑定表，上传时带 `keep_bindings: ["secret_text", "secret_key"]`，不保留旧的 plain_text 绑定，因此同名 var→secret 在一次上传内完成；部署前的远端 secret 冲突检查只比较提交的 `[vars]` 与已有 secret 名，与本次切换无关。只读核对线上（只看名称与类型，不读值）：现有 secret 中没有这三个名字。
- 本地验证（合成数据，按 CI 顺序）：部署配置测试19项、备份29项（1项因无 GPG 跳过）、Worker 类型检查与168项测试、前端类型检查与66项测试和构建、CI 同款占位 dry-run（绑定表中三个个人值与 `BUILD_SHA` 均显示为 `(hidden)`）、根目录 `.github/scripts` 159项均通过。
- 对 127.0.0.1 上的模拟 Cloudflare API（无 token、无真实调用，合成值）分别运行旧包装器（`origin/main`）与新包装器的真实 `wrangler deploy`：两者请求序列相同；上传元数据唯一的差异是三个个人值由 `plain_text` 变为 `secret_text`、新增 plain_text `BUILD_SHA`、`keep_bindings` 由未设置变为 `secret_text`/`secret_key`，其余绑定、兼容日期、资产与 observability 相同。
- 未做：生产发布。发布后只读核对三个绑定类型为 `secret_text`、其余绑定名称与类型不变，并用合成测试信确认收件与 UI 登录正常。
