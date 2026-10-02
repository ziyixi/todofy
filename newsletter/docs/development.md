# 开发：小模块，显式装配

保留一个服务、一个 SQLite、一个串行 worker。`create_app(settings, editor=..., notion=..., ...)` 是组合入口；测试直接注入已有 Protocol 对象，不需要全局单例、依赖注入容器、插件注册表或新增框架。

## 先找职责，再改代码

| 想改什么 | 从哪里开始 | 不该顺带做什么 |
| --- | --- | --- |
| 收集题材、信源、读者偏好 | 仓库根目录的 `content-config/` | 不把个性化内容硬编码进路由 |
| 接口、鉴权、响应 | `app.py`、`contracts.py` | 路由不创建供应商或持有自己的数据库 |
| 启动、依赖检查、资源关闭 | `lifecycle.py`、`preflight.py` | 不在 import 时登录、联网或启动 worker |
| 停机维护与投递账本 | `admin.py`、`ownership.py`、`delivery.py` | 不另建恢复worker、不绕过目录锁或发送审批 |
| 采集、整期状态流转 | `collection/`、`workflow/pipeline.py` | 不绕过冻结的证据/投递策略或直接发送 |
| 选题采编、独立审校 | `workflow/story_editor.py`、`story_nodes.py` | 不把私有事件交给公开研究 |
| 版本/checkpoint、确定性拼版 | `workflow/publication.py` | 不将未审内容或被明确撤回的版本自动提升为已核实 |
| SDK调用、旧整期总编 | `editor.py` | 不把旧整期HOLD重新施加到新选题流程 |
| 模型结构、JSON和工作目录 | `model_schema.py`、`model_io.py` | 不从另一个角色的 schema 内层取字段，不借用其私有 helper |
| 邮件、预览、图表 | `rendering.py`、`templates/`、`charts.py` | 不让排版依赖 HTTP app，不执行模型 HTML |
| 供应商、事务与队列 | `adapters.py`、`todofy.py`、`store.py`、`worker.py` | 不为未来假设的后端建立通用框架 |

除第一行外，路径均相对于 `src/newsletter/`。包内 `instructions/`、`policy/` 和模板仍用于初始配置、离线演示及旧运行兼容，不是需要删除的重复文件。新增供应商先实现现有 Protocol，再在 `lifecycle.py` 显式选择；同步补 settings 校验、启用时的 preflight 和离线故障测试。新增公开字段先改公共 proto，由公共仓库生成、验证并发布 `ziyixi-protos` GitHub Release wheel，再更新 newsletter 的精确版本/URL/uv 锁；本仓库不生成或复制 protobuf。

`lifecycle.py` 统一拥有目录锁、Store、后端和 worker：先检查，再启动；关闭时先取消并等待 worker，再关闭 Store。它不承载 HTTP 路由。`model_io.py` 仅处理模型数据边界，不成为通用 utils 集合。`charts.py` 仅负责 PNG 与字体；引用编号、正文和冻结 hash 仍由 renderer 管理。

## 扩展时保留这些约束

- 每次外部触发快照化指令；相同幂等键不重复研究、创建 Notion 页或发送。
- SQLite 是状态权威，Notion 是单向材料投影；写入结果未知不自动重试。
- 模型输出必须通过结构、引用及来源访问校验，不能靠删校验换取 ready。
- 新选题先保存独立已审简版再深读；错误/截止只能拼接已核实完整版本，每个选题都有覆盖记录。新策略下 Notion 故障不阻塞发信，旧冻结绑定仍保留原门槛。
- 真实/private 材料不进入 fixture 或测试报告；个人事件不进入公开模型上下文或材料库，私人 Notion 档案必须显式授权。
- 冻结预览与发送解耦：只有独立 send 权限和精确 hash 审批能发送，整期采编不发送。

## 验证与目录卫生

```sh
make format
make check
make proto-check
make build
make smoke
uv run --locked --extra codex python scripts/smoke_wheel.py
```

`make format` 运行 Ruff formatter，不修业务逻辑或关闭规则。`make check` 依次执行
锁检查、`make lint`、`make typecheck` 和完整离线测试；CI 使用相同入口。

