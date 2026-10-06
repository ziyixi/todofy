# 个人云可重建性：结论与实施计划

这是 2026-10-03 实施前的缺口记录。当前可执行步骤见 [重建手册](rebuild.md)，实现与验收状态见
[验收记录](rebuild-verification.md)。下文的“今天”和“待实施”保留当时审查背景，不能作为当前操作指引。

2026-10-03 源码审查。操作步骤见 [重建手册](rebuild.md)，生产完成/待验状态见 [HANDOFF](../HANDOFF.md)。
本报告没有创建新账户、切 DNS、启动新 VPS 或做完整历史恢复演练。

## 结论：沿用现有架构，补齐首次配置流程

**目标可以做到：完成下面的 P0 后，换账户/机器主要输入公开配置、实际资源 ID 和秘密，不手改业务源码。今天还没有达到。**
VPS 日常发布已经是 GitHub Actions 主动调用受限 daemon API；daemon/Newsletter 使用独立镜像，
Fleet/Home 读取真实运行证据。无需再加 GitOps controller、SSH key、self-hosted runner 或配置服务。

| 想做的事 | 今天的状态 | 下一步 |
| --- | --- | --- |
| 同账户换 VPS | 有固定版本 bootstrap 和 API release | 转移状态/登录，核对 host prerequisites、observer identity 和实际 rollout |
| 新账户启动空业务 | profile/generator、infra 和发布工具已存在；流程未闭合 | 先完成 P0，不把正常 Infra apply 当空账户 creator |
| 新账户恢复全部历史 | 部分应用有恢复工具，覆盖不完整 | 做 P1，并完成一次隔离恢复后再承诺 RPO/RTO |

“同一个域名”不能消除账户耦合：新 account 的 workers.dev、Access AUD、D1/DO ID 都会变化。
“容器/Worker 都能启动”也不等于历史状态和外部副作用已恢复。

## 输入应收敛成三类

| 类别 | 现有入口 | 重建时的工作 |
| --- | --- | --- |
| 我想部署在哪里 | `config/cloud.toml` | 填 zone/repository/team/hostnames、VPS alias/namespace/state root |
| 平台实际创建了什么 | `config/resources.toml` + encrypted infra state | 记录 provider 返回的真实 ID；自动生成 sole production Wrangler/Home/infra 身份 |
| 谁能登录、调用、解密 | GitHub secrets、Worker secrets、VPS 私有 JSON、独立恢复材料 | 按名称安全初始化/恢复；只报告 presence/结果，不输出值 |

保留 `app.toml`、Wrangler、OpenTofu、Kustomize、proto 各自的职责。
生成文件可以随配置改变，业务逻辑和稳定 proto/resource identity 不随部署域名改名。
首次 zone/R2/Zero Trust/外部登录同意允许人工完成；日常 main 发布不再要求登录 VPS。

## 今天具体卡在哪里

