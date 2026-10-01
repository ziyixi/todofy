# GitHub Actions 原生部署

Mail Hero 位于单仓库的 `mail-hero/` 目录，与 `todofy/` 共用根目录的 `.github/workflows/ci.yml`（"CI and deploy"，说明见根 [README](../../README.md)）。任何分支的 push 若相对累计基准改动了 `mail-hero/`、`packages/edge-auth/`（编译进本Worker的共享鉴权包）、`contracts/` 或 `.github/`，`Mail Hero checks` job 就在 `mail-hero/` 下安装 lockfile 中的依赖、检查 TypeScript、执行 Worker 和 React 测试、构建 UI，并以部署同样的方式（占位的个人值与开关）对提交的 `mail-hero/wrangler.toml` 做 Wrangler dry-run；`packages/edge-auth/` 改动时 `Shared packages` job 还会在包自己的目录运行它的 typecheck 与 vitest；`Contracts` job 检查 `contracts/mail-received-v1` 的 golden payload（含金丝雀 `canary_event.json`）仍由当前 `buildPayload`（`proto/mailhero/webhook/v1` 的生成消息与 wire 编解码器）逐字节生成、生成的 Schema 与冻结的手写 Schema 在 ECMAScript 方言下只在 IDL 写明的字符上不同、所有 fixture 的 event ID 互不重复，并由 Todofy 解析；同一 job 核对 `contracts/ops-v1` 的 JSON Schema 仍由 IDL `proto/ops/v1/ops.proto` 生成，并在主机上运行 `test/ops-golden.test.mjs`（Mail Hero `Ops` 的每个回答与迁移到 proto 前逐字节相同，且通过旧版面板使用的手写 Schema）和 `test/native-ops.test.mjs`（回答经 wire 编解码严格读回；Todofy 侧用 `jsonschema` 与 Python 编解码做同样的检查）。Mail Hero 以 `@ziyixi/proto` 的生成代码构建 ops-v1 回答，`proto/` 中它打包的路径（TypeScript 运行时、`common/wire/`、`ops/`、模块与工具链文件）改动也会检查并发布它；单独、串行运行的 `npm run test:cpu`（`test/cpu/native-ops-cpu.test.mjs`，不与 `npm test` 的其他 workerd 测试并行，以免抢占校准不计入的 CPU）把 `Ops` 调用的 CPU 限制在基准范围内（整个测量依次在三个新隔离区中各跑一遍，每个隔离区的数值除以它自己校准出的速度，界限约束三者的中位数：隔离区首个 `status()` 低于 9 ms，见 `tools/workerd-cpu/README.md`），`test/cpu/payload-cpu.test.mjs` 同样限制构建一个 `mail.received.v1` 事件的 CPU（新隔离区首次与预热后），dry-run 后的打包由 `deploy/bundle-size.mjs` 限制在预算内。经 service binding 调用真实 `Ops` 的 workerd 测试 `native-ops-runtime.test.mjs` 属于 Worker 测试。Worker 测试包含真正的 workerd D1/R2/SQLite Durable Object 绑定与合成大附件。Node 使用 26，Actions 固定到已核实的提交 SHA。

累计基准不是上一个提交：`main` 上是该 workflow 最近一次成功的 `main` push run 的提交，因此失败或排队时被取消的 run 中的改动会由下一次 run 重新检查并发布；其他分支上是与 `origin/main` 的 merge base，分支 head 的 `CI gate` 覆盖整个分支。找不到可用基准（首次运行、API 错误、基准不是祖先）时全部运行。

