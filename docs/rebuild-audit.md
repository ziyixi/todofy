# Personal cloud 重建审查

审查日期：2026-10-03。源码基线：`767ffd3`，分支 `codex/k3s-personal-cloud`。
本文检查当前代码能做什么，以及还缺什么；操作入口是 [rebuild runbook](rebuild.md)。
没有创建新账户、切换 DNS、读取个人内容或做真实空账户/空 VPS 恢复演练。

## 1. 结论

**目标合理，但当前还不能承诺“全新 VPS、全新 Cloudflare 账户，只改少量配置就完整重建”。**
多数业务源码已经不依赖 VPS 地址或 Cloudflare 管理凭据，单节点 Ubuntu VPS 也有固定版本的 bootstrap。
剩下的障碍主要集中在部署身份、首次资源创建、秘密初始化和历史状态恢复，适合用少量边界明确的改进解决。
没有必要再引入运行时配置服务、另一个 GitOps 控制器或第二套生产 Wrangler。

需要区分三种结果：

| 结果 | 当前能力 | 尚缺的条件 |
| --- | --- | --- |
| 新 VPS 替换旧 VPS，保留 Cloudflare | 已有受限 bootstrap、镜像和 daemon API | 正确转移登录/业务状态；先处理 observer 序列；验证宿主 D-Bus、网络和实际 rollout |
| 新 Cloudflare + 新 VPS，启动空业务 | 大部分源码可沿用，配置入口和依赖顺序已有 | workers.dev 两处真实耦合、完整首次创建/采用流程、秘密清单及空环境演练 |
| 新 Cloudflare + 新 VPS，恢复全部历史业务 | 各应用有部分恢复材料 | Watch/Lab/Home DO 的跨账户恢复、停用后的备份覆盖、统一恢复顺序、未知副作用对账及恢复实测 |

相同域名也不能消除新账户问题：新账户可能使用不同的 workers.dev 子域，而 CI 与 Watch 仍写死旧子域。
换域名、仓库或 owner 时，还有路由、业务链接授权、发布包和外部授权要配置化。不能把这些情况排除后，
笼统地宣称“无需代码变更”。目标应是：**做完一次必要的解耦改进后，每次重建只输入配置和凭据，
生成部署材料，不手改业务源码或 proto。** 生成的 TS 身份常量属于构建产物；它们变化不等于改业务逻辑。

## 2. 已经做对的边界

- 应用各自拥有 Worker、数据库、密钥和发布。Newsletter/Platform 保持独立镜像；源码入 monorepo
  不会把它们变成 Worker，也不要求每个应用共同上线。
- `app.toml` 是构建时服务清单；每个 Worker 的 `wrangler.toml` 仍是唯一生产配置。
  Home、Access 清单从现有配置生成，没有第二份并行的服务定义。
- 共享接口在 `proto/`、`contracts/`，共享实现仅在 `packages/`。应用不互相导入业务代码。
  部署可改变 hostname，稳定合同身份不必跟着改。
- GitHub 主动调用有鉴权的 daemon；请求只含允许的 workload alias、SHA、digest、稳定请求身份。
  manifest 属于 daemon 自己的已测试镜像。Actions 不持有 SSH key、kubeconfig 或任意执行能力。
- 镜像从 CI 已测试的 tar 发布，检查 archive hash、image ID 和 source SHA 后推送，VPS 只拉 digest。
  见 [image.py](../tools/container-release/image.py):47–75、[release client](../tools/vps-release/README.md)。
- 接受部署请求、期望状态、物理运行状态和业务结果分开。稳定 release identity、etag 和持久 ledger
  使失联后的检查/继续可追踪；历史未知业务结果不会被伪装成成功。

这些边界应继续保留。新的重建工具负责配置与 bootstrap，不接管应用运行时，也不扩大日常部署权限。

## 3. 发现的具体缺口

P1 表示会阻止重建或造成错误验收；P2 表示增加操作负担或遗漏监控。
“完整历史恢复”目前另有阻断条件，见第 7 节，不能用空库启动绕过。

