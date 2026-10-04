# Cloudflare 初始化

从 [重建手册](../../docs/rebuild.md) 开始。这里说明私有文件和命令；全新环境从空数据库部署，不导入旧邮件、任务或网站内容历史。

需要 Python 3.11+、OpenTofu 1.12.6、已登录的 `gh`，以及仓库固定的 Cloudflare provider 5.25.0。所有命令在仓库根目录执行。脚本复用 `infra/*.tf`，不会另外维护一套资源创建实现。

## 私有文件

将 [example.private.json](example.private.json) 复制到仓库外，设为 `chmod 600`，替换尖括号占位符。`config/cloud.toml` 管公开域名/仓库/节点，`config/resources.toml` 管公开账户、zone 和已验证资源 ID。新账户先填真实 account/zone ID，并清空资源 ID 表；不要沿用旧账户的 ID。

API token 通过 `cloudflare_api_token_file` 读取现有正规凭据文件：该文件只含 token、位于仓库外、权限为 600。也支持把 `cloudflare_api_token` 直接放入同样受保护的私有 JSON；两个字段不能同时存在。密钥不进入命令参数、stdout、Git 或 PR。

### Cloudflare token 权限

在正规 token 页面创建自定义 token。账户权限只选目标账户，zone 权限只选目标域；网页中的 Edit 与 Write 是同类写权限名称。

| 范围 | 权限 | 用途 |
| --- | --- | --- |
| Account | Account Settings Read | Wrangler 识别目标账户 |
| Account | Workers Scripts Read / Write | 创建、部署并核对 Worker、DO 和 bindings |
| Account | D1 Read / Write | 创建数据库、执行 migration、核对 ID |
| Account | Workers R2 Storage Read / Write | 创建桶、读取身份、访问加密 IaC state |
| Account | Access: Apps and Policies Read / Write | 应用与精确 policy |
| Account | Access: Identity Providers Read / Write | GitHub 和一次性邮箱验证码 IdP |
| Account | Access: Service Tokens Read / Write | 专用机器身份 |
| Account | Cloudflare One Connector: cloudflared Read / Write | 专用 Tunnel 与 ingress |
| Zone | Zone Read | 核对域名与所属账户 |
| Zone | Workers Routes Read / Write | Worker 自定义域名与 routes |
| Zone | DNS Read / Write | 专用 runtime DNS |
| Zone | Email Routing Rules Read / Write | 精确收信地址规则 |

