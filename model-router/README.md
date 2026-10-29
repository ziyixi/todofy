# Model Router

个人云的统一模型入口和私有请求控制台。应用只使用根 `modelrouter.inference.v1`；模型供应商、凭据、回退、缓存和用量换算集中在这里。

- `worker/`：Access、机器鉴权、统一 API、Provider adapters，以及执行模型调用的 `RouterEngine`。
- `web/`：用量、请求详情和 Playground。
- `migrations/`：D1 请求元数据。
- VPS `codex-gateway/`：固定版本的官方 Codex SDK。Router 通过现有 Tunnel 调用它。

## 使用

从 Home 打开 Model Router，或访问部署配置里的 `PUBLIC_HOST`。Playground 可选择模型、思考强度和 JSON Schema。所有应用和控制台共用 Router 的供应商连接，不再选择应用计费配置。供应商 key 是 Router secrets，消费上限设在供应商处。

Codex 使用 VPS 上的订阅登录，OpenAI API 直接调用 Responses API。两者即使使用同名模型也分别显示为
`Codex · gpt-6.1-sol` 和 `OpenAI API · gpt-6.1-sol`；API 的 Router ID 是 `openai/gpt-6.1-sol`。
Todofy 与 Mailsort 在各自设置页从 Router 目录选择模型，保存后用于后续请求，无需修改配置或重新发布。
OpenAI 的赠送 API credit 与 Codex 订阅限额独立；API 估价不会计入订阅参考值。

每次调用返回最终结果，不向应用提供 token 流。输入、指令和输出存入私有 R2，保留 7 天；D1 请求记录和统计保留 90 天。每日备份记录与保留中的正文，副本保存七天，见[恢复说明](docs/backup.md)。用量页按小时/天展示请求、token 和费用趋势；订阅按假设 API 价值单列，API 估价另列。未知用量保持未知。

## 开发和发布

在仓库根目录安装固定 workspace 依赖，执行 `pnpm --filter model-router-worker test` 和 `pnpm --filter model-router-web test`。运行方式和 API 边界见 [设计](docs/design.md)。

正式发布走根 Actions 的 `model-router` 范围；不能直接运行裸 `wrangler deploy`。新账户资源和公开 ID 由既有 bootstrap 导出。运行前只在 Router secrets 中配置供应商连接，名称见 [app.toml](app.toml)；API key 不写进 GitHub、客户端、VPS 或请求记录。

各应用保留自己的提示词、预算、排空和业务处理。修改 Router 不会重算旧邮件、重发 Newsletter，或开启暂停中的工作。