| 优先级 | 发现与影响 | 当前代码证据 | 建议 |
| --- | --- | --- | --- |
| P1 | Website relay 的部署检查仍请求旧账户 URL；新账户可能误验旧服务或错误失败；现有 health 只回 ok，不含 SHA | [ci.yml](../.github/workflows/ci.yml):2796；[buttons.ts](../website/relay/src/buttons.ts):76–79 | 从公开部署身份推导新 relay origin，用控制面版本证据或新增版本探针核对真实发布身份 |
| P1 | Watch 将旧 zone、旧 workers.dev suffix 写入自有域排除规则；新账户自己的 relay 会被当成外部网址 | [url-policy.ts](../watch/worker/src/url-policy.ts):20、39–40、64 | 将部署自有域作为有界、校验过的配置输入，保留逐跳拒绝与合成负例 |
| P1 | 正常 Infra apply 要求已有 Wrangler AUD/D1 ID 与输出一致；空账户的 ID 尚未知。state bootstrap 又只允许 import/no-op | [infra_state.py](../infra/scripts/infra_state.py):627–656；[bootstrap_state.py](../infra/scripts/bootstrap_state.py):210–220 | 独立 create-only 首次阶段，收集公共身份后采用，再进入正常 reconcile |
| P1 | Mail Hero backup Access app 的 FROZEN 保护也阻止正常流程首次创建；部分 app-scoped policy/token 不在 provider 管理范围 | [infra_state.py](../infra/scripts/infra_state.py):118–127、907–938；[access.tf](../infra/access.tf):119–150 | 首次阶段显式创建/采用这些例外，保留正式 apply 的冻结保护 |
| P1 | 创建 infra-state 桶的旧 helper 固定旧 account，并覆写 account 环境变量 | [bootstrap_state.py](../infra/scripts/bootstrap_state.py):179–198；[cloudflare-admin.py](../mail-hero/deploy/cloudflare-admin.py):18、128 | 改为显式账户输入；当前只能先在新账户创建该桶并传入新 token，跳过这个创建分支 |
| P1 | `platform_hostname` 更新 infra/Fleet receipt URL，却不更新 Fleet Wrangler route/PUBLIC_HOST | [generate.py](../tools/cloud-config/generate.py):84–87、105–120；[Fleet config](../fleet/wrangler.toml):9、29 | 让同一 hostname 输入生成这些相关字段，验证全部消费者一致 |
| P1（换域名） | Watch 链接授权写在 TS 合同和 Todofy Python 中，仅改 route 会被消费者拒绝 | [task-intent-v1.ts](../contracts/task-intent-v1/task-intent-v1.ts):21–24；[intents.py](../todofy/worker/todofy/core/intents.py):56、284 | 分开稳定 source/合同语义与部署 host 授权；兼容历史冻结 payload |
| P1（恢复） | 旧 Worker secret 在既有 deploy 后保留，不意味着新账户已初始化；旧 ciphertext 不能任意换 key/URL | [Mail Hero security](../mail-hero/cloudflare/src/native/security.ts):24–41；[Todofy deploy vars](../todofy/deploy/deploy_vars.py):105–117 | 明确 required secret 清单；历史密钥独立保存，endpoint 变更用新 revision |
| P1（恢复） | daemon 启动会继续非终态release checkpoint；把恢复库挂入运行daemon可能直接apply/resume/unsuspend | [store.py](../platform/src/personal_cloud/deployment/store.py):158–163；[router.py](../platform/src/personal_cloud/deployment/router.py):137 | 启动前离线核对targets/phase/checkpoint与业务gate；补明确只读恢复/quarantine入口 |
| P2 | 两份 profile 未覆盖全部 import/frozen/policy identity；仍须手工同步若干 infra 文件及 FROZEN_OBJECTS 的新采用对象身份 | [cloud-config README](../tools/cloud-config/README.md):28–32；[ids.tf](../infra/ids.tf):10–39；[access.tf](../infra/access.tf):144、169、176；[infra_state.py](../infra/scripts/infra_state.py):124–125 | 扩大 provider inventory 到完整采用清单，生成身份引用并守卫一致性，保留冻结地址与保护语义 |
| P2（换仓库） | backup、content-config、website release 的 repo/image owner/canonical/dispatch 仍有固定配置 | [backup workflow](../.github/workflows/mail-hero-backup-image.yml):24、77；[content workflow](../.github/workflows/content-config.yml):72；[website workflow](../.github/workflows/website-release.yml):69、73 | 由 repo/host 的公开输入推导，保留镜像 owner 和 dispatch allowlist |
| P2 | 首次部署才产生 DO namespace，Home 初始 identity 可能为 null；Watch 首次 Alarm 需受鉴权调用 | [registry.ts](../dashboard/worker/src/registry.ts):274–289；[Watch README](../watch/README.md):101–107 | 首次发布后有明确 discover → regenerate → Home 发布 → authenticated wake 阶段 |

