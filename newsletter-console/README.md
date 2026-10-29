# Newsletter 控制台

每日简报的只读控制台：期刊正文、运行与失败、来源与配置版本、模型调用、投递，以及 Notion 备份的同步状态。
记录以 Newsletter 的 SQLite 为准；Notion 只是它的异步备份，从不作为来源或流程中的一步。控制台不写入、不运行、
不重发、不重试任何东西。

当前阶段：Worker 把每个读取转发给 Newsletter 自己的控制台监听（[`newsletter/docs/console.md`](../newsletter/docs/console.md)），
页面有「概览」与「运行」；「期刊」「来源」「模型」「备份」随后加入。首次部署等 `Infra apply` 创建 Access 应用、
AUD 记入 `config/resources.toml` 之后（见下文「上线顺序」），在此之前仍是 `ci_changes.py` 的 `CHECK_ONLY`。
golden 回答在 `contracts/newsletter-ui-v1/fixtures/`。

## 结构

- `worker/src/`：只接受本主机的 HTTPS 请求；先用 `packages/edge-auth` 验证 owner 的 Access 登录，再只允许 GET/HEAD，
  然后由共享转码器按 `proto/newsletter/ui/v1` 路由并严格解码；`upstream.ts` 把读取以 GET 转给
  `NEWSLETTER_ORIGIN` 的 `/api/newsletter/v1/`，不跟随重定向，15 秒超时，回答按流读取、上限 2 MiB，原样（PreEncoded）
  返回，不解析。每 MiB 回答约 1–3 ms CPU（`worker/test/runtime/cpu.test.ts`），所以上限是 2 MiB 而不是 4 MiB；
  真实回答只有几百 KiB。没有任何存储绑定。
- `web/`：React 页面，只读、仅浅色，沿用 Fleet 的暖纸与墨蓝配色，每个状态都是形状加文字
  （● 正常 · ▲ 需要关注 · ■ 失败或未发出 · ◆ 未确认或进行中 · ○ 无记录），投递、发布入口与配置状态用 Fleet 和 Home
  的同一套词。「概览」：最新一期、服务状态、最近 14 天、关键数字、今日流程（Notion 备份只是发布旁的虚线分支，不是
  流程中的一步）、外部接口与内容配置。「运行」：按月列出，每次运行有停止原因的白话说明（预算取运行开始时冻结的值）、
  节点时间线、外部调用、选题、模型调用（可打开 Model Router 的请求记录）与投递。模型、订阅源与邮件文本一律按文本
  显示（lint 禁止 `dangerouslySetInnerHTML`）。Home、Fleet 与 Model Router 的链接在构建时从 `wrangler.toml` 读取。
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
