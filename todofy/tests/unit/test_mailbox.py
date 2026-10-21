"""Mail's pure rules: core/mailbox.py (the brief, the page tokens, the IDs). Synthetic text only."""

import sqlite3
from pathlib import Path

import pytest

from todofy.core import mailbox
from todofy.core.mailbox import brief_of

# ---- the brief ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("summary", "brief"),
    [
        pytest.param(
            "云服务 10 月账单 ¥128，10月25日自动扣款，无需操作。\n\n**账单**\n- 金额：¥128",
            "云服务 10 月账单 ¥128，10月25日自动扣款，无需操作。",
            id="new_first_line",
        ),
        pytest.param(
            "需在 10月17日前回复是否带家属同行。另附集合地点。",
            "需在 10月17日前回复是否带家属同行。",
            id="first_sentence",
        ),
        pytest.param(
            "正文不完整：原文 300000 bytes，仅收到前 262144 bytes，摘要可能遗漏尾部内容。\n\n体检定在 10月28日 8:30。",
            "体检定在 10月28日 8:30。",
            id="truncation_notice",
        ),
        pytest.param(
            "**FROM: a@example.com**\n**DATE: 2026-10-01T00:00:00Z**\n**RECEIVED: b@example.com**\n"
            "**SUBJECT: 包裹**\n\n" + "=" * 24 + "\n书架配件已发出，预计周一送达。",
            "书架配件已发出，预计周一送达。",
            id="old_task_header",
        ),
        pytest.param(
            "# 账单\n## 摘要\n**重要提醒**\n要点：\n- **请在周五前**确认。", "请在周五前确认。", id="headings_and_marks"
        ),
        pytest.param("> 引用的 `代码` 与 __下划线__ 都去掉", "引用的 代码 与 下划线 都去掉", id="markdown"),
        pytest.param("**账单已出，无需操作。**\n其余", "账单已出，无需操作。", id="bold_sentence_is_the_brief"),
        pytest.param("1. 第一项   有    多余空格", "第一项 有 多余空格", id="numbered_whitespace"),
        pytest.param(
            "Your pull request #212 was merged. No action needed.", "Your pull request #212 was merged.", id="english"
        ),
        pytest.param("Total is 12.50 today. Pay later.", "Total is 12.50 today.", id="decimal_is_no_sentence_end"),
        pytest.param("写" * 70, "写" * 59 + "…", id="long_cut"),
        pytest.param("", "", id="empty"),
        pytest.param("\n\n# 只有标题\n---\n", "", id="nothing"),
    ],
)
def test_the_brief_is_the_first_plain_sentence(summary, brief):
    assert brief_of(summary) == brief


def test_the_brief_reads_only_the_first_600_characters():
    assert brief_of("#\n" * 300 + "太远了。") == ""
    assert brief_of(" " * 590 + "近。") == "近。"


def test_the_brief_never_exceeds_its_column():
    """migrations/0008_mail_briefs.sql: length(brief) <= 60."""
    for summary in ("长" * 1000, "a " * 300, "😀" * 100):
        assert len(brief_of(summary)) <= mailbox.MAX_BRIEF_CHARS == 60
    db = sqlite3.connect(":memory:")
    for path in sorted((Path(__file__).parents[2] / "migrations").glob("*.sql")):
        db.executescript(path.read_text())
    insert = (
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, brief) VALUES (?, 1, 's', 'x', 'm', ?)"
    )
    db.execute(insert, ("ok", brief_of("长" * 1000)))
    db.execute(insert, ("never", None))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(insert, ("long", "长" * 61))


# ---- requests -------------------------------------------------------------------------------------------------


def test_a_page_token_is_the_last_row_s_time_and_id_and_nothing_else():
    row = {"created_at": 1_790_000_000, "event_id": "00000000-0000-4000-8000-000000000001"}
    assert mailbox.page_cursor(mailbox.next_page(row)) == (row["created_at"], row["event_id"])
    assert mailbox.page_cursor("") == (2**52, "")
    for token in ("garbage", "W10", "x" * 300, mailbox.next_page({"created_at": -1, "event_id": "a"})):
        with pytest.raises(ValueError, match="BAD_REQUEST"):
            mailbox.page_cursor(token)


@pytest.mark.parametrize("value", ["tmp-local-task", "", "a b", "x" * 101])
def test_ids_from_a_browser_or_out_of_shape_are_refused(value):
    with pytest.raises(ValueError, match="BAD_REQUEST"):
        mailbox.check_id(value)
