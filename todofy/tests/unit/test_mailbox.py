"""The Mailbox's pure rules: core/mailbox.py (the brief, the categories) and the Todoist adapter's part of it in
core/plus.py (priorities, membership, labels, untouched). Synthetic text only."""

import sqlite3
from pathlib import Path

import pytest

from todofy.core import mailbox, plus
from todofy.core.mailbox import Category, MailSettings, brief_of, replace_categories

MAPPING = [
    {"role": "office", "id": "1", "label": "office"},
    {"role": "home", "id": "2", "label": "home"},
    {"role": "committed", "id": "3", "label": "committed"},
    {"role": "focus", "id": "4", "label": "focus"},
    {"role": "candiate", "id": "5", "label": "candiate"},
    {"role": "quarter", "id": "6", "label": "quarter"},
    {"role": "lead_1w", "id": "7", "label": "lead_1w"},
    {"role": "bets", "id": "8", "label": "bets"},
]


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


# ---- categories -----------------------------------------------------------------------------------------------


def test_a_category_name_is_generated_and_fits_its_column():
    assert Category(1, "9", "quick", 4).name == "quick · P4"
    long = Category(1, "9", "很长的标签" * 20, 2).name
    assert len(long) == mailbox.MAX_CATEGORY_NAME and long.endswith("… · P2")


def test_replacing_keeps_the_ids_of_unchanged_categories_and_archives_the_rest():
    current = [Category(3, "a", "work", 2), Category(4, "b", "quick", 4), Category(5, "c", "deep", 3)]
    saved, archived = replace_categories(current, [("b", "quick-renamed", 4), ("a", "work", 1), ("d", "new", 3)], 9)
    assert saved == [Category(4, "b", "quick-renamed", 4), Category(9, "a", "work", 1), Category(10, "d", "new", 3)]
    assert archived == [3, 5]
    assert replace_categories(current, [], 9) == ([], [3, 4, 5])


@pytest.mark.parametrize(
    "requested",
    [
        pytest.param([("a", "x", 1)] * 2, id="same_pair_twice"),
        pytest.param([("a", "x", 0)], id="no_priority"),
        pytest.param([("a", "x", 5)], id="priority_out_of_range"),
        pytest.param([(str(index), str(index), 1) for index in range(5)], id="more_than_four"),
        pytest.param([("a", "same" * 20, 1), ("b", "same" * 20 + "!", 1)], id="names_collide"),
    ],
)
def test_a_category_set_breaks_no_rule(requested):
    with pytest.raises(ValueError, match="BAD_REQUEST"):
        replace_categories([], requested, 1)


def test_the_settings_etag_follows_ids_labels_priorities_order_and_destination_only():
    base = MailSettings((Category(1, "a", "work", 2), Category(2, "b", "quick", 4)), "p1")
    assert base.etag == MailSettings((Category(1, "a", "renamed", 2), Category(2, "b", "quick", 4)), "p1").etag
    changed = [
        MailSettings((Category(1, "a", "work", 3), Category(2, "b", "quick", 4)), "p1"),
        MailSettings((Category(2, "b", "quick", 4), Category(1, "a", "work", 2)), "p1"),
        MailSettings((Category(1, "a", "work", 2), Category(3, "b", "quick", 4)), "p1"),
        MailSettings(base.categories, "p2"),
        MailSettings(),
    ]
    assert len({base.etag, *(settings.etag for settings in changed)}) == 6


# ---- the Todoist adapter --------------------------------------------------------------------------------------


def test_domain_priorities_are_written_in_todoist_s_order():
    assert [plus.api_priority(priority) for priority in (1, 2, 3, 4)] == [4, 3, 2, 1]


def view(**fields):
    task = {"id": "t", "content": "Synthetic mail", "project_id": "mail", "labels": [], **fields}
    return plus.task_view(task, "2026-10-16", MAPPING)


@pytest.mark.parametrize(
    ("fields", "member"),
    [
        pytest.param({}, True, id="plain"),
        pytest.param({"labels": ["office", "context"]}, True, id="area_and_other_labels"),
        pytest.param({"project_id": "other"}, False, id="another_project"),
        pytest.param({"parent_id": "p"}, False, id="sub_task"),
        pytest.param({"labels": ["focus"]}, False, id="planned"),
        pytest.param({"due": {"date": "2026-10-17"}}, False, id="date_driven_candidate"),
        pytest.param({"labels": ["quick"]}, False, id="quick"),
        pytest.param({"labels": ["waiting"]}, False, id="waiting"),
        pytest.param({"labels": ["onhold"]}, False, id="someday"),
    ],
)
def test_a_task_is_in_the_mailbox_as_the_extension_lists_it(fields, member):
    assert plus.in_mailbox(view(**fields), "mail") is member
    assert not plus.in_mailbox(view(), "")


def test_a_category_label_is_any_but_the_ones_plus_writes_by_other_means():
    allowed = {"1": True, "2": True, "3": False, "4": False, "5": False, "6": False, "7": False, "8": False}
    for label_id, expected in allowed.items():
        assert plus.mail_label({"id": label_id, "label": "x"}, MAPPING) is expected, label_id
    assert plus.mail_label({"id": "20", "label": "deep"}, MAPPING)
    assert not plus.mail_label({"id": "21", "label": "active"}, MAPPING)


def test_filing_adds_the_label_and_keeps_the_areas_exclusive():
    task = {"labels": ["home", "context"]}
    assert plus.filed_labels(task, "office", MAPPING) == ["context", "office"]
    assert plus.filed_labels(task, "deep", MAPPING) == ["context", "deep", "home"]
    assert plus.filed_labels({"labels": None}, "home", MAPPING) == ["home"]
    renamed = [{**row, "label": "工作"} if row["role"] == "office" else row for row in MAPPING]
    assert plus.filed_labels({"labels": ["工作"]}, "home", renamed) == ["home"]


UNTOUCHED = {"id": "t", "labels": [], "priority": 1, "due": None, "deadline": None, "duration": None, "note_count": 0}


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"labels": ["context"]}, id="label"),
        pytest.param({"priority": 2}, id="priority"),
        pytest.param({"due": {"date": "2026-10-20"}}, id="date"),
        pytest.param({"deadline": {"date": "2026-10-20"}}, id="deadline"),
        pytest.param({"duration": {"amount": 15, "unit": "minute"}}, id="estimate"),
        pytest.param({"note_count": 1}, id="comment"),
        pytest.param({"note_count": None}, id="comment_count_unknown"),
    ],
)
def test_any_owner_change_keeps_a_mail(change):
    assert plus.untouched(UNTOUCHED, set())
    assert not plus.untouched({**UNTOUCHED, **change}, set())
    assert not plus.untouched(UNTOUCHED, {"t"})  # it has a sub-task