- Ruff 统一80列、Google 风格公开 docstring、模块级绝对导入、命名、异常边界与
  pytest 断言；McCabe 复杂度上限15。docstring 写调用契约、返回/失败边界，
  不靠重复函数名或批量占位说明满足规则。
- 导入模块再引用成员，例如 `import newsletter.store as store`；类型辅助模块
  `typing`、`typing_extensions`、`collections.abc` 与 `__future__` 是明确例外。
  生成 protobuf 作为模块导入，不复制其对象到应用门面。
- `scripts/check_python_structure.py` 静态解析 AST，不导入应用：拒绝跨模块私有
  对象导入、直接从测试模块借构件、核心层依赖 HTTP/CLI、嵌套三元和裸 `except`。
  `BaseException` 仅允许清理/持久化后无条件原样抛出，不能吞取消或终止。
- mypy 检查手写源码、脚本及 `tests/support/`，要求类型签名、容器类型参数，
  检查未类型化调用、返回 Any、无效 ignore、不可达分支及严格相等性。

供应商或后台隔离边界确需 `except Exception` 时保留具体理由与局部 `noqa`，
不整文件豁免。使用 `diagnostics.record_failure` 记录安全 phase/异常类型/哈希ID，
不输出异常正文、原始ID、供应商响应或私人数据。SQL 归各自 repository/journal；
需要跨仓储原子操作时用明确的 `*_in_transaction` 方法并持有外层事务，不能套一层
会再次 `BEGIN` 的公开方法。`files.py` 只共用有界读取/原子写入基础操作，路径可信度、
schema、模板安全与冻结配置校验仍留在各自调用边界。

共享合成构件放在 `tests/support/`；生产模块与测试模块不依赖 `test_*.py`。
缺少覆盖时增加真实边界断言，不能删 durability/security 测试来换取门禁通过。

默认 pytest 禁止外网，fake 只用于显式离线测试。`make smoke` 使用真实本机 HTTP，但供应商为 fake，只写一次临时模拟 EML；wheel smoke 在源码目录外用同一锁安装并运行 demo。真实供应商联调按 [单独清单](live-acceptance.md) 授权进行；不属于重构的默认门禁。

`make proto-check` 验证已安装 `ziyixi-protos==0.1.0.dev7` 的代码、stub、descriptor、来源清单和发行版本，不需要另一个仓库或 protoc。公共包通过 `import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2` 使用；类型随公共 wheel 分发。不要改生成文件、重新加入 `src/newsletter/generated/`，或把生产依赖改为本地 `path`/editable。protobuf 的 HTTP/wire 字段语义及 schema 顺序仍须回归；生成文件的 Python 模块名或虚拟 proto 文件路径不等于业务消息包名。

公共服务只有 `StartRun`、`GetRun`、`GetEdition`、`SendEdition`；健康检查与冻结预览
是另外两个只读 HTTP 入口。维护命令不回到 HTTP 层，参数和停机要求见
[维护说明](maintenance.md)。

GitHub wheel URL 属于 `tool.uv.sources`，不是 PyPI 索引。只把 newsletter wheel 交给普通 `pip install`，无法自动发现这个仅在 GitHub 发布的依赖；部署使用本仓库的 `uv.lock`。安装包 smoke 会先从同一锁导出带 hash 的依赖并安装，再在源码目录外安装 newsletter wheel，验证真实分包边界。

移动渲染逻辑时，在同一环境保留改动前的 HTML/text/PNG/hash 并逐字比较；字体差异意味着跨系统 PNG hash 不宜硬编码成统一 golden。模型流程重构同时比较提示词、SDK 参数和 schema 字段顺序，不能只看新代码自己的测试是否通过。

源码与资源在 src/，回归在 tests/，可重复运行的验证工具在 scripts/。本机缓存、dist、demo 和一次性对比证据只进被忽略的 `.artifacts/`；保留一个 `.venv`。凭据、登录缓存、真实服务数据与预览使用仓库和同步盘之外的私有目录。不要把临时调查脚本提升为长期工具，除非确实需要重复运行。

现行操作说明放在 `docs/`，提示词回归基准放在 `tests/fixtures/editorial/`。
旧验收报告和未采用的提示词保留在 Git 历史，不与现行说明混放。
内容质量对比仍使用 `scripts/evaluate_prompts.py`，方法见 [内容评测](evaluation.md)。
