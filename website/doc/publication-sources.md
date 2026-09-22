# Publication 来源与筛选

核实日期：2026-09-21。书目数据位于 `content/publications.json`。

已通过普通浏览器读取用户指定的 [Google Scholar 主页](https://scholar.google.com/citations?user=boNM4acAAAAJ&hl=en) 当前全部 **14 条**记录（页尾显示 `Articles 1–14`，`SHOW MORE` 已禁用），按要求排除 5 条 AGU/EGU 会议记录，最终收录 **9 条：7 篇期刊论文、1 篇博士论文、PyFK 会议摘要**。网页抓取工具曾返回 403，但浏览器正常访问成功，未绕过登录或验证码。

作者、年份和出版信息另通过 [ORCID 公开记录](https://orcid.org/0000-0003-3010-0486)（[公共 API](https://pub.orcid.org/v3.0/0000-0003-3010-0486/works)）、出版社、MSU 馆藏、Crossref 元数据及作者项目引用交叉核实。

## 收录条目

| 条目                                                             | 正式出版信息                                           | 核实来源                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deep learning for deep earthquakes                               | GJI 238(2), 1073–1088, 2024                            | [出版社](https://academic.oup.com/gji/article/238/2/1073/7689220)                                                                                                                                                                            |
| EARA2024                                                         | GJI 239(2), 914–935, 2024                              | [出版社](https://academic.oup.com/gji/article/239/2/914/7740793)、[作者所属机构记录](https://snu.elsevierpure.com/en/publications/eara2024-a-new-radially-anisotropic-seismic-velocity-model-for-th/)                                        |
| Deep Geophysical Anomalies Beneath the Changbaishan Volcano      | JGR: Solid Earth 128(4), e2022JB025671, 2023           | [出版社](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2022JB025671)、[Crossref](https://api.crossref.org/works/10.1029/2022JB025671)                                                                                                  |
| CUSRA2021                                                        | JGR: Solid Earth 127(8), e2021JB023893, 2022           | [出版社](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2021JB023893)、[作者提供的 EarthScope 模型记录](https://ds.iris.edu/ds/products/emc-cusra2021/)                                                                            |
| Unsupervised machine learning reveals slab hydration variations… | Communications Earth & Environment 3, article 56, 2022 | [出版社](https://www.nature.com/articles/s43247-022-00377-x)、[Crossref](https://api.crossref.org/works/10.1038/s43247-022-00377-x)                                                                                                          |
| Assessment of seismic tomographic models…                        | GJI 228(2), 1392–1409, 2022                            | [出版社](https://academic.oup.com/gji/article/228/2/1392/6382133)、[NSF 存档正式论文](https://par.nsf.gov/servlets/purl/10324340)                                                                                                            |
| FastTrip                                                         | Seismological Research Letters 92(4), 2647–2656, 2021  | [DOI](https://doi.org/10.1785/0220200475)、[NSF 存档正式论文](https://par.nsf.gov/servlets/purl/10267619)、[共同作者机构主页](https://faculty.csu.edu.cn/liguoliang1/zh_CN/lwcg/210613/content/59566.htm)                                    |
| PyFK                                                             | AGU Fall Meeting Abstracts, S15E-0288, 2021            | [作者项目 Citation](https://github.com/ziyixi/pyfk#citation)、[共同作者 CV](https://directory.natsci.msu.edu/media/Directory/Profiles/SWei_cv20230202210949.pdf)、[ADS 记录](https://ui.adsabs.harvard.edu/abs/2021AGUFM.S15E0288X/abstract) |

博士论文 [Seismic Studies of Western Pacific Subduction Zones With High-Performance Computing and Deep Learning](https://d.lib.msu.edu/etd/51756) 由 MSU 正式馆藏确认：作者 Ziyi Xi，2024 年，Computational Mathematics, Science and Engineering — Doctor of Philosophy，130 页；馆藏 DOI 为 `10.25335/mmdh-gp84`，亦已由 [DataCite 注册记录](https://api.datacite.org/dois/10.25335/mmdh-gp84) 确认。[NSF 全文 PDF](https://par.nsf.gov/servlets/purl/10584469) 首页已读取核实题名、作者、学位与年份。对应 [Scholar 条目](https://scholar.google.com/citations?view_op=view_citation&hl=en&user=boNM4acAAAAJ&citation_for_view=boNM4acAAAAJ:5nxA0vEk-isC)。

作者及作者顺序按正式论文或出版元数据保留。原有两篇首页精选的 ID 与 `featuredOrder` 不变；其余论文在完整 Publications 页面显示。

## 筛选与日期处理

- 按用户要求，PyFK 是唯一保留的 AGU/EGU 会议条目。JGR 等 AGU 出版的**期刊论文仍收录**，不把期刊出版机构误当成会议筛选条件。
- PyFK 未核实到 DOI，因此不填造 DOI，使用摘要记录与代码仓库链接。它显示为会议摘要，不冒充期刊论文。
- Scholar 的 5 条排除项：Detecting converted seismic phases of Tonga deep earthquakes…（AGU 2022，S52A-05）；A 3D Azimuthal Anisotropy Model…（AGU 2021，S14B-01）；Full waveform inversion…（EGU21-13849）；Slab Thinning…（AGU 2020，T018-0021）；Towards a Refined 3D Model…（AGU 2019）。
- ORCID 另列的 EGU21-14319、EGU22-6650、EGU23-9809 也不额外纳入。[Slab Thinning… 仓储版本](https://doi.org/10.1002/essoar.10505590.1) 的原始文件含 AGU 2020 iPoster，不能仅凭仓储的 `preprint` 分类当作独立期刊论文。
- 已有正式版本的预印本不另列，避免重复计数。Assessment 的 online-first 日期为 2021-10-06，网站采用正式卷期的 **2022**；CUSRA2021 采用 **2022**；Changbaishan 采用 **2023**，不采用 DOI 内年份或预印本年份。
- 检索中出现的同名图像取证、光网络研究作者未纳入；作者身份以 MSU、合作者和 ORCID `0000-0003-3010-0486` 交叉判断。

后续 Scholar 新增条目时可继续按相同规则核对，或用 Scholar 导出的 BibTeX 对照；不需要更改当前页面结构。
