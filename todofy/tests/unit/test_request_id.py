import json
import re

import pytest

from todofy.core.contract import parse_mail_event
from todofy.core.reminder_text import SENDER
from todofy.core.render import clean_summary, has_footer, render_todo_body, task_title
from todofy.core.request_id import todoist_request_id
from todofy.core.todoist_request import (
    MAX_HEADER_BYTES,
    MAX_POST_BODY_BYTES,
    RequestTooLarge,
    build_task_request,
    matching_task_ids,
)

EVENT_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"


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


def test_frozen_request_carries_its_identity_and_no_credential():
    """Go: todo/internal/todoist/client_test.go:210 TestClient_RequestID (the frozen identity Tasks maps)."""
    request = build_task_request("标题", "Body & <b>", "project-one", "todofy-abc")
    assert request.headers == {"Content-Type": "application/json", "X-Request-Id": "todofy-abc"}
    assert json.loads(request.body) == {"content": "标题", "description": "Body & <b>", "project_id": "project-one"}
    assert "标题".encode() in request.body  # UTF-8, not \u escapes


def test_request_has_no_labels_and_omits_an_empty_project_or_a_subtasks_project():
    assert json.loads(build_task_request("t", "d", "", "rid").body) == {"content": "t", "description": "d"}
    child = json.loads(build_task_request("t", "d", "project-one", "rid", parent_id="parent").body)
    assert child == {"content": "t", "description": "d", "parent_id": "parent"}


def test_oversized_body_and_headers_are_refused_before_sending():
    """Go: todo/internal/todoist/client_extended_test.go:169 TestClient_RequestCompliance."""
    with pytest.raises(RequestTooLarge):
        build_task_request("a" * (MAX_POST_BODY_BYTES + 1024), "", "", "rid")
    with pytest.raises(RequestTooLarge):
        build_task_request("small", "", "", "r" * MAX_HEADER_BYTES)
    overhead = len('{"content":"","description":""}')
    build_task_request("a" * (MAX_POST_BODY_BYTES - overhead), "", "", "rid")


def test_footer_match():
    tasks = [
        {"id": "1", "description": f"summary\n\nMail Hero event: {EVENT_ID}"},
        {"id": "2", "description": "unrelated"},
        {"id": "3", "description": None},
        {"id": "4"},
        {"id": "5", "description": f"Mail Hero event: {EVENT_ID}9"},
    ]
    assert matching_task_ids(tasks, lambda description: has_footer(description, EVENT_ID)) == ["1"]
