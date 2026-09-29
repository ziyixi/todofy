import json

import pytest

from todofy.core.todoist_request import (
    MAX_HEADER_BYTES,
    MAX_POST_BODY_BYTES,
    RequestTooLarge,
    build_task_request,
    created_task_id,
    footer_task_ids,
    parse_task_page,
)

EVENT_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"


def test_request_carries_request_id_and_bearer():
    """Go: todo/internal/todoist/client_test.go:210 TestClient_RequestID."""
    request = build_task_request("标题", "Body & <b>", "2203306141", "todofy-abc", " token\n")
    assert request.headers == {
        "Authorization": "Bearer token",
        "Content-Type": "application/json",
        "X-Request-Id": "todofy-abc",
    }
    assert json.loads(request.body) == {"content": "标题", "description": "Body & <b>", "project_id": "2203306141"}
    assert "标题".encode() in request.body  # UTF-8, not \u escapes


def test_request_has_no_labels_and_omits_an_empty_project():
    body = json.loads(build_task_request("t", "d", "", "rid", "tok").body)
    assert body == {"content": "t", "description": "d"}


def test_oversized_body_and_headers_are_refused_before_sending():
    """Go: todo/internal/todoist/client_extended_test.go:169 TestClient_RequestCompliance."""
    with pytest.raises(RequestTooLarge):
        build_task_request("a" * (MAX_POST_BODY_BYTES + 1024), "", "", "rid", "tok")
    with pytest.raises(RequestTooLarge):
        build_task_request("small", "", "", "r" * MAX_HEADER_BYTES, "tok")
    overhead = len('{"content":"","description":""}')
    build_task_request("a" * (MAX_POST_BODY_BYTES - overhead), "", "", "rid", "tok")


@pytest.mark.parametrize(
    ("body", "task_id"),
    [(b'{"id":"123","content":"x"}', "123"), (b'{"id":""}', ""), (b'{"id":123}', ""), (b"[]", ""), (b"", "")],
)
def test_created_task_id(body, task_id):
    assert created_task_id(body) == task_id


def test_task_pages_in_both_shapes():
    tasks, cursor = parse_task_page(b'{"results":[{"id":"1"}],"next_cursor":"c2"}')
    assert (tasks, cursor) == ([{"id": "1"}], "c2")
    assert parse_task_page(b'{"results":[],"next_cursor":null}') == ([], "")
    assert parse_task_page(b'[{"id":"1"}]') == ([{"id": "1"}], "")
    assert parse_task_page(b" ") == ([], "")


@pytest.mark.parametrize(
    "body", [b"{}", b'{"results":{}}', b'{"results":[1]}', b'{"results":[],"next_cursor":5}', b"x"]
)
def test_malformed_task_pages_raise(body):
    with pytest.raises(ValueError):
        parse_task_page(body)


def test_footer_task_ids():
    tasks = [
        {"id": "1", "description": f"summary\n\nMail Hero event: {EVENT_ID}"},
        {"id": "2", "description": "unrelated"},
        {"id": "3", "description": None},
        {"id": "4"},
        {"id": "5", "description": f"Mail Hero event: {EVENT_ID}9"},
    ]
    assert footer_task_ids(tasks, EVENT_ID) == ["1"]
