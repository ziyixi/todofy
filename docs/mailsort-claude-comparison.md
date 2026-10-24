# Mailsort：Claude API 六组实测

2026-10-24。建议日常分类先选 **Opus 5.5 medium**。本轮完整跑了六组、每组一次请求处理同样100封邮件，按API返回的usage和官方标价计算，总计 **$3.514105**。原Codex/VPS方案已撤回，Claude尚未接入生产。

## 实测结果

| 模型与配置 | 输入tokens | 总输出tokens，含思考 | 其中思考tokens | 完整请求耗时 | 标价费用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opus 5.5 low，adaptive | 139,914 | 3,860 | 0 | 34.51秒 | $0.636856 |
| **Opus 5.5 medium，adaptive** | **139,914** | **5,476** | **1,303** | **49.14秒** | **$0.669176** |
| Opus 5.5 high，adaptive | 139,914 | 8,050 | 3,236 | 68.96秒 | $0.720656 |
| Opus 5.5 max，adaptive | 139,914 | 38,242 | 33,116 | 334.04秒 | $1.324496 |
| Haiku 5.5 medium，adaptive | 139,914 | 4,749 | 0 | 27.82秒 | $0.0818295 |
| Haiku 5.5 medium，disabled | 139,913 | 4,454 | 0 | 19.13秒 | $0.0810915 |

六组均正常结束，返回恰好100个唯一ID及合法P1–P4，无缺失、重复或额外ID。没有重试，没有缓存命中，没有工具调用。输出上限统一为65,536，实际均未用满。费用是赠送额度抵扣前的标价折算，尚未按控制台账单对账。

每组只测一次。部分请求并行，耗时包括服务端与网络波动，不能视作稳定性能基准。

## 分类效果

| 配置 | P1 | P2 | P3 | P4 |
| --- | ---: | ---: | ---: | ---: |
| Opus low | 0 | 3 | 7 | 90 |
| Opus medium | 1 | 2 | 7 | 90 |
| Opus high | 1 | 2 | 7 | 90 |
| Opus max | 1 | 2 | 6 | 91 |
| Haiku medium，adaptive | 0 | 8 | 16 | 76 |
| Haiku medium，disabled | 0 | 6 | 16 | 78 |

不能根据四类数量判断好坏。为检查实际偏差，另对24条代表性或有分歧的邮件做了独立AI复核，不提供Claude的回答；其中16条判断较明确、8条有阅读偏好边界。它们是挑选的样本，未经用户逐封确认，不是人工金标准，也不能据此宣称整批准确率。

以下三个切片最影响选择，描述已去掉个人信息：

| 实际需要 | Opus low | Opus medium / high / max | Haiku adaptive | Haiku disabled |
| --- | --- | --- | --- | --- |
| 临近的既定安排发生变化，等两三天会错过，应P1 | P2 | **P1** | P2 | P3 |
| 个人生活的定期汇总，值得周末查看，应P3 | P4 | P4 | P4 | **P3** |
| 已有较新、同内容通知承担后续跟进，旧重复通知可P4 | **P4** | **P4** | P2 | P2 |

由此可见：

- **medium值得保留。** 相比low，一批只多花约3.2美分，补上了临近安排的紧迫性判断。
- **high没有显示出足以成为默认的收益。** medium与high的四类数量相同，但逐封有6处标签不同；在上述明确问题上没有改善，耗时和用量增加。
- **max不适合作为当前默认。** 它比medium贵约一倍、慢约6.8倍；相较high只改了1封标签，仍未修复个人生活汇总的错分。
- **Haiku便宜，但本轮有需要在意的偏差。** 它把那封临近安排放晚，也把重复通知和部分低价值信息抬进主动阅读队列。关闭思考的那一组修好了生活汇总，却把临近安排放得更晚。

Haiku adaptive这一轮实际用了0个思考token，两组Haiku仍有13封标签不同。不能据此断言“关闭思考让它更准”；单次采样和配置差异都可能影响结果。

