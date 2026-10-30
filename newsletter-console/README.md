# Newsletter 控制台

每日简报的私人只读界面：概览、期刊、运行、来源、模型和备份。Newsletter 的 SQLite 是权威记录，Notion 只是
异步副本。控制台不能运行、发送、重试或修改任何业务。

```sh
bazel test //newsletter-console:check
bazel build //newsletter-console
```

Worker 验证 owner Access 后，经固定路径把有界 GET/HEAD 转发给 Newsletter 的只读监听。它没有存储绑定，回答
保持 pre-encoded，避免在普通 Worker 内重新解析大正文。前端按需读取期刊/邮件，并隔离展示不可信 HTML。

同一个 owner Access 应用覆盖控制台主机与平台的精确读取路径。转发只使用刚验证的 owner 断言；owner 身份复用
Home 的声明，不新增 service token，也不接收 Home 的其他 secret。

- [Newsletter 控制台合同与监听](../newsletter/docs/console.md)
- [根接口合同](../contracts/newsletter-ui-v1/README.md)、[协作规则](AGENTS.md)
- [CI/CD](../docs/ci-cd.md)、[资源/首次配置](../docs/rebuild.md)

测试使用合成回答、golden fixtures 和假签发者。正常发布先确保 Newsletter 监听与接口可用，再发布控制台；核对
匿名 Access 拦截、实际版本和同一 main SHA 的对账。配置已登记后不重复执行旧首次上线清单。
