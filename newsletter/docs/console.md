# 控制台只读接口

Newsletter 控制台（[`newsletter-console/`](../../newsletter-console/README.md)）是 owner 查看每日简报的只读页面：
完整期刊正文、运行与失败原因、来源与配置版本、模型调用、投递结果和 Notion 备份状态。页面和 owner 登录在 Cloudflare
Worker 上；所有数据都由本服务从自己的 SQLite 读出并回答。合同是根 proto 的 `newsletter.ui.v1`，语义、边界与一致性规则见
[合同说明](../../contracts/newsletter-ui-v1/README.md)。

**记录以 SQLite 为准。** Notion 只是异步备份：在记录写完之后由复制日志写入，从不作为来源或流水线步骤，在 Notion 中的修改
也不会回写。控制台里的备份状态来自本地复制日志，回答时不调用 Notion。

## 监听与身份

- `NEWSLETTER_CONSOLE_PORT`（默认 0 = 关闭；1024–65535，且不能等于主端口）开启同一进程里的第二个监听，生产清单设为 8081，
  对应宿主机回环端口 18767。这个值只由清单设置，私有 Secret 不能改（`tools/vps-bootstrap/prepare.py` 的 `CONTROLLED`）。
- 路由正好是生成的 `HTTP_BINDINGS`，每个 `/api/v1/` 换成 `/api/newsletter/v1/`，只有 GET；没有 `/healthz`、文档或任何
  引擎接口，主端口也没有这些路由。
- 每个请求先核对恰好一个 `Cf-Access-Jwt-Assertion`，再解码或读取：RS256 与密钥 ID、团队 Access 证书、精确的 issuer 与
  控制台应用的 AUD、过期与签发时间（容许 60 秒偏差）、大小上限，以及 owner 身份断言的形状（有 email 和 subject；
  service token 的断言被拒绝）。实现只是配置 PyJWT，与 Codex 网关相同（`console_access.py`）。不比对邮箱：镜像公开、
  主机不保存个人值；谁能登录由 Access 的 owner 策略决定。
- issuer 与 AUD 都是公开值，镜像构建时从 `config/cloud.toml` 和 `config/resources.toml` 的
  `access_audiences["newsletter-console"]` 烘焙到 `/opt/newsletter/console-access.json`。还没有记录 AUD 时不写这个文件，
  控制台对每个请求回答 503 `NOT_CONFIGURED`，引擎不受影响。改了 AUD 要重新构建 Newsletter 镜像。
- 绑定失败（端口占用等）只记录 `console_listener_failed`，引擎照常服务；控制台在存储打开并恢复之后启动，在 worker 和存储
  关闭之前停止，不接管进程信号。

## 只读

每个回答是一个短的只读快照：独立连接、`mode=ro`、`query_only`、不信任 schema、只允许读取的 authorizer，一个读事务后关闭；
在工作线程里运行，同时最多两个。它不取 `service.lock`/`store.lock`，不登记部署活动，也不写任何表（连监控快照记录的
`monitoring_unknowns` 也不写），所以 drain、frozen 期间照常回答；Pod 重建期间不可用。查询都有上限且按键读取：一个月的运行或
期刊（最多 64）、一次运行的调用（最多 200），冻结输入只取需要的 JSON 标量。

回答由线编解码器写成紧凑 JSON（`console_api.encode`），与 TypeScript 的 `toWire` 字节相同，控制台 Worker 不解析直接转发。
错误是 `google.rpc.Status`，只带 `common.errors.v1` 原因和固定文字；日志只记异常类和散列引用，从不记录断言、请求或记录内容。

## 一致性

规则只在 `console_views.py` 写一次：预算总是运行冻结时的值；运行停止原因的判定顺序；Notion 副本状态的优先级；期刊类型与
Notion 简报库类型同一规则；待核对计数与最近投递使用监控快照的同一谓词和查询（`monitoring_status`），排队与进行中使用部署 gate 的同一谓词（与 Fleet 的“排队”“进行中”相同）；配置状态使用
`monitoring_api.config_status` 的同一读取和 Fleet 的同一判定。上线前没有记录的字段（模型调用的时间、目的、Router 请求，订阅源
计数，备份进度时间）保持缺省，界面写「上线前未记录」，不显示为 0。

## 测试与 fixture

- `tests/support/console_world.py` 用引擎自己的建表和固定时间写出一个合成世界（10-27 已投递、10-28 选题超出冻结预算后
  无可发布内容、10-29 Notion 同步中、修订、样张，以及全部 Notion 副本状态），没有任何生产数据。
- `contracts/newsletter-ui-v1/fixtures/` 是读接口对这个世界的 golden 回答。`bazel test //newsletter:tests_test_console_contract`
  校验，fixture 重写只用于有意的合同更新；`proto/test/newsletter-ui.test.ts` 用 TypeScript 编解码器逐字节往返。
- `test_console_access.py`、`test_console_read.py`、`test_console_readonly.py`、`test_console_listener.py`、
  `test_console_views.py`、`test_console_api_surface.py`、`test_console_contract.py` 覆盖身份、读取规则、只读、监听生命周期、
  纯规则、路由和字节；镜像 smoke 检查烘焙的策略，并确认无登录请求被拒绝、引擎路由不在控制台端口上。