本次合成验证实际发现：旧账户 relay URL 被 Watch 拒绝，而新账户合成 relay URL 会被允许。
公开身份生成、服务清单与 drift 生成检查均通过；cloud-config 的 9 个测试通过。
这些结果证明源码一致性和上述配置缺口，不证明新账户已经上线。

## 4. 最小输入应是什么

推荐继续用三层输入；它们是三类职责，不要求新增三个服务或大型配置框架。

| 层 | 内容 | 保存与消费 |
| --- | --- | --- |
| 公开期望配置 | zone、repo、Access team、各应用 host、workers.dev/relay origin、VPS namespace/state root/node alias、固定逻辑资源名 | 扩展现有 `config/cloud.toml`；生成现有 Wrangler/infra/manifests |
| provider 身份 inventory | account/zone、AUD/app/policy、D1、DO namespace、采用对象身份 | 扩展现有 `config/resources.toml`，首次创建/发现写公共值，后续 `--check` 核对 |
| 私有输入 | owner/地址、外部 provider key、部署/机器 token、加密与恢复密钥、Codex auth | GitHub environment、Worker secrets、节点 Secret/私有持久目录、离机恢复材料 |

长期目标是只手改第一层；第二层由创建/发现命令输出，不手抄几十个 ID。私有输入不进入 Git、镜像或日志。
现有 generator 已生成 13 份文件，涵盖 11 个 Worker 配置及 Home/infra 身份材料；它只覆盖 account/AUD/D1
等已实现字段，不能把“13 文件一致”解释为“所有部署身份已配置化”。

保留固定逻辑 Worker、binding、数据库名和单节点 topology，能减少旋钮。
不必让 namespace、OS、任意 workload、provider 都随意变化才能称为解耦。
但已承诺的输入，例如 `platform_hostname`，必须真正贯穿其消费者。

稳定 `ErrorInfo.domain`、proto resource type、包 namespace、HKDF domain separation 字符串，以及 Newsletter
锁定外部 protobuf provenance，属于合同或供应链身份。全仓替换 `ziyixi` 会破坏这些边界。

## 5. 当前可执行的重建顺序

这是顺序与退出条件清单。首次创建阶段尚无完整命令，因此本节不虚构“一键”脚本。
具体现有命令、私有输入形状与证书交接在 [rebuild](rebuild.md) 和 [VPS bootstrap](../tools/vps-bootstrap/README.md)。

### A. 选择重建类型，冻结实际业务

先选空业务还是历史恢复；保留旧 Fleet 时，先选 observer sequence 恢复或两端新 epoch。
保持 `VPS_DEPLOY_ENABLED=false`、Home canary 关闭、Todofy 处理/外部写入暂停、Mail Hero 强制停发。
新 Email Routing 先不接真实转发。维护模式是否开启按应用恢复步骤决定，不与仅停发混用。
退出条件：所有有外部副作用的启动路径有明确开关，恢复材料与目标 schema/SHA 已选定。

### B. 完成账户与外部授权

owner 必须完成新账户/zone、Workers Free、R2 subscription、Zero Trust team、IdP/GitHub OAuth callback、
窄范围 API token，以及 Notion/Resend/Todoist/Gemini/Codex 等实际使用的授权。
这些同意或账号关系不能由源码自己授予；“代码控制”允许把操作收敛成明确一次性清单。

Cloudflare Registrar 的域名换账户需要人工转移请求；DNSSEC、证书和 DNS 记录有独立迁移步骤，
不能靠 Worker 发布完成。先保存全部现有记录，尤其根邮箱相关记录，再安排切换窗口。
[Cloudflare 域名账户迁移](https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/)。
这里是迁移前核查要求，**不授权立即关闭当前 DNSSEC、变更根 MX 或切换 nameserver**。

