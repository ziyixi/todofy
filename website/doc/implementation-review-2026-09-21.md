# 实现审查与修改建议

审查日期：2026-09-21。对象：当前工作区实现，对照 [技术与设计计划](./plan.md)；本轮只审查并新增本文件及截图，没有修改应用、测试、工作流或原计划。

## 结论与处理顺序

网站的页面结构和整体视觉基本符合已确认的方向，空博客与示例文章均能完成生产构建。但目前不能把“本地构建通过”视为“CI/CD 已可上线”：部署验收本身存在确定的误判，PR 的浏览器配置也有不一致；发布超时后的恢复另有竞态。

共确认 **10 项建议：3 项 P1、5 项 P2、2 项 P3**。P1 应在接通正式发布前处理；P2 中正文相关问题应在迁移真实 Notion 博客前处理。P3 可随正文与 metadata 修正一并完成。这里的等级表示修改优先级，不是已经发生生产事故的断言。

| 编号 | 优先级 | 问题                                                    | 建议时机      |
| ---- | ------ | ------------------------------------------------------- | ------------- |
| R1   | P1     | 部署验收对 canonical 和 RSC 协议的断言错误              | 正式发布前    |
| R2   | P1     | 移动项目实际运行 WebKit，CI 却只安装 Chromium           | PR CI 启用前  |
| R3   | P1     | promotion 超时仍在后台运行，恢复可能过早宣布成功        | 正式发布前    |
| R4   | P2     | 上线成功但 GitHub success 写入失败时，recovery 无法接管 | 正式发布前    |
| R5   | P2     | Notion bookmark 绕过公开集合检查与站内链接重写          | Notion 迁移前 |
| R6   | P2     | 不同标题可能分配相同锚点，目录跳错章节                  | Notion 迁移前 |
| R7   | P2     | 标题前后空格使转换器与校验器不一致，阻断同步            | Notion 迁移前 |
| R8   | P2     | bookmark 的富文本 caption 可能生成嵌套链接              | Notion 迁移前 |
| R9   | P3     | 子页面 Open Graph 覆盖根布局，丢失默认分享图片          | 上线前完善    |
| R10  | P3     | 仅行表头的表格把第一格错误声明为列标题                  | 正文验收时    |

## 验证范围与实际结果

代码和已安装依赖复制到隔离的临时目录后执行检查，构建、快照与测试输出均留在临时目录，避免覆盖工作区现有的 `.generated`、`.next` 和测试结果。当前目录没有 Git 元数据，因此本报告不对应某个可引用的 commit SHA；代码位置以审查时文件为准。

运行环境：macOS，Node **24.19.0**，pnpm **11.25.0**，Next.js **16.3.5**，Playwright **1.63.0**。依赖来自工作区已安装版本，**未证明在干净环境中从 lockfile 重新安装成功**。复制后的 pnpm 路径检查触发过自动安装尝试；因网络不可用而停止，随后恢复独立依赖副本，并仅在审查进程设置 `pnpm_config_verify_deps_before_run=false`，防止重装。没有修改项目的依赖配置。

