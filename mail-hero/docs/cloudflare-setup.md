# Cloudflare 原生部署、预算与恢复

Mail Hero 使用 **Workers Free + D1 + 私有 R2 Standard + SQLite Durable Object Alarm + Static Assets + Access**。应用、数据库和网页都由 Cloudflare 托管。Todofy 是独立 webhook 消费者，可以保留自己的服务器和 Tunnel。

当前已部署：唯一地址 **`inbox-mail-hero@inbox.ziyixi.science`**，UI **[mail-hero.ziyixi.science](https://mail-hero.ziyixi.science)**，唯一 owner **`xiziyi2015@gmail.com`**，数据库 `mail-hero`，私有桶 `mail-hero-store`。GitHub 登录和一封真实纯文本邮件的入站、持久保存、解析及 UI 展示已验收；来源自动转发、HTML/附件、大邮件、OTP 备用登录及生产收信额度仍需分别验证。Todofy消费者已具备持久接管接口，完整邮件到任务链路仍待用户测试信验收，见 [消费者接入说明](todofy-integration.md)。

本地生产配置为 gitignored `cloudflare/wrangler.native.production.toml`；`cloudflare/wrangler.native.toml` 是配置模板。[GitHub Actions](ci-cd.md) 从仓库变量和production secrets生成独立的CI配置并正式发布。以下资源创建和初始化步骤供新环境参考，**现有部署不需要重建资源或重新生成密钥**。完整证据和待验收项见 [验收记录](verification-native.md)。

## 1. 免费计划的运行边界

保持 **Workers Free**，不需要 $5/月的 Workers Paid、Queues 或 Workflows。R2 需要单独开通订阅；它有免费额度，超出按量计费，没有本项目能够保证的每月 $2 硬账单上限。[R2 开通](https://developers.cloudflare.com/r2/get-started/)、[用量计费与提醒](https://developers.cloudflare.com/billing/understand/usage-based-billing/)

| 项目 | 官方 Free 限额 | 本项目用法 |
| --- | --- | --- |
| Workers | 100,000 请求/天；普通调用 10ms CPU；128MB isolate 内存 | Email handler 只校验和流式保存，UI/API 保持短小。[限制](https://developers.cloudflare.com/workers/platform/limits/) |
| SQLite Durable Objects | 100,000 请求/天，含 Alarm；13,000 GB-s/天；SQL 5M 读/100k 写/天、总5GB | 一个 coordinator 保存任务；超额操作失败，不自动升级 Paid。[价格](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| DO Alarm | 默认每次30秒 CPU；wall time 最长15分钟；仍受128MB内存约束 | 有界后台解析和交付，等下次任务用 Alarm。[限制](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| D1 | 5M行读/天、100k行写/天；**单库500MB**、账户总5GB；单行/BLOB 2,000,000 bytes | 索引、状态、正文前16KiB搜索内容；完整正文在R2。[价格](https://developers.cloudflare.com/d1/platform/pricing/)、[限制](https://developers.cloudflare.com/d1/platform/limits/) |
| R2 Standard | 10GB-month、1M Class A、10M Class B/月；出网免费 | 原件、正文、附件、冻结事件；超额存储$0.015/GB-month、A $4.50/M、B $0.36/M。[价格](https://developers.cloudflare.com/r2/pricing/) |
| Static Assets / Access | 静态请求及资源存储免费；Access Free 50用户 | 单人 UI 和 owner 登录。[Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[Access](https://www.cloudflare.com/sase/products/access/) |
| Email Routing | 入站无限量；单封25MiB | 一个精确地址；Worker运行仍计量。[价格](https://developers.cloudflare.com/email-service/platform/pricing/)、[限制](https://developers.cloudflare.com/email-service/platform/limits/) |

25MiB 是原件上限，不代表任意25MiB MIME都已通过真实免费运行环境验收。解析在 DO Alarm 内执行，不在普通10ms Email/fetch handler里做。复杂附件、字符集和嵌套仍可能触及CPU/内存限制；失败时保留原件并显示错误。不能通过给普通Worker配置 `cpu_ms` 来获得付费能力。

## 2. 预算保护

2026-09-25 本轮账户概览只读核对：R2已开通，既有桶约779.89MB，本账期显示$0。没有读取其对象内容；这些是当时状态，不是未来可用额度保证。新Mail Hero资源的最终部署状态以本轮报告为准。

1. 在 Billing 确认 Workers Free，不升级Paid。R2只用Standard，不启用Infrequent Access、R2 SQL、Data Catalog、Sippy等不需要的服务。
2. 查看账户已有用量；免费额度由全部项目共享。建立账户级$1和$2 budget alerts；若只可设置一个，先设$1。**提醒只发通知，不停服务**，Threshold Billing扣款也不是限额。
3. 桶保持私有：不开 `r2.dev`，不绑定公开桶域名，不开放匿名下载。只开放Access保护的UI及精确邮件规则。
4. 保持应用初始逻辑容量 **5GiB**。它不是账户账单上限，不覆盖其他项目、备份和所有孤立对象。失败及待投递邮件不能静默删除腾空间。
5. 默认每个UTC日限制300封、256MiB原件，由 `INGEST_DAILY_MESSAGE_LIMIT` 与 `INGEST_DAILY_BYTE_LIMIT` 配置。DO在写R2前原子预留，D1故障时也生效；达到任一值会暂时拒绝入站。调高前核对用量，不能声称来源一定自动重投。这不是Cloudflare账户账单上限。
6. 新邮件冻结分阶段保留策略：原件默认 7 天、正文及附件默认 30 天，从安全终态开始计时。历史邮件只有在设置页选择并预览确认后才纳入，不因升级立即清理。维护分为恢复、保留、提醒三个独立 Alarm；保留阶段最多处理两个到期阶段，或先续做一个中断的完整删除，提醒约每 10 分钟评估。原件恢复每页最多 100 个 key，未结束时约 10 分钟续页，空闲完整扫描每天一次。失败、待处理和需人工检查的邮件不自动清理。部署状态见验收记录。
7. 每周查看R2总量/Class A/B、D1大小、DO duration/请求、Workers超限错误。建议R2 7GB、A 700k/月、B 7M/月、D1 300MB时开始处理；D1 400MB或应用容量90%时优先导出/清理。异常增长先暂停相关收件规则和失控任务，保留源邮箱副本，再查原因。

每天100封、平均原件1MB、保留30天，原件约3GB；正文、解码附件、事件、备份还会增加空间。正常低量有望$0/月，但不删除会累积到应用或D1容量限制。R2按计费单位向上取整，Class A超过1M免费量后，即使只多一点也可能增加$4.50。因此 **$0–2是目标，不是硬承诺**。

## 2.1 分阶段保留与历史邮件

新邮件默认值为 `raw_retention_days=7`、`content_retention_days=30`、`ledger_retention_days=180`。收件时将策略版本及期限冻结到原件 metadata，登记 D1 时复制到邮件行；改变默认值只影响之后的新邮件。最小去重账本至少保留配置天数，当前实现保守保留账本，不自动删除。

安全终态要求解析成功、没有 `needs_review` 或策略错误、没有处理 claim/lease；归档邮件不能有未完成交付，自动投递邮件必须有与冻结目标 revision 对应的成功交付，且全部交付均为 delivered。达到安全终态才建立时钟；后续成功交付会延后截止时间。失败、取消、需人工检查或积压中的邮件不会为释放容量而被自动删除。

- 原件到期先写 `raw_expired_at`，立即停止下载和重解析。R2 删除与容量结算可独立重试，正文仍可查看。
- 正文到期使用完整删除流程，清理原件、正文、附件、搜索正文和冻结 payload，保留去重身份及非内容记录。
- 新默认启用或缩短、历史邮件纳入均需签名预览确认，令牌绑定 owner、settings version、全部期限及历史选择，有效 10 分钟。历史选择只作用于尚无策略的邮件，其时钟从确认之后达到安全终态开始，本次设置保存不删除内容。
- 原件期限不能长于正文期限；留空表示不单独自动清理该阶段。正文到期仍会删除所有内容，包含尚未单独过期的原件。
- 设置页分别显示逻辑内容和待物理删除字节；桶实际空间、账户 R2 用量没有可靠测量时明确显示“未测量”，不能从逻辑计数推算账单。

API 为 `GET /api/v1/settings/retention-preview?raw_retention_days=7&content_retention_days=30&ledger_retention_days=180&apply_existing=false`；无限期使用 `none`。`PATCH /api/v1/settings` 提交相同字段、`version`，需要确认时附 `retention_confirmation`。旧 `retention_days` / `days` 接口仅保留兼容用途，不会隐式给历史邮件设策略。

## 2.2 持久提醒

D1 保存容量 70% / 85% / 95%、备份超过 36 小时、处理积压超过 1 小时、解析失败等状态；容量取 D1 逻辑字节与 DO 容量计账的较大值，覆盖尚未登记的原件及预留空间，仅激活当前最高档。DO 暂不可用时载荷明确标出计账不可用，暂用 D1 数据；两者都不等于实际账户账单。状态变化在下一次评估登记，每项每天至多一条活跃提醒和一条恢复通知。设置页可查看状态及通知失败数；没有外部 webhook 时只在界面显示。

可选部署变量 `ALERT_WEBHOOK_URL` 指向精确允许的公网 HTTPS URL；`ALERT_WEBHOOK_ALLOWED_HOSTS` 配置精确 hostname，省略时沿用 `WEBHOOK_ALLOWED_HOSTS`。CI 对应 `MAIL_HERO_ALERT_WEBHOOK_URL`、`MAIL_HERO_ALERT_WEBHOOK_ALLOWED_HOSTS` 仓库变量。`ALERT_WEBHOOK_TOKEN` 是至少 32 字符的独立 Worker secret，通过正规 Wrangler secret 流程设置，不写入仓库或公开 vars；CI 发布保留现有 secret。收件地址、发件人、主题、正文、附件及远端响应均不进入提醒；载荷仅含随机 ID、状态码、时间、计数和管理页路径。

外部通知使用 Bearer、稳定 `Idempotency-Key` 和冻结 JSON 字节；单次超时 5 秒，不跟随跳转。网络错误、408、429、5xx 持久退避，尊重不超过一天的 Retry-After，最多 8 次；认证错误及其他不可重试响应停止并在设置页显示失败。已结束通知记录保留 180 天后分批清理。提醒不是扣费硬上限，也不是完整备份成功的替代证据。

## 3. 创建资源与配置

需要Node.js 26。通过正规 `wrangler login` 或权限受限的API token认证。已有独立任务token时沿用该本机流程，不覆盖其他项目的登录；不要把token、邮件或密钥发到聊天。

本次独立 token 已在本机保存并核实有效，且已追加仅目标 zone 的 `Zone Settings Write`，不需要再次保存。新环境首次保存时，在仓库根目录运行 `python3 deploy/cloudflare-admin.py save-token`，提示后从 Cloudflare 的一次性成功页复制 token 并粘贴到本机终端（不回显）。助手只新建 owner-only 文件，不覆盖已有文件，不改 Wrangler 全局登录。随后运行 `python3 deploy/cloudflare-admin.py inspect` 核对权限；下文 Wrangler 命令可改用 `python3 deploy/cloudflare-admin.py wrangler <命令与参数>`。包装命令从仓库根目录调用，但实际工作目录为 `cloudflare/`，所以配置参数使用 `--config wrangler.native.production.toml`；凭据只通过进程环境传递。

仅新环境初始化，从仓库根目录：

```sh
npm --prefix web ci
npm --prefix web run build
npm --prefix cloudflare ci
cd cloudflare
npx wrangler whoami
npx wrangler d1 create mail-hero
npx wrangler r2 bucket create mail-hero-store
```

已经创建的资源只核对，不重复创建。将D1返回的ID填入 `wrangler.native.toml`，检查：

- `DB`对应D1，`MAIL_STORE`对应私有Standard桶。
- `COORDINATOR`对应 `MailCoordinator`，migration使用 `new_sqlite_classes`；应用固定实例名 `inbox-v1`。
- `RECEIVE_ADDRESS`为最终唯一地址；改地址必须同步路由和来源转发。
- `FORCE_SEND_PAUSED="true"`、`MAINTENANCE_MODE="false"`，默认archive。
- `INGEST_DAILY_MESSAGE_LIMIT="300"`、`INGEST_DAILY_BYTE_LIMIT="268435456"`，按UTC日计量。
- `WEBHOOK_ALLOWED_HOSTS`为允许的消费者精确域名；没有消费者可留空。
- `workers_dev=false`、`preview_urls=false`；使用Access保护的自定义域名。
- 不含Queues绑定、普通Worker的Paid CPU配置或生产 `DEV_AUTH_BYPASS`。

仅首次初始化时生成并在密码管理器独立保存 `CREDENTIAL_KEY`：32随机字节，以64位十六进制表示。当前生产密钥已经生成并安装，不要重生成或覆盖。经Wrangler交互输入，不写入 `[vars]`：

```sh
npx wrangler secret put CREDENTIAL_KEY --config wrangler.native.toml
npx wrangler d1 migrations apply mail-hero --remote --config wrangler.native.toml
npm run typecheck
npm test
```

该密钥解密webhook凭据并签署管理令牌，D1/R2备份不会包含它。不能直接改成新值当作完成轮换；已有密文需要迁移。

## 4. UI域名与Access

当前 `mail-hero.ziyixi.science` 已绑定 Access 应用，提供 GitHub 和邮件验证码两种登录方式，没有 Bypass。Gmail 备用策略保留 `xiziyi2015@gmail.com`；GitHub 使用独立 Allow 策略，Include 只含通过 IdP Test 核实的本人精确邮箱，Require 必须是既有 GitHub 登录提供商。不要把邮箱和提供商都放到 Include（那会成为 OR 条件）。应用和策略 ID 见验收记录。

`ACCESS_OWNER` 保留原 Gmail 作为唯一管理员标识，可选 `ACCESS_OWNER_ALIASES` 列出同一个人经核实的其他登录邮箱（逗号分隔，最多 8 个，精确匹配）。JWT 签名、issuer、audience、时效继续校验；alias 成功登录统一映射到原 owner，CSRF 和管理动作身份不变。实际别名保存在 ignored 生产配置；新环境先验证 IdP 实际返回身份，再配置 Access 与应用两层白名单。

在Worker Domains & Routes添加该Custom Domain，或在配置加入：

```toml
[[routes]]
pattern = "mail-hero.ziyixi.science"
custom_domain = true
```

应用独立校验JWT的签名、issuer、audience、过期和owner；浏览器写操作校验Origin/CSRF。附件只能通过鉴权后路由访问，不要为下载而公开R2。[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

当前 Custom Domain 已绑定，`workers_dev=false`、`preview_urls=false`。日常代码更新通过 [GitHub Actions](ci-cd.md) 发布。需要人工维护部署时，在完成构建与验证后，从仓库根目录明确使用生产配置：

```sh
python3 deploy/cloudflare-admin.py wrangler deploy --config wrangler.native.production.toml
```

打开 [UI](https://mail-hero.ziyixi.science)，点击 **GitHub** 即可登录。已使用本人 GitHub 会话成功进入 `/setup`，受保护的配置、D1 状态、调度状态与固定收件地址均正常显示；没有读取私人邮件。之前的拒绝来自 GitHub 返回邮箱与原 Gmail 白名单不一致，现已通过本人 alias 解决。邮件验证码仍可用 **`xiziyi2015@gmail.com`** 作为备用；验证码只填在正规登录网页，本轮未单独重测 OTP 流程。

## 5. 仅设置专用收信子域

本次已经完成，仅启用 **`inbox.ziyixi.science`**，不需要再次操作根域 onboarding：

1. 记录根域现有 MX/SPF，并取得限定 `inbox.ziyixi.science` 的实时 DNS 预览；待添加的三条 MX 和一条 SPF 都只涉及这个子域。
2. 确认 DNS API 支持请求 body 后，调用 `POST /zones/{zone_id}/email/routing/dns`，body 为 `{"name":"inbox.ziyixi.science"}`，返回 `enabled: true`、`status: ready`，再次查询 DNS 预览返回 `errors: null`。这一步尚未让 UI 的 Subdomains 列表显示已启用，不能把 API 的 DNS 状态当成全部设置完成。
3. 启用精确地址规则：`inbox-mail-hero@inbox.ziyixi.science`，action **Send to a Worker**，Worker 为 `mail-hero`。catch-all 保持禁用，未更改。刷新设置后，在 Settings → Subdomains 添加 `inbox`，最终明确显示 **Enabled、DNS Locked**；该 UI 步骤也开启了父级路由标记。
4. UI 步骤添加了 Cloudflare 公共 DKIM TXT `cf2024-1._domainkey.ziyixi.science`。操作前后再次核对根域 MX/SPF，精确一致，原有 iCloud `mx01.mail.icloud.com` / `mx02.mail.icloud.com` 保留。公共 DNS 已查到子域三条 Cloudflare MX 与 SPF；DNS 可解析仍不等于真实邮件链路验收。

根域仍使用 iCloud，根域 Email Routing 因此显示 `status: misconfigured`，界面可能提示根域 DNS **Conflicting/Missing**；专用子域已经显示 Enabled、DNS Locked。**不要点击 Add missing records，也不要删除 iCloud MX/SPF 来消除这个根域提示。** 单独设置 `skip_wizard: true` 未完成子域启用；会修改根域的 UI Activate 没有执行。

其他环境同样必须先核对仅作用于专用子域的 DNS 变更，不直接激活根域向导或盲目重放以上操作。Email Routing 调用 Email handler 不经过 UI 的 HTTP 登录，不能因此给 UI 加 Bypass。[设置 API](https://developers.cloudflare.com/api/resources/email_routing/methods/edit/)、[DNS 查询 API](https://developers.cloudflare.com/api/typescript/resources/email_routing/subresources/dns/methods/get/)

官方：[子域](https://developers.cloudflare.com/email-service/configuration/subdomains/)、[域名要求](https://developers.cloudflare.com/email-service/configuration/domains/)、[Email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)

## 6. 合成邮件验收与来源转发

先保持 archive 和强制暂停。用户已发送测试信，实际主题为 **`Test`**；生产收件、R2 原件大小/摘要、D1 ready 状态、后台解析及线上中文正文均已核实。该信只有纯文本、没有附件，不能代替所有格式或来源的验收。日志不输出正文或凭据，详细证据见验收记录。

至少检查纯文本、中文、HTML-only、常见编码、嵌套附件、接近25MiB原件；实际查看免费CPU/内存错误。再测D1/R2故障、任务注册/唤醒中断、重复Alarm、消费者500→204、429、超时/响应丢失、同ID重试、删除与发送并发、Access错误身份、HTML禁脚本/禁网，完成一次隔离恢复。

UI 会显示解析错误、正文截断和附件省略状态；遇到嵌套邮件、TNEF 等不透明内容时，不猜测内部正文或自动交付。连续三次解析运行中断后停止自动尝试，原件仍可下载，检查后可明确重解析。正文搜索范围仅前 16KiB；详情以实际保留的正文及明确的截断提示为准。聚合状态使用五分钟共享缓存，可在收件箱或设置页人工刷新。

Cloudflare未明确承诺 `email()` 在R2写入前失败时的完整持久重投语义。不能声称“永不丢信”；真实入口故障测试和源邮箱副本仍是必要验收。

收件验收通过后，在 Gmail 的“设置 → 转发和 POP/IMAP → 添加转发地址”填写 **`inbox-mail-hero@inbox.ziyixi.science`**，用 Mail Hero 阅读验证邮件，再回 Gmail 完成确认；选择保留 Gmail 副本，按需使用过滤器只转发需要处理的邮件。Exchange/Outlook 同样填写这个地址，保留原邮箱副本；组织账户可能需要管理员允许外部转发。分别用来源邮箱测试实际到达，不轮询任何来源邮箱。

新环境先保持 archive 和强制暂停，完成下一节的消费者接管验收后再配置 forward并解除暂停，以接收用户主动发送的业务测试信。当前Todofy进度见验收记录；来源邮箱的自动转发由用户在完整链路测试通过后开启。历史archive邮件不会自动释放。

## 7. 独立消费者

将消费者精确域名加入 `WEBHOOK_ALLOWED_HOSTS` 后部署，再在UI创建目标和认证。目标必须公网HTTPS；Workers不能直接访问家里的私有IP。Todofy可继续通过现有Tunnel hostname提供 `/hooks/mail`。

若消费者由Access保护，单独创建Service Auth及Service Token，配置 `ACCESS_SERVICE_ORIGIN` 和秘密 `ACCESS_CLIENT_ID`、`ACCESS_CLIENT_SECRET`。它与消费者自身Bearer/Basic是两层认证，不能使用owner登录凭据。[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

消费者必须先持久接管再回2xx，并按稳定来源+event_id去重。“已交付”不等于Todoist业务完成。先测合成事件，再解除 `FORCE_SEND_PAUSED` 并选择forward。CloudMailin与Mail Hero不能同时触发同一业务。

## 8. 维护窗口备份

D1 Free Time Travel只有最近 **7天**，不包含R2、DO状态或secrets，不是独立备份。[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

目前没有自动化的一致原生备份，也没有完成离机灾难恢复验收。以下是待执行并验证的维护窗口流程；不能把“导出 D1 并复制正在变化的桶”称为一致快照：

1. 保留源邮箱副本，暂停来源转发，记录窗口和最后收件ID。
2. 部署 `FORCE_SEND_PAUSED=true`、`MAINTENANCE_MODE=true`。维护模式拒绝新入站及管理写入，Alarm停止工作。等待在途任务结束，确认无解析、投递、删除、入站写入；外部已在途副作用仍需对账。
3. 在仓库外的受限目录导出D1，例如在 `cloudflare/` 中：

```sh
umask 077
mailhero_backup_dir="$HOME/mail-hero-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$mailhero_backup_dir"
npx wrangler d1 export mail-hero --remote --config wrangler.native.production.toml --output "$mailhero_backup_dir/d1.sql"
```

4. 通过受限S3/R2工具复制整个私有桶，清单包含 **key、大小、内容校验值、自定义metadata** 并逐项校验。raw metadata中的envelope、received_at、raw_size、mode/revision对未索引邮件恢复有用。普通文件复制或丢metadata的rclone副本不能冒充完整备份。
5. 保存代码/schema版本、非秘密配置、资源ID和DO任务恢复说明。独立安全保管 `CREDENTIAL_KEY` 及外部凭据恢复来源，不放进未加密备份目录。
6. 完整快照加密复制到另一设备/账户，建议7份daily+4份weekly，定期验证解密。相同账户的另一个R2桶不解决账号不可用，副本也计入账户存储。
7. 退出维护先恢复archive收件，确认调度恢复；消费者保持暂停直到未知交付完成核对，再恢复来源转发并检查窗口遗漏。

导出或复制命令退出0不等于恢复成功；需要在隔离资源执行下一节的完整恢复验收。

## 9. 隔离恢复演练

恢复到**新的空D1和新的私有桶**，不要直接覆盖生产：

1. 新配置保持维护和强制暂停，不绑定真实Email Routing。
2. 导入D1 SQL，恢复R2全部字节与metadata，装入原 `CREDENTIAL_KEY`。[D1导入导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
3. 校验D1引用的原件、正文、附件和冻结payload存在且散列一致。记录未引用对象，不能盲删。
4. DO调度状态不在D1导出中。通过应用恢复逻辑重新登记pending、retry_wait及未索引raw，对不确定sending先核查。不能假定新DO自动拥有旧Alarm任务。
5. 对照消费者已接管event_id，保留身份和冻结bytes，不重建事件“修复”未知结果。旧备份可能含后来已经交付的任务。
6. 在隔离资源通过合成读取、失败恢复、fake consumer后再安排真实路由切换。未实际演练，不能声称达到RPO/RTO或一键恢复。
