# 直接覆盖上线：GitHub + Vercel

2026-09-21，按用户最新要求：直接覆盖现有仓库与项目，不保留旧内容，不迁移旧 URL，不备份或演练恢复旧站。旧站恢复衔接不再作为上线前提。

本次只简化说明，未修改代码、线上设置或执行 push。新站仍使用现有构建和部署测试。

## 1. Vercel 设置

打开 [Build and Deployment](https://vercel.com/zayne-xis-projects-c6d821a2/ziyixi-science/settings/build-and-deployment)，逐项设置后 Save：

| 设置                               | 值                                                 |
| ---------------------------------- | -------------------------------------------------- |
| Framework Preset                   | Next.js，已正确                                    |
| Node.js Version → Project Settings | 从 22.x 改为 24.x                                  |
| Build Command                      | 开启 Override，填 `pnpm build`                     |
| Install Command                    | 开启 Override，填 `pnpm install --frozen-lockfile` |
| Output Directory                   | 默认，Override 关闭                                |
| Root Directory                     | 留空                                               |
| Rolling Releases                   | 保持 Disabled                                      |

域名已经正确：`ziyixi.science` 跳转到 `www.ziyixi.science`，后者连接此项目的 Production。保持现状；注册商转移以后再做。

## 2. 取得两个 Vercel 凭据

**发布 token：** 在 [Account Tokens](https://vercel.com/account/tokens) 创建 token，Scope 选择 **Zayne Xi's projects**，保存生成的值。

**测试 secret：** 打开 [Deployment Protection](https://vercel.com/zayne-xis-projects-c6d821a2/ziyixi-science/settings/deployment-protection)：

1. 开启 Vercel Authentication → Require Log In。
2. 保护范围选 Standard Protection（若有此选项），保存。
3. 在 Protection Bypass for Automation 点击 Add Secret，保存生成的值。

这是当前新站部署测试的要求，与保护旧站无关。Standard Protection 保持正式域名公开，临时部署地址由测试 secret 授权访问。[官方说明](https://vercel.com/docs/deployment-protection)

## 3. GitHub 配置

进入 [Settings → Environments](https://github.com/ziyixi/ziyixi.science/settings/environments)，新建小写 `production`；已存在就直接进入。

Deployment branches and tags 选 **Selected branches and tags**，添加 Branch：`main`。Required reviewers 可以不设。

在 **Environment secrets** 添加：

| Name                              | Value                              |
| --------------------------------- | ---------------------------------- |
| `VERCEL_TOKEN`                    | 上一步的发布 token                 |
| `VERCEL_ORG_ID`                   | `team_cIZ2GUOVS4QiXmTlMuaOHnZe`    |
| `VERCEL_PROJECT_ID`               | `prj_7JweYq8RdsRPV7FIPnxNoIIK2ZA8` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 上一步的测试 secret                |
| `NOTION_TOKEN`                    | 本地 `.env.local` 的同名值         |
| `NOTION_DATA_SOURCE_ID`           | 本地 `.env.local` 的同名值         |

在 **Environment variables** 添加：

| Name                 | Value                        |
| -------------------- | ---------------------------- |
| `SITE_URL`           | `https://www.ziyixi.science` |
| `NOTION_API_VERSION` | `2026-03-11`                 |
| `BOOTSTRAP_APPROVAL` | `https://www.ziyixi.science` |

密钥直接填到设置页面，不发到聊天。Notion 的两个值只放 GitHub，不放 Vercel，因为文章由 GitHub 同步。无需自己创建 `GITHUB_TOKEN`。

## 4. 准备并覆盖代码

上述配置完成后，后续执行时：

1. 将 `content/site.config.ts` 的 `blogSource` 从 `"empty"` 改成 `"notion"`。
2. 用 `make preview` 查看、`make check` 检查。
3. 初始化本地 Git，连接 `https://github.com/ziyixi/ziyixi.science.git`。
4. 确认提交不包含 `.env.local` 等密钥文件。
5. 用 `--force-with-lease` 覆盖远端 `main`，不保留旧站备份。

本次尚未执行。新代码的 `vercel.json` 关闭 Git 自动部署，push 后仍需下一步发布。

## 5. 第一次上线

进入 [GitHub Actions](https://github.com/ziyixi/ziyixi.science/actions) → **Production release** → **Run workflow**：

| 输入项       | 填写                           |
| ------------ | ------------------------------ |
| Branch       | `main`                         |
| operation    | `bootstrap`                    |
| confirmation | `bootstrap:www.ziyixi.science` |
| force_build  | 不勾选                         |
| allow_empty  | 不勾选                         |

点击后会自动同步、检查、构建、测试并上线。整次运行变绿后查看正式网站，再删除临时变量 `BOOTSTRAP_APPROVAL`；其余配置保留。

`bootstrap` 是现有流水线对首次发布的称呼，不要求保留旧内容。现有脚本对失败记录的检查仍在；如首发失败，先根据报错修正新站或发布流程，不将恢复旧站作为目标。

## 以后更新

修改 Notion 后，运行同一个工作流，使用：

- Branch：`main`
- operation：`release`
- confirmation：`release:www.ziyixi.science`
- 两个勾选框保持不选。

改代码则先提交，再运行此流程；日常不需要 force push。当前没有定时同步。