名称依据 [Cloudflare 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。
bootstrap 不启用 R2 计费或改收信子域 DNS；这些是主手册中的首次网页步骤。
复用已有 token 时保留原权限、有效期和 IP 限制，只补缺项。无需 token 管理权限或 Global API key。

| 字段 | 全新环境 | 已有环境收编 |
| --- | --- | --- |
| `version` | `1` | `1` |
| `infra_values.account_id` | 与公开资源文件一致 | 保留现有值 |
| 两组 `access_*_owner_emails` | 已核实登录邮箱 | 保留已有策略值 |
| `infra_values.access_github_oauth` | 一次性创建的 GitHub OAuth app client ID/secret | 可省略；从明确选中的旧 IdP 读取 ID/name，原 secret 不覆盖 |
| `infra_values.access_allowed_idp_ids` / `access_github_idp_id` | 可省略，使用新 IdP | 原 `local.tfvars` 的值；用于准确定位旧 IdP |
| `infra_values.mail_receive_address` | 一个 `local-part@inbox.<zone>` | 指定旧邮件 rule ID 后只读取得 |
| `infra_state_passphrase` | `prepare` 生成一次并保存 | **必须使用原值**，不重新生成 |
| `worker_secrets` | 示例里的外部 token 必填；自动生成其余应用 key | 可省略未掌握的既有 map，既有 Worker secrets 保留 |
| `github_secrets` | 可选，提供已有标量 key 来复用 | 只填自己已有明文的 key；不要求导出无法读取的生产 secret |
| `vps` | 示例启动一个明确的空 mock Newsletter | 可以完整复制已有 VPS 私有 JSON；原环境、共享 key 和路径保留 |
| `adopt_ids` | 不需要 | 固定 HCL address → 已有公开 ID；允许地址见 `inventory.py` |

`prepare` 自动生成应用加密/CSRF/HMAC/共享认证 key，并把同一值用于相关消费者。Mail Hero webhook token、Newsletter 向 Todofy 报告的账号密码保存在私有 `integration_credentials`，对应 SHA256 写入 Todofy 配置。需要在各应用的首次接入设置中使用这些值时，只从本机私有文件读取。

网站内容读取凭据 `WEBSITE_NOTION_TOKEN` / `WEBSITE_NOTION_DATA_SOURCE_ID` 放在私有输入的 `github_secrets`，只交给 Actions。Relay 仅持有该仓库的 GitHub token，需 Actions Read/Write 和 Deployments Read；bootstrap 不代替正规授权。

示例 Newsletter 使用 `mock`、禁真实发送。真实内容生成必须在它的专用 PVC 完成 Codex ChatGPT 登录；不是填写 API key。真实发送还需 Resend API key 和收发地址；Notion 集成可按需启用。相关步骤见主手册，mock 健康不代表真实内容生成或发信验收。

## 全新账户

先在 Cloudflare 完成账户/R2 开通、zone 接入、Zero Trust 团队创建，以及**仅 `inbox.<zone>`** 的 Email Routing DNS 开启。GitHub OAuth app callback 使用该团队的 Access callback URL。保留根域已有 MX/SPF/DKIM。

```sh
python3 tools/cloud-bootstrap/bootstrap.py prepare --mode fresh \
  --private-file ~/.config/personal-cloud/input.json \
  --output ~/.config/personal-cloud/prepared.json

python3 tools/cloud-bootstrap/bootstrap.py cloud --mode fresh \
  --private-file ~/.config/personal-cloud/prepared.json

python3 tools/cloud-bootstrap/bootstrap.py secrets --mode fresh \
  --private-file ~/.config/personal-cloud/prepared.json \
  --output ~/.config/personal-cloud/vps.json
```

`prepare` 返回 `missing` 列表时，把列出的 `<Worker>.<binding>` 填进私有 `worker_secrets`。生成出的 prepared 文件已保留随机 key，补齐后使用它运行 `check`；不要覆盖或重新生成已使用的 key。

`cloud` 先验证 token 所属账户、zone 和 workers.dev 子域，再创建私有 state 桶并运行同一 HCL。已有对象的任何 update/delete 都会拒绝。成功后导出公开 AUD/D1/owned ID 并正常生成配置；部署 token 和 connector token 只写回私有文件。失败可以从同一 prepared 文件继续，不创建另一套资源。

`secrets` 通过 `gh` 的 stdin 写 GitHub `production` secrets，输出 VPS bootstrap 使用的私有 JSON。仅创建缺失的 operation variables：Mail Hero 投递暂停、Todofy 处理暂停及 Todoist 写入暂停；VPS 自动发布、自动修复、网站定时更新初始关闭。已有暂停/维护值不覆盖。缺失 `production` 限定 main；缺失 `infra-review` 在个人仓库要求 owner 显式审核。已有环境保护不修改，组织仓库需自行选择审核人。

随后按主手册提交公开配置，让同一通过分支检查的 SHA 进入 main，Actions 构建镜像和固定 bundle。
将新镜像设为公开，再下载该 bundle 执行一次 VPS bootstrap，最后启动首次 VPS 发布。
首次发布后，DO namespace ID 和准确邮件 rule 才能完成；无需临时业务 Worker：

```sh
python3 tools/cloud-bootstrap/bootstrap.py finalize --mode fresh \
  --private-file ~/.config/personal-cloud/prepared.json --create-pr
```

该命令要求当前 HEAD 对应全部应用的最近成功发布，并核对 live Worker deployment/bindings。它捕获首次 DO ID、添加精确邮件 rule、更新 `INFRA_TFVARS`，创建仅公开 inventory/生成文件的 PR，并显式触发全量 CI。审核通过后合并一次，常规 main CI 补齐 Home。已有 DO ID 与 live 不同会停止，不自动改基线。

正式打开处理/发送、VPS 发布和自动修复前，完成主手册的验收。GitHub 上已有 operation variables 的作用域保持原样，修改时使用对应 repo/environment 范围。

## 已有账户收编

只读检查最小输入：

```json
{
  "version": 1,
  "cloudflare_api_token_file": "/absolute/private/token-file",
  "infra_state_passphrase": "<existing passphrase>",
  "infra_values": {
    "account_id": "<existing account id>",
    "access_owner_emails": ["<existing owner policy email>"],
    "access_github_owner_emails": ["<existing GitHub owner policy email>"],
    "access_allowed_idp_ids": ["<existing GitHub IdP id>", "<existing email PIN IdP id>"],
    "access_github_idp_id": "<existing GitHub IdP id>"
  },
  "adopt_ids": {
    "cloudflare_email_routing_rule.mail_hero[0]": "<exact existing receive-address rule id>"
  }
}
```

```sh
python3 tools/cloud-bootstrap/bootstrap.py plan --mode adopt \
  --private-file ~/.config/personal-cloud/adopt.json
```

`plan` 只读取明确的 zone、选中 IdP、FlowDay policy、邮件 rule 和 state，运行 Tofu plan。它不创建桶、注册 workers.dev、修改 Cloudflare/state、写私有文件或 GitHub secrets。允许 import/no-op；已有资源任何变更都会拒绝，先解决差异再收编。

FlowDay 的 `include` 有已确认的 provider 导入缺陷，因此由精确的实际 API 规则校验补足；出现 `FLOWDAY_INCLUDE_MISMATCH` 时，在 Access policy 页面恢复声明的规则后重跑 `plan`。这项兼容仅覆盖两个 FlowDay policy，首次创建仍直接使用 HCL。

实际收编使用同一个输入运行 `cloud --mode adopt`。它先按标准 `tofu import` 收编 state 中缺失的固定地址，已有 state 先备份；这一步只读取 Cloudflare、写加密 state，使 IdP 引用确定下来。随后完整计划必须 no-op，才结束初始化。失败可从同一文件续跑，已导入项跳过。OAuth secret、历史数据库、对象和应用 key 保留。收编并不要求运行 `secrets`；现有 GitHub/Worker secrets 仍有效。需要重新生成 VPS 私有文件时补入已有共享 key，不能替换为新随机 key。

## 日常漂移

`Personal cloud reconcile` 自动修复仅限专用 runtime CNAME 指回同一个 Tunnel、已认证 loopback ingress。认证策略、IdP、邮件 rule、资源 ID、create/delete 和未知 provider shape 都进入人工审核。

检查输出 `state`、`expect`、`plan_key`。敏感变更经 `infra-review` 审核后，只应用该 SHA 的原始加密计划； apply 前再次比较实际变化的 HMAC。正常邮件写入造成的无变更 D1 大小差异不影响审核。根域邮件 DNS、其他 tunnel、其他账号资源不进入修复范围。

出现权限错误时，在正规 Cloudflare/GitHub 登录页补足对应权限后重新运行原命令，不要把 token 发到聊天，也不要继续尝试绕过。输出只含固定错误码、缺失名称、状态和公开 PR URL；它不证明新账户的真实邮件、Codex 登录或端到端业务已验收。
