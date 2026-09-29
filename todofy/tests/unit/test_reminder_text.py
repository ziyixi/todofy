import json
import re

import pytest

from tests import mail_contract
from todofy.core import ops
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


# ---- the ops digest (contracts/ops-v1) -------------------------------------------------------
# reminder_ops_only.txt and reminder_attention_and_ops.txt hold the title, a blank line, then the
# body, built from contracts/ops-v1/fixtures/OpsReport/daily.json as reported at 23:40 and sent
# with the next UTC day's reminder.

OPS_DAY = "2026-09-30"
OPS_NOW = 1_790_726_700  # 2026-09-30T00:05:00Z
OPS_REPORT = mail_contract.TODOFY.parent / "contracts" / "ops-v1" / "fixtures" / "OpsReport" / "daily.json"


def daily_digest() -> ops.OpsDigest:
    digest = ops.digest(ops.report(json.loads(OPS_REPORT.read_text()), OPS_NOW), OPS_NOW)
    assert digest is not None
    return digest


def test_without_ops_items_the_text_is_unchanged(golden):
    attention = golden_rows(golden, "3")
    empty = ops.OpsDigest(OPS_NOW, (), None)
    assert reminder_title(3, 0) == reminder_title(3)
    assert reminder_body(3, DAY, attention, HOST, None) == reminder_body(3, DAY, attention, HOST)
    assert reminder_body(3, DAY, attention, HOST, empty) == reminder_body(3, DAY, attention, HOST)


def test_an_ops_only_day_gets_the_ops_section_alone(golden):
    digest = daily_digest()
    text = f"{reminder_title(0, len(digest.items))}\n\n{reminder_body(0, OPS_DAY, [], HOST, digest)}"
    assert text == golden.text("reminder_ops_only.txt")
    assert text.endswith("\n\n此提醒每个 UTC 日最多创建一次。")
    assert "处理方法" not in text


def test_attention_and_ops_share_one_task(golden):
    attention = golden_rows(golden, "3")
    digest = daily_digest()
    title, body = reminder_title(3, 4), reminder_body(3, OPS_DAY, attention, HOST, digest)
    assert f"{title}\n\n{body}" == golden.text("reminder_attention_and_ops.txt")
    # The attention part and the instructions are the unchanged ones, around the ops section.
    plain = reminder_body(3, OPS_DAY, attention, HOST)
    head, instructions = plain.split(INSTRUCTIONS)
    assert body.startswith(head) and body.endswith(INSTRUCTIONS + instructions)


def test_the_ops_text_holds_only_codes_numbers_times_and_links():
    digest = daily_digest()
    body = reminder_body(0, OPS_DAY, [], HOST, digest)
    section = body.split("\n", 1)[1].rsplit("\n\n", 1)[0]
    for line in section.splitlines():
        if line.startswith("查看仪表盘："):
            assert line == "查看仪表盘：https://home.example.com/"
            continue
        assert re.fullmatch(
            r"- (critical|warning) · [a-z][a-z0-9-]* · [a-z][a-z0-9_]* · 自 [0-9TZ:-]{20}"
            r"( · [a-z][a-z0-9_]*=-?[0-9.]+(, [a-z][a-z0-9_]*=-?[0-9.]+)*)?",
            line,
        ), line
    assert "canary_ok" not in body  # info items never reach the digest


def test_the_ops_section_is_bounded_to_twenty_items():
    item = ops.DigestItem("dashboard", "x", "warning", OPS_NOW, ())
    digest = ops.OpsDigest(OPS_NOW, (item,) * 25, None)
    assert reminder_body(0, OPS_DAY, [], HOST, digest).count("- warning · dashboard · x") == LIST_LIMIT
