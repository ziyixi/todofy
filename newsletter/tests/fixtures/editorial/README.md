# 提示词回归基准

这三份文件用于 `tests/test_workflow_content.py` 的文本一致性测试，不参与运行时采编。

- `selection.md`：已采用的选题提示词片段，原实验版本为 v3。
- `discovery-economy.md`、`discovery-technology.md`：包内发现指令的固定基准，原实验版本为 v2。

本次整理只移动文件，不改变内容或测试断言。日常配置应修改 `content-config/`；不要为了让测试通过而直接重写基准。内容质量对比方法见 [评测说明](../../../docs/evaluation.md)。
