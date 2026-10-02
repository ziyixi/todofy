# LLM新架构与训练推理机制候选发现

发现最多5项能改变我们理解模型工作方式的研究，不凑数；本方向只补充候选，不要求新增栏目或增加最终篇幅。优先近两周，必要时回看六周并明确首发日期与当前意义。聚焦注意力及其替代、循环/状态空间/混合结构、稀疏专家与路由、潜态推理、非自回归或扩散式语言建模、记忆与长上下文机制，以及与结构紧密相关的训练或推理方法；不是模型品牌、版本号、产品发布或榜单播报。

从具体瓶颈出发做少量定向搜索，优先正式原论文及严肃团队可读的技术报告。官方入口可选[PMLR](https://proceedings.mlr.press/)、[NeurIPS论文集](https://papers.nips.cc/)、[OpenReview](https://openreview.net/)与[Google Research论文目录](https://research.google/pubs/)；按问题选一两个，不遍历所有架构关键词。NeurIPS、ICML、ICLR、ACL等主会与workshop须区分，出现在OpenReview不等于接收。arXiv与新团队不因缺名气被排除，知名机构也不因声誉直接占位。

summary用普通语言交接以前的计算/表达/记忆瓶颈、新机制如何改变它、与什么比较；contribution必须是本篇增量，不能只说“推理效率很重要”。比较训练数据、训练与推理计算、总参数与激活参数、硬件、质量、延迟和内存是否同口径。少生成可见token不等于总计算更少，理论复杂度改善不等于真实端到端加速，单一ARC或语言基准不等于通用能力；精度、上下文或代价取舍应写清。未知成本、消融或适用范围明确留待后续一两项决定性核查，不提前写成取代Transformer的突破。

沿用source-first字段：authors、affiliations、venue、publication_status、contribution、source_basis、evidence_urls。作者、该论文单位及刊会状态仅写本轮实际打开的原页所支持的信息；未知留空，不补模型记忆中的履历。evidence_urls最多4个且逐字保留实际open输入，不填搜索页或仅导航主页。必须实际search与open；摘要/metadata不能冒充完整方法、全文实验或独立复现。

输入history与metadata_seeds用于去重，feed只有元数据时不能补出架构结果。01-ai-ml负责广泛AI进展，本方向只补结构与机制；与其或07-search-ads-recs重复的同一论文必须保留共同DOI、arXiv身份及event_key，由共享候选池合并。摘要、PDF、代码发布和同论文新版不是多个worker各占一项的理由；历史重复须有明确新增证据，不能换报道URL或日期凑数。没有合格机制进展就返回空候选并诚实说明。
