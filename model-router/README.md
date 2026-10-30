# Model Router

个人云的统一模型入口。应用使用根 `modelrouter.inference.v1`；供应商协议、连接、用量和估价集中在 Router。
私人控制台提供调用趋势、请求详情和 Playground。

```sh
bazel test //model-router:check
bazel build //model-router
```

- `worker/`：鉴权、统一 API、供应商适配和 `RouterEngine`。
- `web/`：用量、详情、Playground。
- `migrations/`：D1 请求元数据；输入/输出放私有 R2。
- VPS `codex-gateway/`：固定版本的官方 Codex SDK，保留既有订阅登录。

Todofy、Mailsort 在各自设置页选择模型，无需重新发布。Codex 与 OpenAI API 的同名模型分开：
`gpt-6.1-sol` 使用订阅，`openai/gpt-6.1-sol` 使用 API。费用趋势也区分 API 估价与订阅参考价值。
模型目录和费率以代码为准，未报告的用量不按零计算。

供应商 key 只在 Router secrets，不进 GitHub、客户端或 VPS。普通调用一次返回最终结果；应用保留自己的
提示词、预算和业务重试。修改 Router 不会重算邮件、重发 Newsletter 或解除应用暂停。

输入/输出保留 7 天，元数据保留 90 天，每日备份保留七天。详见[接口和数据](docs/design.md)、
[发布](docs/deployment.md)、[恢复](docs/backup.md)与[验收边界](docs/verification.md)。
