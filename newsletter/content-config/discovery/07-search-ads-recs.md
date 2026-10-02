# 搜索、广告与推荐技术候选发现

发现最多5项有具体技术增量的公开研究，不凑数；本方向只补充候选，不要求新增栏目或延长最终邮件。优先近两周，必要时回看六周并写明首发日期与当前意义。聚焦搜索召回/排序、广告预估与竞价、推荐表征与序列建模、多目标与长期价值、反事实评估和反馈偏差；不以公司的营收新闻或产品上线替代技术进展。

根据一两个明确瓶颈做少量定向搜索，优先SIGIR、RecSys、KDD、WWW / The Web Conference的原论文、严肃研究团队的技术报告及可复查部署研究。官方发现入口可选[SIGIR](https://sigir.org/)、[RecSys](https://recsys.acm.org/)、[SIGKDD论文与会议导航](https://kdd.org/)和[Google Research论文目录](https://research.google/pubs/)；只挑匹配的入口，不遍历全清单。入口页不是具体论文证据，知名团队也不是可信结论担保；新团队、有实质增量的预印本同样可入选。

summary说明旧方法卡在哪里、这次改了哪个机制和可见证据，contribution区分“搜广推很重要”与“这篇实际增加了什么”。核对离线指标的任务、负采样、训练数据与基线；线上A/B要区分点击率、转化率、收入、留存、延迟及长期副作用。离线排序提升不等于线上商业收益，同期流量、曝光策略、数据量和模型一起改变不能归为单一架构的净效果。why_now说明新证据而非热度，只列一两项决定性未知留给深读。

沿用source-first字段：authors、affiliations、venue、publication_status、contribution、source_basis、evidence_urls。作者及该论文单位、主会/workshop/期刊/预印本状态必须由本轮实际打开的原页支持；未知留空，不把网页publisher当作者单位。evidence_urls最多4个且逐字保留实际open输入，不填搜索结果页或仅导航主页。必须实际search与open；摘要/metadata只支持已读范围，不能写成全文或独立复现。

输入history与metadata_seeds用于避开已覆盖线索，feed元数据不是实验事实。与01-ai-ml、06-technology或08-llm-architectures重合的论文使用同一DOI、arXiv身份和event_key交给共享去重；不能换URL、版本标签或改题名伪装另一项。历史重复只有具体新增证据才保留，不能用新抓取日期当首发日。聚焦检索/广告/推荐的特定机制，不重复泛LLM产品更新；没有合格发现就返回空候选并诚实说明。
