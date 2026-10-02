"""Test bilingual private-selection counterexamples with fictional data."""

import copy

import pytest

import newsletter.personal as personal


def item(title, detail, rank=1):
    return {"rank": rank, "title": title, "detail": detail}


@pytest.mark.parametrize(
    "title,detail",
    [
        ("Statement available", "Your monthly statement is ready."),
        ("信用卡账单已出", "本期电子账单可查看。"),
        ("银行对账单已生成", "可下载本期对账单。"),
        ("Statement is now available", "Please pay your bill."),
        ("信用卡账单已出", "请还款。"),
        (
            "Credit card payment reminder",
            "Autopay is enabled. Payment due September 20.",
        ),
        ("信用卡账单还款提醒", "已开通自动还款，将在到期日处理。"),
        ("Monthly bill", "Automatic payment has been scheduled."),
    ],
)
def test_routine_notices_do_not_manufacture_payment_actions_or_fill_slots(
    title, detail
):
    original = item(title, detail)
    assert personal.item_priority(original) == "routine"
    selected = personal.select_personal_items([original], 5)
    assert selected.items == []
    assert selected.routine_omitted == 1
    assert original == item(title, detail)


@pytest.mark.parametrize(
    "detail",
    [
        "Autopay is enabled, but the latest payment failed.",
        "Autopay is active; this account is past due.",
        "Automatic payment scheduled, but insufficient funds were reported.",
        "Autopay is enabled; only a partial payment was received.",
        "Autopay is enabled; payment was not successful.",
        "Autopay is enabled; the amount increased unexpectedly.",
        "Autopay is active, but a suspicious charge requires review.",
        "Autopay is enabled; SECURITY ALERT: unrecognized login.",
        "Autopay is enabled; this payment was returned by the bank.",
        "Autopay is enabled; the card has expired.",
        "已开通自动还款，但本次扣款失败。",
        "已设置自动扣款，银行提示余额不足。",
        "已启用自动还款，但本期账单已逾期。",
        "已安排自动扣款，本期只完成部分还款。",
        "已开通自动还款，但发现不明交易和盗刷风险。",
        "已启用自动扣款，但本次未成功。",
        "已设置自动付款，费用上涨且金额变更。",
        "已开通自动还款，本次扣款未到账。",
        "已开通自动还款，但卡片过期需要处理。",
    ],
)
def test_autopay_and_statement_terms_never_suppress_an_exception(detail):
    candidate = item("Credit card statement available / 信用卡账单已出", detail)
    selected = personal.select_personal_items([candidate], 1)
    assert personal.item_priority(candidate) == "risk"
    assert selected.items == [candidate]


@pytest.mark.parametrize(
    "title,detail",
    [
        (
            "Statement available",
            "Payment is due September 20; autopay status unknown.",
        ),
        ("Statement available", "Autopay is not enabled. Please pay manually."),
        ("Monthly bill", "Autopay disabled; payment required."),
        ("Statement ready", "Never set up autopay; minimum payment required."),
        ("信用卡账单已出", "自动还款状态未知，需要核对。"),
        ("信用卡账单已生成", "尚未开通自动还款，需自行还款。"),
        ("信用卡账单已出", "自动扣款是否安排尚未核实。"),
        ("信用卡账单已出", "本期应还金额有明确付款截止日。"),
        (
            "Statement available",
            "Tax document: retain for the filing deadline.",
        ),
        ("Statement available", "A medical billing dispute requires review."),
        (
            "Statement available",
            "Autopay is enabled, but something looks wrong.",
        ),
        ("信用卡账单已出", "已开通自动还款，不过这次出现了新的问题。"),
        (
            "Credit card statements available",
            "Autopay is enabled for Card A. Card B payment due tomorrow.",
        ),
        ("信用卡账单已出", "已开通自动还款；另一张卡本期也有还款要求。"),
        ("会议信息", "请回复两个候选时段。"),
    ],
)
def test_unknown_manual_deadline_or_nonroutine_document_is_retained(
    title, detail
):
    candidate = item(title, detail)
    assert personal.item_priority(candidate) != "routine"
    assert personal.select_personal_items([candidate], 5).items == [candidate]


def test_unknown_autopay_word_alone_is_not_confirmation():
    candidate = item(
        "Payment settings", "Autopay information is provided without a status."
    )
    assert personal.item_priority(candidate) == "unknown"
    assert personal.select_personal_items([candidate], 1).items == [candidate]


@pytest.mark.parametrize(
    "detail", ["Your parcel is ready for pickup.", "快递柜待取件，请领取包裹。"]
)
def test_concrete_pickup_action_precedes_unclassified_notice(detail):
    candidates = [
        item("普通通知", "没有具体行动要求。", 1),
        item("Parcel", detail, 9),
    ]
    selected = personal.select_personal_items(candidates, 1)
    assert selected.items[0]["title"] == "Parcel"
    assert selected.items[0]["detail"] == detail


def test_separate_cards_do_not_inherit_each_others_autopay():
    candidates = [
        item("Card A statement available", "Autopay is enabled.", 1),
        item(
            "Card B statement available",
            "Payment due tomorrow; autopay unknown.",
            2,
        ),
    ]
    selected = personal.select_personal_items(candidates, 5)
    assert [entry["title"] for entry in selected.items] == [
        candidates[1]["title"]
    ]
    assert selected.items[0]["detail"] == candidates[1]["detail"]


def test_risk_then_action_then_unknown_is_stable_and_does_not_mutate():
    candidates = [
        item(
            "Unclassified event",
            "Needs context, not a known routine notice.",
            1,
        ),
        item("Meeting", "Please reply with a time.", 2),
        item("Bank notice", "Autopay failed.", 9),
        item("Other security alert", "Review suspicious activity.", 10),
    ]
    before = copy.deepcopy(candidates)
    first = personal.select_personal_items(candidates, 3)
    assert first == personal.select_personal_items(candidates, 3)
    assert [entry["title"] for entry in first.items] == [
        "Bank notice",
        "Other security alert",
        "Meeting",
    ]
    assert [entry["rank"] for entry in first.items] == [1, 2, 3]
    assert candidates == before
    assert first.limit_omitted == 1


def test_only_exact_duplicates_are_removed_not_similar_risk_alerts():
    first = item("Security alert", "Account A reported an unknown login.", 1)
    exact_duplicate = {**first, "rank": 2}
    distinct = item("Security alert", "Account B reported an unknown login.", 3)
    selected = personal.select_personal_items(
        [first, exact_duplicate, distinct], 5
    )
    assert len(selected.items) == 2
    assert selected.duplicates_omitted == 1
    assert selected.items[1]["detail"] == distinct["detail"]


@pytest.mark.parametrize("limit", [0, 11, True])
def test_invalid_selection_limits_fail_closed(limit):
    with pytest.raises(ValueError, match="Invalid personal selection limit"):
        personal.select_personal_items([], limit)


def test_negated_risk_is_kept_without_verified_resolution():
    candidate = item(
        "Statement available",
        "Autopay is enabled. No overdue balance was reported.",
    )
    # A conservative false positive is preferable to deriving resolved state
    # from a fragment of a model-generated description.
    assert personal.select_personal_items([candidate], 1).items == [candidate]
