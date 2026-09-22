# 上线前 Pending List：Notion、GitHub、Vercel 与域名

更新时间：2026-09-21。本文根据当前实现、修复记录及当日官方文档整理；所有勾选框表示**待执行或待账户持有人确认**，不是已完成配置。此轮没有创建账号资源、写入密钥、发布网站、修改 DNS 或发起域名转移。

建议继续使用当前代码中的主地址 **https://www.ziyixi.science**，让 **https://ziyixi.science** 重定向到它。主线优先复用现有 Vercel 项目；若希望保留完全独立的旧项目，第 3.4 节提供新项目分支。

建议顺序：**GitHub/Vercel 接通并验收 → 接管正式域名 → 启用已验收的 Notion 内容 → 网站稳定后转注册商**。Notion 建库可并行准备；如果内容已准备好，也可直接以 notion 模式首次发布。注册商转移与网站上线没有技术上的先后依赖，分开进行更容易排查和恢复。

## 0. 最先确认的事项

| 待确认       | 建议/当前依据                                                                                |
| ------------ | -------------------------------------------------------------------------------------------- |
| GitHub 仓库  | 当前工作目录仍没有 Git 元数据；先确定正式仓库 URL、可见性和 main 分支                        |
| 主域名       | 保持 `https://www.ziyixi.science`，与 `content/site.config.ts` 一致；`SITE_URL` 不加末尾斜杠 |
| Vercel 项目  | 记录现有项目及所属 team；默认复用它，减少域名归属变化                                        |
| 首发博客状态 | 当前 `blogSource: "empty"`；可先上线空博客，准备好后再切 notion                              |
| Cloudflare   | 你已使用其 DNS；仍需在控制台确认 zone 为 Active、当前 NS、DNSSEC/DS 状态                     |
| 旧站恢复资料 | 保存旧 production deployment 的不可变 ID/URL、旧项目设置、域名归属和 DNS 导出                |

这套架构中，各服务负责的事情如下：

| 服务                           | 用途                                                  |
| ------------------------------ | ----------------------------------------------------- |
| Notion                         | 写文章、维护文章属性                                  |
| GitHub                         | 保存代码、执行检查、读取 Notion、构建与控制发布       |
| Vercel                         | 接收已构建产物并提供网站                              |
| Cloudflare DNS                 | 维护域名解析；建议网站记录使用 DNS only               |
| Cloudflare Registrar（转入后） | 域名注册、续费与转移管理，取代 Namecheap 的注册商角色 |

## 1. Notion：建库与连接

### 1.1 创建专用 Blog 数据库

- [ ] 创建一个专门存博客的原始数据库，名字可叫 `Blog`。
- [ ] 一行就是一篇文章；打开该行后，在页面正文里写博客。
- [ ] 将默认 `Name` 标题列重命名为 `Title`，然后按下表创建其它属性。
- [ ] 建立默认模板：`Status=Draft`，`Language` 选常用语言。新建空行也要保持 Draft。

**下面 7 列都必须存在，名称和大小写须完全一致。**

| 列名             | Notion 中的类型                | 填写要求/示例                                                  |
| ---------------- | ------------------------------ | -------------------------------------------------------------- |
| `Title`          | Title／标题                    | 已发布必填，1–300 字符；如“我的第一篇笔记”                     |
| `Slug`           | Text／文本（API 为 rich_text） | 已发布必填，1–80 字符；如 `first-note`                         |
| `Status`         | Status／状态                   | 使用 `Draft` 和 `Published`；不能用 Select 列替代              |
| `PublishedAt`    | Date／日期                     | 已发布必填；需要精确时间时开启时间并选时区                     |
| `Summary`        | Text／文本                     | 已发布必填，1–600 字符，一两句摘要                             |
| `Language`       | Select／单选                   | 已发布必填；选项严格为 `en`、`zh-CN`                           |
| `Tags`           | Multi-select／多选             | 列必须存在，但文章可不选标签；如 `systems`、`research`         |
| `TranslationKey` | Text／文本                     | 可选；同一篇文章的中英文版本填写相同值，如 `content-pipelines` |

