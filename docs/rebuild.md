# 个人云重建操作手册

**只换 VPS、保留现有 Cloudflare：已有可执行流程。全新 Cloudflare + VPS：还缺首次创建/采用和几处配置解耦，不能靠一次 `Infra apply` 完成。**
本页是今天可执行的步骤；[改进计划](rebuild-audit.md)说明补哪些代码后才能做到“以后只改配置”。
当前生产进展看 [HANDOFF](../HANDOFF.md)，不要从本页推断新账户演练已经通过。

## 先选路径

| 情况 | 从哪里开始 | 必须保留什么 |
| --- | --- | --- |
| 只换 VPS，账户/域名/仓库不变 | 第 1 步核对配置，再到第 4 步 | Newsletter data/auth/config；需要保留的 daemon ledger 和 observer sequence |
| 新账户 + 新 VPS，空业务启动 | 第 1–5 步；第 2 步目前需要单独准备创建/采用方案 | 新账户身份与秘密；不能沿用旧 IDs/AUDs |
| 新账户 + 新 VPS，恢复历史 | 同上，并先完成第 6 步恢复核对 | 原解密材料、冻结事件身份、未确定副作用；不能用空库绕过 |

开始时关闭仓库变量 `VPS_DEPLOY_ENABLED`、Home canary，保持 Todofy 外部处理暂停、Mail Hero 强制停发。
它不会取消 daemon 已持久接管的 release，先检查进行中的操作。换 VPS 时先停旧 observer，
移交最新 sequence/pending 状态或协调两端新 epoch；不要并行运行相同 host key/epoch 的观察器。

## 最少准备的输入