只有 `main` 上相对该基准改动了 `mail-hero/`、`packages/edge-auth/`、四个 TypeScript Worker 都打包的 `contracts/ops-v1/ops-v1.ts` 或 Mail Hero 打包的 `proto/` 路径的 push，或在 `main` 上手工运行并选择 `both`/`mail-hero`，且 `Mail Hero checks` 与 `CI gate` 成功，`Mail Hero deploy` 才进入 GitHub `production` environment。只改 `contracts/` 的其他文件或 `.github/` 会重新检查但不发布；`ops-v1.ts` 的常量（`OPS_LIMITS`）打包进 Worker，改它会同时发布四个应用。部署从同一提交重新构建 UI，用提交的 `mail-hero/wrangler.toml` 加部署时注入的值先做 Wrangler dry-run，再依次应用 D1 migrations、发布 Worker。并发部署排队，不中断正在应用的 migration。非 `main` 分支不接触生产密钥。

这条流水线发布 Cloudflare Worker 和静态资源，使用现有D1、R2和SQLite DO资源。来源邮箱转发、Access策略及根域MX由各自设置管理；流水线不会创建新的Cloudflare收费计划。Todofy 在同一仓库的 `todofy/` 中，由独立的 `Todofy checks`/`Todofy deploy` job 发布；两者只共享 `contracts/` 与 `packages/`（目前是 `packages/edge-auth`，由各自Worker编译进去），互不导入代码；共享包改动会同时检查并发布两者，其余发布互不依赖。

独立的根目录 `.github/workflows/mail-hero-backup-image.yml`（仅在 `mail-hero/deploy/backup/**`、`mail-hero/cloudflare/migrations/**` 或该文件变更时运行）发布新的 package `ghcr.io/ziyixi/mail-hero-backup-collector`。旧 package `ghcr.io/ziyixi/mail-hero-backup` 仍关联到原 `ziyixi/mail-hero` 仓库，不再更新；服务器继续使用 Compose 中已固定的旧 digest，直到下一次升级收集器时改为新 package 的 digest。它先运行合成备份/恢复及调度测试，再构建 `linux/amd64` 镜像；非 `main` 分支只构建，main发布使用当前工作流的 `GITHUB_TOKEN`，只有发布job获得 `packages: write`。镜像带源码revision标签、`sha-<完整提交>`标签及不可变digest。无需新增长期GitHub token，也不向构建过程提供邮件、备份凭据或Cloudflare管理密钥。新 package 首次发布后核对其为 public，服务器才可匿名拉取。

服务器的 `self-host-on-vultr` Compose配置固定备份镜像digest，更新时只执行 `docker compose pull mailhero-backup` 和 `docker compose up -d --no-deps mailhero-backup`。容器自己负责每日调度和失败后的有界重试，使用原来的私有备份配置及状态目录，不安装systemd或主机cron。操作与恢复见[备份说明](../deploy/backup/README.md)。

## 仓库设置

在 GitHub 仓库 Settings → Environments 创建 `production`，将可部署分支限制为 `main`。个人使用可以直接自动部署；若希望每次人工确认，可添加 required reviewer。给 `main` 开启分支保护时，将 `CI gate` 设为 required check（它汇总共享包、两个应用及合同检查，未改动而跳过的 job 视为通过）。

生产配置提交在 [`mail-hero/wrangler.toml`](../wrangler.toml)，顶层即生产（不用 `[env.*]`，不设 `keep_vars`）：account ID、D1（名称与 ID）、R2 桶 `MAIL_STORE` 与备份桶 `BACKUP_STORE`、自定义域名与 `PUBLIC_HOST`、Access issuer/AUD、`WEBHOOK_ALLOWED_HOSTS`、每日接收上限、兼容日期、Durable Object 绑定与迁移。改这些值就是改这个文件（公开提交，走同样的检查与发布）；CI 不再读取同名的旧 GitHub variables（`MAIL_HERO_D1_DATABASE_ID` 等仍保留在 production 环境，只作为回滚本次配置布局变更时旧生成器的输入，改它们没有效果；保留与删除时机见根目录 README“Rolling back the committed-config layout”）。值必须与现有资源一致，不要新建重复资源。换 D1 或桶（例如恢复到新资源）同样是在维护模式下提交这个文件。可选的 metadata 告警按 ops-v1 计划不配置；若将来启用，只把不含凭据的 `ALERT_WEBHOOK_URL` 与 `ALERT_WEBHOOK_ALLOWED_HOSTS` 提交进该文件，`ALERT_WEBHOOK_TOKEN` 仍是 Worker secret。

