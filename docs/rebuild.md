# 重建个人云

日常更新：提交代码，等待 main 的 **CI and deploy**。它发布 Workers、构建两个独立镜像，再通过 daemon 更新 VPS。
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

成功结果：Workers 已发布，两个 VPS 镜像已按 digest 发布，run artifact 中有 `vps-bootstrap-<完整 SHA>`。
`VPS_DEPLOY_ENABLED=false` 时服务器部署等待一次性安装。
静态网站是异步发布，另确认 **Website release** 成功；CI 的 dispatch 成功只代表已启动它。

网站或外部凭据错误在对应 job 处理，无需重建数据库。

全新仓库首次创建的两个 GHCR 镜像默认私有。在 GitHub 的 **Packages** 分别打开
`<仓库名>-newsletter` 和 `<仓库名>-platform`，进入 **Package settings → Change visibility → Public**。
这一步每个包只做一次；已有公开包跳过。安装器和 k3s 使用匿名拉取，不配置 registry 密钥。
公开前确认镜像只包含代码与依赖；私有文件由第 3 步单独传给 VPS。
[GitHub 的默认可见性说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)。
如安装时镜像拉取报 `unauthorized`，先检查这两个包的可见性。

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
[Newsletter 配置](../newsletter/README.md)准备专用 Codex 登录目录及外部 provider 凭据，将私有输入的
`vps.newsletter_env` 改为对应的 live/codex 设置，用 `vps.old_paths.auth` 指定登录目录；安装器会导入该目录。
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
真实收信、Todoist 写入、Newsletter 发送和网站内容分别验收。

新环境的邮件链路准备好后，关闭 bootstrap 创建的三个暂停变量，并发布使其生效：

```sh
gh variable set MAIL_HERO_FORCE_SEND_PAUSED --body false -R "$cloud_repo"
gh variable set TODOFY_PROCESSING_PAUSED --body false -R "$cloud_repo"
gh variable set TODOFY_FORCE_PAUSE_TODOIST --body false -R "$cloud_repo"
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

保留原安装包和每次接受版本的 bundle。下载与当前接受发布一致且 **VPS bootstrap bundle** job 成功的 artifact，传入 VPS 后执行：

```sh
sudo /usr/bin/python3 -E -s <新 bundle>/installer/recover.py \
  --installed-bundle <原安装 bundle> --bundle <新 bundle>
```

成功结果：`runtime_restored`。入口恢复保留 Secrets、PVC 和账本，再从 Actions 继续原发布。
它核对原安装身份和账本接受版本；缺失磁盘数据、错误 bundle 或未知归属会停止。
宿主服务故障需要管理员操作，日常部署和运行资源修复通过 daemon HTTP API 完成。
即使其他 job 失败，成功生成的同 SHA bundle 仍可用于该发布。Actions artifact 保留 30 天；下载后自行保留。
过期时用原接受 SHA 和账本中的两个 digest，按 [固定 bundle 生成命令](../tools/vps-bootstrap/README.md#prepare-locally)重新生成。

## Data recovery

空环境 bootstrap 创建空业务状态。恢复历史时先停旧写入，保留原事件、密钥、SQL/R2/DO、Newsletter 登录/状态和 daemon 账本，
按各应用恢复说明核对后激活。Mail Hero 每日副本在私有 R2，见 [原生备份](../mail-hero/docs/native-backup.md)。
Watch/Lab/Home 等 DO 完整跨账户数据恢复、真实空账户与干净 VPS 演练留待后续。PVC Retain 和镜像 artifact 都不能替代业务备份。