因此，当前更适合用Opus medium作为起点。prompt仍需明确个人定期汇总的阅读价值；增加思考强度没有自动补上这点。本轮保留原prompt，不新增发件品牌规则或修改生产分类。

## 价格与月用量

官方美元单价，每百万tokens：

| 模型与单次输入长度 | 输入 | 输出，含思考 |
| --- | ---: | ---: |
| Opus 5.5 | $4 | $20 |
| Haiku 5.5，输入不超过100,000 | $0.10 | $0.50 |
| Haiku 5.5，输入超过100,000 | $0.50 | $2.50 |

本轮整批约14万输入tokens，因此Haiku采用高档单价；超过门槛后整次输入和输出都按该档计算。小批邮件可能落入低档，实际生产费用会与本轮不同。[官方价格](https://platform.claude.com/docs/en/about-claude/pricing)

无缓存和工具调用时，Opus的计算式为：

```text
费用 = 输入tokens × 4 / 1,000,000 + 总输出tokens × 20 / 1,000,000

本轮Opus medium = 139,914 × 4 / 1,000,000 + 5,476 × 20 / 1,000,000
                 = $0.559656 + $0.109520 = $0.669176

本轮Haiku medium = 139,914 × 0.50 / 1,000,000 + 4,749 × 2.50 / 1,000,000
                 = $0.069957 + $0.0118725 = $0.0818295
```

思考已经包含在总输出里，不能再次相加。effort没有固定的价格倍率，实际生成多少token才决定费用。[思考计费](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)、[effort说明](https://platform.claude.com/docs/en/build-with-claude/effort)

如果每次都能凑满类似的100封，按每月900–1,200封机械折算：Opus medium约 **$6.02–8.03/月**，本轮Haiku配置约 **$0.73–0.98/月**。这只是满批折算：每小时小批会重复固定prompt及部分思考开销，Haiku也可能进入更低价格档，不能把它当作真实月账单预测。

后续最该避免的是反复重判同一批未读。继续只选“未读且尚未分类”，没有新邮件就不调用模型。当前量级先用普通Messages请求；异步Message Batches虽然有50%折扣，但最长可等待24小时，不适合为了少量费用给及时分类增加等待。[Batch说明](https://platform.claude.com/docs/en/build-with-claude/batch-processing)

## 试验与保留范围

- 模型为`claude-opus-5-5`、`claude-haiku-5-5`，响应模型身份与请求一致；使用官方Python SDK 2.3.0。
- 两模型支持low、medium、high、xhigh、max。本轮按用户要求只选六组，未测xhigh，也未增加其他Haiku档位。Opus不能关闭adaptive；Haiku允许在medium关闭。[Opus资料](https://platform.claude.com/docs/en/models/opus-5-5/overview)、[Haiku资料](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- 100封来自此前同一份私有快照，顺序、正文截断方式、统一冻结的`evaluated_at`及JSON schema不变。每个请求都包含整批，允许参考同一事项的新旧通知。
- 六组试验使用[该版本的原prompt](https://github.com/ziyixi/todofy/blob/511ec5063ecc1cd3602020aa2544f6cf975090f1/mailsort/prompts/priority-classification.txt)，SHA-256为`0c7ab3aa1ccf61a96cb85c1ffb08e1e62c0ec55b18fa909c0bd2b7d675c8c5c5`。后续生产 prompt 的编辑不改变本次试验。
- 私人输入和逐封理由只留本机；公开仓库只有prompt、汇总报告及交接说明。临时API key已在控制台停用，本机key文件已删除，原Brief key保留。
- Codex/VPS批处理实现已撤回，清理提交`1076deda`通过[分支CI](https://github.com/ziyixi/todofy/actions/runs/40125660575)。没有生产发布、Gmail改标或VPS安装。

如果接入Claude，建议直接复用Mailsort现有DO、Gmail接口和写入账本，先用一份prompt与一个模型配置。这条路径不需要新增VPS任务或Codex登录。本轮仅完成评估。
