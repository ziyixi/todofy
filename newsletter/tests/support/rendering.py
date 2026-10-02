"""Shared offline rendering builders and fakes."""

from __future__ import annotations

import html.parser as parser

import newsletter.types as types

SAMPLE_PACKETS: list[types.Payload] = [
    {
        "id": "sample-packet",
        "workflow_id": "sample-workflow",
        "producer_id": "sample-producer",
        "content_hash": "sample-only",
        "created_at": "2026-09-05T00:00:00Z",
        "is_fixture": True,
        "content": {
            "title": "模拟研究：从试用到流程改造",
            "body": "以下材料与数字均为模拟，只用于验证编辑和排版。",
            "sources": [
                {
                    "id": "survey",
                    "title": "模拟调查：工具使用与流程变化",
                    "url": "https://example.org/research/adoption",
                    "excerpt": (
                        "模拟数据：试用42，稳定使用18，流程改造7，另一"
                        "组暂未公布。"
                    ),
                    "access_scope": "dataset",
                    "published_at": "2026-09-04",
                },
                {
                    "id": "methods",
                    "title": "模拟方法说明：为什么采用率不是生产率",
                    "url": "https://example.org/research/methods",
                    "excerpt": (
                        "本模拟采用横截面调查，不能据此识别因果或推断总体。"
                    ),
                    "access_scope": "full_text",
                    "published_at": "2026-09-04",
                },
            ],
            "tags": ["fixture"],
        },
    }
]

SAMPLE_DRAFT: types.Payload = {
    "subject": "试刊｜工具普及之后，真正改变了什么",
    "title": "工具普及之后，真正改变了什么",
    "introduction": (
        "当新工具变得触手可及，最容易统计的是有多少人试"
        "过它。更难回答的问题是：它是否改变了工作的组织"
        "方式？今天的模拟样张沿着这条差距展开。"
    ),
    "sections": [
        {
            "kind": "world",
            "heading": "同一个数字，可能藏着不同故事",
            "paragraphs": [
                {
                    "text": (
                        "演示材料把“试用过”“稳定使用”和“流程改造”分成三"
                        "层。这不是三个可以相加的独立群体，而是需要分别"
                        "解释的观察指标。"
                    ),
                    "citations": ["sample-packet/survey"],
                }
            ],
            "limitations": "",
        },
        {
            "kind": "feature",
            "heading": "从会用，到工作真的变了",
            "paragraphs": [
                {
                    "text": (
                        "试用门槛下降，可以让一项技术很快拥有庞大的使用"
                        "者。但试用本身没有告诉我们，任务交接、审核责任"
                        "或错误处理是否发生了变化。这些往往才是工具进入"
                        "工作流程后真正困难的部分。"
                    ),
                    "citations": ["sample-packet/survey"],
                },
                {
                    "text": (
                        "下一次看到一份漂亮的采用率调查，值得多问一步："
                        "问卷究竟测量了接触、熟练，还是可持续的工作改变"
                        "？若只有一张横截面照片，就不能把几个群体之间的"
                        "差异，解释成同一群体随时间进步的轨迹。"
                    ),
                    "citations": ["sample-packet/methods"],
                },
            ],
            "limitations": (
                "这组材料和数值均为模拟。不同层级不能相加，也不"
                "能据此计算生产率提升。"
            ),
        },
    ],
    "chart": {
        "kind": "bar",
        "question": "同样是“采用”，测量的是哪一层？",
        "metric": "受访者占比",
        "unit": "%",
        "period": "模拟横截面",
        "caption": (
            "三种定义呈现出不同规模。这里比较的是指标，不是一个漏斗转化率。"
        ),
        "alt_text": (
            "模拟数值：试用42%，稳定使用18%，流程改造7%；另"
            "一组数据缺失，不能记作零。"
        ),
        "limitations": (
            "展示为独立条形；群体可能重叠。数据缺失不代表没有人采用。"
        ),
        "points": [
            {
                "label": "试用过",
                "decimal_value": "42",
                "citations": ["sample-packet/survey"],
            },
            {
                "label": "稳定使用",
                "decimal_value": "18",
                "citations": ["sample-packet/survey"],
            },
            {
                "label": "流程改造",
                "decimal_value": "7",
                "citations": ["sample-packet/survey"],
            },
            {"label": "另一组", "missing_reason": "尚未公布", "citations": []},
        ],
    },
    "recommended_reading": {
        "citation": "sample-packet/methods",
        "reason": (
            "问题：采用率能说明工作方式真的改变了吗？\n"
            "\n"
            "方法与结果：这份模拟方法说明用横截面问卷区分试"
            "用、稳定使用与流程改造。它能描述同一时点的不同"
            "指标，不能证明同一批人逐步改善。\n"
            "\n"
            "限制与意义：横截面比较不能识别因果，也不足以推"
            "断总体。理解问卷测了什么，才能避免把采用率直接"
            "写成生产率提升。"
        ),
    },
    "limitations": "本期为离线排版样张，不代表真实调查、新闻事实或投资判断。",
}


class ParsedEmail(parser.HTMLParser):
    """Capture rendered email structure while rejecting event handlers."""

    def __init__(self, html: str) -> None:
        super().__init__()
        self.tags: list[str] = []
        self.links: list[str | None] = []
        self.images: list[dict[str, str | None]] = []
        self.text: list[str] = []
        self.feed(html)

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        """Record links and images, rejecting event-handler attributes."""
        self.tags.append(tag)
        attributes = dict(attrs)
        if tag == "a":
            self.links.append(attributes.get("href"))
        if tag == "img":
            self.images.append(attributes)
        assert not any(name.startswith("on") for name in attributes)

    def handle_data(self, data: str) -> None:
        """Record visible text fragments in source order."""
        self.text.append(data)
