"""Synthetic examples for current editorial prompts, never publication evidence.

Discovery and selection are also copied into the independently published content
configuration. Tests validate both copies through the current output contracts.
"""

from typing import Literal

import newsletter.types as types

# Install baselines and authored configuration share these output examples.
# Editorial preferences remain in their respective policy text.
DISCOVERY = (
    "\n"
    "\n"
    "## 任务与输出\n"
    "\n"
    "本阶段只交接候选，后续选题和采编会决定是否刊出。先按本方向和上面"
    "的规则搜集，\n"
    "再按给定 schema 返回一个 JSON 对象；不要 Markdown 围栏或额外解释"
    "。\n"
    "`candidates` 最多 5 项，`note` 说明本轮查找范围和主要缺口。候选"
    "不输出 `id`、\n"
    "`direction` 或 `provenance`，这些由代码生成。未知出处字段用空字"
    "符串，未知证据列表用 `[]`。\n"
    "`access_scope` 如实反映实际读到的内容；`evidence_urls` 只放本轮"
    "逐个打开过的原始 URL。\n"
    "\n"
    "以下输入和输出全部为合成示例，只演示字段和判断。例中的事件、日期"
    "和 URL 均不是本期材料；\n"
    "实际输出只使用本期输入和本轮观察，不能复制示例事实、URL 或把示例"
    "观察当作真实访问。\n"
    "\n"
    "示例输入节选：已搜索，且独立打开以下虚构公告全文。\n"
    "\n"
    "```json\n"
    '{"issue_date":"2026-09-06","direction":"03-world","opened_source":{"'
    'url":"https://example.org/synthetic-ferry","excerpt":"虚构渡轮此前只接受预约乘客，'
    '9月6日起允许现场购票，航线不变；未报告客流变化。","access_scope":"full_text"}}\n'
    "```\n"
    "\n"
    "示例输出：\n"
    "\n"
    "```json\n"
    '{"candidates":[{"title":"虚构渡轮开放现场购票","url":"https://example.org/synt'
    'hetic-ferry","doi":"","version":"","event_key":"synthetic-ferry-walk'
    'up","published_at":"2026-09-06","summary":"虚构渡轮此前只接受预约乘客，现在允许现场购票。临时'
    '出行者可直接买票，航线没有增加；客流是否变化仍未知。","why_now":"本次购票方式已改变，不只是预告。","access_sco'
    'pe":"full_text","authors":"","affiliations":"","venue":"","publicati'
    'on_status":"","contribution":"","source_basis":"合成公告全文明确给出购票变化及日期。",'
    '"evidence_urls":["https://example.org/synthetic-ferry"],"editorial_k'
    'ind":"news","change_basis":"从只接受预约改为允许现场购票，影响临时出行的乘客；航线不变。"}],"note"'
    ':"已搜索并读取合成公告，尚无客流变化的证据。"}\n'
    "```\n"
    "\n"
    "另一种输入：已搜索，但只有旧报道和无法读取的转述，未找到足以交接"
    "的新事实。示例输出：\n"
    "\n"
    "```json\n"
    '{"candidates":[],"note":"已检索本方向近期变化，找到的材料均为旧报道或无法核对的转述，本轮没有合格候选。"}\n'
    "```\n"
)
SELECTION = (
    "\n"
    "\n"
    "## 任务与输出\n"
    "\n"
    "本阶段只比较当前候选及历史，不搜索或打开网页。按上面的取舍规则和"
    "输入的代码预算排序；\n"
    "先合并同一事件，再给每个实际要采编的话题一个 `research_task`。每"
    "项仅引用输入里已有的\n"
    "`candidate_ids` 和 `source_urls`，新建的任务 `id` 只标识本次任务"
    "；`priority` 从 1 开始"
    "且不重复。\n"
    "`why` 说明本项具体价值，`question` 留下有界核查问题，`evidence_c"
    "ontext` 分开已有主张和未知。\n"
    "按给定 schema 只输出包含 `research_tasks` 和 `note` 的 JSON，不"
    "加围栏或前后说明。\n"
    "没有值得刊出的候选时返回空列表，并在 `note` 说明缺口；不能用 `no"
    "te` 代替任务。\n"
    "\n"
    "以下为合成输入节选与完整输出，省略了不影响取舍的候选字段。示例 I"
    "D、URL 和事件仅用于演示，\n"
    "实际结果必须使用本期输入中允许的引用，不能复制示例；这组取舍不构"
    "成固定题材或机构偏好。\n"
    "\n"
    "```json\n"
    '{"max_tasks":1,"editorial_budget":{"max_public_items":1,"max_researc'
    'h_items":1,"max_deep":1},"candidates_untrusted":[{"id":"example-news'
    '","url":"https://example.org/synthetic-ferry","summary":"虚构渡轮允许现场购票，'
    '航线不变。"},{"id":"example-paper","url":"https://example.org/synthetic-p'
    'aper","summary":"虚构论文讨论重要问题，但相对旧方法的增量未知。"}],"candidate_classificatio'
    'ns":{"example-news":{"kind":"news","basis":"允许现场购票，航线不变。"},'
    '"example-paper":{"kind":"research"}}}\n'
    "```\n"
    "\n"
    "```json\n"
    '{"research_tasks":[{"id":"example-task","candidate_ids":["example-ne'
    'ws"],"question":"现场购票何时生效，适用哪些乘客？核对公告中的限制。","why":"购票方式已经变化，直接影响临时出行'
    '的安排。","priority":1,"evidence_context":"候选称允许现场购票且航线不变；覆盖范围和实施条件仍需原文核'
    '对，不能据此推断客流增长。","source_urls":["https://example.org/synthetic-ferry"]'
    ',"editorial_kind":"news"}],"note":"仅保留有具体变化的虚构事件；另一篇的贡献尚不清楚，未占本次有限版面'
    '，也未承诺额外研究。"}\n'
    "```\n"
)

