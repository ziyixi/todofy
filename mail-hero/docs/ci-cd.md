# Mail Hero 构建与发布

Mail Hero 使用根 [CI and deploy](../../.github/workflows/ci.yml)。Bazel 的依赖闭包选择受影响检查，Actions 保留发布权限、各应用锁与部署顺序。

```sh
bazel test //mail-hero:check
bazel build //mail-hero
```

检查包括 Worker 类型/lint/unit、真实 workerd D1/R2/SQLite DO、独占 CPU 回归、Web 类型/测试/体积预算，以及 webhook/ops golden 和离线恢复。IDL、schema 与共享包依赖在 BUILD 中显式声明；Bazel 不自行推断合同或跨包语义。

`//mail-hero` 归档编译后的 Worker、完整 assets、权威 Wrangler 配置和 migrations。分支不接触生产密钥。main 的 CI gate 通过后，Actions 验证同一 source SHA/归档摘要，运行兼容 migration，再用编译入口和 `--no-bundle` 提升原字节；发布阶段不重新从源码打包。

## 配置来源

唯一生产来源是 [`wrangler.toml`](../wrangler.toml) 顶层。绑定、路由与静态值公开提交；个人值只通过 secrets-file，运维开关及 BUILD_SHA 只经 `deploy/deploy-vars.mjs` 校验注入。不添加 env 分支、keep_vars 或生成的并行生产配置。

运维变量为 `MAIL_HERO_FORCE_SEND_PAUSED`、`MAIL_HERO_MAINTENANCE_MODE`、`MAIL_HERO_NATIVE_BACKUP_ENABLED`。它们分别控制投递、维护和未来自动备份；关闭自动备份不取消已开始的快照。变量变化仍走既有受控发布，避免下次部署覆盖现场状态。

既有 `CREDENTIAL_KEY` 和独立机器凭据的责任不变。发布不读取或轮换这些值，不重写 D1 内的目标密文。应用状态（archive/forward、目标选择、目标暂停）不随普通代码发布重置。

## 验证与恢复

- Migration 在旧 Worker 仍运行时执行，必须向后兼容。当前代码升级不授权清库、删桶或解除暂停。
- 发布成功只证明交付步骤完成；还要区分实际邮件接管、来源转发、Todofy 后续业务和恢复验收。
- 恢复到新 D1/R2 或修改 stateful binding 属于独立受控切换，先隔离恢复、校验和对账，再更新权威配置与资源登记；不能用普通 push 绕过 stateful binding 守卫。
- webhook golden 由真实 builder 生成，legacy fixture 保留原 bytes。修改合同后运行根/应用对应 Bazel 检查，审阅变化并验证所有消费者。

原生备份随本 Worker 的同一版本发布；它不构建 VPS collector。格式和恢复见[原生备份](native-backup.md)、[恢复工具](../deploy/backup/README.md)，历史提交映射见[来源表](history-map.md)。
