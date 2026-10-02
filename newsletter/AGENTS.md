# Newsletter 开发边界

遵循根 AGENTS.md。此目录为独立 VPS 引擎，不迁入 Worker/DO，不读其它应用数据库，
不改现有 Python DAG、模型或发送账本来配合发布。SQLite 是权威运行状态，Notion
是异步副本。原料、模型输出、URL 与供应商响应均为不可信内容。

镜像固定 `ghcr.io/ziyixi/todofy-newsletter`，构建 context 为 `newsletter/`。CI 位于根
`.github/workflows/`，不添加此目录下的嵌套 Actions。本次保留锁定的外部
`ziyixi-protos==0.1.0.dev7` 依赖；共享 proto 迁移须另行设计，不顺带替换。

保持 service.lock 单一 owner、稳定 run/request/provider key、冻结输入、unknown
不自动重放。部署使用 [持久排空合同](docs/deployment-drain.md)：新业务 admission
与活动登记原子核对 gate；freeze 需同时核对活动与实际 submitting 账本。
取消的本机活动在旧进程存活期间不能伪装为已经结束；restart recovery 只在独占锁下。
内部部署 JSON 接口只用既有 send 机器身份，不扩展 owner UI 或跨应用 RPC。

不读取/提交私有 env、登录缓存、生产内容与备份；不调用真实模型/Notion/发信来
代替测试。测试默认禁止网络，使用合成 fixture；记录检查与生产验收的区别。
不得把 secret、个人生成内容或生产路径放日志/报告。依赖、源码和运行状态不混用。

从本目录运行 `make check`、`make smoke`、`make smoke-codex`、`make build`，
再执行 `uv run --locked --extra codex python scripts/smoke_wheel.py`。
容器验收用 `scripts/smoke_image.py`，不手工在 VPS 构建。来源记录见
[import-source.md](docs/import-source.md)。
