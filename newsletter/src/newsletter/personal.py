"""Conservative local selection of private summaries, not financial advice.

No model calls, account state, public packets, or external writes. Exact routine
notice patterns are suppressors; risk and uncertain-payment signals veto them.
Unknown prose is retained. This cannot recover facts an upstream model omitted.
"""

from __future__ import annotations

from collections.abc import Sequence
import dataclasses
import re
from typing import Literal

import newsletter.types as types

CANDIDATE_LIMIT = 10
Priority = Literal["risk", "action", "unknown", "routine"]

# These are conservative vetoes, not negative-keyword filters: even an ambiguous
# or negated risk mention is retained rather than assuming an alert is resolved.
_RISK = re.compile(
    "\\b(?:overdue|past[ -]due|delinquen\\w*|late "
    "fee|failed|failure|unsuccessful|declined|"
    "rejected|returned|reversed|unpaid|partial "
    "payment|insufficient|fraud\\w*|suspicious|"
    r"unauthori[sz]ed|unrecognized|unusual|security|breach|compromised|locked|"
    r"suspended|collections|dispute|error|alert|anomal\w*|unexpected charge|"
    "amount changed|amount increased|payment terms changed|rate "
    "increase|expired card|"
    r"card (?:has )?expired)\b|"
    "\\bpayment\\b.{0,25}\\bnot\\b.{0,15}\\b(?:successful|received|processe"
    "d|completed)\\b|"
    r"逾期|拖欠|滞纳|失败|未成功|未扣款|扣款未完成|退回|退票|拒付|撤销|冲正|未支付|未还清|未到账|部分还款|"
    r"部分付款|不足|欺诈|诈骗|盗刷|未经授权|不明交易|异常|安全|泄露|冻结|封锁|催收|争议|告警"
    r"|金额变化|金额变更|费用上涨|新增费用|付款要求变更|还款要求变更|卡片过期|信用卡过期|"
    r"银行卡过期|卡已过期|支付方式过期",
    re.I,
)
_PAYMENT_UNCERTAIN_OR_MANUAL = re.compile(
    r"\b(?:auto[ -]?pay|automatic payment)\b.{0,60}"
    "\\b(?:unknown|unclear|unconfirmed|unverified|not|off|disabled|cancelle"
    "d|canceled|uncertain)\\b|"
    r"\b(?:not|never)\b.{0,30}\b(?:auto[ -]?pay|automatic payment)\b|"
    "\\b(?:manual payment|pay manually|must pay|payment required|minimum "
    "payment required)\\b|"
    r"自动(?:扣款|还款|付款|缴费).{0,30}(?:未知|不明|未确认|未核实|是否|未开通|未启用|未设置|关闭|取消)|"
    r"(?:没有|未|尚未|不确定是否).{0,8}(?:开通|设置|启用|安排).{0,5}自动(?:扣款|还款|付款|缴费)|"
    r"手动(?:还款|付款|缴费)|(?:需|须|必须)自行(?:还款|付款|缴费)",
    re.I,
)
_AUTOPAY_CONFIRMED = re.compile(
    "\\bauto[ -]?pay\\s+(?:(?:is|has been)\\s+)?(?:enabled|active|scheduled"
    "|set up|confirmed)\\b|"
    "\\bautomatic payment\\s+(?:(?:is|has "
    "been)\\s+)?(?:scheduled|confirmed|set up)\\b|"
    r"(?:已|已经)(?:开通|设置|启用|安排)自动(?:扣款|还款|付款|缴费)|"
    r"自动(?:扣款|还款|付款|缴费)(?:已|已经)(?:开通|设置|启用|安排)",
    re.I,
)
_FINANCIAL_NOTICE = re.compile(
    "\\b(?:statement|bill|billing|invoice|payment|credit "
    "card)\\b|账单|对账单|还款提醒|缴费通知",
    re.I,
)
_STATEMENT_AVAILABLE = re.compile(
    "\\b(?:statement|e-statement)\\s+(?:(?:is|is now|now|has "
    "become)\\s+)?(?:available|ready)\\b|"
    r"(?:账单|对账单).{0,12}(?:已出|已生成|已就绪|可查看|可查阅|已可|已发布|可下载)",
    re.I,
)
_NON_ROUTINE_DOCUMENT = re.compile(
    r"\b(?:tax|irs|1099|w-?2|court|legal|lawsuit|witness|medical|diagnosis)\b|"
    r"报税|税务|税表|法院|诉讼|证词|医疗|诊断|医疗保险",
    re.I,
)
_COMPLICATION = re.compile(
    r"\b(?:but|however|except|problem|issue|warning|urgent|concern|changed|"
    "another account|another card|other account|other card|multiple "
    "accounts|multiple cards)\\b|"
    r"(?:card|account)\s+[a-z0-9-]+.{0,100}(?:card|account)\s+[a-z0-9-]+|"
    r"但是|不过|然而|问题|警告|紧急|变更|需要核对|需核实|另一张卡|其他账户|多个账户|多张卡",
    re.I | re.S,
)
_ACTION = re.compile(
    "\\b(?:due|deadline|rsvp|reply|respond|action required|review "
    "required|renewal required)\\b|"
    "\\b(?:ready for (?:pick[ -]?up|collection)|awaiting collection|please "
    "collect)\\b|"
    r"截止|到期|应还|待还|欠款|需回复|请回复|待确认|待处理|验收|确认会议|必须提交|待取件|请取件|请领取|待领取",
    re.I,
)