| 输入 | 放在哪里 | 来源 |
| --- | --- | --- |
| 域名、仓库、Access team、Fleet/daemon hostname、namespace/state root/node alias | [config/cloud.toml](../config/cloud.toml) | Owner 选择；不放 IP、邮箱或秘密 |
| Account/zone、D1、Access app/AUD/policy、DO namespace 等真实 ID | [config/resources.toml](../config/resources.toml) | 目标账户创建/盘点返回 |
| 发布 token、应用秘密与开关 | GitHub `production` + Worker secret | [CI/CD 清单](ci-cd.md#production-environment)及下方 secret inventory |
| Access machine client、daemon Bearer、connector token、Fleet HMAC | 对应 GitHub secret + VPS 私有 JSON | 创建时安全保存；管理员 Cloudflare token 不放 VPS |
| 两个已测试 image digest + 完整 source SHA | 公开 bootstrap bundle | 同一成功 Actions run；不用 tag |
| 原密钥、登录和状态（恢复时） | 独立私有恢复材料 | Owner；Git/镜像/CI artifact 都不替代备份 |

一次性人工项：zone/Zero Trust/R2 激活、GitHub OAuth 回调和登录同意、外部 provider 授权。
沿用 Workers Free；R2 激活有超额计费，免费额度按账户共享，提醒不是硬消费上限。重建不自动升级 Paid。
换域名/仓库还要改 routes、canonical origin、包发布权限和业务链接授权；当前 generator 没有包办它们。
不全局替换 proto resource type 或 `ErrorInfo.domain`，它们是稳定合同身份。

## 1. 准备并检查公开配置

在独立干净 checkout 使用 Node 26、现有 uv 和 `platform/versions.json` 的 manifest compiler。
先选择 Python 3.12，避免 macOS 的旧系统 Python 缺少 tomllib；后面的 `rebuild_python` 始终指向这个解释器。
填好 profile/inventory 后：

```sh
uv python install 3.12
rebuild_python="$(uv python find 3.12)"
"$rebuild_python" tools/cloud-config/generate.py
"$rebuild_python" tools/cloud-config/generate.py --check
"$rebuild_python" tools/service-catalog/catalog.py
"$rebuild_python" tools/service-catalog/catalog.py --check
"$rebuild_python" .github/scripts/drift_desired.py
"$rebuild_python" .github/scripts/drift_desired.py --check
```

**放行：**生成文件一致；diff 只包含预期身份；binding、预算、暂停开关、迁移和鉴权没有意外变化。
generator 更新已有生产字段、Home resource identities 和 infra DNS locals。
Fleet route/PUBLIC_HOST、部分 infra references、workers.dev 自有域规则仍需核查，见改进计划。
配置改动照常分支 CI，完全通过的同一 SHA 才能进入 main。

## 2. 新账户：先创建/采用，再进入正式 infra

保留现有账户时跳过。**今天没有完整自动 creator；此处是人工准备阶段，不是已经存在的一键命令。**

1. 激活目标 zone、Workers Free、R2 和 Zero Trust，配置 owner/GitHub 登录。
   保留根邮箱 MX/TXT/DKIM/DMARC；域名、nameserver、DNSSEC/DS 与邮件切换单独安排。
2. 按 [infra scope](../infra/README.md#scope) 创建/盘点等价对象：五个 D1、三个应用 R2、owner Access，
   特殊 FlowDay/backup 身份，专用 daemon Tunnel/DNS/Access machine 与 Fleet receipt。
   先在**新账户**创建 `infra-state` 桶：当前缺桶分支仍调用旧账户 helper，不能拿它创建新账户桶。
3. 创建时保存 Access client secret；import 不保证取回。记录 IDs/AUDs，更新 inventory、`infra/ids.tf`、
   app-scoped policy references 和 `FROZEN_OBJECTS` 的新对象 ID，保留冻结语义；补齐完整 import inventory。
4. 用新 token、独立 passphrase、私有 tfvars 做 import-only adoption。旧账户 state 仅作恢复证据。

仅在对象、引用和 imports 已审查完整后执行。下文 `rebuild_repo` 为目标仓库，`rebuild_private` 为仓库外
mode 700 私有目录，`rebuild_import_count` 为本次审查的纯 import 数量；私有文件 mode 600：

```sh
"$rebuild_python" infra/scripts/bootstrap_state.py \
  --var-file "$rebuild_private/local.tfvars" --token-file "$rebuild_private/cf-token" \
  --passphrase-file "$rebuild_private/state-passphrase" --expect "$rebuild_import_count"
"$rebuild_python" infra/scripts/infra_state.py values-json --var-file "$rebuild_private/local.tfvars" \
  | gh secret set INFRA_TFVARS --env production -R "$rebuild_repo"
gh secret set INFRA_STATE_PASSPHRASE --env production -R "$rebuild_repo" \
  < "$rebuild_private/state-passphrase"
```

**放行：**目标账户正确、encrypted state 存在、最终 no-op、outputs 与生产 Wrangler 一致，无旧账户写入。
`bootstrap_state.py` 只允许 import/no-op；不要删 `prevent_destroy`/FROZEN 或绕过 outputs 检查。
采用与 tfvars 格式见 [infra bootstrap](../infra/README.md#bootstrap-once)。
之后的正式更新使用已有 workflow；`rebuild_expect` 必须取自最新 drift 的已审查动作/fingerprint：

```sh
gh workflow run infra.yml --ref main -R "$rebuild_repo"
gh workflow run infra-apply.yml --ref main -R "$rebuild_repo" -f expect="$rebuild_expect"
```

有陌生对象、删除/替换或意外更新先解决差异。`Infra apply` 是采用后的 reconcile，不能直接用于空账户。
每次 dispatch 后等对应 run 完成再进入下一步；用 `gh run list --workflow <workflow-file> -R "$rebuild_repo"`
找到本次 run，再用 `gh run watch <run-id> --exit-status -R "$rebuild_repo"` 核对完整结果。

## 3. 初始化秘密并发布 Worker

按 [secret inventory](#secret-inventory)配置 GitHub/Worker 秘密。通过正常输入或 stdin 保存，例如：

```sh
gh secret set CF_API_TOKEN --env production -R "$rebuild_repo" < "$rebuild_private/cf-token"
gh variable set VPS_DEPLOY_ENABLED --body false -R "$rebuild_repo"
gh workflow run ci.yml --ref main -R "$rebuild_repo" -f app=all
```

当前 wrapper 只上传它负责的秘密；旧 Worker 保留 secret **不等于新账户已初始化**。
首次安全发布形成 Worker 后，保持暂停，再初始化 wrapper 外的 runtime secret。
例如在 Mail Hero 的 `cloudflare/` 目录：

```sh
npx wrangler secret bulk "$rebuild_private/mail-hero-runtime-secrets.json" --config ../wrangler.toml
```

其他应用分别使用自己的锁定工具和唯一 production config，见各 setup。
Website 独立发布还有 bootstrap approval/Notion 授权；`app=all` 不证明网站内容已恢复。
首次部署取得真实 DO namespace ID 后补回 inventory、重新生成，再发布 Home 的准确资源身份。
**放行：**各 deploy 成功、实际版本/绑定正确、Access 登录/拒绝路径正确、runtime secret 齐、暂停的合成流程通过。
此时不切邮箱转发，不开放真实写入。

## 4. 准备并安装新 VPS

支持 Ubuntu 24.04 Linux amd64、systemd、已有 UID65534、Python stdlib、iptables/ip6tables、启用的标准 AppArmor。
2 CPU/4 GiB RAM/20 GiB 空余磁盘是准备起点，Newsletter 实际容量另核对。
允许出站 HTTPS；Tunnel 另需 7844 UDP 或 TCP；固定 Pod CIDR/hostPorts 不得冲突。
不需要 Docker/Compose、主机应用 Python 包或新 tailnet。

从同一成功 SHA 取得两个 published digest，在该 SHA 的干净 checkout 生成公开 bundle。
prepare 校验 image 的 owner/digest 形式，不代替 Actions artifact/source 核验：

```sh
npm ci --prefix proto --no-audit --no-fund
node proto/tools/ensure.mjs
uv sync --project platform --locked --python "$rebuild_python"
test "$(git rev-parse HEAD)" = "$rebuild_sha"
git diff --quiet
git diff --cached --quiet
platform/.venv/bin/python tools/vps-bootstrap/prepare.py \
  --sha "$rebuild_sha" --newsletter-image "$rebuild_newsletter_image" \
  --platform-image "$rebuild_platform_image" --output "$rebuild_bundle"
```

SHA 为完整 40 位；image 为目标 owner 的 `todofy-newsletter@sha256:…` 和 `todofy-platform@sha256:…`。
通过可信管理通道把 bundle、私有 JSON 放 VPS；完整 JSON 格式见 [bootstrap private input](../tools/vps-bootstrap/README.md#private-input)。
空启动可用 `old_paths: {}`；恢复填停止写入的 data/auth/config 原目录。它不会生成 Codex/provider 登录。
保留旧 daemon ledger 时先按第 6 步核对，不能挂库就启动。

在 VPS 重新设置 `rebuild_bundle`、`rebuild_private` 为传入文件所在位置，再一次执行：

```sh
sudo /usr/bin/python3 -E -s "$rebuild_bundle/installer/install.py" \
  --bundle "$rebuild_bundle" --credentials "$rebuild_private/bootstrap.json" --grant-reader
```

首次 bootstrap 在应用资源前加载 pinned observer AppArmor policy。
已有节点先运行 [profile-only installer](../platform/apparmor/README.md)，加载后才发布 Localhost manifest。
宿主 policy 修改仍需管理员；日常镜像发布不用 sudo，也不能修改 kernel policy。
**放行：**`complete_held`、专用 connector 注册、reader 能读 metadata、Newsletter 不接新工作、daily suspended。
初始 gate 通常 draining；`complete_held` 不是 release ready，observer receipt 另验。
新 VPS 无旧全局 `cloudflared.service` 时当前监督集合会告警；需要补配置边界，不装无用途服务或伪造 active。

## 5. 第一轮发布、观测，再接真实业务

先完成 provider 设置与历史 unknown 处理决定。**固定 main 在 bootstrap 同一 SHA**，然后：

```sh
gh variable set VPS_DEPLOY_ENABLED --body true -R "$rebuild_repo"
gh workflow run ci.yml --ref main -R "$rebuild_repo" -f app=platform
```

正常 release 会 drain/freeze、apply/verify、resume admission 和 daily，最后 ready。
当前没有独立“部署完成但继续暂停、另行激活”阶段，所以不能在 provider/对账尚未准备好时执行。

| 放行门 | 必须看到 |
| --- | --- |
| Actions `VPS deploy` | ready；两个实际 digest/source/request/generation 与冻结 targets 一致；fresh status |
| Newsletter | running/accepting；历史 unknown 保持告警，不自动当成功/重放 |
| Fleet/observer | 自然新鲜签名回执、匹配 image/source；init 固定单元真实状态；主容器 `READ_OK`，不是仅 exit 0 |
| Home | 正常刷新反映同一部署/业务状态；旧回执有 stale/missing 提示 |

Held/failed 先查固定错误，再以原 SHA/身份继续，不换 targets、不清 ledger：

```sh
gh workflow run ci.yml --ref main -R "$rebuild_repo" -f app=platform \
  -f resume_vps_release=true -f resume_source_sha="$rebuild_original_sha"
```

全部通过后继续 main、开放各应用处理，最后配置专用 Mail Hero Email Routing rule 和源邮箱转发。
真实收信、摘要、Todoist/Notion/Newsletter 发送分别验收；部署绿灯不覆盖外部业务。

## Secret inventory

GitHub 名称/必选开关以 [CI/CD production table](ci-cd.md#production-environment)与实际 workflow 为准。
下面是目前不由普通 wrapper 完整初始化的 runtime secret，只列名称：

| Worker | Runtime secret |
| --- | --- |
| Mail Hero | `CREDENTIAL_KEY`、`BACKUP_TOKEN`、`BACKUP_RECEIPT_KEY`；启用能力另需消费者 Access/alert secret |
| Todofy gateway | `CSRF_SIGNING_KEY`、`MAIL_WEBHOOK_TOKEN_SHA256`、`REPORT_BASIC_AUTH_SHA256`；已有轮换的 previous hash |
| Todofy core | `GEMINI_API_KEY`、`TODOIST_API_KEY` |
| Website relay | `GITHUB_DISPATCH_TOKEN`、`NOTION_TOKEN`、`NOTION_DATA_SOURCE_ID`、`NOTION_WEBHOOK_SECRET` |

VPS 的三个 production secret 是 `PLATFORM_ACCESS_CLIENT_ID`、`PLATFORM_ACCESS_CLIENT_SECRET`、`PLATFORM_DEPLOY_TOKEN`。
Fleet HMAC 与 Bearer 独立；owner/邮箱/project 等个人值也按秘密处理。
空部署可生成新 key；历史 ciphertext 必须保留 Mail Hero/FlowDay 原解密 key及其绑定身份。
[CMS exporter](../infra/scripts/platform_export.py)可用 production variable `VPS_BOOTSTRAP_CERT` 的 owner X.509 certificate
密封 Access client/Tunnel handoff；private key 留 owner 端。这是一天交接 artifact，不是备份。
创建时没保存 secret 就需要独立安全交接，不能假设 import/CMS 能找回。

## 6. 历史恢复与备份：单独放行

| 对象 | 激活前核对 |
| --- | --- |
| Mail Hero | SQL、R2 bytes/customMetadata/hash、最新删除清单、原 event/payload；保持停发，重建 DO 调度并对账 |
| Todofy、FlowDay、Links、Lab | SQL/schema/原密钥；Todofy 未确定外部副作用；DO 状态另核对 |
| Watch/Lab/Home DO | 目前没有统一跨账户 export/import；空 namespace 不恢复 watches/queue/settings/ledger/budgets |
| Newsletter | 一致 SQLite/config、冻结身份、原 mode/delivery target、专用 auth；保留 unknown，不以新身份重发 |
| Platform/observer | ledger targets/checkpoint 与 namespace/PVC/gate 一致；observer 最新 sequence/pending 或协调新 epoch |
| Infra | 新账户采用到新 encrypted state；旧 state 仅作证据 |

Daemon 非终态 checkpoint 会自动继续，held/failed 才等待 Resume；启动前离线核对，当前没有统一 quarantine 入口。
不复制正在写入的 SQLite 主文件而忽略 WAL；PVC Retain 不是离机备份。
Mail Hero [现有隔离恢复](../mail-hero/deploy/backup/README.md)保持 `activation_allowed=false`，不自动导入新账户/重建 Alarm。
Mail Hero 备份正在迁移到 Cloudflare 原生执行，**不增加 k3s/Compose backup collector**。
旧 collector 已停；新备份上线、完整读回、隔离恢复各自验收，不拿 Platform 健康替代。
其他 VPS/DO 持续备份仍需按应用补齐，见 [改进计划](rebuild-audit.md)。
有独立备份、解密材料和真实隔离恢复证据后才记录 RPO/RTO；本文不宣称完整重建/恢复已经通过。
