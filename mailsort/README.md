# Mailsort

私人 Gmail 阅读队列，使用四个单层英文标签：

| 标签 | 含义 | Gmail 动作 |
| --- | --- | --- |
| P1 | 需要及时查看 | 留在 Inbox |
| P2 | 两三天内查看的重要信息/跟进 | 归档 |
| P3 | 值得周末查看的周期总结/内容 | 归档 |
| P4 | 留作参考的通知和促销 | 归档 |

不标已读、不发送、不删除邮件；星标和无关标签保持。没有自动提醒或任务创建。

```sh
bazel test //mailsort:check
bazel build //mailsort
```

## 使用

设置页可修改模型、思考强度、分类间隔和提示词，无需重新发布。模型目录来自 Router，明确区分 Codex 订阅和
OpenAI/Claude/Gemini API；凭据只在 Router。基础提示词有合成输入/JSON 输出例子，个人规则可覆盖偏好，代码
不维护品牌/发件人硬编码分支。保存只影响之后的批次，不重判已分类邮件。

自动分类默认每 15 分钟，范围限定最近 48 小时仍在 Inbox 且无 P1–P4 的邮件，已读也包括。每批最多十封，一次
模型请求；已接受的积压保留自己的重试/额度等待。手动未读操作有独立明确范围，不会因部署自行启动。

Off 不执行；Shadow 记录判断但不改 Gmail；Live 应用判断。部署上限可降低用户模式。失败不会伪造 P1，缺失费用
估算不会把成功结果变成失败或触发另一次付费请求。API 用量/估价主要在 Router；Claude 的既有本地记录消费限制
仍只在选择 Claude 时生效，历史不会因切换模型清零。

## 维护

一个 Worker/UI 和现有 SQLite DO 保存 Gmail 授权、配置、待办与写入账本。`gmail.ts` 是唯一 Google 操作入口；
应用只通过统一 Router 合同调用模型。Gmail 凭据由 owner 配置，发布不覆盖，不进入 GitHub。

日备份保留完整数据和恢复能力，恢复不重放 Gmail 写入。正常发布走同一 green SHA 的 Actions，完成实际配置对账；
不会改变已保存模型、模式、提示词、额度或已有邮件。

- [设计与错误处理](docs/design.md)、[协作规则](AGENTS.md)
- [备份与恢复](docs/backup.md)、[验收](docs/verification.md)
- [历史 P1–P4 切换](docs/priority-rollout.md)
- [根构建/依赖](../docs/bazel.md)、[CI/CD](../docs/ci-cd.md)

测试使用真实 workerd/SQLite 与假 Gmail/模型，覆盖分类结果和实际写入。交互式开发保持原 local-only 入口，
build/test/type/lint 等检查脚本委托 Bazel。当前提示词是业务输入，不是可随文档清理改写的说明文字。
