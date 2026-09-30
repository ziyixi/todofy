# GitHub Actions 原生部署

Mail Hero 位于单仓库的 `mail-hero/` 目录，与 `todofy/` 共用根目录的 `.github/workflows/ci.yml`（"CI and deploy"，说明见根 [README](../../README.md)）。任何分支的 push 若相对累计基准改动了 `mail-hero/`、`packages/edge-auth/`（编译进本Worker的共享鉴权包）、`contracts/` 或 `.github/`，`Mail Hero checks` job 就在 `mail-hero/` 下安装 lockfile 中的依赖、检查 TypeScript、执行 Worker 和 React 测试、构建 UI，并用占位值生成配置做 Wrangler dry-run；`packages/edge-auth/` 改动时 `Shared packages` job 还会在包自己的目录运行它的 typecheck 与 vitest；`Contracts` job 检查 `contracts/mail-received-v1` 的 golden payload（含金丝雀 `canary_event.json`）仍由当前 `buildPayload` 逐字节生成、所有 fixture 的 event ID 互不重复，并由 Todofy 解析；同一 job 用 `validate.mjs` 校验 `contracts/ops-v1` 的 fixture 与常量，并在主机上运行 `test/native-ops.test.mjs`，确认 Mail Hero `Ops` 产生的值符合 Schema（Todofy 侧用 `jsonschema` 做同样的检查）。经 service binding 调用真实 `Ops` 的 workerd 测试 `native-ops-runtime.test.mjs` 属于 Worker 测试。Worker 测试包含真正的 workerd D1/R2/SQLite Durable Object 绑定与合成大附件。Node 使用 26，Actions 固定到已核实的提交 SHA。

累计基准不是上一个提交：`main` 上是该 workflow 最近一次成功的 `main` push run 的提交，因此失败或排队时被取消的 run 中的改动会由下一次 run 重新检查并发布；其他分支上是与 `origin/main` 的 merge base，分支 head 的 `CI gate` 覆盖整个分支。找不到可用基准（首次运行、API 错误、基准不是祖先）时全部运行。

只有 `main` 上相对该基准改动了 `mail-hero/` 或 `packages/edge-auth/` 的 push，或在 `main` 上手工运行并选择 `both`/`mail-hero`，且 `Mail Hero checks` 与 `CI gate` 成功，`Mail Hero deploy` 才进入 GitHub `production` environment。只改 `contracts/` 或 `.github/` 会重新检查但不发布。部署从同一提交重新构建 UI，生成专用原生配置，先做 Wrangler dry-run，再依次应用 D1 migrations、发布 Worker。并发部署排队，不中断正在应用的 migration。非 `main` 分支不接触生产密钥。

这条流水线发布 Cloudflare Worker 和静态资源，使用现有D1、R2和SQLite DO资源。来源邮箱转发、Access策略及根域MX由各自设置管理；流水线不会创建新的Cloudflare收费计划。Todofy 在同一仓库的 `todofy/` 中，由独立的 `Todofy checks`/`Todofy deploy` job 发布；两者只共享 `contracts/` 与 `packages/`（目前是 `packages/edge-auth`，由各自Worker编译进去），互不导入代码；共享包改动会同时检查并发布两者，其余发布互不依赖。

独立的根目录 `.github/workflows/mail-hero-backup-image.yml`（仅在 `mail-hero/deploy/backup/**`、`mail-hero/cloudflare/migrations/**` 或该文件变更时运行）发布新的 package `ghcr.io/ziyixi/mail-hero-backup-collector`。旧 package `ghcr.io/ziyixi/mail-hero-backup` 仍关联到原 `ziyixi/mail-hero` 仓库，不再更新；服务器继续使用 Compose 中已固定的旧 digest，直到下一次升级收集器时改为新 package 的 digest。它先运行合成备份/恢复及调度测试，再构建 `linux/amd64` 镜像；非 `main` 分支只构建，main发布使用当前工作流的 `GITHUB_TOKEN`，只有发布job获得 `packages: write`。镜像带源码revision标签、`sha-<完整提交>`标签及不可变digest。无需新增长期GitHub token，也不向构建过程提供邮件、备份凭据或Cloudflare管理密钥。新 package 首次发布后核对其为 public，服务器才可匿名拉取。

服务器的 `self-host-on-vultr` Compose配置固定备份镜像digest，更新时只执行 `docker compose pull mailhero-backup` 和 `docker compose up -d --no-deps mailhero-backup`。容器自己负责每日调度和失败后的有界重试，使用原来的私有备份配置及状态目录，不安装systemd或主机cron。操作与恢复见[备份说明](../deploy/backup/README.md)。

## 仓库设置

在 GitHub 仓库 Settings → Environments 创建 `production`，将可部署分支限制为 `main`。个人使用可以直接自动部署；若希望每次人工确认，可添加 required reviewer。给 `main` 开启分支保护时，将 `CI gate` 设为 required check（它汇总共享包、两个应用及合同检查，未改动而跳过的 job 视为通过）。

在 Settings → Secrets and variables → Actions 配置以下 repository variables；也可放入 `production` environment variables。值必须与现有资源一致，不要新建重复资源。