| 检查                                 | 本轮结果                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm check`                         | 格式、ESLint、类型检查通过；10 个单元测试文件，72 个用例通过                 |
| empty 内容准备、校验、`pnpm build`   | 通过；0 篇博客                                                               |
| fixture 内容准备、校验、`pnpm build` | 通过；1 篇合成测试文章                                                       |
| empty 的现有页面测试                 | 15 通过，1 跳过                                                              |
| fixture 的现有页面测试               | 15 通过，1 跳过                                                              |
| 对 empty 额外启用部署合同测试        | 4 失败：两个根因分别出现在两个浏览器项目，见 R1                              |
| 对 fixture 额外启用部署合同测试      | 同样 4 失败，见 R1                                                           |
| 10 个发布 shell 脚本 `bash -n`       | 通过；这只说明 shell 语法有效                                                |
| 发布恢复故障注入                     | 用本地假 `curl`、`pnpm` 和 JSON 状态复现 R3、R4；没有调用真实云端变更        |
| Notion 转换边界                      | 调用真实转换器和完整快照校验器复现 R5–R7                                     |
| 正文 HTML                            | 内存渲染真实组件复现 R8、R10；检查新生成 HTML 确认 R9                        |
| 浏览器目视检查                       | 首页、博客空态、论文页、示例文章；桌面及 375px 窄屏，见截图                  |
| axe                                  | 现有首页、博客列表、论文页的 serious/critical 检查通过；不代表完整无障碍认证 |

页面测试的 1 个跳过来自实际 WebKit 下的硬件 Tab 用例，详见 R2。现有 axe 用例没有覆盖文章页。

默认测试端口 4173 已被其它服务占用，本轮在 **127.0.0.1:4175** 启动临时副本的 `next start`，使用测试配置已有的 `DEPLOYMENT_BASE_URL` 注入机制。未复用占用端口的未知服务。为同时运行部署合同测试，注入：

```sh
DEPLOYMENT_BASE_URL=http://127.0.0.1:4175 \
DEPLOYMENT_AUTH_MODE=production \
EXPECTED_BUILD_INFO_PATH=.next/server/app/build-info.json.body \
CI=true pnpm test:e2e
```

这里的 `production` 表示本地测试不带候选访问凭据，**不表示已验证 Vercel 生产环境**。预期 build-info 使用本次本地构建产物，验证的是服务输出和路由合同，未验证 GitHub/Vercel 身份链。fixture 第二轮将重试设为 0，避免重复已知失败。

未验证的事项：真实 Notion 授权、真实文章与媒体同步、GitHub 分支保护与 Environment 配置、Vercel 项目保护/套餐/权限、候选访问、DNS、正式 promote 与 rollback 演练。当前这些不属于“已通过”的项目。

## 修改意见

### R1 · P1 · 部署验收与固定 Next.js 版本不兼容

**位置：** [tests/e2e/deployment.spec.ts:100](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/tests/e2e/deployment.spec.ts:100>)、[tests/e2e/deployment.spec.ts:121](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/tests/e2e/deployment.spec.ts:121>)。发布接线为 [.github/workflows/production-release.yml:215](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/.github/workflows/production-release.yml:215>) → [scripts/release/verify-deployment.sh:141](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/release/verify-deployment.sh:141>) → `test:deployment`。

**实际复现：** empty 和 fixture 的生产构建均出现以下两个失败：

```text
/ RSC response: expected 200, received 307
homepage canonical:
  expected https://www.ziyixi.science/
  received https://www.ziyixi.science
