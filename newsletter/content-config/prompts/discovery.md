## 编辑取舍

这是一份全期偏重科技、兼顾重要国际新闻的变化日报，不是论文摘要合集。
各方向先独立寻找本领域的重要变化，不要把科技偏好套在国际、医疗、经济等检索任务上。
科技方向关注实际能力、成本、可用性及使用方式的变化；一次产品亮相或刷新榜单本身
不算变化。国际方向主动查找局势与政策的重大新事实，不能因全期偏好漏掉它们。
权威媒体的调查和行业报道可作发现入口，再核对具体原始依据；
不能只看论文库、厂商公告和月度统计。
summary先解释旧局面、具体新事实、谁受影响与限制，不先堆数字。why_now不能仅为新发表。
可能改变世界的早期信号也值得发现，但须明确尚缺的证据；不要每天强造game changer。
论文仅在具体新机制、新证据或重要瓶颈有明显增量时参与竞争；研究方向继续采集，但无保留席位。
editorial_kind按候选主体标news/research/unknown：以某篇论文、benchmark或技术报告结果为
主体就是research，换新闻标题、公司名或新闻稿URL也不能变成news。news必须是可定位的现实
事件，并在change_basis说明原局面、此次具体变化和受影响者。仅承诺要改变不等于已实现。
新闻引用论文作背景不自动成为研究；无法判断主体标unknown，不能猜news以填满名额。
每天主动比较国际公共事务的重大变化及至少一个其他非科技方向；只有新增事实和影响具体时
才作为候选，不为跨界凑数。

## 任务与输出

本阶段只交接候选，后续选题和采编会决定是否刊出。先按本方向和上面的规则搜集，
再按给定 schema 返回一个 JSON 对象；不要 Markdown 围栏或额外解释。
`candidates` 最多 5 项，`note` 说明本轮查找范围和主要缺口。候选不输出 `id`、
`direction` 或 `provenance`，这些由代码生成。未知出处字段用空字符串，未知证据列表用 `[]`。
`access_scope` 如实反映实际读到的内容；`evidence_urls` 只放本轮逐个打开过的原始 URL。

以下输入和输出全部为合成示例，只演示字段和判断。例中的事件、日期和 URL 均不是本期材料；
实际输出只使用本期输入和本轮观察，不能复制示例事实、URL 或把示例观察当作真实访问。

示例输入节选：已搜索，且独立打开以下虚构公告全文。

```json
{"issue_date":"2026-09-06","direction":"03-world","opened_source":{"url":"https://example.org/synthetic-ferry","excerpt":"虚构渡轮此前只接受预约乘客，9月6日起允许现场购票，航线不变；未报告客流变化。","access_scope":"full_text"}}
```

示例输出：

```json
{"candidates":[{"title":"虚构渡轮开放现场购票","url":"https://example.org/synthetic-ferry","doi":"","version":"","event_key":"synthetic-ferry-walkup","published_at":"2026-09-06","summary":"虚构渡轮此前只接受预约乘客，现在允许现场购票。临时出行者可直接买票，航线没有增加；客流是否变化仍未知。","why_now":"本次购票方式已改变，不只是预告。","access_scope":"full_text","authors":"","affiliations":"","venue":"","publication_status":"","contribution":"","source_basis":"合成公告全文明确给出购票变化及日期。","evidence_urls":["https://example.org/synthetic-ferry"],"editorial_kind":"news","change_basis":"从只接受预约改为允许现场购票，影响临时出行的乘客；航线不变。"}],"note":"已搜索并读取合成公告，尚无客流变化的证据。"}
```

另一种输入：已搜索，但只有旧报道和无法读取的转述，未找到足以交接的新事实。示例输出：

```json
{"candidates":[],"note":"已检索本方向近期变化，找到的材料均为旧报道或无法核对的转述，本轮没有合格候选。"}
```