草稿的其余字段可暂空，但不要删除属性列。作者由网站个人资料提供，当前不需要 Author、Featured、Cover 等额外列。

**中英文译文：** 在 Notion 中保留两个独立文章页面，分别填写各自的 Title、Summary、Slug 和正文；Language 选 `en`、`zh-CN`，两行的 `TranslationKey` 填相同值。Slug 仍不同，例如 `content-pipelines-en` 和 `content-pipelines-zh`。该列可以不建，单语文章也可以留空，程序不会根据相似标题或 Slug 自动猜测关系。

同步后，首页与博客列表将它们合为一条，显示两个语言的标题和 `English / 中文` 入口；文章页可直接切换版本。只有 Published 且日期已到的版本才会出现。译文暂未发布时，原文正常单独显示。同一 TranslationKey 下每种语言只能有一个公开版本；列表排序采用该组最早的发布日期，补发译文不会让旧文章突然上浮。RSS 保留各语言独立条目，以便订阅者收到新译文。

**几条容易踩到的规则：**

- Status 的默认选项 `Not started`、`In progress`、`Done` 要改成/不再使用；任何未归档行出现未知或空状态，都会使整次同步失败。
- Slug 只允许小写英文字母、数字及单个短横线；不能用中文、空格、下划线、连续短横线。不能使用 `about/api/blog/build-info/cv/feed/publications/robots/sitemap` 这些保留值。
- 不同文章不能使用相同 Slug；历史 Slug 也不要分配给另一篇文章。改名和重定向由累计内容登记表处理，生产发布不要重置这个登记表。
- 程序按整个 data source 的属性筛选，Notion 的某个视图筛选不会决定公开范围。
- Published 且日期已到的文章才进入网站；Draft、归档、删除和未来日期不会发布。只填日期会按该日 UTC 00:00 处理。
- 未来日期不是自动定时发布：当前没有定时同步，到时间后仍需要手动运行 release。

### 1.2 创建只读连接并授权

