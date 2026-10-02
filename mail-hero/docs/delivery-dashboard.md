# 投递 Dashboard 的统计口径

Dashboard 使用现有 Cloudflare Access owner 身份访问 Mail Hero API，读取 D1 中的 webhook 投递尝试记录；不读取邮件正文，也不引入图表服务或新的付费产品。

`mailhero.ui.v2` 的 `SummarizeDeliveryAttempts`（`GET /api/v2/deliveries/-/attempts:summarize?start_time=<RFC 3339>&end_time=<RFC 3339>&granularity=hour|day&time_zone=<IANA 时区>`；下文的 `from`、`to`、`bucket`、`tz` 即这四个参数）使用半开区间 `[from, to)`，以尝试的 `finished_at` 按 `tz` 的本地小时或本地日期归桶。Dashboard 发送浏览器时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`），区间、图表和明细表都按该时区显示并注明缩写（如 PDT/PST）；URL 与 API 中的 `from`、`to` 仍是精确的 UTC ISO 时刻，下钻链接不随查看者时区产生歧义。`tz` 最长 64 字符，只允许字母、数字和 `_+-/`，且须为 Worker Intl 可识别的时区，否则返回 400「时区无效」（原因 `INVALID_TIME_ZONE`）。浏览器每次计算区间时重新读取时区，打开的页面在系统时区变化后，下一个区间即按新时区计算；时段标签始终按响应中的 `time_zone` 显示，与 Worker 的归桶一致。浏览器报告的时区不符合上述规则（如 `+03:00` 偏移或 `Etc/Unknown`、为空）或被 Worker 以 `INVALID_TIME_ZONE` 拒绝时，Dashboard 改按 UTC 计算区间、发送 `tz=UTC` 并显示「浏览器时区无法用于统计，时间按 UTC 显示」，而不是整页报错。不带 `tz` 的请求按 UTC 统计。返回 `AttemptCounts`：按 `AttemptResult`（`delivery.proto`，下表）分的四个互斥计数 `succeeded_count`、`retried_count`、`failed_count`、`unknown_count`，以及同口径的时间桶。没有实际发出请求的 `not_sent`、尚未结束的尝试和投递创建前即失败的事件不计入该图。列表中的一条事件可以有多次尝试，因此 Dashboard 的尝试数不等于邮件数或事件数。

响应带 `time_zone` 与 `granularity`，每个时段带 `end`（下一时段的 `start`，最后一段为 `to`）。夏令时开始或结束的当地日期为 23 或 25 小时，下钻使用 `end` 而不是 `start` 加 24 小时；回拨时重复的 01:00 是两个小时桶（明细表以 PDT/PST 区分），DST 跳过的午夜从第一个有效时刻开始；Asia/Kolkata、Asia/Kathmandu 等半小时或 45 分钟偏移按当地整点对齐。第一个时段的 `start` 可能早于 `from`，下钻从 `from` 开始。Worker 先用 Intl 求出该时区在区间内的偏移分段（每 6 小时采样，变化处二分到分钟，最多 8 段，超出同样返回 400 `INVALID_TIME_ZONE`），再在同一条 D1 查询中用 `CASE` 按分段选择 SQLite 日期修饰符（如 `-420 minutes`）计算本地日期或小时：不逐行调用 Intl，查询条件和 `delivery_attempts_finished_idx` 索引与 UTC 版相同，绑定参数不超过 17 个。

小时桶最多 7 天，日期桶最多 90 个本地日，各另加 2 小时容纳夏令时回拨：美国时区的回拨日为 25 小时，tzdata 中最大的时钟调整是 Antarctica/Troll 的 +00/+02（26 小时的当地日）。按尝试结果下钻的 `ListDeliveries`（filter `attempt_result = <AttemptResult> AND attempt_finish_time >= "<from>" AND attempt_finish_time < "<to>"`，如 `attempt_result = RETRIED`；尝试的 `outcome` 名称如 `DELIVERED` 不是结果，返回 400）接受 90 天加 2 小时，因此 Dashboard 允许的任意区间都能下钻。Dashboard 的“最近 24 小时”为滚动 24 小时，“最近 7 天”“最近 30 天”从 6 或 29 天前的当地午夜到现在；自选日期按当地日期（包含选中的结束日期）转换为 `[首日当地午夜, 末日次日当地午夜)`，最多 90 天。

| Dashboard 文案 | `AttemptResult` | 已完成尝试的 `outcome` | 含义 |
| --- | --- | --- | --- |
| 成功 | `SUCCEEDED` | `delivered` | 目标返回 2xx，按 webhook 合同表示消费者已持久接管；不表示 Todofy 后续业务成功。 |
| 进入重试 | `RETRIED` | `retryable` | 本次请求暂时失败，并已进入自动重试队列。一次事件可能贡献多次。 |
| 失败 | `FAILED` | `rejected`、`failed` | 本次请求后自动投递终止，包括不可重试响应，以及重试预算或窗口在本次请求后耗尽。手动重试仍可产生后续尝试。 |
| 结果不明 | `UNKNOWN` | `interrupted` | 请求结果无法确认，不能据此声称成功或失败。 |

旧版本把一些已经耗尽重试预算的暂时性错误也写作 `retryable`。历史记录保持原样，不能凭事件的**当前**状态倒推过去那次请求的结局；因此旧数据中的“重试”可能包含这种终止尝试。新版本写入时直接记录本次尝试的终止结果。

图表用于查看流量与故障趋势。排障时打开投递记录，再查看事件详情中的 HTTP 状态、错误码和完整尝试时间线；当前事件状态可能在图表所选时段之后发生变化。所有统计查询仍经过 owner 鉴权，返回 `no-store`，不输出邮件、凭据或响应正文。
