# Newsletter 控制台

每日简报的只读控制台：期刊正文、运行与失败、来源与配置版本、模型调用、投递，以及 Notion 备份的同步状态。
记录以 Newsletter 的 SQLite 为准；Notion 只是它的异步备份，从不作为来源或流程中的一步。控制台不写入、不运行、
不重发、不重试任何东西。

当前阶段：Worker 把每个读取转发给 Newsletter 自己的控制台监听（[`newsletter/docs/console.md`](../newsletter/docs/console.md)），
六个页面「概览」「期刊」「运行」「来源」「模型」「备份」都已就位。Access 应用的 AUD 已记入
`config/resources.toml`，Worker 随 main 的 CI 发布（见下文「上线顺序」）。
golden 回答在 `contracts/newsletter-ui-v1/fixtures/`。

## 结构

- `worker/src/`：只接受本主机的 HTTPS 请求；先用 `packages/edge-auth` 验证 owner 的 Access 登录，再只允许 GET/HEAD，
  然后由共享转码器按 `proto/newsletter/ui/v1` 路由并严格解码；`upstream.ts` 把读取以 GET 转给
  `NEWSLETTER_ORIGIN` 的 `/api/newsletter/v1/`，不跟随重定向，15 秒超时，回答按流读取、上限 2 MiB，原样（PreEncoded）
  返回，不解析，只校验 UTF-8。每 MiB 回答最多约 1.5 ms CPU（`worker/test/runtime/cpu.test.ts`），上限是 2 MiB 而不是 4 MiB；
  真实回答只有几百 KiB。没有任何存储绑定。
- `web/`：React 页面，只读、仅浅色，沿用 Fleet 的暖纸与墨蓝配色，每个状态都是形状加文字
  （● 正常 · ▲ 需要关注 · ■ 失败或未发出 · ◆ 未确认或进行中 · ○ 无记录），投递、发布入口与配置状态用 Fleet 和 Home
  的同一套词。「概览」：最新一期、服务状态、最近 14 天、关键数字、今日流程（Notion 备份只是发布旁的虚线分支，不是
  流程中的一步）、外部接口与内容配置。「运行」：按月列出，每次运行有停止原因的白话说明（预算取运行开始时冻结的值）、
  节点时间线、外部调用、选题、模型调用（可打开 Model Router 的请求记录）与投递。「期刊」：按月的卡片（全部、已投递、
  未发出、测试），每一期有三种读法：「阅读」按结构化正文重排，栏目、边界、图表、研究介绍、参考编号与邮件完全一致，
  Todofy 个人事项标明「仅你可见」以及是否写入 Notion 备份；「邮件原样」与「纯文本」打开时才读取冻结的邮件。旁边是
  这一期的记录：运行、投递、Notion 副本（以记录为准）、模型用量与审校。「来源」：内容配置（与 Fleet 同一套词）、
  最近运行冻结的版本、四类输入、每个搜集方向及其订阅源最近 7 次的结果、节点预算与编辑规则；这一页不提 Notion，
  因为备份是记录的输出，不是输入。「模型」：7、30 或 90 天的调用、失败、tokens 与估算费用，按模型堆叠的每日柱状图
  （附表格）与按节点的用时。「备份」：先说明权威记录是 SQLite、Notion 只是异步副本，再列两个库的计数、最早等待与
  需要关注的记录（结果未确认时先核对，避免重复创建）。模型、订阅源与邮件文本一律按文本显示（lint 禁止
  `dangerouslySetInnerHTML`），只有 http 与 https 地址成为链接，并在新标签页打开、不带来源与 opener。邮件 HTML 只在
  `sandbox=""` 的 srcdoc 框里显示，先放一条自己的 CSP（不许脚本与网络，只许内嵌的 `data:` 图片）和
  `<base target="_blank">`（沙箱拒绝新窗口，所以点链接什么也不发生）。页面本身仍是 `STRICT_CSP`：srcdoc 不经网络读取，
  Chromium 与 WebKit 在它之下都正常显示，所以不需要再放宽 `frame-src`。Home、Fleet 与 Model Router 的链接在构建时从
  `wrangler.toml` 读取。
- `deploy/`：部署包装器、Worker 与界面的体积预算、配置测试。

接口合同、传输与鉴权见 [`contracts/newsletter-ui-v1`](../contracts/newsletter-ui-v1/README.md)。

## 鉴权与身份

一个 owner Access 应用（`newsletter-console`）、一个 AUD，覆盖两个目标：控制台主机 `news.<zone>`，以及平台运行主机上的
`/api/newsletter/v1/*`。Worker 转发读取时只携带刚刚验证过的 owner 断言；平台隧道对该路径要求同一个 AUD，
Newsletter 读取之前再验证一次。没有 service token，也不保存任何凭据。

控制台的 owner 就是 Home 的 owner。发布时只从 Home 的身份 secret 和 Home 的 Worker secret 映射中取
`ACCESS_OWNER` 与 `ACCESS_OWNER_ALIASES`（`app.toml` 的 `identity_from = "home"`），Home 的其他值（例如分析 token）
不会到达本 Worker；控制台没有自己的 GitHub secret。

## 本地检查

先在仓库根目录运行一次 `pnpm install --frozen-lockfile`，然后：

```sh
node --test deploy/test/*.test.mjs
cd worker && npm run lint && npm run typecheck && npm test && npm run test:runtime
cd ../web && npm run lint && npm run typecheck && npm test && npm run build
```

全部使用合成数据与合成 Access 签发者，不连接 Newsletter、主机或任何 Cloudflare 账户：Worker 的单元测试与 workerd
测试用假的 Newsletter 回答 golden 答案，界面测试经共享客户端读同一批答案。生产只经 main 的 Actions 发布。

## 上线顺序

1. 合并本应用与基础设施改动；`Infra drift` 按设计变红。
2. 分派 `Infra apply`（预期见 [infra README](../infra/README.md#adding-an-app)），创建 Access 应用并加入隧道路径规则。
3. 首次部署的提交写入 AUD（`config/resources.toml` 生成 `ACCESS_AUDIENCE`）、应用 id，并移出 `CHECK_ONLY`、
   `FIRST_DEPLOY_PENDING` 与 `AHEAD_OF_DEPLOY`。Newsletter 镜像在构建时烘入同一个 AUD：这次提交若不同时发布
   Newsletter，就再发布一次 Newsletter（`workflow_dispatch`，`app=newsletter`，在洛杉矶 07:00 的运行结束之后），
   否则它的监听回答 `NOT_CONFIGURED`，控制台显示「无法连接 Newsletter 服务」。
4. 发布后核对：匿名访问两个主机都被 Access 拦下；owner 打开控制台，「概览」与 Fleet 的数字一致，转发的登录被
   Access 接受（第二个目标）。
