# 一次性设置：默认 Cloudflare 入口

Mail Hero 的默认部署适用于没有公网 IP 的主机：Gmail、Exchange 等来源转发到一个固定地址；Cloudflare Email Routing 触发 Worker，Worker 先把原始邮件及其字节长度保存在私有 R2，再经现有 Tunnel 推送到内网 Mail Hero。Mail Hero 核对实际收到的原件长度并提交 PostgreSQL 后才返回 204，Worker 收到确认后清理 R2 暂存。网页也经 Tunnel 访问，PostgreSQL 不发布端口。详细控制台操作、Wrangler 命令和验收见 [Cloudflare 端清单](cloudflare-setup.md)。

本仓的默认 `deploy/compose.yaml` 使用 Cloudflare 收件模式。应用、Worker、账号配置及真实邮箱转发要分别验收；运行本机 Compose 不会修改 Cloudflare 账户或来源邮箱，也不代表已经上线。

## 本机配置和启动

先选择专用收信子域及唯一完整地址，例如 `hero@in.example.org`。在仓库根目录以部署用户运行，参数都不是密码：

```sh
./deploy/bootstrap-cloudflare.sh hero@in.example.org \
  https://YOUR-TEAM.cloudflareaccess.com YOUR-UI-ACCESS-AUDIENCE owner@example.org
```

脚本只生成受限的 `deploy/runtime.env`、PostgreSQL 连接文件、应用加密密钥和 Worker 入站 token；已有文件时停止，不覆盖旧密钥。密钥留在本机，不提交到 Git，也不要发到聊天。首次验证保持 `MAIL_HERO_FORCE_SEND_PAUSED=true` 且在 UI 使用 `archive` 模式。

```sh
docker compose --env-file deploy/runtime.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/runtime.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/runtime.env -f deploy/compose.yaml ps
```

`/health/ready` 只检查应用和 PostgreSQL，不能证明 Cloudflare 邮件到达。默认 Compose 不要求公网 TCP 25 或 SMTP 证书。数据库卷需要可靠的本机持久磁盘，另设 [离机备份](operations.md)。

Tunnel 中给 Mail Hero 添加 UI 和机器入口两个 hostname，按 [Cloudflare 端清单](cloudflare-setup.md) 分别设置 Access。同 Compose 网络里的 `cloudflared` 可将两个 hostname 指向 `http://app:8080`。若现有 Todofy Tunnel 的 connector 位于另一个网络，先检查它是否能访问 Mail Hero；同一 Tunnel 的所有 replica 都可能收到流量，不能只让新 replica 能访问 `app`。不能做到时，为 Mail Hero 建独立 Tunnel，用此仓 `deploy/compose.tunnel.yaml` 与它自己的受限 `deploy/secrets/tunnel-token` 启动即可。不要为方便接入直接发布应用公网端口。

来源邮箱的转发应最后启用：先用合成邮件核对 Worker→R2→PostgreSQL 的 204 确认和失败后补投，再让 Gmail 或 Exchange 发送验证邮件。只有消费者履行 [持久接管与幂等合同](../api/mail-received-v1.md) 后，才考虑启用 `forward`；CloudMailin 与 Mail Hero 不应同时自动触发同一业务。

## 可选：旧公网 SMTP 方案

以下内容记录直接接收 SMTP 的旧实现，适用于**有公网 TCP 25** 的主机。当前无公网 IP 的默认部署不用执行这些步骤；旧方案需要追加 `-f deploy/compose.smtp.yaml`，并独立完成 MX、STARTTLS 与公网收信验收。

Mail Hero 只有一个接收地址。它是 SMTP 目的地址，不需要创建邮箱账号，也没有 IMAP 密码。部署时由你指定完整地址，各 Gmail/Exchange 来源都转发到同一地址。浏览器里可以直接复制地址并查看收到的验证邮件。

### 旧模式需要准备

- 一台可接收公网 TCP 25 的主机、已由 Cloudflare 管理的域名、持久磁盘和 Docker Compose。
- Cloudflare Access 的单人应用：记录 issuer、audience，并把 owner 邮箱设为允许登录的人。
- 一个 Cloudflare Tunnel，公开 UI 所用的 hostname。Tunnel 的 HTTP 服务地址在本 Compose 网络内为 `http://app:8080`。
- 为 SMTP MX 主机名签发的公信 TLS 证书。Cloudflare 的边缘证书不能代替 SMTP 主机证书。
- 一个独立、可恢复的离机 restic 仓库。没有离机备份时可以先试运行，但 UI 的“备份完成”不能代表容灾。

Cloudflare 的域名、Tunnel 和 Access 设置是一次性的；`deploy/bootstrap.sh` 不会自动改账户中的 DNS 或访问策略。应用不需要 Gmail/Exchange 密码。Gmail 的目的地址确认与 Exchange 管理员的外部转发策略仍需在来源侧完成。

### 1. 生成本机配置

以非 root 部署用户在仓库根目录运行，参数不含密钥：

```sh
./deploy/bootstrap.sh hero@in.example.org mx.in.example.org \
  https://YOUR-TEAM.cloudflareaccess.com YOUR-ACCESS-AUDIENCE owner@example.org
```