### C. 首次创建与采用 Cloudflare 资源

创建/发现五个 D1、三个应用 R2 桶、独立 infra-state 桶、owner Access apps/policies，以及特殊 backup/FlowDay
身份。准备专用 daemon Tunnel/DNS/Access service identity 与 Fleet receipt path。
当前应先在**新账户**创建 infra-state 桶，避免旧 helper 的 account 耦合；使用新私有 token 文件。

这一步需专门审查的 bootstrap/采用过程；当前不能直接调正常 `Infra apply` 从旧 profile 创建空账户。
将实际 IDs/AUDs 写入 inventory 和仍需手工的 infra references，生成生产配置，补全 import inventory。
新账户使用新的加密 state，不能把旧 resource state 当成新账户 state。
退出条件：import/no-op、输出与 Wrangler 一致、读取到的对象属于目标账户、没有删除/替换旧对象。

Access service-token secret 只在创建时显示；预创建后 import 不能假定能够取回它。
必须在创建时存入加密 state/密封交接，或独立保存再写入对应私有 stores。
当前 [platform_export.py](../infra/scripts/platform_export.py):39–49 需要这个 secret，缺失则不能形成有效交接。
这是官方行为与代码要求得出的风险判断，未做 live import 实验。
[Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。

### D. 初始化秘密，生成并检查公开配置

按第 6 节清单准备 Worker secret 材料、GitHub production inputs、VPS 私有 JSON 与 dedicated auth。
deploy wrapper 管理的秘密在部署时注入；wrapper 外的手工 Worker secret 要在对应 Worker 已创建后显式初始化，
不能假设 CI 会上传它们。首次创建/初始化顺序必须在bootstrap阶段记录，全部required秘密就绪后才验收功能或开放业务。
只记录名称、用途、持有方、轮换关系和验证结果，不记录值。
生成现有配置，再运行 cloud-config、catalog、drift 检查及完整 branch gate；review diff 不得改变预算、
迁移、binding、pause/maintenance 或安全路由。未配置好账户身份时不得以旧账户 URL 验收。

### E. 发布 Worker，发现 DO，再补全监控

先 Todofy core，后 gateway；Lab/Watch 等 gateway；Mail Hero、Fleet 等可独立部署。
Home 在它的 Ops providers 之后。Website/relay 有独立发布/内容权限。
同账户 service bindings 的目标先部署再部署调用者；目标必须属于本账户。
[Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)。

Home自身首次发布也会产生namespace。先发布providers和初始Home，允许尚未知identity明确显示null；
发现全部六个应用 DO namespace 后回填 inventory、生成 identities，再发布Home完成资源匹配。
用受鉴权的状态/唤醒流程验证新 Alarm，不能把匿名 Access redirect 当成 Alarm 已启动。
退出条件：账户与资源身份一致、正确 SHA、绑定可用、owner UI 和机器路径各自鉴权正确。

### F. 首次 VPS bootstrap

当前支持 **Ubuntu 24.04 Linux amd64、systemd、单节点**。宿主需要现有 Python stdlib、iptables/ip6tables，
应用依赖在镜像。固定 Pod CIDR `10.42.0.0/16`、loopback hostPorts `8765/18765`、业务 UID/GID 10001，
systemd probe 使用宿主已有 UID65534。有冲突、ARM、其他发行版或已有异构集群需先增加并验证支持。

文档的 2 CPU/4 GiB/20 GiB 是准备下限，不是容量实测；Newsletter 配置可允许更高内存，真实材料可能需要更多。
允许出站 HTTPS 下载镜像/二进制并访问 provider；Tunnel 另需出站 **7844 UDP（QUIC）或 TCP（HTTP/2）**，
不能只放行 443。[Cloudflare Tunnel firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)。

从同一 green SHA 的两个 CI-tested image digests 准备 bundle，compiler 版本取 `platform/versions.json`。
保留 Fleet 换 VPS 时，先停止旧 observer，再移交其 durable state 或配置两端新 epoch，随后启动新 observer；
不能让两台机器并行使用同一 host key/epoch，也不能用旧 observer 继续推进后的过早副本。
live Newsletter 先准备 dedicated Codex 登录。
`old_paths: {}` 会创建空目录并 seed 内容配置，不会生成订阅登录，也不等于恢复业务库。

owner 一次 sudo 安装固定版本 k3s/专用 connector、持久目录和窄 RBAC。bootstrap 结束是 `complete_held`：
Newsletter 已关闭接单/领取（初始 gate 通常为 `draining`）、daily CronJob suspended，而 observer 已启用。
这不等于取得 `frozen` 回执；首次 release 仍要实际 drain/freeze 核验。它必须使用同 bootstrap SHA。
GitHub 凭据使用专用 Access machine identity 加独立 daemon Bearer；不上传 host/cluster-admin key。

已有宿主迁移时，installer 会保留旧数据后停用 Docker，再应用 replacement runtime；失败不会自动恢复 Compose。
这是当前迁移授权下的行为。新 VPS 没有需要退休的旧运行时，也不需要先安装 Docker/Compose。

### G. 验证 release，再启用正常发布与业务

完成 bootstrap、机器鉴权和初始 held 状态核对后，冻结 main 的推进，将 `VPS_DEPLOY_ENABLED` 设为 true，
才可受控 dispatch 首次同 SHA Actions release；该变量也控制 explicit resume。失败时可重新关闭发布入口，
但关闭变量不会取消已持久化的服务器操作。

**当前 normal release 会自行恢复 Newsletter admission 并解除 daily suspend，再进入 ready。**
所以 Newsletter 登录、配置与恢复后外部副作用的处理策略必须在首次 normal release 前确认；
不存在 ready 后另一个独立的“激活 Newsletter”按钮。若需要先完成完整 rollout 验收再单独批准激活，
应作为未来接口/状态机能力设计，不能假装当前已具备。

完成后核对 actual digest/source/request/generation、process/admission、PVC、observer fresh receipt，
以及 Fleet/Home 显示，再开放按 main push 正常发布。
使用合成 fixture 验证邮件、重试和故障边界；真实来源转发、模型、Notion 写入、Todoist 或 Newsletter 发送分别验收。
最后才接入精确收件 rule、恢复各 Worker 的 processing/canary；Newsletter daily 已由正常 release 恢复。
对于未知历史副作用，先决定保留待对账且不重放，或完成逐项对账；不能未经决定就以新身份重试旧发送。

## 6. 逐应用的配置、秘密与状态清单

下表是职责与恢复检查表；精确名称/必选条件仍以当前 workflow、deploy wrapper 和 app runbook 为准。
一个应用“/health 有响应”不能覆盖整行验收。

| 应用 | 公共配置/资源 | 私有 bootstrap | 历史状态与验收 |
| --- | --- | --- | --- |
| Mail Hero | D1、MAIL_STORE/BACKUP_STORE、MailCoordinator；receive/owner 通过私有输入 | CREDENTIAL_KEY、backup Bearer/HMAC；已启用时的消费者 Access machine identity、origin和alert webhook token | SQL、R2 bytes/customMetadata、删除清单、冻结 event/payload、DO 重建；合成 intake→Alarm→解析→fake consumer，真实来源另验 |
| Todofy | gateway/core、D1、backup R2、core DO、METRICS Analytics Engine；project/owner 为私有输入 | Gemini/Todoist、CSRF、mail token hash、Newsletter Basic hash及对应 consumer 值；已有轮换时的previous hash | SQL/schema/backup parts、任务去重及未确定副作用；DO预算/cursor与analytics重新积累需明确策略。gateway SHA、core/D1、provider 业务分别验 |
| Lab | D1、LabState、AI binding、Todofy Ops；AI 预算 | owner/CSRF/Access | SQL与DO pending queue/vector/label/seed/neuron/activity/send-watch/guard及预算；恢复或明确重新构建策略。受鉴权首次唤醒、新账户 AI 能力独立核查 |
| Links | D1、path-scoped Access | owner/CSRF | links/revisions/request ledger；合成创建/跳转/删除/恢复，匿名重定向与受保护管理页分别验 |
| Watch | WatchState、Todofy Intents；self-domain policy | owner/CSRF/Access | watch/snapshot/change/outbox 全在 DO；跨账户恢复未统一。合成逐跳策略、首次 Alarm、同冻结 intent 重试 |
| FlowDay | D1、owner Access/PWA policy | CSRF/CREDENTIAL_KEY；Todoist token由 owner 设置 | SQL/原 sealing key；timer、分页、只读 Todoist 同步。不能写 Todoist |
| Home | HomeState、Ops bindings、account/D1/DO identities | owner/CSRF、read-only analytics token、canary 开关 | snapshot/guard/canary/history；空 namespace可重建观察值，但不是恢复全部 owner 设置/历史。逐 binding、usage、drift验收 |
| Fleet | FleetState、owner/receipt Access；host key/epoch | owner、report HMAC 与 observer一致 | 新 namespace从未观察；保留 namespace换 VPS 时恢复 sequence/pending或同步新 epoch。签名、重放、freshness和真实 workload identity验收 |
| Website/relay | hosts/canonical、relay origin、GitHub release registry与Notion反馈；relay无Worker持久存储 | Website/relay Notion授权、data-source、dispatch PAT、button/webhook secret | 从授权源重新构建，保留发布证据；relay当前health仅liveness，发布身份需控制面证据或未来版本探针；按钮 dispatch、网站 build/canonical分别验收 |
| Newsletter | 独立镜像、SQLite/config/auth PVC；repo/Todofy URL/time zone | dedicated Codex登录、Notion/schema、Resend/收件设置、editor/send/monitor；drain复用send身份；可选Todofy Basic | 独占 SQLite、冻结 preview/run/config、auth、mode与immutable delivery target；image/runtime SHA、配置 revision、恢复 gate。模型/Notion/发送分别验收 |
| Platform | 单节点 k3s、namespace/RBAC/PVC、固定 manifests、专用 connector | daemon Bearer、machine Access、connector token、Fleet HMAC | release SQLite及其一致快照、observer sequence/pending；鉴权、允许范围、两次 rollout、重启恢复、实际 observation |

GitHub 所需 inputs 在 [CI/CD production table](ci-cd.md#production-environment)；
额外 Worker secret 在 [rebuild secret inventory](rebuild.md#secret-inventory)。
新空部署可生成新 key；历史 ciphertext 必须保留原 decryption key。
Mail Hero 的 AES-GCM AAD 绑定 endpoint revision 与 URL，FlowDay 的 stored token也依赖原 sealing key；
不能先改历史 URL 或覆盖 key，再期望备份自动可用。

## 7. 备份与恢复需要补的闭环

**重新创建容器、PVC、Worker 或 SQL schema，不会恢复个人云。** PVC `Retain` 只保留本机目录，
不是离机备份。旧 Mail Hero collector 已随 Compose 停用，当前没有新的自动 VPS 备份；
旧备份保留，但不能描述成持续覆盖。见 [HANDOFF](../HANDOFF.md)。

最小恢复包应独立包含：

1. 公开 profile、完整 inventory、源码 SHA/schema、manifest/compiler/image identity、加密 infra state。
2. 原密钥与秘密/授权恢复清单，和真正独立保存的解密材料；不要只备份 ciphertext而丢失key。
3. D1 SQL、R2 bytes + metadata + hash + 最新删除清单，备份版本/一致性证据。
4. Watch 的业务 DO 数据/冻结通知身份；Lab 的 queue/vector/预算/guard；Home 的有价值设置/ledger。
   恢复工具目前欠缺，需逐应用设计恢复或明确可重建/保守预算策略。
5. Newsletter 一致 SQLite、config/frozen identities和auth；Platform一致ledger；observer sequence/pending。
   不能只随手复制运行中的 SQLite 主文件而忽略 WAL 状态。
6. 外部业务对账记录：Mail Hero原 event_id、Todofy去重、Newsletter未知发送/发布；恢复不生成新事件自动重放。

现有 Mail Hero local restore 明确 `activation_allowed=false`，并不替你导入新 Cloudflare 或重建实时 Alarm。
现有 bootstrap只复制支持的 Newsletter data/auth/config，创建 Platform/observer目录；没有统一恢复 daemon ledger
与 observer state 的入口。恢复旧 Newsletter frozen gate还须保留对应release身份，不同SHA不能直接接管。
Newsletter 数据库还绑定 mode 和 immutable `{backend, from, to}`，启动会拒绝 mock→live 或投递目标变更；
恢复验收不能临时改fake/from/to来使用同库，也不能换空库绕过这个历史保护。

daemon恢复尤其不能先挂库启动再看情况：非 `ready/held/failed` 的记录会自动继续checkpoint，
可能执行apply、恢复admission或解除daily suspend；只有held/failed等待显式etag Resume。
应在启动前离线核对原targets、phase/checkpoint、namespace/PVC和Newsletter gate。
当前没有统一read-only restore/quarantine入口，保持停止写入直到核对完成，不能声称所有恢复操作都等人工继续。

推荐以应用为单位补 export/import 和校验，把它们放在所属模块；公共备份工具只负责加密、清单、存储与保留。
使用既有 k3s镜像/CronJob、官方D1/R2 API和SQLite一致备份能力，避免另造全平台业务恢复服务。
迁移备份调度会涉及数据与实际运行，需单独审查后实施；本次报告没有自动启用新 scheduler。
有独立读回与隔离恢复证据后才给RPO/RTO，不承诺当前没有测试过的数字。

## 8. 发布、观测与失败恢复的验收标准

GitHub、daemon、Fleet/Home 要表达同一部署结果，但不能把它们合并成一个模糊绿灯：

| 层 | 成功所需证据 | 不足以证明成功的信号 |
| --- | --- | --- |
| Actions | 同一green SHA的测试artifact；指定release进入ready；actual两镜像身份与fresh status一致 | push成功、HTTP 202、desired SHA、Job仅发出请求 |
| daemon | 持久ledger、相同request/etag；正确Pod世代/实际digest/source；process/admission满足合同 | Kubernetes apply成功或仅Pod Ready |
| Fleet | 有签名、有界、新鲜报告；正确node/epoch/sequence；desired/actual一致及daemon状态来源可信 | 长期缓存、上个release报告、unknown systemd probe |
| Home | 通过Fleet Ops展示同一业务/process状态，stale有明确提示 | 独立猜测VPS、直接读取业务库、未知即成功 |
| 业务 | 已接管、成功、待对账分别记录；历史未知仅保持相应告警 | 镜像上线、process健康替代发送/Todoist成功 |

当 k3s 本身停止调度，CronJob不会继续独立诊断宿主。Fleet应报告stale/missing，而不是猜测k3s故障原因。
若以后需要宿主外监控，先确认需要的具体保证，不能为了一个单节点默认增加第二套agent。

本次 held release说明一个恢复边界：daemon自升级后，执行逻辑改变但原release targets仍冻结。
不能修改旧release payload、清空ledger或自动用新SHA重建操作。正常Resume必须复用原身份和当前etag。
此次恢复由owner完成严格preflight/CAS的phase修复，再以原身份Resume成功；冻结targets未被重写。
随后的正常`7a66336`发布也已完成。这个历史恢复操作不等于日常部署需要sudo。

后续可评估一个版本化、窄范围的维护/recovery API：只允许列明恢复动作、CAS与审计，保留安全gate，
不接收shell/YAML/路径，也不把任意kubectl权限交给GitHub。必须解释旧版本不支持此API时的fallback。
这是设计建议，未在本次增加接口或扩大权限。

## 9. 建议的最小改进顺序

| 阶段 | 改动 | 验收/边界 |
| --- | --- | --- |
| 当前发布收尾 | owner修复、原身份Resume及正常ownership/Fleet修复发布已完成 | 原身份恢复成功；`7a66336`完整release ready、targets verified；fresh Fleet/Home已核验。system-daemon仍unknown，实际daemon状态验收待完成 |
| 1. 补公开身份 | workers.dev/relay origin、Fleet hostname消费者、Watch自有域与Todofy授权、仓库发布身份；沿用现有generator | 同源码在合成新account/team/domain/repo输入生成完整一致配置；旧域负例与历史payload兼容；不改proto身份 |
| 2. 闭合首次创建 | 复用固定版本OpenTofu/provider、Wrangler/官方API，独立create-only与完整adoption inventory；去掉旧helper账户假设 | 空账户plan只有允许create；重复run no-op；部分失败可查/续；creation-time secret不丢；正式apply保护不削弱 |
| 3. 统一准备清单 | required secret presence、rotation关系、bootstrap状态、renderer/compiler版本与host preflight | 输出只给缺失名称和步骤；不开provider调用验证真实业务，不读取/打印秘密 |
| 4. 恢复覆盖 | 补DO业务恢复、VPS一致state/observer恢复与k3s备份调度 | 独立读回、离机解密材料、空资源恢复；unknown副作用保持原身份待对账 |
| 5. 做真实重建演练 | 在明确授权的隔离zone/account/VPS做空启动，再做恢复；最后决定是否切流量 | 完整证据矩阵通过、无业务源码变更、bootstrap后两次main发布不用SSH、无旧账户探测或访问 |

不建议为了“全可配置”开放任意应用插件、任意k8s YAML、任意部署命令或长期root通道。
最优先的收益来自闭合上表几处实际身份与首次创建缺口，而非重写整个monorepo。
默认沿用Workers Free与已选免费功能；没有升级计划或添加收费产品。
空账户演练可能涉及新的VPS、域名/订阅或共享免费额度，实施前需明确范围和成本。

## 10. 本次交付与证据边界

- 完成11个应用声明、11个Worker服务、运行时配置、infra/adoption、CI、VPS/bootstrap和逐服务状态边界审查。
  Worker配置守卫覆盖catalog中的生产文件；测试配置不计为生产服务。
- 公开生成检查：13个文件一致；catalog：11apps/11Workers；drift desired：current；cloud-config 9tests、
  migration-reference 2tests通过，六份相关文档的113个相对文件链接有效。
  Watch运行时源文件的无网络合成URL-policy probe证实新workers.dev的排除缺口。
- ownership永久修复在branch [37115872382](https://github.com/ziyixi/todofy/actions/runs/37115872382)通过gate；
  配置/说明跟进在 [37116764975](https://github.com/ziyixi/todofy/actions/runs/37116764975)通过gate。
  这些branch checks本身不是新账户恢复或生产rollout的证据。
- 当前发布状态单独更新：owner phase修复完成；原`0f84d91`发布以原身份在
  [37142362209](https://github.com/ziyixi/todofy/actions/runs/37142362209)成功恢复；正常`7a66336`发布的
  [37142838447](https://github.com/ziyixi/todofy/actions/runs/37142838447)完整workflow成功。
  typed API为`ready`且`frozen_targets_verified=true`；两workload的actual source为`7a66336`、generation为6，
  request为`9b00f775-b0df-4147-8660-33e50fc126f1`。实际镜像digest见[HANDOFF](../HANDOFF.md)。
  Newsletter为accepting、0 active，32个历史unknown保持原样。
- 18:15 UTC的新Fleet receipt匹配actual/desired source、digest和request，记录`resolved_deployment_pending`。
  两release ConfigMap的phase均为activated，phase只由`personal-cloud-runtime-status`持有；
  `newsletter-daily`及observer均为`suspend=false`。18:19 UTC Home正常刷新后Newsletter从故障变为需关注，
  仅保留对应32个历史结果的`newsletter_unknown`警告，旧unavailable、deployment_pending、paused告警已清。
  Todofy报告正常，Notion写入未接入。system-daemon仍为`unknown`，单独诊断和真实daemon状态验收待完成。
  已完成的生产发布/Fleet/Home验收不证明真实provider/send业务、新账户/VPS重建或历史恢复；
  没有运行新的自动VPS备份，保留的旧备份也不构成当前备份覆盖。
- 后续诊断版本`c2f0d09`的[37144825529](https://github.com/ziyixi/todofy/actions/runs/37144825529)也完整成功，
  typed release为ready且冻结targets核验通过。18:40 UTC自然observer的四个单位均记录`BUS/DBUS_DENIED`，
  main记录`READ_OK`并成功提交；直接有界宿主观察四个单位均active。这证明拒绝发生在连接阶段，
  不应通过扩大Reader、给GitHub SSH/root权限或将unknown改成healthy来掩盖。
  具体拒绝策略仍须确认；后续profile/bootstrap工作保持单独验收，当前未应用主机策略变更。
- 本报告和runbook修正文档导航/已有能力说明；没有实现上表新的provisioner、恢复工具或账户迁移。

验收此报告时，可以直接问：输入是否齐全、每一步谁持有权限、失败能否继续、旧数据能否保留、
哪条观察证明实际运行、哪些保证还未验证。只有这些问题都有证据，才能称为可重建的个人云。