```

- 首页 canonical 的两个字符串在 URL 语义上相同。Next.js 16.3.5 的 metadata resolver 正常将根路径序列化为无尾斜杠的 origin；当前测试用字符串严格比较，因此正常页面也失败。
- RSC 探测只发送 `RSC: 1`，未提供 `_rsc` 参数。本地 `next start` 的防缓存投毒校验将其 307 重定向到带正确参数的同一路径；测试一律要求立即 200。所安装 Next 源码的该分支还受 `!minimalMode` 限制，故这里不推断所有 Vercel 运行模式一定返回同样的 307。**canonical 错误断言本身已经足以阻断候选验收。**

这组测试是正式候选发布门禁，失败会阻止后续创建发布记录和 promote。现有 PR E2E 没有设置 `DEPLOYMENT_BASE_URL`，整组部署用例会跳过，因此普通 PR 检查无法提前发现问题。

**建议修改：**

1. 对 canonical 做严格的 URL 规范化后比较，仍检查 origin、pathname、query、fragment；无需为了测试改掉框架正常输出。
2. RSC 专用探测按固定框架协议构造请求；或只允许一次经校验的“同 origin、同路径、仅规范化 `_rsc`”跳转，再核对实际响应。
3. 最终 RSC 响应同时验证 200、`text/x-component` 及私有内容过滤；不要把普通 HTML 200 当作成功。
4. 普通路由合同继续使用 `maxRedirects: 0`，不要全局跟随跳转，避免把候选保护凭据发往错误地址。
5. PR 对本地生产构建运行无云端凭据的部署合同测试。

**验收：** 两种内容模式的部署合同均通过；跨 origin 重定向、错误 canonical、HTML 冒充 RSC 的负例仍失败。

### R2 · P1 · 移动浏览器项目与 CI 安装项不一致

**位置：** [playwright.config.ts:24](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/playwright.config.ts:24>)、[.github/workflows/pr-checks.yml:98](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/.github/workflows/pr-checks.yml:98>)。

项目名称是 `mobile-chromium`，但直接展开 `devices["iPhone 13"]`。该描述符的 `defaultBrowserType` 为 `webkit`。隔离探针继承真实配置、读取 Playwright 解析后的 fixture，得到：

```json
{ "project": "mobile-chromium", "browserName": "webkit" }
```

CI 只执行 `playwright install --with-deps chromium`。干净 runner 没有对应版本的 WebKit 时，移动测试无法启动。本机已有 WebKit，所以当前页面测试通过不能排除此问题。

**建议修改：** 若目标是移动 Chromium，优先改用 Chromium 手机描述符（例如 Pixel）；若确实需要 iPhone/WebKit，则将项目改名 `mobile-webkit`，并在 CI 安装 `chromium webkit` 及对应系统依赖。不要只改项目显示名称。

**验收：** 在干净浏览器缓存的 Linux runner 上运行 empty/fixture 两个矩阵；确认实际 `browserName` 与预期一致，Tab 用例的跳过条件也一致。

### R3 · P1 · promotion 超时后，恢复可能过早宣告成功

**位置：** [scripts/release/rollback.sh:69](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/release/rollback.sh:69>)；触发来源 [scripts/release/promote.sh:102](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/release/promote.sh:102>)；恢复复验 [.github/workflows/production-release.yml:329](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/.github/workflows/production-release.yml:329>)。

`vercel promote --timeout=5m` 返回超时，并不取消后台 promotion。若恢复脚本此时看到正式域名仍是旧版本，就直接跳过 rollback；紧接着旧版复验可能通过，但稍后未结束的 promotion 又把域名切到候选版本。

这不是已经观察到的线上事故；本轮以离线状态注入确认脚本会走该路径，异步切换前提与 [Vercel 官方 promote 文档](https://vercel.com/docs/cli/promote#timeout)一致。

```text
rollback_exit: 0
production already points to the known-good restore target; no rollback mutation needed
CLI recovery mutation issued: False
domain after delayed promotion completed: dpl_candidate
```

**影响：** 流水线可能报告“旧版已恢复且验证”，却无法保证之后仍服务旧版。候选可能尚未完成公开生产复验。

**建议修改：** 把超时归为“结果未知”，查询并协调 pending promotion，确认没有尚未结束的切换，再做恢复和最终公开复验。不能只凭一次域名查询宣布恢复成功。若状态不能确认，应明确进入人工恢复状态并保留门禁。

**验收：** 故障测试覆盖“超时 → 域名暂时仍是旧版 → promotion 延迟完成”，不能出现已成功结束恢复后又被切走；另覆盖真实恢复命令自身超时的状态处理。

### R4 · P2 · 最终 success 写入失败后，recovery 缺少可执行的协调路径

**位置：** [scripts/release/deployment-record.sh:196](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/release/deployment-record.sh:196>)、[.github/workflows/production-release.yml:111](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/.github/workflows/production-release.yml:111>)、[.github/workflows/production-release.yml:294](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/.github/workflows/production-release.yml:294>)、[doc/operations.md:122](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/operations.md:122>)。

**触发：** 候选已经 promote，公开生产检查成功，但 GitHub 最后一笔 success POST 失败，最新记录停在 `in_progress`。因为 promote 和生产复验都成功，现有 workflow 不执行 rollback。

普通 release 会正确阻断；但 recovery 只选择更早的 success 作 baseline，并要求当前正式域名匹配那个旧 deployment ID。域名实际已经服务新候选，因此 recovery 也必失败。手册的“核对后再走 recovery”没有给出可执行的协调步骤。

离线复现：

```text
recovery gate accepted with baseline GitHub Deployment 1
recovery baseline verification:
  Vercel deployment ID does not match the expected ID
```

**建议修改：** 增加明确的受控状态协调：重新验证已上线候选的 ID、完整发布 identity 和路由合同后建立可信 baseline；或提供具体、可验证的“先恢复旧 deployment，再 recovery”流程。不能直接人工把状态改绿来跳过证明。

**验收：** 从“新候选已上线、最后状态写入失败”完整运行恢复流程，最后平台实际服务版本、GitHub 状态与内容 registry 一致；操作手册可按步骤执行。

### R5 · P2 · Notion bookmark 绕过公开页面检查

**位置：** [scripts/content/notion/convert.ts:230](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/content/notion/convert.ts:230>)、[src/components/ArticleBody.tsx:232](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/components/ArticleBody.tsx:232>)。

普通富文本链接通过 `rewriteNotionLink` 校验并重写；bookmark 的 URL 却只经过 `validatePublicHref`。对不在公开文章集合中的假 Notion 页面：

```text
https://www.notion.so/Private-page-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

同一地址在普通富文本中抛 `PRIVATE_NOTION_LINK`，放入 bookmark 却能通过转换和完整 snapshot 校验，随后原始 URL 被直接渲染；没有 caption 时还显示在正文里。公开文章的 bookmark 也不会被重写为本站文章路径。