部署时由 [`deploy/deploy-vars.mjs`](../deploy/deploy-vars.mjs) 校验后加入的值有两类：三个个人值（GitHub secrets `MAIL_HERO_RECEIVE_ADDRESS`、`MAIL_HERO_ACCESS_OWNER`、`MAIL_HERO_ACCESS_OWNER_ALIASES`）由 `secrets` 写进只属于本次运行的临时文件（0600，发布后删除），经同一次 `wrangler deploy --secrets-file` 成为 Worker secret（Cloudflare 控制台与 API 都不显示值）；两个运维开关（GitHub variables）和 `BUILD_SHA`（提交 SHA）以 `--var NAME:value` 加入（与 `[vars]` 相同的 plain_text var，Wrangler 输出里显示为 `(hidden)`）。缺少或非法时拒绝发布（未发送的 var 会被删除）；`exec` 也拒绝没有恰好一个含这三个值的 `--secrets-file` 的发布。三个个人值在 2026-10 之前是 plain_text var：第一次发布在同一次上传里把每个 var 换成同名 secret，不存在缺值的中间状态；不要改用 `wrangler secret put` 手工迁移。

在 `production` environment 添加 variables（只有运维开关）：

| Variable | 用途 |
| --- | --- |
| `MAIL_HERO_FORCE_SEND_PAUSED` | 明确设为 `true` 或 `false`，与当前运维状态一致；注入为 `FORCE_SEND_PAUSED` |
| `MAIL_HERO_MAINTENANCE_MODE` | 明确设为 `true` 或 `false`，正常运行是 `false`；注入为 `MAINTENANCE_MODE` |

在 `production` environment 添加 secrets：

| Secret | 用途 |
| --- | --- |
| `MAIL_HERO_CF_API_TOKEN` | 独立 Cloudflare 部署 token（原仓库中名为 `CF_API_TOKEN`；单仓库的 `production` 中 `CF_API_TOKEN` 属于 Todofy），限定目标账户的 Worker 发布、D1 migration 及现有 zone 的 Worker route 所需权限；不需要 Billing 权限 |
| `MAIL_HERO_RECEIVE_ADDRESS` | 固定收件地址，作为 Worker secret `RECEIVE_ADDRESS` 发布。仓库公开，这个地址（以及下面的 owner 邮箱）只存为 secret，Actions 日志里显示为 `***` |
| `MAIL_HERO_ACCESS_OWNER` | canonical owner 邮箱，作为 Worker secret `ACCESS_OWNER` 发布 |
| `MAIL_HERO_ACCESS_OWNER_ALIASES` | 已核实的同一 owner 登录邮箱，作为 Worker secret `ACCESS_OWNER_ALIASES` 发布；沿用当前 GitHub 登录 alias，逗号分隔。若尚未使用 alias，可留空（上传为一个空格，应用读作没有 alias；不会留下旧列表） |

不要把 token 或 alias 直接写进 workflow、命令参数或提交的配置。现有临时 bootstrap token 到期后，Actions 需要换成有效的专用 token；更新 GitHub secret 即可，不影响本机 Wrangler 登录。

`CREDENTIAL_KEY`、可选的 Access service client secrets 等其他 Worker secret 继续保存在现有 Worker 中（`wrangler secret put <NAME> --config ../wrangler.toml`，在 `cloudflare/` 运行）。部署保留 Worker secret bindings；流水线不读取、复制、轮换或重新上传主密钥。D1 内保存的 webhook 凭据也不由流水线重写。

## 日常发布和失败恢复

1. 在分支上提交并 push，`CI gate` 通过后 fast-forward 到 `main`。
2. Actions 的 `Mail Hero deploy` 成功后，记录提交 SHA 和 Wrangler 输出的 Worker version ID。
3. 查看 Mail Hero 登录、收件与新测试事件的交付状态。部署成功仅证明发布步骤成功，不等于真实邮箱到 Todofy/Todoist 的业务链路通过。