- [ ] 进入 [Notion Developer portal](https://developers.notion.com/guides/get-started/internal-connections) 的 Build → Internal connections，创建专供网站使用的连接。
- [ ] 选择你的工作区；若创建入口受限，由该 workspace owner 完成。
- [ ] 在 Configuration 只启用 **Read content**；不需要 Insert/Update、评论或用户信息权限。
- [ ] 在 Content access → Edit access 中授权专用 Blog 原始数据库；也可在数据库完整页面的 `••• → Connections → Add connection` 添加。
- [ ] 取得 **Installation access token**，保存到本机密码管理器及后面的 GitHub Secret。

当前实现采用 internal connection 的官方 API 方式，**不需要把 Notion 页面 Publish to web**。若你用 linked database 视图，连接必须能访问其原始数据库。[连接指南](https://developers.notion.com/guides/get-started/internal-connections)、[权限说明](https://developers.notion.com/reference/capabilities)、[数据源访问要求](https://developers.notion.com/reference/retrieve-a-data-source)。

### 1.3 取得 data source ID

- [ ] 在数据库设置 → Manage data sources 中，找到实际 Blog 数据源并选择 **Copy data source ID**。
- [ ] 将它作为 `NOTION_DATA_SOURCE_ID`。

它不同于数据库 URL 中的 database ID、`v=` 视图 ID、单篇文章 ID。若 UI 没有这个入口，可由实现模型通过官方 Retrieve database API 只读查询 `data_sources` 列表；不要凭 URL 猜 ID。[Notion 官方说明](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03#step-1-add-a-discovery-step-to-fetch-and-store-the-data_source_id)。

### 1.4 本地连接验收

- [ ] 本机准备 Node 24 和项目固定的 pnpm 11.25.0。

macOS 使用 Homebrew 时，一次性运行 `brew install node@24`。Makefile 优先使用当前 Node 24；当前版本不匹配时，会为本项目命令自动选择已安装的 Homebrew Node 24，不修改终端默认版本。已有 nvm 则运行 `nvm install && nvm use`，仓库的 `.nvmrc` 已指定 24。版本检查会在 Notion 同步之前完成。直接执行 `pnpm` 不经过 Makefile，需先自行切到 Node 24。

- [ ] 建立被 Git 忽略的 `.env.local`，在编辑器中填写：

```dotenv
NOTION_TOKEN=<Installation access token>
NOTION_DATA_SOURCE_ID=<Blog data source ID>
NOTION_API_VERSION=2026-03-11
SITE_URL=https://www.ziyixi.science
```

- [ ] 用一篇 Published 真实文章、一篇 Draft 测试连接。第一篇测试稿不要包含不希望公开的内容。
- [ ] 本地查看真实 Notion 文章，直接运行：

```sh
make preview
```

打开 `http://localhost:3000`，Ctrl+C 停止。首次缺少依赖时先运行 `make install`；端口被占用时用 `make preview PORT=3001`。

`make preview` 自动加载 `.env.local`、同步 Notion 到网站默认目录并启动开发服务器。首次同步自动初始化，后续自动使用本地已有 registry，无需手动选择 bootstrap/baseline；同步失败会停止启动。仅同步用 `make sync`，查看已经同步的内容用 `make dev`。这些命令不发布，也不修改生产配置；本地预览无需提前切换 `blogSource`。Notion 修改后，停止服务器并重新执行 `make preview`。

这里使用的是本地快照与本地 baseline；正式发布仍通过 release 工作流获取可信线上 baseline。底层 `pnpm content:prepare` 本身不会自动加载 `.env.local`，Makefile 已代为传入 Node 的 `--env-file`。

- [ ] 用本地预览验收标题、代码、公式、图片、中文排版、目录、内部链接、Draft 过滤、撤稿、Slug 改名；正式构建和部署验收按后续发布流程执行。
- [ ] 验收后提交配置变更：`content/site.config.ts` 的 `blogSource` 从 `"empty"` 改为 `"notion"`。
- [ ] 如果此前 empty 网站已经成功发布，启用 Notion 走普通 `release`，无需再次 bootstrap。

### 1.5 正文支持范围

当前支持普通段落/H1–H3、富文本、嵌套列表、引用、分隔线、代码、KaTeX 公式、图片、简单表格、toggle、简单 callout 和 bookmark。

普通外链支持 HTTP、HTTPS 与 mailto；HTTP 链接保留原协议，Notion 自动添加的 HTTP 链接不会使同步失败，无需为此修改正文。bookmark 支持普通 HTTP/HTTPS 外链。图片下载和站点 canonical 仍单独要求 HTTPS。

迁移前先处理 checkbox/to-do、分栏、toggle heading、子页面、嵌套数据库、synced block、复杂 embed、音视频、PDF/file 块、非 page 的 mention：当前这些不在支持范围，遇到会停止同步。

图片优先直接上传 Notion；支持 JPEG/PNG/WebP/AVIF/GIF，单图上限 20 MiB、一次同步总量上限 200 MiB。填写 caption 以便生成有意义的替代文本。默认接受 Notion 使用的 `amazonaws.com`、`file.notion.so`、`notion-static.com` 来源；第三方图床需单独处理，不能仅在 GitHub 新增一个 env 就假定工作流会读取它。

Notion 页面链接、page mention、bookmark 目标必须是本轮公开文章；当前不支持带 Notion block fragment 的章节链接。

以上字段、限制以 `scripts/content/adapters/notion.ts`、`scripts/content/notion/`、`src/lib/content/schema.ts` 为准。

## 2. GitHub：仓库、密钥与发布入口

### 2.1 仓库和 CI

- [ ] 确定正式 GitHub 仓库，将当前实现及 `pnpm-lock.yaml` 提交到 `main`。当前本机目录还没有 Git 元数据，不要误认为 Actions 已经接通。
- [ ] 确认提交不含 `.env*` 密钥、`.vercel/`、原始 Notion 数据或生成快照；现有 `.gitignore` 已覆盖这些路径。
- [ ] 发起一次 PR，实际跑出 `Static checks`、`empty build and E2E`、`fixture build and E2E`。
- [ ] 在 main 的 branch protection/ruleset 中要求 PR 和这些检查通过；选择真实运行后显示的检查名称。
- [ ] 创建名为 **production** 的 Environment，限制可部署分支为 main。

GitHub 路径：**Repository → Settings → Environments → production**。所有下表值放在该 Environment 的 Secrets 或 Variables 中。

GitHub Free 的私有仓库不提供这里所需的 Environment 能力；私有仓库需核对 Pro/Team/Enterprise。Required reviewers 在 Free/Pro/Team 中仅面向公开仓库提供。单人维护时不要同时设置“只能自己审批”和 Prevent self-review，否则会阻塞自己触发的发布。[GitHub 当前规则](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。

### 2.2 Environment secrets

| 名称                              | 必需时机              | 从哪里取得                                                                                  |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                    | 所有正式发布          | Vercel Account Settings → Tokens；按目标 team/scope 配置可用的最小权限与有效期              |
| `VERCEL_ORG_ID`                   | 所有正式发布          | 目标 Vercel Team/账号 ID；或本机正规 `vercel link` 产生的 `.vercel/project.json` 中 `orgId` |
| `VERCEL_PROJECT_ID`               | 所有正式发布          | Vercel 项目 Settings → General → Project ID，形如 `prj_...`                                 |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 所有正式发布          | Vercel 项目 Settings → Deployment Protection → Protection Bypass for Automation             |
| `NOTION_TOKEN`                    | `blogSource="notion"` | 上面创建的只读连接 token                                                                    |
| `NOTION_DATA_SOURCE_ID`           | `blogSource="notion"` | Blog 的 Copy data source ID                                                                 |

`GITHUB_TOKEN` 由 Actions 自动提供，不需要再创建个人 token。虽然 Vercel 的两个 ID 不是密码，当前工作流从 `secrets` 读取，所以仍放对应位置。

### 2.3 Environment variables

| 名称                 | 值                           | 保留方式                                 |
| -------------------- | ---------------------------- | ---------------------------------------- |
| `SITE_URL`           | `https://www.ziyixi.science` | 长期；与仓库 canonicalOrigin 完全一致    |
| `NOTION_API_VERSION` | `2026-03-11`                 | notion 模式必需；不能单独自动改为 latest |
| `BOOTSTRAP_APPROVAL` | `https://www.ziyixi.science` | 仅首次接管正式站点前临时设置，成功后删除 |
| `RECOVERY_APPROVAL`  | `https://www.ziyixi.science` | 仅故障恢复时临时设置，完成后删除         |

不需要手填 `CODE_SHA` 或 `RELEASE_SHA`，工作流自行锁定提交。

**Notion token 和 data source ID 不放在 Vercel，不使用 `NEXT_PUBLIC_*`。** GitHub 读取 Notion、生成本地快照，再构建并上传。当前工作流发现 Vercel env 中存在这两个 Notion 字段会主动失败。Vercel 的普通 Environment Variables 页在默认方案下没有需要手动复制过去的应用秘密；若曾配置 `SITE_URL`，确保值与上述一致。

## 3. Vercel 与 ziyixi.science

### 3.1 复用现有项目：推荐主线

- [ ] 在 Vercel 找到当前承载域名的项目，记录 team、project ID、旧 production deployment ID/URL、域名和构建设置。
- [ ] 保留可访问的旧部署及源码，写明控制台的恢复入口；第一次接管时这是实际的恢复依据。
- [ ] 核对新项目设置；从旧框架迁移时尤其检查旧的 build/output overrides。

| 设置             | 目标值                                          |
| ---------------- | ----------------------------------------------- |
| Framework Preset | Next.js                                         |
| Root Directory   | 此网站仓库根目录                                |
| Node.js          | 24.x，与 package.json 一致                      |
| Install Command  | `pnpm install --frozen-lockfile`                |
| Build Command    | `pnpm build`                                    |
| Output Directory | Next.js 默认；去掉旧项目的 `out`、`dist` 等覆盖 |
| Rolling Releases | 关闭；当前脚本只支持一次性切换                  |
| Git 自动部署     | 关闭；发布只从本仓库 Actions 进入               |

Vercel 支持 Node 24；项目 ID 可在 General 中查看。[Node 版本](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)、[General 设置](https://vercel.com/docs/project-configuration/general-settings)。

现有 `vercel.json` 已设置 `git.deploymentEnabled: false`，但这**不会替你关闭旧仓库或别的 pipeline**。若当前 Vercel 项目仍连接旧站 Git 仓库，应在接管前停止旧 Git 自动部署和旧发布工作流。可以不建立新的 Vercel Git 自动部署连接，Actions 通过固定 project ID 发布即可。

普通 Dashboard Redeploy 不会替本项目完成 GitHub 的 Notion 同步和快照准备；日常更新用下面的 Actions 入口。当前正式链路为 `vercel build --prod` → `deploy --prebuilt --prod --skip-domain` → 验证 → promote。

### 3.2 保护候选、公开正式域名

- [ ] Settings → Deployment Protection，选择 **Vercel Authentication + Standard Protection**。
- [ ] 在 Protection Bypass for Automation 生成专用 secret，放入 GitHub 同名 Secret。
- [ ] 确认生成的 candidate URL 无凭据时受保护，正式自定义域名无需登录即可访问。
- [ ] 不选保护正式域名的 All Deployments；检查没有意外的候选保护例外。
- [ ] 记录 token/bypass 到期或轮换方式。

Standard Protection 保留正式域名公开，并保护生成的部署地址；当前发布脚本对此有实际负向探测。不要为测试绕过它而把候选全部公开。[保护范围](https://vercel.com/docs/deployment-protection)、[自动化 bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)。

### 3.3 域名与 Cloudflare DNS

- [ ] 在 Vercel 项目 Settings → Domains 同时确认 `www.ziyixi.science` 与 `ziyixi.science`。
- [ ] `www.ziyixi.science` 服务 Production；根域 `ziyixi.science` 永久重定向到 www，并检查路径、查询参数保留。
- [ ] 如果继续复用同一项目，现有正确绑定与 DNS 可以保留；没有必要为重写网站而迁走域名。
- [ ] 如 Vercel 提示 DNS 配置变化，只按**当前项目 Domains 页面显示的值**更新 Cloudflare 中对应 A/CNAME/TXT。
- [ ] 网站记录建议 DNS only（灰云）；不要同时增加 Cloudflare Cache Everything、Worker 路由或另一套 apex/www 重定向。
- [ ] 核对 Vercel 的有效配置/证书状态，以及 HTTP、HTTPS、apex、www 四种入口。
- [ ] 保留 MX、SPF、DKIM、DMARC、其它子域名和所有权验证记录。

不需要把 nameservers 改成 Vercel，也不要照网上写死的通用 IP/CNAME。保留 Cloudflare DNS 与 Vercel 托管可共存；Vercel 建议这种组合使用 DNS only。[外部 DNS 操作](https://vercel.com/docs/domains/set-up-custom-domain#when-youre-using-an-external-dns-provider)、[DNS-only 建议](https://vercel.com/kb/guide/vercel-waf-vs-cloudflare-waf)。

### 3.4 可选：新 Vercel 项目，再转域名

只有希望将旧站和新站项目完全隔离时才采用这一分支：

- [ ] 新项目与旧项目尽量放在同一 Vercel team；先部署并验收新项目，明确当前生产版本就是希望接收流量的版本。
- [ ] 切换时，在**目标项目** Settings → Domains 添加已有域名，核对弹出的 **Move Domain** 中源项目、目标项目和全部关联域名，再确认。
- [ ] 不要先从旧项目删除域名；这会造成不必要的中断。
- [ ] 检查一起迁移的 redirect 域名、apex/www 设置、DNS 建议、证书、页面和路由。
- [ ] 保留旧项目；首次切换故障时，按相同项目间移动流程将域名恢复到旧项目。

这是 Vercel 项目归属移动，与下一节注册商转移是两件事。新项目流程需要有明确的切换步骤，不能仅改 GitHub 的 project ID 就运行发布。[Vercel 当前 Move Domain 流程](https://vercel.com/docs/domains/working-with-domains/transfer-your-domain#transferring-domains-between-projects)。

## 4. 第一次发布、日常更新与恢复

### 4.1 正式接管前

- [ ] 在独立演练环境完成真实 candidate、公开验证、失败恢复测试。
- [ ] 演练使用**独立测试仓库 + 独立 Vercel 项目/域名**。当前发布记录按仓库内的 `task=website-release`、`environment=production` 管理；不要在正式仓库的 production 中先指向测试项目，留下记录后再直接换 project ID，污染正式 baseline。
- [ ] 演练仓库中的 canonicalOrigin、SITE_URL、项目 ID 使用演练值；正式仓库保持正式值。
- [ ] 整理旧站 URL 清单。当前 `content/redirects.json` 是空数组；有对应新页面的旧路径再增加准确重定向，移除内容可保留真实 404。不要把全部旧 URL 都重定向到首页。
- [ ] 按你的要求不自动迁移旧 CUDA 博客；以后由你在 Notion 维护内容。

### 4.2 首次 bootstrap

即使复用已有 Vercel 项目，**旧站存在也不等于新工作流已经有可信 baseline**。当前首次 bootstrap 的 GitHub 登记表为空，失败时不能假设脚本会自动恢复那个未登记的旧站。先确认旧 deployment 的平台恢复入口可用；Hobby 的 Instant Rollback 范围是紧邻的上一生产部署，不能把它当任意历史版本恢复。[Vercel 回退范围](https://vercel.com/docs/instant-rollback)。

- [ ] 正式代码已在 main，PR 检查已通过，平台设置、域名和旧站恢复步骤已确认。
- [ ] 在 GitHub production Variables 临时设置 `BOOTSTRAP_APPROVAL=https://www.ziyixi.science`。
- [ ] Actions → Production release → Run workflow，选择：
  - Branch：`main`
  - operation：`bootstrap`
  - confirmation：`bootstrap:www.ziyixi.science`
  - force_build：`false`（bootstrap 本身会重建）
  - allow_empty：`false`
- [ ] 等候 candidate 验证、promote、公开域名验证和 GitHub success 全部完成。
- [ ] 检查首页、`/blog`、`/publications`、真实文章（若有）、`/feed.xml`、`/sitemap.xml`、`/robots.txt`、`/build-info.json` 和未知 URL 的 404。
- [ ] 删除 `BOOTSTRAP_APPROVAL`；保留旧站至观察期结束。

若首次失败，先按准备好的旧站方案恢复，保留失败记录；之后按 operations 手册走 recovery，不删除记录伪装为第一次发布。

### 4.3 平时发布 Notion 更新

1. 在 Notion 写作，Draft 阶段不会发布。
2. 填齐属性，设为 Published，确认 PublishedAt 已到。
3. GitHub Actions → Production release：
   - operation：`release`
   - confirmation：`release:www.ziyixi.science`
   - force_build / allow_empty：通常均为 `false`
4. 成功后核对网站与 RSS。Notion 保存或设置 Published 本身不会自动让网站更新。

编辑、撤稿、改 Slug 后同样再运行一次 release。未来希望自动同步，再单独增加 schedule/webhook；当前尚未实现这项自动触发。

若把最后一篇文章撤下，使已发布集合从非空变零，需有意开启一次性的 `allow_empty`，并填 `release:www.ziyixi.science:allow-empty`。它不能绕过权限或正文错误。

### 4.4 故障恢复

- [ ] 接收 GitHub Actions 失败通知；发布失败时先读实际原因，现网不因 Notion 写作失败而主动清空。
- [ ] 按 `doc/operations.md` 核对正式域名、GitHub record、Vercel deployment ID。
- [ ] 需要 recovery 时临时设置 `RECOVERY_APPROVAL=https://www.ziyixi.science`，运行 `operation=recovery`，confirmation 为 `recovery:www.ziyixi.science`。
- [ ] 恢复验证成功后删除临时变量。
- [ ] 不通过 Dashboard 随意 promote 未记录候选，不手工把 GitHub status 改绿。

## 5. Namecheap → Cloudflare Registrar

建议网站稳定后再做这一段；不需要等待它完成才上线。你已经使用 Cloudflare DNS，主要迁移的是**注册和续费管理**。

### 5.1 转入前

- [ ] Cloudflare 中 `ziyixi.science` 为 Active，当前 NS 确实是该账户分配的 Cloudflare nameservers。
- [ ] 导出 DNS 备份；确认没有需要跟随搬迁的 Namecheap 独立邮箱、转发或其它付费服务。
- [ ] 在 Cloudflare Transfer domains 页面确认该具体域名可转、报价与到期日。官方支持列表包含 `.science`，但个别域名资格仍以实际检查为准。
- [ ] 确认注册/上次转移已超过 60 天，无其它 transfer lock/hold；临转移不要随意修改注册人姓名、组织或邮箱，以免触发新的锁。
- [ ] 确认域名未过期、Registrant email 能收信，Cloudflare 邮箱已验证且付款方式有效。
- [ ] 避免在临近到期时才开始；若刚过期续费、处于相关 45 天窗口，先核对转移后期限，不能假定必然额外加一年。

[Cloudflare 支持的 TLD](https://domains.cloudflare.com/tld-policies)、[转入要求与期限规则](https://developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare/)。

### 5.2 DNSSEC：只在存在 DS 时处理

- [ ] 查看 Namecheap 中是否发布了 DS，并核对 Cloudflare DNSSEC 状态。
- [ ] **没有 DS：** 跳过撤销步骤，保持当前 NS 和网站解析。
- [ ] **已有 DS：** 先记录 DS 与 TTL；在 Namecheap → Domain List → Manage → Advanced DNS → DNSSEC 移除 DS 发布，并等待父区 DS 的原 TTL 过期。
- [ ] 这段等待期间保留 Cloudflare zone 的 DNSSEC 签名；**不要先关闭签名**，避免还缓存着 DS 的解析器无法验证。
- [ ] 转入后在 Cloudflare Registrar 核对/恢复 DNSSEC、DS 与域名锁状态。

Cloudflare 当前转入故障排查说明旧注册商 active DNSSEC 会阻断转入；安全顺序应是先移除父区 DS，等缓存失效，再按需要处理签名。若控制台无法明确显示 DS 的状态，先确认该状态再继续，不反复切 NS 或 DNSSEC。[转入 DNSSEC 条件](https://developers.cloudflare.com/registrar/troubleshooting/#dnssec-is-still-active)、[安全撤销顺序](https://developers.cloudflare.com/dns/dnssec/#roll-back-dnssec)、[Namecheap 自定义 DNS 的 DS 管理](https://www.namecheap.com/support/knowledgebase/article.aspx/9722/2232/managing-dnssec-for-domains-pointed-to-custom-dns/)。

### 5.3 发起转移

- [ ] Namecheap → Domain List → Manage → Sharing & Transfer → Transfer Out。
- [ ] 解除 Registrar Lock，申请 EPP/Auth code；代码通常发到 Registrant email，未必是登录邮箱。
- [ ] Cloudflare → Domain Registration → Transfer domains，选择 `ziyixi.science`，填入 Auth code。
- [ ] 核对联系资料、收费与到期日，再由你确认支付并提交；根据 Namecheap 邮件完成放行。
- [ ] 保留当前 Cloudflare zone、NS、A/CNAME/MX/TXT。不要删除 zone 重建，也不要把 NS 改成 Vercel。

[Namecheap 转出操作](https://www.namecheap.com/support/knowledgebase/article.aspx/258/84/what-should-i-do-to-transfer-a-domain-from-namecheap/)、[Cloudflare 转入操作](https://developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare/)。

EPP/Auth code 与密码一样只在正规控制台使用，不放聊天、文档或仓库。转移通常需要数天，不保证即时完成；页面可能提供加速确认。具体费用以提交前报价为准。

### 5.4 完成验收

- [ ] Cloudflare 显示注册商转入完成，原 nameservers 与记录保持正确。
- [ ] 核查网站 apex/www/HTTPS、邮件收发及其它子域名正常。
- [ ] 核对续费日期、自动续费、付款方式、联系人邮箱验证。
- [ ] 核对域名锁、DNSSEC/DS 已按预期启用。
- [ ] 只在确定转移完成后处理 Namecheap 的旧续费安排；不要误取消独立邮件等服务。
- [ ] 记录 Registrar 与 DNS 都在 Cloudflare，后续续费在 Cloudflare 管理。

转入后通常会有新的 60 天转出限制，所以注册商不是可即时来回切的回退手段；网站仍可独立在 Vercel 恢复旧部署。[Cloudflare 转出限制](https://developers.cloudflare.com/registrar/account-options/transfer-out-from-cloudflare/)。

## 6. 其余收尾与操作习惯

- [ ] 再确认 `content/profile.json`、`content/publications.json`、照片、GitHub/LinkedIn 链接与简介是最终公开版本。
- [ ] 若要提供 CV，再加入真实 PDF 与对应配置；不要放空链接。
- [ ] 真实运行修复后的 PR CI；修复记录中的本地通过不替代 GitHub Linux runner 和平台演练。
- [ ] 为 GitHub、Notion、Vercel、Cloudflare、Namecheap 配置可靠的登录恢复与双重验证；密钥保存在密码管理器。
- [ ] 保留代码备份、Notion 内容导出和域名配置导出；不把私有 Notion 原始响应提交到公开仓库。
- [ ] 配好 Actions 失败通知；上线后再考虑可选 uptime 检查。
- [ ] 可选：Google Search Console 验证并提交 `https://www.ziyixi.science/sitemap.xml`；无需因此增加前端追踪代码。
- [ ] 当前不需要 Redis、数据库服务器、Cloudflare API token 或浏览器侧 Notion SDK。
- [ ] 以后密钥轮换、修改 canonical、迁移 Vercel 项目、定时同步均单独安排，避免一次改动多个发布边界。

## 最短执行路径

如果希望先把新版网站用起来，可以按下面分两轮：

**第一轮：** 确定 GitHub 仓库 → production Environment 与 Vercel secrets → 复用旧 Vercel 项目并保留旧部署 → 验收 empty 模式 → bootstrap → 删除临时 approval。

**第二轮：** Notion 建库与只读连接 → 真实内容验收 → 加入 Notion secrets/variable → 提交 `blogSource="notion"` → 普通 release → 站点稳定后转入 Cloudflare Registrar。

涉及身份、密钥、支付、域名转移确认的步骤由你在正规控制台完成；无需把 token、Auth code 或密码发到聊天。本文只提供待办与操作说明，尚未执行这些变更。