**影响边界：** 泄露的是私有页面 URL/ID，不是 Notion 私有正文；页面本身仍受 Notion 权限控制。这同时破坏计划中的统一站内链接边界。

**建议修改：** 所有已支持的 URL 字段共用公开集合校验和 Notion 链接重写规则，校验器也守住最终快照边界。

**验收：** 公开 bookmark 转为 `/blog/<slug>`；私有/未知页面拒绝；片段链接按现有明确规则处理，不以 bookmark 绕过。

### R6 · P2 · 标题锚点可能重复，目录跳错章节

**位置：** [scripts/content/notion/convert.ts:85](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/content/notion/convert.ts:85>)、[src/components/ArticleBody.tsx:123](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/components/ArticleBody.tsx:123>)。

用三个合法 heading 块，内容依次为 `Setup`、`Setup`、`Setup 2`，真实转换器输出：

```text
["setup", "setup-2", "setup-2"]
```

完整快照校验仍放行。渲染后第二、第三个标题 ID 相同，第三个目录项会跳到第二章。原因是算法只对各自基础 slug 计数，没有检查最终分配出的 ID 是否已占用。

**建议修改：** 维护整篇文章已分配锚点集合，逐个尝试后缀直到唯一；避开 `main-content` 等保留 ID。快照校验器也验证锚点唯一性，不能只验证 block ID。

**验收：** 重复标题、天然带数字后缀标题、不同文字归一后重名、保留 ID 的组合均唯一且稳定；每个目录链接定位正确标题。

### R7 · P2 · 标题空格使正常文章同步失败

**位置：** [scripts/content/notion/convert.ts:80](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/content/notion/convert.ts:80>)、[src/lib/content/validate.ts:215](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/lib/content/validate.ts:215>)。

目录文本被 `.trim()`，正文 rich text 保留原样；校验器却将未 trim 的正文标题与目录逐字比较。仅一个标题 `"Setup "` 就能使真实转换结果在完整快照校验中抛出 `INVALID_TOC`。

**影响：** 无意输入的前后空格会阻断整个内容同步。这是转换与校验不一致，不是需要作者主动规避的不支持格式。

**建议修改：** 提取一致的标题文本规范化规则，供目录、锚点与校验共同使用，保留正文 rich text 的结构和格式。

**验收：** 前后空格、多 span 边界空格、仅空白标题均有明确行为；正常标题不能再触发内部 `INVALID_TOC`。

### R8 · P2 · bookmark caption 中的链接产生非法嵌套

**位置：** [src/components/ArticleBody.tsx:234](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/components/ArticleBody.tsx:234>)；输入来自 [scripts/content/notion/convert.ts:235](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/scripts/content/notion/convert.ts:235>)。

bookmark 外层链接指向 A；caption 的一段富文本可以自带链接 B。当前渲染器在完整 `RichText` 外再包一层链接，真实组件的内存渲染结果为：

```html
<a href="https://example.com/bookmarked">
  <span><a href="https://example.com/caption">Linked caption</a></span>
</a>
```

**影响：** HTML 不合法，浏览器会修复 DOM，存在点击目标改变及 hydration 不一致的风险。本轮确认的是非法 HTML 输出，未把潜在 hydration 报错当成已经观察到的浏览器事实。

**建议修改：** 把 bookmark 主链接和 caption 分开渲染；或在 caption 作为链接标签时明确去除其中的链接语义，并规定原 caption 链接的处理方式。

**验收：** 含链接 caption 的实际文章没有嵌套 `a`；点击、键盘焦点、浏览器控制台检查通过。

### R9 · P3 · 子页 Open Graph 丢失默认头像与站点字段

**位置：** [src/app/blog/page.tsx:11](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/app/blog/page.tsx:11>)、[src/app/publications/page.tsx:11](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/app/publications/page.tsx:11>)、[src/app/blog/[slug]/page.tsx:31](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/app/blog/[slug]/page.tsx:31>)。

本轮重新构建的 HTML 中：首页含 `og:image`、`og:site_name`、`og:locale`；博客列表、论文页和 fixture 文章都缺失这些字段，只保留各自的 title、description、url、type。

