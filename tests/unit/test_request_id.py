import re

import pytest

from todofy.core.contract import parse_mail_event
from todofy.core.reminder_text import SENDER
from todofy.core.render import clean_summary, render_todo_body, task_title
from todofy.core.request_id import todoist_request_id


def golden_ids(golden) -> dict[str, str]:
    return dict(line.split(" ") for line in golden.text("request_ids.txt").splitlines())


@pytest.mark.parametrize("case", ["ascii", "chinese", "truncated"])
def test_mail_request_id_matches_go(golden, case):
    """Go: todo/todo.go:169 buildTodoistRequestID over the request built in createTodo."""
    event = parse_mail_event(golden.bytes(f"event_{case}.json"))
    body = render_todo_body(event, clean_summary(golden.text(f"model_summary_{case}.txt"), event))
    sender = event.from_addresses[0].address if event.from_addresses else ""
    assert todoist_request_id(task_title(event), body, sender) == golden_ids(golden)[case]


@pytest.mark.parametrize("rows", ["3", "25"])
def test_reminder_request_id_matches_go(golden, rows):
    title, body = golden.text(f"reminder_{rows}_title.txt"), golden.text(f"reminder_{rows}_body.txt")
    assert todoist_request_id(title, body, SENDER) == golden_ids(golden)[f"reminder_{rows}"]


def test_request_id_is_stable_and_separates_fields():
    """Go: mail_inbox_test.go:347-380, the same frozen request always yields the same ID."""
    first = todoist_request_id("Subject", "Body", "sender@example.org")
    assert first == todoist_request_id("Subject", "Body", "sender@example.org")
    assert re.fullmatch(r"todofy-[0-9a-f]{28}", first)
    assert first != todoist_request_id("Subject2", "Body", "sender@example.org")
    assert first != todoist_request_id("Subject", "Body2", "sender@example.org")
    assert first != todoist_request_id("Subject", "Body", "todofy")
