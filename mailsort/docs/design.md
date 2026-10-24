# Mailsort：小时邮件阅读队列

## 1. 使用方式

每小时整点检查一次未读邮件。普通批次只选没有 P1–P4 的邮件，已归档也可选；不处理
Spam、Trash、Sent、Draft。分类依据是内容和最晚合理阅读时间，模型固定 6.1 Sol medium。

P1 及时看并留 Inbox，P2 两三天内、P3 周末、P4 留作查询，后三者归档。保留邮件、已读、星标与
其他标签；不创建 Tasks、不定时把邮件搬回 Inbox。Gmail 自身的垃圾邮件处理不变。

Owner可在分级页登记一次“重新判断全部未读”，把已有P1–P4也纳入。它走同一小时链路，已读不处理。
日常不自动重判旧结果。当前界面移除旧学习、回放、模型神经元预算及三套临时重判入口。

## 2. 存储与保留

沿用一个SQLite DO，不新增数据库或对象桶。既有labels/decisions/ledger/pending/unread_batch继续使用。
`classification_items`保存一次run选择的掩码输入、原标签、判断和账本关联；meta保存最近run的状态。
同一个run/request ID用于本次分页与提交重试；下个小时使用新run ID，未上报结果可重新判断。

| 数据 | 保留 |
| --- | --- |
| 决策中的掩码主题、发件人、摘要、理由；批次掩码正文及理由 | 14天 |
| 无内容的决策、账本、批次身份及结果 | 180天 |
| 请求去重及冻结回复（可能含掩码内容） | 1天 |
| 日计数 | 400天 |
| 历史学习例子及回放 | 既有保留规则；新链路不再产生 |

Gmail OAuth secrets仅在Worker。Runner仅有独立Codex登录卷和一枚机器Bearer。原值存Kubernetes
Secret，Worker存SHA-256摘要；日志只记run ID、数量、状态及固定错误码。

## 3. 边界与数据流

1. k3s `mailsort-runner` CronJob按UTC整点运行，禁止重叠，失败不由Kubernetes立即反复重跑。
2. 向Worker的`classification:claim`领取输入。Worker先机器鉴权，复杂准备在DO；每页最多10封，
   一次模型批次最多100封。Owner全未读请求剩余成员保持原范围，下一run继续。
3. MIME提取、HTML清理、掩码后，正文最多12k字符；带真实截断标志、收件时间、当前时间与本地时区。
   不下载附件。完整分页后才调用一次SDK turn，结构化返回每个ID的P1–P4与短理由。
4. Runner用`classification:report`提交结果、SDK模型/effort、prompt hash及累计token。
   Worker持久保存判断，借助既有ledger登记Gmail操作；Alarm按已有请求和写入预算推进。
5. 返回“已接收”只证明判断落库。Gmail的成功、等待与失败由账本单独记录。

协议：[根proto](../../proto/mailsort/runner/v1/mailsort_runner_service.proto)。Owner继续用`mailsort.ui.v2`，
机器口令没有owner API权限。只有精确claim/report路径配置Access Bypass，应用Bearer仍必须校验。
VPS没有新的入站端口、Tunnel、HTTP server或任意prompt执行接口。

模型只读取邮件数据，不执行其中指令或访问链接。现有100封试验使用同一prompt比较medium/high/max，
支持medium作为日常默认；这些是一次批次观察，不是独立标注的准确率。真实私人样本不进仓库或fixture。

## 4. 写入与失败

- off不读Gmail/不判断；shadow记录判断但不写；live才登记自动写入。部署模式上限和owner模式保留。
- 已保存判断、尚未写入的邮件不再送模型。达到每日或每轮写入上限时等待，保留原intent。
- 一次全未读cohort全部已判后，新小时任务可继续扫描新邮件，不等待旧写入全部完成。
  UI的待写入数来自全局有效intended账本，不能因下一run为空而显示0。
- 模型登录、额度、网络或输出失败不生成分类，下一小时继续。没有Clef或P1程序回退。
- 请求重放复用既有账本/去重；Gmail原有重试机制保留。相同优先级不做无必要的标签写入。
- 新决定以claim时的实际优先级初始化current_labels；旧自动写入的history回读不会误作owner修改。
  不增加模型期间改标的特殊并发协议。

## 5. 状态和界面

概览显示最新批次状态、最近开始与最近成功完成、实际模型和prompt、选中/已判及全局待写数量。
空批次也必须明确report完成，才更新完整检查时间。失败时保留旧完成时间但显示当前错误，超过两小时
未完整检查会提示检查Runner。Token缺失显示未提供，不把不完整记录当0或换算成精确订阅账单。

Home沿用Mailsort Ops，只读数量和固定状态码。Fleet的runner观测是`observation_scope=template`，
只证明已安装的CronJob与固定镜像模板；它不是实际模型执行或Gmail成功的证据。
不再发布旧Workers AI额度、神经元预算或降载能力。Gmail每日写入上限等待显示为信息提示，
判断和待写入账本保留，次日继续；owner可在现有设置中按需调整每日上限。

## 6. 构建、发布与首次安装

- Runner是独立`ghcr.io/<repo>-mailsort-runner`镜像，SDK/CLI锁0.163.0，Python锁版本与现有VPS一致。
  `prompt.txt`随镜像发布并自动hash。生产不直接import Newsletter。
- GitHub分支CI通过后，同一SHA在main构建/部署；Worker保留Gmail secrets，机器摘要由部署secret map注入。
- Access精确机器路径走现有Infra apply，资源纳入清单与漂移核验。不要在网页临时放开整个路径前缀。
- 首次用CI固定版本bundle安装独立auth卷/Secret及新的Platform镜像；之后受管资源由现有daemon发布。
  具体输入和命令见[首次runner foundation](../../tools/vps-bootstrap/README.md)。
- Codex使用Runner独立登录，不共挂或修改Newsletter的登录卷。正式发布后等自然小时任务，分别核对
  batch完成、实际模型身份、Gmail写入和Home；不会启动真实重算来替代自然调度验收。

## 7. 检查与兼容

Worker单测、workerd实际SQLite、UI、Free CPU与完整本地Wrangler smoke使用合成输入、独立fake Gmail闭表。
测试验证实际结果，不靠mock调用次数宣称业务成功。根IDL跑lint/API lint、breaking与schema；Runner
验证一次完整模型turn、分页、JSON结果、失败与用量；实际Docker构建由CI完成。

旧判断、账本和旧API字段保持历史可读。旧回放启动不再执行，旧神经元字段不再代表当前模型预算。
`/api/v1`的410保留到2026-11-10。一次性旧标签迁移的历史说明见[priority-rollout](priority-rollout.md)，
其中旧Clef校准与原100重判不是当前自动运行方式。
