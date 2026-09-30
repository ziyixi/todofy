# 从 Notion 一键发布网站

## 平时只需要三步

1. 在 **Blog** 数据库写好文章，检查 `Status = Published`、`PublishedAt`、`Slug` 和 `Language` 等原有必填项。
2. 切换到 **发布管理**，点击 **发布网站**。任意一行的按钮作用相同：同步整个数据库的已发布文章，不只是这一行；按钮不会修改作者设置的 `Status`。
3. 查看 [GitHub 发布进度](https://github.com/ziyixi/ziyixi.science/actions/workflows/production-release.yml)（Blog 顶部说明也有这个地址）。等待最新运行显示绿色，再查看 [网站](https://www.ziyixi.science)。刚打开时可能需要刷新一次才看到新运行。

日常改 Notion 内容不需要 `git push`、本地同步或手动进入 Vercel。改网站代码时仍需先提交并推送，再发布。

Notion 的“成功”表示请求已送出，不表示网站已经部署完成。最终以 GitHub 的发布验收结果为准。发布进行中再次点击通常会复用当前运行；如果这时又修改了文章，请等它结束后再点一次。

## 三个视图各做什么

| 视图             | 显示的列                                                           |
| ---------------- | ------------------------------------------------------------------ |
| **写作**（默认） | Title、Tags、Language、Summary、Status                             |
| **发布管理**     | Title、网站状态、Notion 编辑时间、线上版本时间、刷新状态、发布网站 |
| **文章设置**     | Title、Slug、PublishedAt、TranslationKey、网站链接                 |

Tags 留在写作视图；两个按钮放在发布管理。所有视图使用同一批文章，不会复制文章。`检查时间`、`已上线指纹` 是辅助属性，不占日常视图；需要排查时可以打开文章属性查看。

## 怎么知道文章有没有更新到网站

写完之后，可以先点 **刷新状态**。它启动单独的 [状态检查](https://github.com/ziyixi/ziyixi.science/actions/workflows/notion-status.yml)，比较整库文章与当前正式网站，并回写状态；**不构建、不部署网站**。等待检查结束后查看：

| 网站状态     | 含义                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| 已同步       | 最近一次检查时，Notion 可发布内容与线上该篇文章一致                       |
| 有修改待发布 | 已上线，但当前 Notion 内容与线上版本不同                                  |
| 未上线       | 正式网站还没有这一篇；Draft 也会显示此状态                                |
| 待下线       | 线上仍有这篇，但 Notion 已改成 Draft 或未来发布日期；下次成功发布才会移除 |
| 待定时发布   | 发布日期还没到，线上没有此篇；到日期后仍需点击发布，当前没有定时任务      |
| 检查失败     | 当前记录无法完成比较，查看状态检查运行详情                                |

`Status` 是你填写的 **Draft / Published 发布意图**，`网站状态` 是检查得出的 **实际网站情况**，两者分开。发布成功后也会自动检查并回写，所以通常只需要点「发布网站」。状态不是实时订阅：修改后在下一次刷新或发布前，旧状态仍可能显示为「已同步」。

时间的含义：

- **Notion 编辑时间**：Notion 自带的最后编辑时间。修改文章或回写属性都会更新它，因此不能单独拿它判断“有改动”。系统实际比较的是文章内容指纹。
- **线上版本时间**：首次确认当前线上内容版本的时间。同一版本反复检查、无变化发布、仅代码更新时保留原值。初次接入或发现未记录的线上版本时，记本次确认时间；不会编造历史发布时间。下线后清空。
- **检查时间**：此次内容比较开始的时间；隐藏在日常视图之外。
- **Blog 顶部网站更新时间**：最近一次新部署通过正式域名验收的时间。刷新状态和跳过重复构建不会改它。

如果 Notion 或网站在读取期间发生变化，检查会失败并保留原状态，避免把混合版本误报为同步。权限或网络失败也可能使旧状态保留，以 GitHub 运行结果和检查时间判断是否为最新结果。发布后的回写失败会显示 GitHub warning，但不会撤回已经验收成功的网站。

## 首次配置与维护

现有网站 Notion integration 除了 **Read content**，还需要 **Update content**。在 Notion My integrations → 对应集成 → Capabilities 中开启并保存；无需新建 token。GitHub production 环境继续使用原来的 `NOTION_TOKEN`、`NOTION_DATA_SOURCE_ID` 和 `NOTION_API_VERSION`。

初始化反馈字段（只在首次安装或补字段时运行）：

```sh
node --env-file=.env.local --import tsx scripts/notion/sync-status.ts --setup-schema
```

本机手动刷新：`make notion-status`。不写 Notion 的预演：

```sh
node --env-file=.env.local --import tsx scripts/notion/sync-status.ts --dry-run
```

这些本机命令绕过 GitHub 的串行锁，只在没有发布或其他状态检查进行时运行。日常优先用 Notion 按钮。当前已发布网站必须具备 `/publication-state.json` 接口才能比较；接口只包含公开文章的不可逆来源标识、slug、内容指纹和构建标识，不包含草稿或原始 Notion page ID。

## 已配置的连接

```text
Notion Blog「发布网站」
  → Cloudflare Worker 验证专用密钥
  → GitHub production-release.yml（main / release）
  → 拉取最新 Notion 内容、校验、构建、部署及验收 Vercel
```

- 中转：`https://ziyixi-notion-publish.cloudflare-579.workers.dev/publish`。
- 刷新状态：同一中转的 `/refresh-status`，固定触发 `notion-status.yml`，没有部署参数。使用相同的专用请求头密钥，不发送文章属性。
- 请求：POST；自定义请求头 `X-Notion-Publish-Secret`。
- 按钮不发送文章属性给中转；中转也不读取、记录或转发 Notion 请求正文。
- 发布参数固定为 `operation=release`、`confirmation=release:www.ziyixi.science`、`force_build=false`、`allow_empty=false`。按钮无法选择恢复模式或其他仓库/分支。
- GitHub 上原来的校验、串行发布、正式环境规则和回退机制继续生效。
- 发布与状态检查共用串行队列，避免状态回写与内容读取同时进行；队列允许等待的请求保留，不会因为按刷新而替换等待中的发布。
- Worker 使用 `workers.dev` 地址，不需要修改网站域名、DNS 或 Vercel 设置。

## 两种密钥分别放在哪里

| 名称                    | 用途                           | 保存位置                                                          |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `GITHUB_DISPATCH_TOKEN` | 只允许目标仓库的 Actions 读写  | 本机 `.env.local` 和 Cloudflare Worker 的 Secret                  |
| `NOTION_WEBHOOK_SECRET` | 验证来自私人 Notion 按钮的请求 | 本机 `.env.local`、Cloudflare Worker 的 Secret、Notion 按钮请求头 |

这两项都不需要放入 Vercel 或 GitHub Actions Secrets，也不要提交到 Git。不要把 GitHub token 填入 Notion。保持 Blog 及按钮编辑权限私有；能读到按钮请求头的人具有触发发布的能力。

## Token 到期时怎么换

1. 在 [GitHub fine-grained tokens](https://github.com/settings/personal-access-tokens) 创建新的 token：Owner 选 `ziyixi`，只选 `ziyixi.science` 仓库，Repository permissions 只增加 **Actions → Read and write**。设置合适的到期时间，并记下续期提醒。
2. 在本机 `.env.local` 更新 `GITHUB_DISPATCH_TOKEN`。
3. 在项目目录运行 `make deploy-relay`。如本机 Cloudflare 登录已失效，先执行下方登录命令。
4. 从 Notion 点击按钮，确认新的 GitHub 运行启动。替换 GitHub token 不需要改 Notion 按钮。

```sh
npx --yes wrangler@4.141.0 login --scopes account:read user:read workers_scripts:write
make deploy-relay
```

`make deploy-relay` 只上传中转代码和上述两项 Secret，不会上传 `.env.local` 里的 Notion、Vercel 等其他密钥。它临时使用仅本机当前用户可读取的文件，完成后删除。

如果要更换 `NOTION_WEBHOOK_SECRET`，本机和 Cloudflare 更新后，还必须同步修改 Notion **两个按钮**里的 `X-Notion-Publish-Secret` 值。

## 点了但没上线

- **GitHub 有运行且仍在执行**：等待完成，不要反复点击。
- **GitHub 有红色失败运行**：进入运行查看失败步骤；不要靠重置密钥或反复点击修复内容校验错误。
- **Notion 报 webhook 错误、GitHub 没新运行**：优先检查 GitHub token 是否到期，以及按钮请求头和 Cloudflare 的共享密钥是否一致。
- **Notion 的动作暂停**：打开「发布网站」列菜单 → 编辑自动化，修复后重新启用/保存。Notion 的 webhook 错误可能使动作暂停。
- **网络超时**：先查 GitHub；请求可能已经到达，避免立刻重复触发。
- **运行成功但没有新部署**：如果代码和已发布内容都未变化，流程可以正常跳过重复构建。

中转无持久化去重数据库；两个几乎同时到达的点击仍可能创建多次运行。GitHub 的并发组会串行发布，内容未变化时会跳过重建。

实现和安全测试见 [中转说明](../integrations/notion-publish/README.md)。官方参考：[Notion webhook](https://www.notion.com/help/webhook-actions)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