子页重设整个 `openGraph` 对象时不会逐项继承根布局的嵌套字段，符合 [Next.js metadata 合并规则](https://nextjs.org/docs/app/api-reference/functions/generate-metadata#merging)。这使分享子页时无法使用根布局配置的默认头像卡片；具体分享平台可能自行找图，不能保证其最终展示一定无图。

**建议修改：** 通过共享 metadata 构造函数显式带上公共字段，文章 locale 按文章语言确定；检查是否还需要文章发布时间等字段。

**验收：** 从生成 HTML 断言首页、列表页、论文页和文章页都包含正确的 canonical、OG image、site_name、locale，且不混入测试域名。

### R10 · P3 · 行表头的第一格 scope 方向错误

**位置：** [src/components/ArticleBody.tsx:199](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/src/components/ArticleBody.tsx:199>)。

输入 `hasRowHeader=true`、`hasColumnHeader=false`，真实组件输出：

```html
<tr>
  <th scope="col">Mass</th>
  <td>2kg</td>
</tr>
<tr>
  <th scope="row">Speed</th>
  <td>3m/s</td>
</tr>
```

第一行第一格本应也是行标题，当前却仅根据 `rowIndex === 0` 设为列标题，给屏幕阅读器错误的关联关系。

**建议修改：** 分别依据 `hasColumnHeader` 和 `hasRowHeader` 判断 scope；文章页也纳入无障碍检查，避免只扫描三个列表/入口页面。

**验收：** 仅行标题、仅列标题、行列标题同时存在的三种表格语义正确；补 DOM 级断言，不能只依赖截图或 axe 是否报错。

## 页面与设计核对

以下均为本轮浏览器访问临时生产构建的截图，不是原概念图或此前设计 QA 的截图。第 1–4 步为 empty 模式，第 5–6 步为 fixture 模式；fixture 内容仅用于测试。

1. **首页，整体正常。** 姓名没有放大成 hero；导航左对齐；照片与简介并列；Blog 在论文之前；分区靠间距，未出现横贯页面的强分隔线。论文标题与简介/博客使用不同文字风格，首页保留紧凑作者与期刊信息。没有据此提出新的整页改版建议。
2. **博客空态，正常。** 显示 “Writing will appear here.”，没有把旧 CUDA 文章或 fixture 冒充真实博客。
3. **论文页，正常。** 两篇论文显示完整作者、期刊、卷期页码与 DOI/Publisher 入口。这里确认的是当前呈现和已有数据，不代表逐项重新查验了全部外部资料。
4. **375px 首页，正常。** 照片排在简介之前，文字与导航可读；自动化没有发现首页横向溢出。窄屏需要纵向滚动属于当前内容量的正常结果。
5. **示例文章桌面，基本正常。** 代码高亮、公式、表格、嵌套列表与正文可见；展开目录并点击可跳到样例标题。该短 fixture 并未覆盖 R5–R8、R10 的输入组合，也不能替代真实长文验收。
6. **375px 文章，基本正常。** 样例正文无明显裁切，当前浏览器查看未捕获控制台 error。宽表格、长代码、真实图片、中文长文仍需实际 Notion 文章覆盖。

### 1. 首页

![桌面首页实拍](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/assets/review-2026-09-21/01-home-desktop.png>)

### 2. 博客空态

![博客空态实拍](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/assets/review-2026-09-21/02-blog-empty.png>)

### 3. 论文页

![论文页实拍](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/assets/review-2026-09-21/03-publications.png>)

### 4. 窄屏首页

![375px 首页实拍](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/assets/review-2026-09-21/04-home-mobile.png>)

### 5. 示例文章

![桌面 fixture 文章实拍](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/assets/review-2026-09-21/05-article-fixture.png>)

### 6. 窄屏文章

![375px fixture 文章实拍](</Users/ziyixi/Library/CloudStorage/GoogleDrive-xiziyi2015@gmail.com/My Drive/Packages_Personal/website/doc/assets/review-2026-09-21/06-article-mobile.png>)

## 给后续实现模型的建议

按以下顺序修改，保留已经确认的视觉方向、empty 默认模式，以及用户稍后自行迁移 Notion 的安排：

1. 先修 R1、R2，让干净 CI 和本地部署合同能如实验证正常构建。把部署合同测试接进 PR，避免发布时才暴露测试误判。
2. 修 R3、R4，分别补异步 promotion 与 GitHub 状态写失败的故障路径测试，再更新 operations 手册；不要以扩大权限或跳过发布门禁掩盖状态问题。
3. 修 R5–R8、R10，并用具体反例补回归测试。用真实长文验收分页、媒体和正文前，不把当前短 fixture 的通过当作完成迁移。
4. 修 R9，检查最终生成 HTML。已有页面风格可以保留，无需借这些正确性问题重新做视觉方案。
5. 完成修复后再在真实授权环境验证 Notion、受保护候选、公开生产域名和恢复流程；本报告没有声称这些已完成。

本轮交付仅为审查意见与截图，以上修改均未实施。