def item_priority(item: types.PersonalItem) -> Priority:
    """Omit narrow routine notices while retaining uncertain facts."""
    text = item["title"] + "\n" + item["detail"]
    if _RISK.search(text):
        return "risk"
    if (
        _PAYMENT_UNCERTAIN_OR_MANUAL.search(text)
        or _NON_ROUTINE_DOCUMENT.search(text)
        or _COMPLICATION.search(text)
    ):
        return "action"
    # A claimed scheduled autopay can lower a routine bill's priority, but never
    # overrides a failure, uncertain/manual payment, or non-routine document.
    if _AUTOPAY_CONFIRMED.search(text) and _FINANCIAL_NOTICE.search(text):
        return "routine"
    if _ACTION.search(text):
        return "action"
    # Merely making a statement available is not evidence of an obligation to
    # pay today. No autopay is assumed, and no payment is marked done.
    if _STATEMENT_AVAILABLE.search(text):
        return "routine"
    return "unknown"


@dataclasses.dataclass(frozen=True)
class PersonalSelection:
    """Selected private items and omission counts without inferred facts."""

    items: list[types.PersonalItem]
    candidates: int
    routine_omitted: int
    duplicates_omitted: int
    limit_omitted: int
    risk_limit_omitted: int


def select_personal_items(
    items: Sequence[types.PersonalItem], maximum: int
) -> PersonalSelection:
    """Keep at most maximum items without filling slots or mutating input."""
    if type(maximum) is not int or not 1 <= maximum <= CANDIDATE_LIMIT:
        raise ValueError("Invalid personal selection limit")
    if len(items) > CANDIDATE_LIMIT:
        raise ValueError("Too many personal candidates")
    priority_order = {"risk": 0, "action": 1, "unknown": 2}
    retained: list[tuple[int, int, int, types.PersonalItem]] = []
    seen: set[tuple[str, str]] = set()
    routine_omitted = duplicates_omitted = 0
    for index, item in enumerate(items):
        # Only identical title AND explanation are duplicates. Similar titles
        # with different accounts, dates or risk details must not be merged.
        key = (item["title"].strip(), item["detail"].strip())
        if key in seen:
            duplicates_omitted += 1
            continue
        seen.add(key)
        priority = item_priority(item)
        if priority == "routine":
            routine_omitted += 1
            continue
        retained.append((priority_order[priority], item["rank"], index, item))
    retained.sort(key=lambda entry: entry[:3])
    selected: list[types.PersonalItem] = [
        {"rank": rank, "title": entry[3]["title"], "detail": entry[3]["detail"]}
        for rank, entry in enumerate(retained[:maximum], 1)
    ]
    return PersonalSelection(
        items=selected,
        candidates=len(items),
        routine_omitted=routine_omitted,
        duplicates_omitted=duplicates_omitted,
        limit_omitted=max(0, len(retained) - maximum),
        risk_limit_omitted=sum(entry[0] == 0 for entry in retained[maximum:]),
    )