NOTICE = (
    "以下是合成输入节选和完整JSON输出，仅演示字段及判断。"
    "事件、ID、URL和观察记录都不是本题证据；不要访问示例URL，"
    "不要把示例ID、URL或事实复制进实际结果。"
    "实际输出只使用当前story_id、可用引用和本轮真实来源观察。"
    "示例不代替必须进行的search/open，也不规定题材或篇幅。"
)


def writer(mode: Literal["brief", "deep"], repair: bool) -> types.Payload:
    """Show only the current brief, deep or repair output variant."""
    text = (
        "虚构渡轮开始接受现场购票。此前乘客必须预约，现在临时出行者"
        "也可直接买票；航线保持不变。"
    )
    paragraphs = [{"text": text, "citations": ["example-packet/source"]}]
    if mode == "deep" and not repair:
        paragraphs.append(
            {
                "text": (
                    "这次改变的是买票条件。预约要求原先排除了未提前登记"
                    "的乘客，现场购票开放了这部分出行机会。公告未报告"
                    "客流变化，不能据此断言运力或实际客流已经增长。"
                ),
                "citations": ["example-packet/source"],
            }
        )
    content = {
        "story_id": "example-story",
        "title": "虚构渡轮开放现场购票",
        "kind": "world",
        "paragraphs": paragraphs,
        "limitations": "公告未报告客流变化。",
        "recommended_reading": None,
        "chart": None,
    }
    signal = None
    if mode == "brief" and not repair:
        signal = {
            **content,
            "paragraphs": [
                {
                    "text": "虚构渡轮已允许现场购票，航线不变。",
                    "citations": ["example-packet/source"],
                }
            ],
        }
    example: types.Payload = {
        "notice": NOTICE,
        "input_excerpt": {
            "story_id": "example-story",
            "mode": mode,
            "available_citations": ["example-packet/source"],
            "source": {
                "url": "https://example.org/synthetic-ferry",
                "access_scope": "full_text",
                "excerpt": (
                    "虚构渡轮此前仅接受预约乘客，本次允许现场购票，"
                    "航线不变；未报告客流变化。"
                ),
            },
            "observed_web": {
                "searched": True,
                "opened": ["https://example.org/synthetic-ferry"],
            },
        },
        "output": {
            "content": content,
            "signal": signal,
            "supplemental_packets": [],
        },
    }
    if repair:
        example["input_excerpt"]["repair_untrusted"] = {
            "source_component": "body",
            "claim": "虚构渡轮新增航线。",
            "issue": "来源明确说航线不变，须改正该陈述。",
        }
    return example


REVIEW: types.Payload = {
    "notice": NOTICE,
    "input_excerpt": {
        "body_claim": "虚构渡轮新增航线。",
        "signal_claim": "虚构渡轮已允许现场购票。",
        "absent_components": ["reading", "chart"],
        "prior_verified_brief_untrusted": None,
        "available_citations": ["example-packet/source"],
        "source_excerpt": "虚构渡轮现允许现场购票，航线不变。",
        "observed_web": {
            "searched": True,
            "opened": ["https://example.org/synthetic-ferry"],
        },
    },
    "output": {
        "prior_withdrawal": None,
        "assessments": [
            {
                "component": "body",
                "status": "blocked",
                "findings": ["正文把购票方式变化误写为新增航线。"],
            },
            {"component": "reading", "status": "not_present", "findings": []},
            {"component": "chart", "status": "not_present", "findings": []},
            {"component": "signal", "status": "approved", "findings": []},
        ],
        "issues": [
            {
                "component": "body",
                "claim": "虚构渡轮新增航线。",
                "reason": "来源明确说航线不变，只改变购票方式。",
                "evidence": ["example-packet/source"],
                "action": "correct",
            }
        ],
    },
}
