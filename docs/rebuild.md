# 重建个人云

日常更新：提交代码，等待 main 的 **CI and deploy**。它发布受影响的 Workers 和独立镜像，再通过 daemon 更新对应 VPS 服务。
检查或修复运行偏差：在 Actions 打开 **Personal cloud reconcile**，选择 `check` 或 `repair`。

首次部署需要修改 [cloud.toml](../config/cloud.toml)，填写仓库外的一个私有 JSON，运行 bootstrap，再做一次 VPS 主机初始化。
资源 ID 自动写入 [resources.toml](../config/resources.toml)。账户启用、OAuth 注册和应用登录需要 owner 完成。
历史恢复见 [恢复边界](#data-recovery)，实际验收见 [实施记录](rebuild-verification.md)。

## 1. 准备账户

准备 GitHub 仓库、Cloudflare 域名和 Ubuntu 24.04 amd64 VPS。启用 Workers Free、R2、Zero Trust。
在专用 `inbox.<域名>` 子域启用 Email Routing，保留根域现有邮箱配置。
注册 GitHub OAuth app，回调使用目标 Access team 的 `/cdn-cgi/access/callback`；给 Notion integration 授予网站内容集合访问权限。

本机运行 `gh auth login`，通过正常 Cloudflare API token 创建流程保存 token 到仓库外的 mode 600 文件。
权限见 [bootstrap 凭据清单](../tools/cloud-bootstrap/README.md)。VPS 不接收此管理 token。
准备固定 Bazel（或 Bazelisk）、Node 26、uv，以及 [infra 固定版本](../infra/versions.tf)的 OpenTofu。

模型凭据只配置在 `model-router`，每个供应商共用一枚 key。不要把它们放入 bootstrap JSON、GitHub 或 VPS。
Router 首次上传后，按 owner 连接流程配置 `ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`OPENAI_API_KEY`。
供应商消费限制与 Router 已知用量估算分别核对，不把估价停止线当账单硬上限。Gmail 授权仍归 Mailsort。
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
uv python install
cloud_python="$(uv python find "$(cat .python-version)")"
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
/usr/bin/python3 -E -s <bundle>/installer/install.py \
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
安装完成、镜像构建和业务处理分别核对。错误处理见 [VPS bootstrap](../tools/vps-bootstrap/README.md#recovery-boundaries)。

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

当前 bootstrap 用专用稳定节点地址和明确的集群上游 DNS，避免 DHCP 变更后控制面端点或 CoreDNS 仍使用旧值。
这不是依赖周期重启的修补。固定网络配置、冲突检查、一次性旧主机迁移与核验由
[VPS bootstrap](../tools/vps-bootstrap/README.md#fixed-node-address-and-dns)维护；不要在多个文档复制宿主实现细节。

已安装节点若仍使用旧 bootstrap，应先核对其版本并按该手册完成授权迁移。没有新鲜 API/DNS/工作负载证据时，
不能把一次命令退出或 Pod Running 当作恢复。业务数据、账本和 PVC 保留，修复之后继续原发布身份。

### 宿主入口或运行资源损坏

保留原安装包和每次接受版本的 bundle。下载与当前接受发布一致且 **VPS bootstrap bundle** job 成功的 artifact，传入 VPS 后执行：

```sh
/usr/bin/python3 -E -s <新 bundle>/installer/recover.py \
  --installed-bundle <原安装 bundle> --bundle <新 bundle>
```

成功结果：`runtime_restored`。入口恢复保留 Secrets、PVC 和账本，再从 Actions 继续原发布。
它核对原安装身份和账本接受版本；缺失磁盘数据、错误 bundle 或未知归属会停止。
它同时写入[固定节点地址与 DNS](#主机地址变化)，并在 K3s 重启后按需替换一次 CoreDNS、在恢复的 daemon Pod 里核对 API 与 DNS；
原安装 bundle 早于固定地址时，只接受这一处已审核的 K3s 文件差异。
宿主服务故障需要管理员操作，日常部署和运行资源修复通过 daemon HTTP API 完成。
即使其他 job 失败，成功生成的同 SHA bundle 仍可用于该发布。Actions artifact 保留 30 天；下载后自行保留。
过期时用原接受 SHA 和账本中的两个 digest，按 [固定 bundle 生成命令](../tools/vps-bootstrap/README.md#build-the-public-bundle)重新生成。

## Data recovery

空环境 bootstrap 创建空业务状态。历史恢复先停旧写入，保留冻结事件身份、原加密材料、数据库/对象、
Newsletter 状态及 daemon 发布账本。按对应手册恢复、验证，再启用写入。

| 应用 | 恢复来源和边界 |
| --- | --- |
| Mail Hero | [每日 R2 副本](../mail-hero/docs/native-backup.md)；保留事件、对象和投递身份 |
| Tasks | [每周 R2 / D1 Time Travel](../tasks/docs/backup.md)；核对任务 ID、完成次数和邮件引用。重新导入旧 Todoist 不是当前恢复路径 |
| Mailsort | [每日完整 DO 备份](../mailsort/docs/backup.md)，最近 30 份；只恢复空对象，在途写入转为历史，不重放 Gmail 副作用 |
| Personal MCP | [每日完整 DO 备份](../personal-mcp/docs/backup.md)，最近 30 份；恢复 Work、订阅和游标，业务来源从当前状态继续，不重放缺失历史 |
| Watch | [每日 DO 与证据备份](../watch/docs/backup.md)，最近 30 份；恢复空对象，旧通知不重发 |
| Links | [每日完整 D1 备份 / Time Travel](../links/docs/backup.md)，最近 30 份；逐行核对后切换。JSONL 导出不含完整恢复状态 |
| Model Router | [每日数据库与请求正文备份](../model-router/docs/backup.md)，保留 7 天；不备份供应商凭据或恢复在途模型调用 |

备份桶由 infra 管理存在性；恢复工具只填空对象或新数据库，Time Travel 的原地恢复另按应用手册操作。
已下载的备份可按原布局转入新账户，但跨账户完整演练仍未进行。Mailsort、MCP、Watch、Links 的完整恢复
目前只有本地 workerd 证据，未在生产演练。Home 等其余 DO 的完整历史恢复也未完成。
PVC Retain、镜像和 Actions artifact 都不能替代业务数据备份。Codex 登录和外部授权由其原凭据所有者另行恢复。
