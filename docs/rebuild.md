# 重建个人云

日常更新：提交代码，等待 main 的 **CI and deploy**。它发布 Workers、构建三个独立镜像，再通过 daemon 更新 VPS。
检查或修复运行偏差：在 Actions 打开 **Personal cloud reconcile**，选择 `check` 或 `repair`。

首次部署需要修改 [cloud.toml](../config/cloud.toml)，填写仓库外的一个私有 JSON，运行 bootstrap，再执行一次 VPS sudo。
资源 ID 自动写入 [resources.toml](../config/resources.toml)。账户启用、OAuth 注册和应用登录需要 owner 完成。
历史恢复见 [恢复边界](#data-recovery)，实际验收见 [实施记录](rebuild-verification.md)。

## 1. 准备账户

准备 GitHub 仓库、Cloudflare 域名和 Ubuntu 24.04 amd64 VPS。启用 Workers Free、R2、Zero Trust。
在专用 `inbox.<域名>` 子域启用 Email Routing，保留根域现有邮箱配置。
注册 GitHub OAuth app，回调使用目标 Access team 的 `/cdn-cgi/access/callback`；给 Notion integration 授予网站内容集合访问权限。

本机运行 `gh auth login`，通过正常 Cloudflare API token 创建流程保存 token 到仓库外的 mode 600 文件。
权限见 [bootstrap 凭据清单](../tools/cloud-bootstrap/README.md)。VPS 不接收此管理 token。
准备 Node 26、uv，以及 [infra 固定版本](../infra/versions.tf)的 OpenTofu。

模型凭据只配置在 `model-router`。Claude 使用原 Brief 工作区，所有 Claude 调用合计受其每月 US$80 支出上限约束；
在供应商控制台确认该限额。Gemini 使用一个共享 key。Router 首次上传后，在 owner 本机运行：

```sh
cd model-router/worker
npx --no-install wrangler secret put ANTHROPIC_API_KEY --config ../wrangler.toml
npx --no-install wrangler secret put GEMINI_API_KEY --config ../wrangler.toml
```

两把 key 都不进入 bootstrap JSON、GitHub 或 VPS。Gmail 授权仍归 Mailsort。
首次上传后，连接检查会在凭据不全时失败并阻止下游发布；owner 配好后重跑同一 SHA。执行器 Access 连接和 Newsletter 独立口令见
[Model Router 部署说明](../model-router/docs/deployment.md)。

成功结果：账户已启用、`gh auth status` 正常、目标域名可用。登录或账户启用失败，先完成对应网页步骤。

## 2. 填两份配置

在独立分支修改 `config/cloud.toml`：域名、GitHub 仓库、Access team、workers.dev 子域和 VPS 公开身份。
全新 VPS 的 `expected_daemons` 使用 `k3s`、`ssh`、`cloudflared_platform`；沿用旧 SSH Tunnel 的节点才加入 `cloudflared`。

全新账户的 `config/resources.toml` 先只填写目标 `account_id`、`zone_id` 和空清单：

```toml
version = 1
account_id = "<目标账户 ID>"
zone_id = "<目标域 ID>"
[access_audiences]
[d1_databases]
[durable_objects]
```

将 [私有输入示例](../tools/cloud-bootstrap/example.private.json)复制到仓库外，设为 mode 600，填写 owner、收信地址、OAuth 和外部服务凭据。
保留已有环境时用 `adopt` 模式、现有清单、原 state passphrase 和原应用密钥。旧数据不能用 `fresh` 生成的新密钥解密。

后文在仓库根目录运行。路径改成自己的值：

```sh
uv python install 3.12
cloud_python="$(uv python find 3.12)"
cloud_private="$HOME/.config/todofy-cloud/bootstrap.json"
cloud_repo="<owner>/<repository>"
```

首次准备新文件：

```sh
"$cloud_python" tools/cloud-bootstrap/bootstrap.py prepare \
  --mode fresh --private-file "$cloud_private" \
  --output "$HOME/.config/todofy-cloud/prepared.json"
cloud_private="$HOME/.config/todofy-cloud/prepared.json"
"$cloud_python" tools/cloud-bootstrap/bootstrap.py check --mode fresh --private-file "$cloud_private"
```

成功结果：`input_ready`。如果输出 `missing`，补列出的凭据，再运行 `check`；重复运行保留已生成密钥。

## 3. 创建或采用 Cloudflare 资源

```sh
"$cloud_python" tools/cloud-bootstrap/bootstrap.py cloud --mode fresh --private-file "$cloud_private"
"$cloud_python" tools/cloud-config/generate.py
"$cloud_python" tools/service-catalog/catalog.py
"$cloud_python" .github/scripts/drift_desired.py
"$cloud_python" tools/cloud-bootstrap/bootstrap.py secrets --mode fresh \
  --private-file "$cloud_private" --output "$HOME/.config/todofy-cloud/vps.json"
```

成功结果：`cloud_in_sync`、`production_secrets_set`。D1、R2、Access、专用 Tunnel、DNS 和 ID/AUD 已登记，GitHub 凭据与 VPS 私有文件已生成。
state 桶先于 backend 初始化。收信 Worker 尚未存在时，精确收信规则留到第 6 步。

沿用环境将 `--mode fresh` 换成 `--mode adopt`，提供示例中的精确 `adopt_ids`。
通常只运行 `plan`、`cloud`，保留 GitHub 现有 secrets；只有掌握既有共享 key 和 VPS 私有配置时才运行 `secrets`。
具体输入见 [已有账户收编](../tools/cloud-bootstrap/README.md#已有账户收编)。
中断后重跑同一私有文件和模式。错误账户、陌生同名对象或既有资源变更会停止，先处理具体差异。

## 4. 推送并构建

提交配置和生成结果，推送分支，等 **CI gate** 全部通过，再将同一 SHA 合入 main。
首次 main 的 Website job 若提示 `bootstrap_required`，先完成下面的网站初始化，再重跑全量发布。
其余服务和安装包可独立完成；下载时以对应 job 成功为准。

Website 首次需要内容身份初始化：设置 `WEBSITE_BOOTSTRAP_APPROVAL` 为配置中的准确网站 URL，
运行 **Website release**，选择 `operation=bootstrap`，confirmation 填 `bootstrap:<网站主机名>`。
全新空内容集合可勾选 `allow_empty`，此时 confirmation 必须为 `bootstrap:<网站主机名>:allow-empty`。
`WEBSITE_LEGACY_REPOSITORY` 仅恢复旧网站发布记录时填写，空环境留空。首次内容要求见 [Website 发布](../website/docs/release.md)。
网站读取凭据只交给 Actions；网站同步 Worker 只需要目标仓库的 Actions 读写和 Deployments 只读令牌。
每日同步在 `website/relay/wrangler.toml` 的 `triggers.crons` 与 `DAILY_SYNC_CRON` 中配置，默认两者均为 `17 10 * * *`（UTC）；无需 Notion 按钮或状态字段。
Home 的“立即同步”与每日同步共享现有发布队列，真实检查和上线状态见 [网站同步运行说明](../website/relay/README.md)。

全量运行：

```sh
gh workflow run ci.yml --ref main -R "$cloud_repo" -f app=all
gh run list --workflow ci.yml -R "$cloud_repo"
gh run watch <本次 run ID> --exit-status -R "$cloud_repo"
```

成功结果：Workers 已发布，Newsletter、Platform 和 Codex gateway 三个镜像已按 digest 发布，run artifact 中有 `vps-bootstrap-<完整 SHA>`。
`VPS_DEPLOY_ENABLED=false` 时服务器部署等待一次性安装。
静态网站是异步发布，另确认 **Website release** 成功；CI 的 dispatch 成功只代表已启动它。

网站或外部凭据错误在对应 job 处理，无需重建数据库。

全新仓库首次创建的三个 GHCR 镜像默认私有。在 GitHub 的 **Packages** 分别打开
`<仓库名>-newsletter`、`<仓库名>-platform` 和 `<仓库名>-codex-gateway`，进入 **Package settings → Change visibility → Public**。
这一步每个包只做一次；已有公开包跳过。安装器和 k3s 使用匿名拉取，不配置 registry 密钥。
公开前确认镜像只包含代码与依赖；私有文件由第 3 步单独传给 VPS。
[GitHub 的默认可见性说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)。
如安装时镜像拉取报 `unauthorized`，先检查这三个包的可见性。

## 5. 一次性安装 VPS

下载同一 run 中成功生成的固定安装包：

```sh
gh run download <同一 run ID> -R "$cloud_repo" \
  -n "vps-bootstrap-<完整 SHA>" -D "$HOME/.cache/todofy-cloud/bundle"
```

通过自己的可信管理通道将 bundle 和第 3 步的 `vps.json` 放入 VPS，私有文件保持 mode 600。
在 VPS 执行一次：

```sh
sudo /usr/bin/python3 -E -s <bundle>/installer/install.py \
  --bundle <bundle> --credentials <vps.json> --grant-reader
```

成功结果：`complete_held`。K3s、专用 Tunnel、daemon 和 observer 已安装，Newsletter 暂不接新工作。
示例 Newsletter 使用 mock 模式且禁真实发送，可先验收空服务。首次安装时要启用真实处理，先按
[Newsletter 配置](../newsletter/README.md)准备 Router URL/独立口令及发信凭据，将私有输入的 `vps.newsletter_env`
改为对应的 live/codex 设置。Codex 订阅登录属于 [Codex gateway](../codex-gateway/README.md)：用 `vps.old_paths.auth`
指定登录目录，安装器把它导入 gateway 挂载的 `newsletter-auth` 卷（沿用原名），Newsletter 不挂载它。
已安装后更改 Secret 或登录状态属于 owner 的一次维护操作，daemon 不会替你修改它们。
mock 服务健康不代表真实摘要通过。
启动首次发布：

```sh
gh variable set VPS_DEPLOY_ENABLED --body true -R "$cloud_repo"
gh workflow run ci.yml --ref main -R "$cloud_repo" -f app=platform
```

首次 main SHA 必须与安装包一致。成功结果：Actions 显示 ready，daemon 核对两个实际 digest，Fleet 收到新鲜观测，Home 显示相同状态。
安装完成、镜像构建和业务处理分别核对。错误处理见 [VPS bootstrap](../tools/vps-bootstrap/README.md#failures-and-retries)。

## 6. 登记首次 DO 身份并启用业务

```sh
"$cloud_python" tools/cloud-bootstrap/bootstrap.py finalize --mode fresh \
  --private-file "$cloud_private" --create-pr
```

成功结果：实际 namespace 已核验并登记，精确收信规则已创建，清单 PR 已启动分支检查。
合入同一通过检查的清单 SHA。保留环境用 `adopt`；已有 DO 身份不匹配会停止。
核对 Access、Fleet/Home、Mail Hero 后，按应用开启初始暂停开关，最后设置源邮箱转发。
真实收信、配置的任务来源写入（当前为 Tasks）、Newsletter 发送和网站内容分别验收。
Tasks 的服务与数据边界见 [设计](../tasks/docs/design.md)；已有任务迁移按 [导入与切换](../tasks/docs/import.md)核对后再启用写入。

新环境的邮件链路准备好后，关闭 bootstrap 创建的两个暂停变量，并发布使其生效：

```sh
gh variable set MAIL_HERO_FORCE_SEND_PAUSED --body false -R "$cloud_repo"
gh variable set TODOFY_PROCESSING_PAUSED --body false -R "$cloud_repo"
gh workflow run ci.yml --ref main -R "$cloud_repo" -f app=both
```

已有环境在变量原来的 repo/environment 范围修改；`production` 变量用 `--env production`。
仅修改 GitHub 变量不会改变已运行 Worker。

## 检查与修复

```sh
gh workflow run personal-cloud-reconcile.yml --ref main -R "$cloud_repo" -f operation=check
gh workflow run personal-cloud-reconcile.yml --ref main -R "$cloud_repo" -f operation=repair
```

每日和成功发布后也执行检查。`PERSONAL_CLOUD_AUTO_REPAIR=true` 开放常规自动修复，首次上线先保持 false。
各服务与正常发布共用锁，锁内重新确认目标。Worker 使用最后一次核验成功的源码；VPS 修复当前已接受的 release，另建事务和排空 ID。
无差异时跳过部署和重启。Fleet 显示检查时间、差异和下一步，Home 提醒仍可关闭。

| 结果 | 下一步 |
| --- | --- |
| clean | 无需操作 |
| repairable | 运行 repair，等待实际状态再次核验 |
| Access/密钥/字段归属变化 | 核对差异；敏感 infra 计划需 `reviewed_apply=true` 和 infra-review 审批 |
| 数据库、桶、DO 或 PVC 身份缺失/变化 | 进入恢复，普通 repair 不创建空资源替代 |
| 修复事务 held/failed | 处理错误后运行下方修复 resume，填写该修复的原 `releases/<UUID>` |
| 普通发布 held/failed | 处理错误后运行下方 CI resume，填写原发布的完整 SHA |
| daemon、K3s 或 Tunnel 不可达 | 恢复宿主入口 |

审批绑定这次实际计划和 SHA；等待期间 state 或目标变化会拒绝旧计划，重新运行后重新审核。
人工暂停和运维开关保留，修复不自动开启业务。

恢复同一次操作，保留其请求身份：

```sh
# Personal cloud reconcile 创建的修复事务
gh workflow run personal-cloud-reconcile.yml --ref main -R "$cloud_repo" \
  -f operation=resume -f 'resume_release=releases/<原修复UUID>'
# CI and deploy 创建的普通发布，包括首次激活
gh workflow run ci.yml --ref main -R "$cloud_repo" \
  -f app=platform -f resume_vps_release=true -f 'resume_source_sha=<原发布完整SHA>'
```

## Host recovery

### 主机地址变化

集群的节点地址和 DNS 都不依赖 DHCP。K3s 不设置 `node-ip` 时，只在启动那一刻从默认路由取地址，之后不再更新；
租约一变，Node InternalIP 和 `default/kubernetes` 的 EndpointSlice 就指向主机已经没有的地址。
宿主上经 `127.0.0.1` 的 kubectl 仍然正常，但所有集群内客户端（发布 daemon、状态观测）经 Service NAT 都连不上 API，
发布停在 `suspend / UNAVAILABLE`。这是架构问题，不靠重启或地址变化钩子补救。

bootstrap 给 K3s 一个只属于本机、永不变化的节点地址：

- oneshot 单元 `personal-cloud-node-address.service` 在 `k3s.service` 之前运行（K3s 以 `Requires=`/`After=` 依赖它），
  创建或保留 dummy 网卡 `pcloud0`，设置唯一地址 `10.254.0.42/32` 并启用；它不留下进程，也没有停止动作。
- K3s 配置的 `node-ip`、`advertise-address` 为该地址，`flannel-iface` 为 `pcloud0`；不设置 `node-external-ip`。
  K3s 自动把 node-ip 和 advertise-address 加进 API 证书；宿主 kubeconfig 仍连 `127.0.0.1`。
- `PCLOUD-K3S` 只允许本机回环，以及 Pod 网段经 `cni0` 访问该地址的 6443/10250；局域网与公网照旧丢弃。
- 有 NetworkManager 时，另写一个只匹配 `pcloud0` 的 unmanaged 配置，下次 NetworkManager 启动时生效；迁移不重启或重载它。

该地址属于 RFC 1918 的 10.254/16，不在 K3s 的 10.42/16、10.43/16，不在 Docker 默认地址池、CGNAT/Tailscale 的 100.64/10，
也不在家用路由器常用的 192.168/16 和 10.0–10.10 网段。安装、迁移和恢复都会先检查主机现有网段，任何网段包含它就在写入前停止
（`NODE_ADDRESS_CONFLICT`）。Pod 出网仍按当时的默认路由做地址转换，公网入口仍是 Tunnel 到 `127.0.0.1` 的 hostPort，
所以局域网地址变化或网络重连都不改变 Node 与 API 端点的地址。没有 DHCP 钩子、定时器或常驻进程。

#### 集群 DNS

CoreDNS 同样不使用 DHCP 下发的 DNS 服务器。K3s 不设置 `resolv-conf` 时，把宿主 systemd-resolved 的
`/run/systemd/resolve/resolv.conf`（即 DHCP 给的服务器）交给 kubelet。CoreDNS 以 `dnsPolicy: Default` 运行，
`forward . /etc/resolv.conf` 只在启动时读取 Pod 创建那一刻得到的副本；DHCP 换了 DNS 服务器后，Pod 的 DNS 会一直坏到 CoreDNS 重建。

- bootstrap 写入 root 所有的 `/etc/rancher/k3s/resolv.conf`，只有 `1.1.1.1`、`1.0.0.1`（Cloudflare）和 `8.8.8.8`（Google，另一家运营方），
  K3s 配置的 `resolv-conf` 指向它。三者都不过滤结果，CoreDNS 随机选用哪个都不会拦截域名（按地域调度的答案可能不同）；只用 IPv4，与 Pod 网络一致；kubelet 最多传三个。
- kubelet 每创建一个 Pod 都读取该文件，所以它必须一直存在，回退也不删除。`ClusterFirst` 的 Pod 照旧经 CoreDNS 解析，不再继承 DHCP 的 search 域。
- K3s 以该文件启动后，在 CoreDNS 的 Pod 模板上设置注解 `personal-cloud/upstream-dns`，由该 Deployment 自己滚动替换一次 Pod：
  集群 DNS 中断几秒，与 K3s 升级替换 CoreDNS 相同；注解已相同时不替换。随后在 daemon 自己的 Pod 里经 CoreDNS 解析 Fleet 主机名。
- Pod 到上游 53/udp、53/tcp 的请求和其他 Pod 出网一样是转发流量，不经过 INPUT；`PCLOUD-K3S` 不变，不新开端口。

#### 已安装主机的一次性迁移

在此之前安装的主机仍是旧配置。把包含 `installer/node_address.py` 的 bundle 放到主机后执行一次：

```sh
sudo /usr/bin/python3 -E -s <bundle>/installer/node_address.py --bundle <bundle>
```

它先核对 bundle 校验和与安装完成标记，并要求主机上的 `k3s.service`、`config.yaml`、`firewall.v4`、`firewall.v6`
恰好是该 bundle 的版本或其加入固定地址与 DNS 之前的版本；其他改动、`pcloud0` 或 `/etc/rancher/k3s/resolv.conf` 已有别的内容、
地址冲突或使用内嵌 etcd 时，在任何写入前停止。daemon 的 Pod 可达时，它还先从该 Pod 直接向三个上游各发 DNS 查询（与 CoreDNS 相同的转发出网路径），
任一不回应就以 `CLUSTER_DNS_UPSTREAM_UNREACHABLE` 在写入前停止；Pod 暂不可达（例如 Node 仍停在过期地址）时记为 `unchecked`，交给最后的解析核对。然后写入单元、创建地址、写入上游 DNS 文件，写入新的 K3s 配置与防火墙，只重启一次 K3s，
等待 API 就绪、Node InternalIP 和 `default/kubernetes` EndpointSlice 都只剩固定地址（K3s 的 cloud controller 每分钟同步一次 Node 地址，
每项最多等 5 分钟）。接着按上节替换一次 CoreDNS，最后在 daemon 自己的 Pod 里经 `https://kubernetes.default.svc` 读取一次
`platform-release`，并经 CoreDNS 解析 Fleet 主机名。成功的最后一行为 `"status": "stable"`。是否重启 K3s 只看文件是否改变，
以及正在运行的 K3s 启动时用的 node-ip（Node 注解 `k3s.io/internal-ip`；DNS 设置在同一配置文件里）；是否替换 CoreDNS 只看注解。
已迁移的主机重复运行只做核对；中途失败时直接重跑同一命令，K3s 已按固定地址启动时只继续等待，不再重启。

控制面中断通常不到一分钟：`KillMode=process` 让现有容器继续运行（[K3s 停止规则](https://docs.k3s.io/upgrades/killall)），
业务 Pod 不重启，Tunnel 入口不中断；只有 CoreDNS 的 Pod 被替换，集群 DNS 中断几秒。完成后用[检查与修复](#检查与修复)中的 CI resume 命令继续原 SHA 的发布；
重复创建发布不会解除 `RELEASE_HELD`。

核对：`ip -4 address show dev pcloud0` 只有固定地址；Node InternalIP 与 `default/kubernetes` EndpointSlice 为该地址；
CoreDNS 的 Pod 模板注解为三个上游，且只有迁移后创建的一个 Pod；daemon 读到真实运行状态，Fleet/Home 恢复新鲜观测；
原业务 Pod 的 UID 和重启次数不变（只有 CoreDNS 换成新 Pod）。

回退：同一命令加 `--rollback`，写回迁移前的 K3s 配置与防火墙并重启一次 K3s，再删除 CoreDNS 的注解，让 CoreDNS 回到 DHCP 给的服务器；
单元、`pcloud0` 和上游 DNS 文件保留但不再被 K3s 使用。迁移前未能检查、之后因网络拦截公共 DNS 而以 `CLUSTER_DNS_LOOKUP_FAILED` 失败时，也用它恢复。
回退后节点地址和 DNS 重新跟随 DHCP，原问题随之回来。迁移后的恢复只使用包含 `node_address.py` 的 bundle；
更早的 bundle 会写回旧配置，遇到时重新运行上面的迁移命令。

### 宿主入口或运行资源损坏

保留原安装包和每次接受版本的 bundle。下载与当前接受发布一致且 **VPS bootstrap bundle** job 成功的 artifact，传入 VPS 后执行：

```sh
sudo /usr/bin/python3 -E -s <新 bundle>/installer/recover.py \
  --installed-bundle <原安装 bundle> --bundle <新 bundle>
```

成功结果：`runtime_restored`。入口恢复保留 Secrets、PVC 和账本，再从 Actions 继续原发布。
它核对原安装身份和账本接受版本；缺失磁盘数据、错误 bundle 或未知归属会停止。
它同时写入[固定节点地址与 DNS](#主机地址变化)，并在 K3s 重启后按需替换一次 CoreDNS、在恢复的 daemon Pod 里核对 API 与 DNS；
原安装 bundle 早于固定地址时，只接受这一处已审核的 K3s 文件差异。
宿主服务故障需要管理员操作，日常部署和运行资源修复通过 daemon HTTP API 完成。
即使其他 job 失败，成功生成的同 SHA bundle 仍可用于该发布。Actions artifact 保留 30 天；下载后自行保留。
过期时用原接受 SHA 和账本中的两个 digest，按 [固定 bundle 生成命令](../tools/vps-bootstrap/README.md#prepare-locally)重新生成。

## Data recovery

空环境 bootstrap 创建空业务状态。恢复历史时先停旧写入，保留原事件、密钥、SQL/R2/DO、Codex gateway 登录、Newsletter 状态和 daemon 账本，
按各应用恢复说明核对后激活。Mail Hero 每日副本在私有 R2，见 [原生备份](../mail-hero/docs/native-backup.md)。
Tasks 用自己的每周备份（私有 R2 `tasks-backups`，由其 `TaskJobs` 的 Alarm 写入）或 7 天内的 Time Travel 恢复自己的 D1，见 [Tasks 备份与恢复](../tasks/docs/backup.md)；核对任务 ID、完成次数以及 Todofy 邮件引用后，再恢复任务写入。从 Todoist 重新导入只能重建 10-17 切换时的状态，不是恢复路径。
Mailsort 用自己的每日备份（私有 R2 `mailsort-backups`，由 `MailsortState` 的 Alarm 每天写入，保留最近 30 份完整备份）恢复：把 `MAILSORT_OBJECT` 换成新对象名发布得到空存储，再由 owner 调用 `StartBackupRestore` 在对象内加载并核对；在途写入转为历史、不重放 Gmail 写入，Gmail 授权 secret 须保持不变或用 `mint-token` 重新写入，见 [Mailsort 备份与恢复](../mailsort/docs/backup.md)。
Personal MCP 用自己的每日备份（私有 R2 `personal-mcp-backups`，由 `SubscriptionStore` 的 Alarm 每天写入，保留最近 30 份完整备份）恢复 Work 记忆、订阅、游标与投递记录：先让应用指向空的 store（同账户改 `STORE_OBJECT` 后发布；新账户用新 namespace，并把下载的备份 upload 进新桶），再由 owner 经 Access 调用 `POST /owner/restore`，对象内分步载入并核对，见 [Personal MCP 备份与恢复](../personal-mcp/docs/backup.md)；业务订阅从当前状态重新开始，不重放备份之后的事件，Watch 从备份游标续读。
Watch 用自己的每日备份（私有 R2 `watch-backups`，由 `WatchState` 的 Alarm 每天写入全部表和快照引用的页面证据，保留最近 30 份完整备份）恢复到一个空对象：新账户的 `watch-v1` 或改 `WATCH_OBJECT` 得到的新对象，由 owner 在健康页“从备份恢复”，对象内校验 SHA-256、先恢复证据再恢复行并核对行数；旧通知不重发、事件游标过期一次，见 [Watch 备份与恢复](../watch/docs/backup.md)。
短链接用自己的每日备份（私有 R2 `links-backups`，由 `LinksBackup` 的 Alarm 每天分步写入，保留最近 30 份完整备份）或 7 天内的 Time Travel 恢复自己的 D1 `links`，见 [短链接备份与恢复](../links/docs/backup.md)；`verify` 逐表逐行核对新库后再切换 Worker 并恢复编辑。导出的 JSONL 只含未删除的链接，不是完整恢复路径。
这四个备份桶与 `tasks-backups` 一样由 `infra/` 声明并经 "Infra apply" 创建；桶本身丢失时先经 Infra apply 重建，再把 owner 下载的备份按各应用文档 upload 回去。从备份的完整恢复只写入空对象或新数据库（短链接的 Time Travel 是原地恢复）；四者的恢复都只在本地 workerd 验证过，尚未在生产演练。
Home 等 DO 完整跨账户数据恢复、真实空账户与干净 VPS 演练留待后续。PVC Retain 和镜像 artifact 都不能替代业务备份。
