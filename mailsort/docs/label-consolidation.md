# 旧主题标签整理

主题标签已由固定 P1–P4 阅读分级取代。标签合并于 2026-10-11 完成，旧整理实现、Gmail 操作和 UI 已移除；
旧 RPC 只提示刷新。新环境使用[分级初始化](priority-rollout.md)，不运行旧合并计划。

## 2026-10-11 上线与生产整理

`4a48878a011106f49b62046394c5cdc570c7fdee` 的
[分支检查](https://github.com/ziyixi/todofy/actions/runs/38177634581)与
[同 SHA 发布](https://github.com/ziyixi/todofy/actions/runs/38177844303)通过。
当次私有 15→12 整理完成，12 个启用标签均为单层英文名称；未物化的来源标签没有需要交换的历史邮件。
既有 Gmail ID、历史决策、例子和可信设置保留，敏感分类仍不存例子。恢复正式模式后观察到后续自然同步，
未以此证明新邮件的分类效果。

分页搬移、已有目标、归档邮件和中断恢复由合成测试覆盖。完整旧记录及已退役操作说明见
[当时版本](https://github.com/ziyixi/todofy/blob/288e5ef7c9e3df3761b45b0e436b86503bf38cba/mailsort/docs/label-consolidation.md)。
这些说明仅用于解释历史记录，不是当前操作手册。