| Variable | 当前部署的值或来源 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | 现有 Cloudflare account ID |
| `MAIL_HERO_D1_DATABASE_ID` | 现有 `mail-hero` D1 UUID |
| `MAIL_HERO_D1_DATABASE_NAME` | 可省略，默认 `mail-hero` |
| `MAIL_HERO_R2_BUCKET_NAME` | 可省略，默认 `mail-hero-store` |
| `MAIL_HERO_RECEIVE_ADDRESS` | `inbox-mail-hero@inbox.ziyixi.science` |
| `MAIL_HERO_ACCESS_ISSUER` | `https://ziyixi.cloudflareaccess.com` |
| `MAIL_HERO_ACCESS_AUDIENCE` | 现有 Mail Hero Access application AUD |
| `MAIL_HERO_ACCESS_OWNER` | 现有 canonical owner 邮箱 |
| `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` | `daily.ziyixi.science`；多个精确 hostname 用逗号分隔 |
| `MAIL_HERO_PUBLIC_HOST` | `mail-hero.ziyixi.science` |
| `MAIL_HERO_FORCE_SEND_PAUSED` | 明确设为 `true` 或 `false`，与当前运维状态一致 |
| `MAIL_HERO_MAINTENANCE_MODE` | 明确设为 `true` 或 `false`，正常运行是 `false` |
| `MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT` | 可省略，默认 `300` |
| `MAIL_HERO_INGEST_DAILY_BYTE_LIMIT` | 可省略，默认 `268435456` |
| `MAIL_HERO_BACKUP_BUCKET_NAME` | 已启用备份时必须照旧设置（现有私有备份桶名）；省略则发布的 Worker 没有 `BACKUP_STORE` binding，备份 API 不可用 |
| `MAIL_HERO_ALERT_WEBHOOK_URL` | 可选；按 ops-v1 计划不配置，统一运维摘要取代它（见 [cloudflare-setup.md](cloudflare-setup.md) §2.2）。若已设置，删除前确认不再需要，否则下次发布照旧使用 |
| `MAIL_HERO_ALERT_WEBHOOK_ALLOWED_HOSTS` | 可选，省略时沿用 `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS` |

在 `production` environment 添加 secrets：

| Secret | 用途 |
| --- | --- |
| `MAIL_HERO_CF_API_TOKEN` | 独立 Cloudflare 部署 token（原仓库中名为 `CF_API_TOKEN`；单仓库的 `production` 中 `CF_API_TOKEN` 属于 Todofy），限定目标账户的 Worker 发布、D1 migration 及现有 zone 的 Worker route 所需权限；不需要 Billing 权限 |
| `MAIL_HERO_ACCESS_OWNER_ALIASES` | 已核实的同一 owner 登录邮箱；沿用当前 GitHub 登录 alias，逗号分隔且不要加空格。若尚未使用 alias，可留空 |

不要把 token 或 alias 直接写进 workflow、命令参数或提交的配置。现有临时 bootstrap token 到期后，Actions 需要换成有效的专用 token；更新 GitHub secret 即可，不影响本机 Wrangler 登录。

`CREDENTIAL_KEY`、可选的 Access service client secrets 继续保存在现有 Worker 中。普通 `wrangler deploy` 保留 Worker secret bindings；流水线不读取、复制、轮换或重新上传主密钥。D1 内保存的 webhook 凭据也不由流水线重写。

## 日常发布和失败恢复

1. 在分支上提交并 push，`CI gate` 通过后 fast-forward 到 `main`。
2. Actions 的 `Mail Hero deploy` 成功后，记录提交 SHA 和 Wrangler 输出的 Worker version ID。
3. 查看 Mail Hero 登录、收件与新测试事件的交付状态。部署成功仅证明发布步骤成功，不等于真实邮箱到 Todofy/Todoist 的业务链路通过。

`deploy/generate-ci-config.mjs` 生成 `cloudflare/wrangler.native.production.ci.json`，权限为 0600；此文件被 git ignore，CI 最后删除，不上传为 artifact。不要把本机私有 `wrangler.native.production.toml` 提交到 GitHub。生成器只输出成功/错误字段名，不打印配置值。

`FORCE_SEND_PAUSED` 与 `MAINTENANCE_MODE` 是部署配置来源的一部分。紧急暂停后，应同步修改 GitHub variable，否则下一次部署会恢复仓库设置的值。数据库中的 archive/forward 模式、目标选择和目标暂停由应用 UI 管理，不随普通部署重置。

Migration 在旧 Worker 仍运行时执行，因此自动发布中的 migration 必须向后兼容，例如添加表或列。破坏性 schema 变更需另行维护窗口与备份计划。若 migration 成功而 Worker 发布失败，修复后重跑同一 workflow；已记录的 migration 不会重复执行。不要自动回滚 D1 或重新生成 webhook 事件。回滚应用代码也不能假定数据库会一起回滚。

本地在 `mail-hero/` 目录运行同样的检查：

```sh
npm ci --prefix cloudflare
npm ci --prefix web
node --test deploy/test/*.test.mjs
npm run typecheck --prefix cloudflare
npm test --prefix cloudflare
npm run typecheck --prefix web
npm test --prefix web
npm run build --prefix web
python3 -m unittest discover -s deploy/backup -p 'test_*.py'
```

mail.received.v1 golden fixture 由 `cloudflare/test/contract-fixtures.mjs` 生成；有意修改 payload 构建器后在 `mail-hero/cloudflare` 运行 `npm run contract:update` 并提交 `contracts/` 的变更，再在 `todofy/` 运行 `uv run pytest tests/unit/test_mail_hero_compat.py` 确认消费者兼容。

本地 workerd 测试需要允许监听 loopback。Actions 使用 GitHub 托管 Ubuntu runner。代码发布不需要给 runner 访问真实邮件或业务数据库的权限。

依据：[Cloudflare GitHub Actions 部署](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
