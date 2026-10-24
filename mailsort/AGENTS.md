# mailsort：协作与运行边界

先读根 [AGENTS](../AGENTS.md)、[README](README.md) 和 [design](docs/design.md)。

- 当前架构：Cloudflare Worker + 既有 SQLite DO 保管 Gmail 接口、判断、账本及 UI；独立
  `mailsort-runner/` 镜像作为 VPS 小时 CronJob 调 Codex。VPS 不新增 HTTP endpoint。
- 日常仅处理仍未读且没有 P1–P4 的邮件，包含已归档邮件，排除 Spam、Trash、Sent、Draft。
  每封回复独立判断。模型固定 `gpt-6.1-sol` / medium、SDK/CLI 0.163.0；一批最多100封、一次turn。
  prompt 是 Runner 中的单个文件，不加发件品牌特例、概率阈值、多模型投票或自动回退。
- P1 打标签并留 Inbox；P2 两三天内、P3 周末集中看、P4 留作查询，后三者归档。
  不发送、删除、标为垃圾或更改已读、星标、其他标签。模型失败保持未分类，不自动塞进 P1。
- Owner 可以显式 `recheck_all_unread` 重判全部当前未读，含既有 P1–P4；已读不处理。
  超过100封时，未判成员在下次run继续；全部已判后可扫描新邮件，旧待写入仍由账本恢复。
  已完成判断不因普通重试、每日写入等待或prompt变更而重新调用模型。
- Worker两条机器路由只接受专用Bearer，在读取body前鉴权，转DO后用根proto生成转码器。
  Owner JWT/Origin/CSRF不能被机器口令替代。只让这两条精确路径绕过交互式Access。
  Gmail授权留Worker，不复制到VPS/GitHub；机器token原值与摘要分别归Runner/Worker。
- 邮件是不可信数据，模型没有网页、shell或本地工具。正文先清HTML、掩码，再截12k，显式提供
  截断与本地时区。附件不读取。日志、Ops、CI和fixture不含真实邮件、主题、地址、理由或凭据。
- Gmail只经 `worker/src/gmail.ts` 封闭表，修改须先有持久账本。既有off/shadow/live及写入限额继续生效。
  限额等待保留intent，不能为了测试恢复而改预算或把未应用写成成功。日常Alarm只做维护与写入恢复。
- 停用Clef分类、embedding、自动弱学习和回放执行。保留历史记录、旧只读合同和根历史表约定的410。
  不为旧代码重新启用AI绑定，也不为让旧测试变绿而保留假分类路径。
- 个人项目不加模型期间人工改标的额外核对、租约框架或故障矩阵。已有真实复现的历史回读问题
  通过current_labels正确初始化和只处理实际集合变化解决，不增加外部读取。
- 决策内容与批次输入/理由14天；非内容判断、写入和批次记录180天；请求去重1天；计数400天。
  旧学习/回放数据按既有规则保留，不再产生新学习记录。更改处理方或保留期时同步网站隐私页。
- UI分别显示最近开始、完整检查、模型/effort/prompt、判断已保存及待写Gmail；领取成功不算完成。
  无邮件必须有完成回执；失败不借用旧成功冒充正常。超过两小时无完整检查时Home提示，保留关闭机制。
- 验证用合成邮件和独立fake Gmail闭表，覆盖筛选、分页跨run、错误不贴标签、持久写入、全未读重判、
  mode/限额、运行状态、实际CPU及Wrangler smoke。质量对照与流水线测试分别记录，不计算虚假准确率。
- 分支完整CI gate通过后，同一SHA经main发布。首次foundation、镜像发布、模板安装、自然小时运行和
  Gmail实际变化分别验收。Newsletter及其他业务内容不在本任务范围，不能重算它们来验证分类器。