| 缺口 | 影响 | 已核对的代码入口 |
| --- | --- | --- |
| Relay 验收 URL 与 Watch 自有域写死旧 workers.dev；relay health 只有 ok | 新账户可能验到旧服务，或把自己的 Worker 当外部网址 | [ci.yml](../.github/workflows/ci.yml)、[buttons.ts](../website/relay/src/buttons.ts)、[url-policy.ts](../watch/worker/src/url-policy.ts) |
| generator 尚未覆盖 Fleet route/PUBLIC_HOST、所有 route/canonical/业务 host 授权 | 改 profile 后仍有配置漏改；换域名时 Watch→Todofy 被拒绝 | [generate.py](../tools/cloud-config/generate.py)、[Fleet config](../fleet/wrangler.toml)、[task-intent contract](../contracts/task-intent-v1/task-intent-v1.ts)、[intents.py](../todofy/worker/todofy/core/intents.py) |
| state bootstrap 只 import；正式 apply 要求既知 AUD/D1 与 Wrangler 一致 | 空账户的 ID 尚未创建，正常流程不能凭空闭合 | [bootstrap_state.py](../infra/scripts/bootstrap_state.py)、[infra_state.py](../infra/scripts/infra_state.py) |
| 缺 state 桶时用旧 account helper；adoption references/FROZEN ID 分散 | 可能指向旧账户；新账户仍要手改多处 refs | [cloudflare-admin.py](../mail-hero/deploy/cloudflare-admin.py)、[ids.tf](../infra/ids.tf)、[access.tf](../infra/access.tf) |
| 普通 deploy wrapper 不负责全部 runtime secrets；Access client secret 创建后不能假设找回 | 新账户 deploy 绿了，运行功能仍缺秘密；import 后可能无法交接 | [CI/CD inputs](ci-cd.md#production-environment)、[secret inventory](rebuild.md#secret-inventory)、[platform_export.py](../infra/scripts/platform_export.py) |
| 监督集合仍要求旧全局 cloudflared；宿主 AppArmor 需要一次管理员加载 | 干净 VPS 没有旧 SSH Tunnel 会误告警；镜像发布不能改宿主 policy | [observer manifest](../platform/k3s/newsletter/observer.yaml)、[Fleet report contract](../proto/fleet/telemetry/v1/host_report.proto)、[AppArmor installer](../tools/vps-bootstrap/observer_policy.py) |
| 第一轮 release 自动恢复 Newsletter admission/daily；旧非终态 ledger 启动会继续 checkpoint | 不能把首次 rollout 当成“部署好后保持暂停”；恢复启动可能触发旧操作 | [controller.py](../platform/src/personal_cloud/deployment/controller.py)、[store.py](../platform/src/personal_cloud/deployment/store.py) |

这些是明确的代码/流程缺口。用手动创建、补 refs、初始化 secrets 可以推进，但不符合“只改最少配置”的最终目标。
当前已有命令及每阶段放行证据在重建手册；下面列的是**待实施计划，不是现有 CLI**。

## P0：先让空环境可以完整启动

按顺序做四个可独立 review 的改动。每项保留现有生产门禁和免费计划，不添加新的运行服务。

| 任务 | 具体改什么 | 交付物 | 验收 |
| --- | --- | --- | --- |
| P0.1 补齐部署身份 | 扩展现有 public profile/generator：workers.dev suffix、relay origin、Fleet route/PUBLIC_HOST及明确的当前/历史业务 host allowlist；CI 验证当前发布版本，不只 ok | 所有消费者来自同一校验过的输入；旧冻结 payload 有兼容策略 | 用不同 account/team/zone/repo 的合成 profile生成；无旧账户探测、自有域负例仍拒绝、历史身份不重写 |
| P0.2 闭合 create→adopt | 在现有 infra 工具新增独立 create-only 首次阶段，显式 account；先建 state 桶，再建/发现允许对象；收集 inventory 后采用并进入正常 apply | 公共 inventory、逐对象进度、encrypted state、creation-time secrets 的密封交接 | 只允许清单内 create/adopt；陌生同名对象拒绝；重复 no-op；部分失败可查/续；正常 FROZEN/prevent_destroy/output gate 不削弱 |
| P0.3 补齐秘密初始化 | 给现有 deploy wrapper/准备工具明确 required/optional names、消费者一致性与轮换关系；首次安全发布一次注入其负责的 runtime secrets，presence 检查只显示名称 | 单一私有输入清单；目标账户/Worker对应检查；缺秘密时给出最小下一步 | 新 Worker不会借“旧secret保留”假设通过；无秘密进 artifact/log；旧key恢复与新空key分开 |
| P0.4 收敛首次 VPS/监控 | 在 public profile 中定义有界 expected daemon aliases，proto/producer/Fleet同改并兼容旧scope；bundle preflight检查网络/平台/AppArmor；把第一轮副作用门槛显式化 | 新机器不要求无用的旧 SSH Tunnel；固定 bundle+私有JSON+一次sudo；明确 activation 规则 | 本机及无旧Tunnel的合成拓扑都正确；unsafe/unknown不变绿；同SHA首发和后续两次push均有实际ready证据 |

P0.2 的首建工具负责配置与 provider 资源，不接管应用运行时，不接收任意 YAML、shell 或长期 root 权限。
P0.3 沿用 Wrangler/Cloudflare API/GitHub secret storage，不另造秘密服务。
P0.4 不把 systemd probe 改成宿主业务 daemon；它仍是无凭据 init container与独立主观察器。
宿主 policy 加载是允许的一次性 bootstrap，日常发布只能选择已支持的安全配置。

首次发布的 activation 有两个可行阶段，但需要明确选择：保留现有自动恢复并要求 provider/对账先齐，
或在当前 release 状态机增加“已验证但暂停”及 CAS 激活动作。
推荐后者用于历史恢复；必须保留原 targets/request身份，不能靠普通重试偷偷激活。

**P0 终点：**一个合成全新配置能完成全部离线检查；一次明确授权的空账户/空 VPS 演练中，
配置/秘密以外无业务源码修改，完成首次安装和连续两次 main 发布，GitHub/Fleet/Home 都确认实际部署。
演练不默认切现有流量；新 VPS/R2 激活或免费共享额度的成本先确定。

## P1：让“重建”同时能恢复数据

### Mail Hero 的每日备份已恢复

旧 Compose collector 已停，Mail Hero 复用 Cloudflare DO Alarm，把 D1、DO业务状态与原R2文件复制到私有备份桶。
用户选择普通副本，无新增加密或恢复公钥流程。`5837c0c` 的 main CI及真实快照已完成；Home过旧故障清除。
该快照为1,031个文件、37,723,651字节，成功时间2026-10-03 23:06 UTC；详细证据看HANDOFF。
本地普通备份恢复测试11项通过，Worker204/UI81项通过；Linux完整CI另覆盖旧GPG兼容。
这证明当前规模的复制/记录/轮转执行，不能替代5GiB满量、空Cloudflare资源恢复或整云RPO/RTO验收。

同账户 R2 备份能应对应用损坏/误删，不单独承担整个账户丢失。
另做 owner 私有离机导出或独立存储副本；不因为迁移原生调度就丢掉这层恢复保证。

### 然后按状态所有者补齐

| 状态 | 最小工作 | 恢复门 |
| --- | --- | --- |
| Watch/Home DO | 各应用有界 export/import，记录 schema、队列/intent身份、设置和预算；明确哪些历史可重建 | 空 namespace 不宣称已恢复；预算保守、旧副作用身份不变 |
| Newsletter | 一致 SQLite、config/frozen identity、原 mode/delivery target与独立 auth 恢复包 | 原 unknown 保留；不通过换空库/mock/目标绕过保护 |
| Platform | 一致 release ledger 与公开 bundle/image身份；启动前离线检查或版本化 quarantine/恢复门 | 非终态不能未经核对继续 apply/resume；held/failed只CAS继续原操作 |
| Observer | stop-old→最新sequence/pending移交，或协调两端新epoch | 无双写、无重复刷新新鲜度、无过早快照 |
| D1/R2/应用密钥 | 校验SQL/schema/object manifest/hash/deletion journal；原解密材料独立保存 | 内容、调度、消费者持久接管、外部业务分别验 |
| Website | 从授权 Notion 来源重建并保留发布身份/registry证据 | 内容发布、版本回退分别验；代码上线不等于内容恢复 |

应用拥有 export/import 和对账语义；共享工具只做加密、清单、校验、存储和保留。
VPS 状态备份如何触发/送出另按实际需求设计，不借 Mail Hero 备份引入 k3s collector。
复制活跃 SQLite 主文件、PVC Retain、infra state 备份都不能代替上述恢复包。

## 每次演练交付什么，才算完成

| 阶段 | 保存的无敏感证据 | 不能拿来替代的证据 |
| --- | --- | --- |
| 配置/资源 | 检查结果、目标账户一致性、清单与no-op计划 | generator测试不证明实际对象存在 |
| Secret/bootstrap | required presence、固定bundle身份、held状态、connector注册与边界检查 | `complete_held`不代表ready/provider登录成功 |
| 发布 | 同一green SHA的两镜像digest；ready；actual source/request/generation与targets一致 | HTTP接管、desired SHA、仅PodReady不够 |
| 观测 | 自然fresh签名receipt、真实systemd状态/READ_OK、Home相同状态 | init exit0、SYSTEMD_COMPLETE、旧缓存不够 |
| 恢复/业务 | 完整读回、独立解密、空资源恢复、原身份对账；授权真实业务分别记录 | CI、本机fixture、正常进程不证明外部副作用成功 |

k3s 不能调度时 observer也会停，Fleet正确显示 stale/missing；它不冒充宿主独立带外监控。
32 条已知 Newsletter 历史 unknown 保持待对账，过程健康与业务结果分开；重建不自动处理它们。
已有 same-ID恢复、正常两镜像发布与 Fleet/Home 修正的生产证据在 HANDOFF，**不是新账户重建证据**。
目前不能给完整个人云恢复的 RPO/RTO；完成 P1 和隔离演练后再记录实际结果。

## 执行顺序

1. k3s/AppArmor/Fleet/Home 和当前规模的普通私有 R2 备份已完成验收，证据见 HANDOFF。
2. 实施 P0.1→P0.2→P0.3→P0.4；每项一个可审查改动，分支CI后同green SHA发布。
3. 做空账户/空VPS演练；把人工步骤与耗时记录到重建手册，不切现有流量。
4. 补齐 P1 后做历史恢复演练，再决定切换窗口和可承诺的恢复目标。

这份报告授权范围内只更新设计/手册；P0/P1 新功能尚未在本文实现。
