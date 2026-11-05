"""Test Todofy with fakes and HTTP transports, never live accounts."""

import asyncio
import base64
import copy
import datetime
import json

import httpx
import pytest

import newsletter.contracts as contracts
import newsletter.personal as personal
import newsletter.todofy as todofy

TODAY = "2026-09-05"
INSTANT = datetime.datetime(2026, 9, 5, 18, 0, tzinfo=datetime.UTC)
USER, PASSWORD = "test-user", "test-secret-not-for-output"


def adapter(handler, **options):
    return todofy.Todofy(
        "https://todofy.example.org",
        USER,
        PASSWORD,
        transport=httpx.MockTransport(handler),
        clock=lambda: INSTANT,
        **options,
    )


def recommendation():
    return {
        "tasks": [
            {
                "rank": 1,
                "title": "确认会议安排",
                "reason": (
                    "邀请有两个候选时段。尚未确认你的时间，"
                    "请对照日历后回复。\n"
                    "不是已安排的会议。"
                ),
            },
            {
                "rank": 2,
                "title": "项目验收",
                "reason": "预览可以检查，但正式邮件还没有发送。",
            },
        ],
        "task_count": 7,
        "model": "MODEL_GEMINI_TEST_ONLY",
    }


@pytest.fixture(autouse=True)
def forbid_http_network(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Todofy tests must not call real services")

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", forbidden
    )


async def test_fetches_ten_candidates_once_preserves_selected_full_reasons():
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "GET"
        assert (
            str(request.url)
            == "https://todofy.example.org/api/recommendation?top=10"
        )
        expected_auth = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
        assert request.headers["Authorization"] == f"Basic {expected_auth}"
        assert request.headers["Accept"] == "application/json"
        return httpx.Response(200, json=recommendation())

    result = await adapter(handler).fetch(TODAY)
    assert len(calls) == 1
    assert result["state"] == "current"
    assert result["task_count"] == 7
    assert (
        result["items"][0]["detail"] == recommendation()["tasks"][0]["reason"]
    )
    assert result["fetched_at"] == INSTANT.isoformat()
    assert result["time_window_hours"] == 24
    assert "并非全部事件" in result["limitations"]
    assert "不代表事项已经完成" in result["limitations"]
    assert not result["is_fixture"]
    assert PASSWORD not in json.dumps(result)


async def test_summary_is_opt_in_and_only_one_call():
    calls = []
    narrative = (
        "事项一有待回复，当前信息尚不足以确认截止时间。\n"
        "\n"
        "事项二只是通知，无需行动。"
    )

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://todofy.example.org/api/summary"
        return httpx.Response(
            200,
            json={
                "summary": narrative,
                "task_count": 4,
                "time_window_hours": 24,
            },
        )

    result = await adapter(handler, mode="summary").fetch(TODAY)
    assert len(calls) == 1
    assert result["summary"] == narrative
    assert result["items"] == []  # Never invent structured events from prose.
    assert result["task_count"] == 4
    assert "综合概述" in result["source_label"]


async def test_empty_summary_is_success_not_upstream_obsolete_alarm():
    result = await adapter(
        lambda _: httpx.Response(
            200,
            json={
                "summary": (
                    "Please check your service as it's highly not possible..."
                ),
                "task_count": 0,
                "time_window_hours": 24,
            },
        ),
        mode="summary",
    ).fetch(TODAY)
    assert result["state"] == "empty"
    assert result["task_count"] == 0
    assert "check your service" not in result["summary"]
    assert "不代表没有未完成任务" in result["summary"]


async def test_empty_recommendations_unknown_total_not_fabricated_zero():
    result = await adapter(
        lambda _: httpx.Response(200, json={"tasks": []})
    ).fetch(TODAY)
    assert result["state"] == "empty"
    assert "task_count" not in result
    assert "未提供" in result["limitations"]


async def test_recommendation_known_empty_zero():
    result = await adapter(
        lambda _: httpx.Response(200, json={"tasks": [], "task_count": 0})
    ).fetch(TODAY)
    assert result["state"] == "empty"
    assert result["task_count"] == 0


