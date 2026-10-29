# Newsletter 控制台

每日简报的只读控制台：期刊正文、运行与失败、来源与配置版本、模型调用、投递，以及 Notion 备份的同步状态。
记录以 Newsletter 的 SQLite 为准；Notion 只是它的异步备份，从不作为来源或流程中的一步。控制台不写入、不运行、
不重发、不重试任何东西。

当前阶段：Worker、鉴权、外壳页面与基础设施已就位，尚未部署（`ci_changes.py` 的 `CHECK_ONLY`）。
`newsletter.ui.v1` 的每个方法在鉴权之后回答 `UNAVAILABLE`（原因 `NOT_CONFIGURED`），页面据此显示“尚未接通”；
转发到 Newsletter 的读取路径、Newsletter 自己的读取接口和各个视图随后加入。

## 结构

- `worker/src/`：只接受本主机的 HTTPS 请求；先用 `packages/edge-auth` 验证 owner 的 Access 登录，再只允许 GET/HEAD，
  然后由共享转码器按 `proto/newsletter/ui/v1` 路由。没有任何存储绑定。
- `web/`：React 外壳，只读、仅浅色，沿用 Fleet 的暖纸与墨蓝配色；模型、订阅源与邮件文本一律按文本显示
  （lint 禁止 `dangerouslySetInnerHTML`）。
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

全部使用合成数据与合成 Access 签发者，不连接 Newsletter、主机或任何 Cloudflare 账户。生产只经 main 的 Actions 发布。

## 上线顺序

1. 合并本应用与基础设施改动；`Infra drift` 按设计变红。
2. 分派 `Infra apply`（预期见 [infra README](../infra/README.md#adding-an-app)），创建 Access 应用并加入隧道路径规则。
3. 首次部署的提交写入 AUD（`config/resources.toml` 生成 `ACCESS_AUDIENCE`）、应用 id，并移出 `CHECK_ONLY`、
   `FIRST_DEPLOY_PENDING` 与 `AHEAD_OF_DEPLOY`。
