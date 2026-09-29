import pytest

from todofy.core.reminder_text import LIST_LIMIT, AttentionRow, reminder_body, reminder_title

DAY = "2026-09-27"
HOST = "todofy.example.org"
INSTRUCTIONS = "\n处理方法：\n"


def golden_rows(golden, rows: str) -> list[AttentionRow]:
    return [
        AttentionRow(item["event_id"], item["state"], item["code"], item["created_at"])
        for item in golden.json(f"reminder_{rows}_rows.json")
    ]


@pytest.mark.parametrize("rows", ["3", "25"])
def test_title_and_row_list_are_byte_identical_to_go(golden, rows):
    """Go: mail_inbox_attention_test.go:355-433 (count in title, content-free, at most 20 rows)."""
    attention = golden_rows(golden, rows)
    assert reminder_title(len(attention)).encode() == golden.bytes(f"reminder_{rows}_title.txt")
    body = reminder_body(len(attention), DAY, attention, HOST)
    go_body = golden.text(f"reminder_{rows}_body.txt")
    assert body.split(INSTRUCTIONS)[0] == go_body.split(INSTRUCTIONS)[0]


def test_list_is_bounded_to_twenty_rows(golden):
    """Go: TestMailInboxReminderBodyIsBoundedToTwentyRows."""
    attention = golden_rows(golden, "25")
    body = reminder_body(25, DAY, attention, HOST)
    assert body.count(" · failed_summary · ") == LIST_LIMIT == 20
    assert attention[19].event_id in body
    assert attention[20].event_id not in body
    assert "- … 另有 5 条\n" in body


def test_rows_show_dash_for_a_missing_code_and_utc_arrival():
    row = AttentionRow("f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710302", "todo_unknown", "", 1_790_506_800)
    body = reminder_body(1, DAY, [row], HOST)
    assert "- f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710302 · todo_unknown · - · 收到 2026-09-27T11:00:00Z\n" in body
    assert "另有" not in body


def test_instructions_point_at_the_owner_ui():
    """Deliberate change: the BasicAuth API and X-Todofy-Admin-Action header no longer exist."""
    body = reminder_body(0, DAY, [], HOST)
    instructions = body[body.index(INSTRUCTIONS) :]
    assert f"https://{HOST}/attention" in instructions
    for action in ("task_created", "task_not_created", "retry_summary", "dismiss"):
        assert f"（{action}）" in instructions
    for retired in ("BasicAuth", "X-Todofy-Admin-Action", "/api/v1/mail_inbox"):
        assert retired not in body
    assert body.endswith("此提醒每个 UTC 日最多创建一次。")