async def test_plain_24_hour_recommendation_keeps_its_caption():
    for extra in ({}, {"new_count": 7, "carryover_count": 0}):
        result = await adapter(
            lambda _, extra=extra: httpx.Response(
                200, json=recommendation() | extra
            )
        ).fetch(TODAY)
        assert result["state"] == "current"
        assert result["source_label"].startswith("Todofy · 近 24 小时候选")
        assert "仍未完成" not in result["source_label"]
        assert "天前" not in result["limitations"]


async def test_carried_over_tasks_are_named_in_caption_and_limitations():
    payload = recommendation() | {"new_count": 4, "carryover_count": 3}
    result = await adapter(lambda _: httpx.Response(200, json=payload)).fetch(
        TODAY
    )
    assert result["state"] == "current"
    assert result["task_count"] == 7
    assert result["source_label"] == (
        "Todofy · 近 24 小时及 3 条仍未完成的旧任务候选本地精选（最多 5 条）"
    )
    assert "另带入 3 条此前入库" in result["limitations"]
    assert "（N 天前）" in result["limitations"]
    assert "最近 24 小时" in result["limitations"]


async def test_missing_rank_is_stable_position_and_response_order_by_rank():
    payload = recommendation()
    payload["tasks"][0].pop("rank")
    result = await adapter(lambda _: httpx.Response(200, json=payload)).fetch(
        TODAY
    )
    assert [item["rank"] for item in result["items"]] == [1, 2]


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "todofy_auth_failed"),
        (403, "todofy_auth_failed"),
        (429, "todofy_unavailable"),
        (500, "todofy_unavailable"),
        (302, "todofy_unavailable"),
    ],
)
async def test_failures_have_one_attempt_no_body_leak_or_redirect(status, code):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status,
            content=f"private event {PASSWORD}",
            headers={"Location": "https://attacker.example.org/leak"},
        )

    result = await adapter(handler).fetch(TODAY)
    assert len(calls) == 1
    assert result["state"] == "unavailable"
    assert result["error_code"] == code
    assert "task_count" not in result
    assert PASSWORD not in str(result)


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"tasks": "bad"},
        {"tasks": [{}]},
        {"tasks": [], "task_count": True},
        {"tasks": [], "task_count": -1},
        {"tasks": [], "carryover_count": True},
        {"tasks": [], "carryover_count": -1},
        {"tasks": [], "carryover_count": "3"},
        {"tasks": [{"title": "Title only", "reason": ""}]},
        {"tasks": [{"rank": True, "title": "title", "reason": "detail"}]},
        {"tasks": [{"title": "t", "reason": "d"}] * 11},
    ],
)
async def test_invalid_recommendations_not_silently_treated_as_empty(payload):
    result = await adapter(lambda _: httpx.Response(200, json=payload)).fetch(
        TODAY
    )
    assert result["state"] == "unavailable"
    assert result["error_code"] == "todofy_invalid_response"


@pytest.mark.parametrize(
    "payload",
    [
        {"summary": "x", "task_count": True, "time_window_hours": 24},
        {"summary": "", "task_count": 1, "time_window_hours": 24},
        {"summary": "x", "task_count": 1},
        {"summary": "x", "task_count": 1, "time_window_hours": 48},
        {"summary": "x\u0000", "task_count": 1, "time_window_hours": 24},
        {"summary": "x" * 20_001, "task_count": 1, "time_window_hours": 24},
    ],
)
async def test_invalid_summary_not_published(payload):
    result = await adapter(
        lambda _: httpx.Response(200, json=payload), mode="summary"
    ).fetch(TODAY)
    assert result["state"] == "unavailable"
    assert result["error_code"] == "todofy_invalid_response"


@pytest.mark.parametrize(
    "content",
    [
        b"not json",
        b'{"tasks": [], "tasks": []}',
        b'{"tasks": [], "other": NaN}',
        b'{"tasks":' + b" " * (128 * 1024) + b"[]}",
        b"\xff",
    ],
)
async def test_bad_or_oversize_json(content):
    result = await adapter(
        lambda _: httpx.Response(
            200, content=content, headers={"Content-Type": "application/json"}
        )
    ).fetch(TODAY)
    assert result["error_code"] == "todofy_invalid_response"