不再生成配置文件：部署的就是提交的 `mail-hero/wrangler.toml`，外加 `deploy/deploy-vars.mjs exec` 追加的三个 `--var` 和 `secrets` 写出的 secrets 文件。包装器只输出字段名，从不打印值；它拒绝 `--env`、`--keep-vars`、自带的 `--var`、其他配置文件以及缺少或内容不对的 `--secrets-file`。不得手动 `wrangler deploy`（会删除这三个 var，暂停解除）；应急手动发布在 `cloudflare/` 先运行 `node ../deploy/deploy-vars.mjs secrets <仓库外的临时文件>`，再运行 `node ../deploy/deploy-vars.mjs exec -- npx --no-install wrangler deploy --config ../wrangler.toml --secrets-file <同一文件>`，环境里给出与 CI 相同的值（`GITHUB_SHA` 为所发布的提交），完成后删除该文件。`deploy/cloudflare-admin.py wrangler` 拒绝 `deploy`。静态值的校验在 `deploy/test/wrangler-config.test.mjs`，跨应用的一致性（唯一配置文件、主机名、ci.yml 注入名）在根目录 `.github/scripts/test_wrangler_configs.py`。

`FORCE_SEND_PAUSED` 与 `MAINTENANCE_MODE` 是部署配置来源的一部分，每次发布都从 GitHub variables 重新声明。紧急暂停后，应同步修改 GitHub variable，否则下一次部署会恢复 variable 的值；最快的途径是改 variable 后手工运行该应用的 workflow（Cloudflare 控制台直接改 var 立即生效，但下一次部署会覆盖，除非 variable 也改了）。数据库中的 archive/forward 模式、目标选择和目标暂停由应用 UI 管理，不随普通部署重置。

回滚“个人值改为 Worker secret”（2026-10）的变更：revert 该提交后，旧包装器又以 `--var` 发送这三个值、不带 `--secrets-file`。Wrangler 的远端 secret 冲突提示只检查提交的 `[vars]`，不会提示；按 Wrangler 的说明同名配置值会替换远端 secret，但这个方向没有在生产验证过。若该发布被 Cloudflare 拒绝，在 `cloudflare/` 用 `wrangler secret delete <NAME> --config ../wrangler.toml` 删除这三个 secret 后立即重跑 workflow（两次发布之间收件地址与 owner 缺失，收件和登录失败）。

Migration 在旧 Worker 仍运行时执行，因此自动发布中的 migration 必须向后兼容，例如添加表或列。破坏性 schema 变更需另行维护窗口与备份计划。若 migration 成功而 Worker 发布失败，修复后重跑同一 workflow；已记录的 migration 不会重复执行。不要自动回滚 D1 或重新生成 webhook 事件。回滚应用代码也不能假定数据库会一起回滚。

本地在 `mail-hero/` 目录运行同样的检查：

```sh
npm ci --prefix cloudflare
npm ci --prefix web
node --test deploy/test/*.test.mjs
npm run typecheck --prefix cloudflare
npm test --prefix cloudflare
npm run test:cpu --prefix cloudflare
npm run typecheck --prefix web
npm test --prefix web
npm run build --prefix web
python3 -m unittest discover -s deploy/backup -p 'test_*.py'
```

mail.received.v1 golden fixture 由 `cloudflare/test/contract-fixtures.mjs` 生成；有意修改 payload 构建器后在 `mail-hero/cloudflare` 运行 `npm run contract:update` 并提交 `contracts/` 的变更，再在 `todofy/` 运行 `uv run pytest tests/unit/test_mail_hero_compat.py` 确认消费者兼容。

本地 workerd 测试需要允许监听 loopback。Actions 使用 GitHub 托管 Ubuntu runner。代码发布不需要给 runner 访问真实邮件或业务数据库的权限。

依据：[Cloudflare GitHub Actions 部署](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