第一个参数是你选定的**完整唯一收信地址**，脚本不创建邮箱账户、不随机生成别名，也不添加第二个地址。它把该地址写入受限的 `deploy/runtime.env`，在 `deploy/secrets/` 写入 PostgreSQL 密码、数据库连接文件和 32 字节凭据加密密钥；文件权限为 0600。这些文件被 Git 与 Docker build 排除。脚本发现已有文件就停止，防止覆盖密钥导致旧 webhook 凭据无法解密。收信地址本身也是收件入口信息，请不要放入公开日志或截图。

启动时还有 `MAIL_HERO_FORCE_SEND_PAUSED=true`。首次验证和从备份恢复时，都先保持这个开关；它优先于 UI 的“恢复投递”。要正式发送时，在检查消费者合同后把该值改为 `false` 并重建应用容器。

### 2. 配置收件 DNS 和证书

以示例域名为例，在 Cloudflare DNS 中配置：

| 名称 | 类型 | 值 | 说明 |
| --- | --- | --- | --- |
| `mx.in.example.org` | A | 主机公网 IPv4 | **DNS only**，不能橙云代理 SMTP |
| `in.example.org` | MX | `mx.in.example.org`，优先级 10 | 只修改专用子域，不改已有主邮箱 MX |

只有 IPv6 真实可达时才增加 AAAA。外部邮件服务器必须能连接 `mx.in.example.org:25`；Tunnel 不能代替这个 SMTP 入口。Vultr 的 outbound 25 限制不能直接推断 inbound 25 的状态，须从外网实测。

用 ACME DNS-01 为 **MX 主机名**签证书。下面是 Certbot DNS Cloudflare 插件的形状；把只允许目标 zone DNS Edit 的凭据文件放在主机受限位置，用正规流程取得，不要写进仓库：

```sh
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /secure/path/cloudflare-dns.ini \
  -d mx.in.example.org
```

将签发的 `fullchain.pem` 和 `privkey.pem` 安全复制到 `deploy/certs/`，让运行 Compose 的部署用户可读。`deploy/certs/` 不提交。证书续期后更新这两个文件，重启 `app`，再从外部检查 SMTP STARTTLS 实际呈现的新证书；当前进程在启动时加载证书，不做无重启热加载。

### 3. 启动应用与 UI

先用 `docker compose config` 做本地配置检查，再启动：

```sh
docker compose --env-file deploy/runtime.env \
  -f deploy/compose.yaml -f deploy/compose.smtp.yaml config --quiet
docker compose --env-file deploy/runtime.env \
  -f deploy/compose.yaml -f deploy/compose.smtp.yaml up -d --build
```

仓库目前使用明确版本的容器 tag，尚未固定 registry digest。真实上线前应在可访问镜像仓库的环境核对镜像来源，固定已测试的 digest，并在升级时逐一更新；`docker compose config` 只能检查配置结构，不能证明镜像已拉取或服务已启动。

PostgreSQL 18 的 volume 挂在 `/var/lib/postgresql`；应用和数据库是同一个 Compose 项目中的独立容器。不要把数据目录放在同步网盘。应用启动时持有单实例锁、运行嵌入式 SQL 迁移，再启动 SMTP、管理 API 和后台 worker。`/health/ready` 只证明应用可以访问数据库，不证明公网 25、TLS、来源转发或消费者业务成功。

在 Cloudflare Dashboard 建立仅 owner 可访问的 Access 应用，并将 Tunnel 的 public hostname 映射到 `http://app:8080`。若使用 Compose 内的 Tunnel，把 dashboard 给出的 token 写入受限 `deploy/secrets/tunnel-token`，再运行：

```sh
docker compose --env-file deploy/runtime.env \
  -f deploy/compose.yaml -f deploy/compose.smtp.yaml \
  -f deploy/compose.tunnel.yaml up -d
```

Tunnel token 文件必须只供部署用户读取。管理 UI 没有公开 host port；应用还会验证 Access JWT 的 issuer、audience、签名和 owner。不要把 `MAIL_HERO_DEV_AUTH_BYPASS` 或 `MAIL_HERO_ALLOW_INSECURE_SMTP` 放进生产环境。

### 4. 验证与接入来源

先打开 UI 的设置/收件状态页，查看“地址有效”“MX 配置”“实际收到邮件”。当前页面把外部 SMTP 可达性标成 `not_verified`；须从另一网络实测 MX 主机的 25 端口和 STARTTLS，不能把服务器内部自测当作外部探测。最终以 Gmail/Exchange 发来的邮件出现在收件箱为准。

在 Gmail 或 Exchange 的原邮箱设置转发到 UI 显示的唯一地址。Gmail 的目的地址确认邮件会先出现在 Mail Hero，用户自行在页面读取并完成确认；Exchange/Workspace 可能由组织策略禁止外部自动转发。初次保持“仅收件”，确认正文、附件和收件时间。随后在 UI 创建 webhook 目标、查看实际请求预览，再选择“自动投递”。目标若是 Todofy，需要它先实现 [durable consumer contract](../api/mail-received-v1.md)。

Cloudflare DNS、Tunnel/Access、证书和 Gmail/Exchange 来源规则都由各自服务控制；此仓库没有获得这些账户的自动配置权限。所有真实外部步骤在上线验收时单独检查，不以本地 Compose 启动代替。