async def test_html_response_is_not_parsed_as_json():
    result = await adapter(
        lambda _: httpx.Response(
            200, content='{"tasks":[]}', headers={"Content-Type": "text/html"}
        )
    ).fetch(TODAY)
    assert result["error_code"] == "todofy_invalid_response"


@pytest.mark.parametrize(
    "error,code",
    [
        (httpx.ReadTimeout, "todofy_timeout"),
        (httpx.ConnectError, "todofy_unavailable"),
    ],
)
async def test_transport_errors_are_safe(error, code):
    def handler(request):
        raise error(PASSWORD, request=request)

    result = await adapter(handler).fetch(TODAY)
    assert result["error_code"] == code
    assert PASSWORD not in str(result)


async def test_wall_timeout_bounds_slow_stream_and_does_not_retry():
    calls = []

    async def handler(request):
        calls.append(request)
        await asyncio.sleep(1)
        return httpx.Response(200, json=recommendation())

    result = await adapter(handler, timeout=0.005).fetch(TODAY)
    assert result["error_code"] == "todofy_timeout"
    assert len(calls) == 1


async def test_cancellation_propagates():
    async def handler(request):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await adapter(handler).fetch(TODAY)


@pytest.mark.parametrize("issue_date", ["2026-09-04", "2026-09-06"])
async def test_current_rolling_window_cannot_masquerade_as_historical_or_future(
    issue_date,
):
    def forbidden(request):
        pytest.fail("Historical dates must never fetch current private events")

    result = await adapter(forbidden).fetch(issue_date)
    assert result["error_code"] == "todofy_historical_unavailable"


async def test_issue_date_uses_configured_timezone():
    seen = []
    backend = todofy.Todofy(
        "https://todofy.example.org",
        USER,
        PASSWORD,
        transport=httpx.MockTransport(
            lambda request: (
                seen.append(request) or httpx.Response(200, json={"tasks": []})
            )
        ),
        clock=lambda: datetime.datetime(2026, 9, 6, 1, 0, tzinfo=datetime.UTC),
    )
    assert (await backend.fetch(TODAY))["state"] == "empty"
    assert len(seen) == 1


@pytest.mark.parametrize(
    "url",
    [
        "http://todofy.example.org",
        "https://user:password@todofy.example.org",
        "https://todofy.example.org/private",
        "https://todofy.example.org?key=secret",
        "https://todofy.example.org#fragment",
        "https://todofy.example.org:444",
        "https://todofy.example.org\n",
        "https://todofy.example.org\\@evil.example.org",
        "https://todofy.example.org%2fattacker.example.org",
        "not a URL",
    ],
)
def test_reject_unsafe_service_url_without_echoing_input(url):
    with pytest.raises(
        ValueError, match="Invalid Todofy HTTPS origin or credentials"
    ) as caught:
        todofy.Todofy(url, USER, PASSWORD)
    assert url not in str(caught.value)
    assert PASSWORD not in str(caught.value)


@pytest.mark.parametrize(
    "username,password",
    [
        ("", "password"),
        ("user", ""),
        ("user:other", "password"),
        ("user", "password\r\n"),
        ("user\x00", "password"),
    ],
)
def test_reject_invalid_auth_without_echo(username, password):
    with pytest.raises(ValueError, match="Invalid Todofy"):
        todofy.validate_todofy_configuration(
            "https://todofy.example.org", username, password
        )


@pytest.mark.parametrize(
    "options",
    [
        {"mode": "both"},
        {"top": 0},
        {"top": 11},
        {"top": True},
        {"timeout": float("nan")},
        {"timeout": 0},
    ],
)
def test_invalid_bounds(options):
    with pytest.raises(ValueError, match="Invalid Todofy"):
        todofy.Todofy("https://todofy.example.org", USER, PASSWORD, **options)


async def test_fakes_and_disabled_are_offline_and_honest():
    disabled = await todofy.DisabledTodofy().fetch(TODAY)
    assert disabled["state"] == "disabled"
    assert "task_count" not in disabled
    first = await todofy.FakeTodofy().fetch(TODAY)
    assert first == await todofy.FakeTodofy().fetch(TODAY)
    assert first["is_fixture"]
    assert len(first["items"]) == 3
    assert all(len(item["detail"]) > 35 for item in first["items"])
    assert (
        "不是真实" in first["summary"]
        or "不是从你的账户读取" in first["summary"]
    )
    assert "未连接" in first["limitations"]
    contracts.validate_personal_digest(first)
    contracts.validate_personal_digest(disabled)


@pytest.mark.parametrize(
    "value", ["2026-02-30", "20260905", "2026-9-5", "not-a-date"]
)
async def test_invalid_issue_dates(value):
    with pytest.raises(ValueError, match="Invalid Todofy issue date"):
        await todofy.DisabledTodofy().fetch(value)


def test_unknown_exception_text_cannot_become_visible_error_code():
    result = todofy.unavailable_digest(PASSWORD)
    assert result["error_code"] == "todofy_unavailable"
    assert PASSWORD not in str(result)


async def test_top_limits_display_after_filtering_not_the_candidate_request():
    calls = []
    payload = {
        "tasks": [
            {
                "rank": 1,
                "title": "信用卡账单已出",
                "reason": "电子账单可查看。",
            },
            {
                "rank": 2,
                "title": "普通项目记录",
                "reason": "这里是尚待判断的具体说明。",
            },
            {
                "rank": 3,
                "title": "AutoPay failed",
                "reason": "Payment was declined; bank review needed.",
            },
            {"rank": 4, "title": "确认会议安排", "reason": "请回复候选时段。"},
        ],
        "task_count": 23,
    }

    def handler(request):
        calls.append(request)
        assert request.url.params["top"] == "10"
        return httpx.Response(200, json=payload)

    result = await adapter(handler, top=2).fetch(TODAY)
    assert len(calls) == 1
    assert [item["title"] for item in result["items"]] == [
        "AutoPay failed",
        "确认会议安排",
    ]
    assert [item["rank"] for item in result["items"]] == [1, 2]
    assert (
        result["task_count"] == 23
    )  # Original ingress count, not selected count.
    assert result["items"][0]["detail"] == payload["tasks"][2]["reason"]
    assert "1 条明确例行通知" in result["summary"]
    assert "1 条候选超过展示上限" in result["summary"]
    contracts.validate_personal_digest(result)


async def test_routine_candidates_add_no_filler_or_paid_bill_claims():
    payload = {
        "tasks": [
            {
                "rank": 1,
                "title": "Statement available",
                "reason": "Your monthly statement is ready.",
            },
            {
                "rank": 2,
                "title": "信用卡账单提醒",
                "reason": "已启用自动还款。",
            },
        ],
        "task_count": 8,
    }
    result = await adapter(lambda _: httpx.Response(200, json=payload)).fetch(
        TODAY
    )
    assert result["state"] == "current"
    assert result["items"] == []
    assert result["task_count"] == 8
    assert "保留 0 条" in result["summary"]
    assert "这不表示账单已支付" in result["summary"]
    assert "不推断所有账户自动还款" in result["limitations"]
    assert "没有新的入库事件" not in result["summary"]
    contracts.validate_personal_digest(result)


async def test_nonempty_upstream_can_yield_zero_selected_items():
    result = await adapter(
        lambda _: httpx.Response(200, json={"tasks": [], "task_count": 12})
    ).fetch(TODAY)
    assert result["state"] == "current"
    assert result["items"] == [] and result["task_count"] == 12
    assert "不代表没有未完成任务" in result["summary"]
    contracts.validate_personal_digest(result)


async def test_risk_candidates_exceeding_cap_are_counted_not_silently_hidden():
    tasks = [
        {
            "rank": i,
            "title": f"安全告警 {i}",
            "reason": f"测试账户 {i} 检测到异常登录。",
        }
        for i in range(1, 4)
    ]
    result = await adapter(
        lambda _: httpx.Response(200, json={"tasks": tasks}), top=1
    ).fetch(TODAY)
    assert len(result["items"]) == 1
    assert "2 条含风险提示" in result["summary"]
    assert "task_count" not in result


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
    assert personal.select_personal_items([candidate], 1).items == [candidate]
