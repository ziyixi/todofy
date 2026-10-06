"""task-intent-v1 end to end (contracts/task-intent-v1): a stand-in for the watch app calls the gateway's
``Intents`` entrypoint over its service binding (``proposeTasks`` / ``taskIntentStatus``, ``props.source =
"watch"``), in front of the real gateway, core, D1, Durable Object alarm and the fake Todoist.

Covered: a parent with subtasks and separate tasks created once, parent first (the watch app's digest, SOURCE_WATCH,
too); a replay answered
``duplicate`` without a Todoist call; a conflict; every refusal (schema, size, URL host, source,
pause, daily limit per source); frozen X-Request-Id and bytes across retries; a partial failure retried by the
proposer (only the unfinished tasks are sent again); an unknown result settled by the read-only
footer lookup instead of a resend; an interrupted call; the 48-attempt cap; the Todoist auth block;
a recorded row of a source the contract no longer knows; and mail processing going on while intents are
created. Every value validates against the schema.
Synthetic data only.
"""

import json
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import jsonschema
import pytest

from tests import mail_contract
from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.server import Recorded, Reply, rate_limited, retry_after_seconds
from tests.fakes.todoist_fake import PROJECT_ID, TASKS_PATH, TodoistFake
from tests.runtime.conftest import pipeline_vars
from tests.runtime.harness import mail_event, wait_until
from tests.runtime.ops_support import OpsStack, start_ops_stack
from todofy.core import intents
from todofy.core.ops import timestamp

CONTRACT = mail_contract.TODOFY.parent / "contracts" / "task-intent-v1"
SCHEMA = json.loads((CONTRACT / "task-intent-v1.schema.json").read_text())
StackLaunch = Callable[..., OpsStack]
UUID_CHARS = set("0123456789abcdef-")


def schema_errors(definition: str, value: Any) -> list[str]:
    validator = jsonschema.Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{definition}"})
    return [f"{list(error.absolute_path)}: {error.message}" for error in validator.iter_errors(value)]


def fixture(name: str) -> dict[str, Any]:
    return json.loads((CONTRACT / "fixtures" / "TaskIntent" / name).read_text())


def new_intent(name: str = "subtasks-3.json", **changes: Any) -> dict[str, Any]:
    """A fixture intent under a fresh intent_id (every test records its own)."""
    return fixture(name) | {"intent_id": f"test-{uuid.uuid4().hex[:12]}"} | changes


def ref(doc: dict[str, Any]) -> dict[str, str]:
    return {"version": "task-intent-v1", "source": doc["source"], "intent_id": doc["intent_id"]}


def propose(stack: OpsStack, doc: dict[str, Any]) -> dict[str, Any]:
    answer = stack.intents("proposeTasks", doc)
    assert "ok" in answer, answer
    assert schema_errors("TaskIntentResult", answer["ok"]) == [], answer["ok"]
    assert (answer["ok"]["source"], answer["ok"]["intent_id"]) == (doc["source"], doc["intent_id"])
    return answer["ok"]


def status(stack: OpsStack, doc: dict[str, Any]) -> dict[str, Any]:
    answer = stack.intents("taskIntentStatus", ref(doc))
    assert "ok" in answer, answer
    assert schema_errors("TaskIntentResult", answer["ok"]) == [], answer["ok"]
    return answer["ok"]


def wait_state(stack: OpsStack, doc: dict[str, Any], states: set[str], timeout_s: float = 40) -> dict[str, Any]:
    last: list[dict[str, Any]] = []

    def probe() -> dict[str, Any] | None:
        last[:] = [status(stack, doc)]
        return last[0] if last[0]["state"] in states else None

    try:
        return wait_until(probe, timeout_s, f"intent {doc['intent_id']} in {states}")
    except TimeoutError:
        pytest.fail(f"intent {doc['intent_id']} never reached {states}: {last}")


def footer(doc: dict[str, Any], n: int) -> str:
    return intents.footer(doc["source"], doc["intent_id"], n)


def creates_of(todoist: TodoistFake, doc: dict[str, Any], n: int) -> list[Recorded]:
    """Every POST for task n of this intent (its footer ends the description)."""
    return [r for r in todoist.creates() if intents.has_footer(r.json()["description"], footer(doc, n))]


def rows(stack: OpsStack, doc: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    key = f"source = '{doc['source']}' AND intent_id = '{doc['intent_id']}'"
    [intent] = stack.d1(f"SELECT * FROM task_intents WHERE {key}")
    return intent, stack.d1(f"SELECT * FROM task_intent_tasks WHERE {key} ORDER BY n")


def literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def seed(stack: OpsStack, doc: dict[str, Any], *, created_at: int, tasks: dict[int, dict[str, Any]]) -> None:
    """Write an intent the way a proposal records it, with some task rows changed (``tasks``),
    then wake the alarm."""
    value = intents.intent(doc)
    intent_row = {
        "source": value.source,
        "intent_id": value.intent_id,
        "payload_sha256": value.sha256,
        "mode": value.mode,
        "tasks_total": value.tasks_total,
        "tasks_created": 0,
        "state": "pending",
        "error_code": "",
        "payload_json": value.canonical,
        "next_attempt_at": created_at,
        "created_at": created_at,
        "updated_at": created_at,
    }
    statements = [
        f"INSERT INTO task_intents ({', '.join(intent_row)}) VALUES ({', '.join(map(literal, intent_row.values()))})"
    ]
    for n in value.task_numbers:
        row = {
            "source": value.source,
            "intent_id": value.intent_id,
            "n": n,
            "request_id": str(uuid.uuid4()),
            "state": "pending",
            "attempts": 0,
            "next_attempt_at": created_at,
            "error_code": "",
            "started_at": created_at,
            "updated_at": created_at,
        } | tasks.get(n, {})
        statements.append(
            f"INSERT INTO task_intent_tasks ({', '.join(row)}) VALUES ({', '.join(map(literal, row.values()))})"
        )
    stack.d1("; ".join(statements))
    wake(stack)


def ledger_row(
    source: str, intent_id: str, *, created_at: int, state: str = "created", payload: str | None = None
) -> str:
    """An INSERT of a one-task intent row as the ledger holds it, for a source no fixture uses."""
    row = {
        "source": source,
        "intent_id": intent_id,
        "payload_sha256": "0" * 64,
        "mode": "separate",
        "tasks_total": 1,
        "tasks_created": 1 if state == "created" else 0,
        "state": state,
        "error_code": "",
        "payload_json": payload,
        "next_attempt_at": created_at,
        "created_at": created_at,
        "updated_at": created_at,
    }
    return f"INSERT INTO task_intents ({', '.join(row)}) VALUES ({', '.join(map(literal, row.values()))})"


def wake(stack: OpsStack) -> None:
    """Run the alarm loop now. The probe cannot fire the gateway's cron, but ending a shed guard
    wakes the object (the jobs it deferred are due again), with no other effect here."""
    until = timestamp(int(time.time()) + 600)
    stack.ok("setGuard", {"level": "shed", "reason": "test_wake", "until": until}, definition="GuardState")
    stack.ok("setGuard", {"level": "normal", "reason": "test_wake", "until": None}, definition="GuardState")


@pytest.fixture(scope="module")
def launch_stack(
    tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake
) -> Iterator[StackLaunch]:
    running: list[Iterator[OpsStack]] = []

    def start(**overrides: str) -> OpsStack:
        process = start_ops_stack(tmp_path_factory.mktemp("intents"), pipeline_vars(gemini, todoist) | overrides)
        running.append(process)
        return next(process)

    yield start
    for process in running:
        process.close()


@pytest.fixture(scope="module")
def stack(launch_stack: StackLaunch) -> OpsStack:
    return launch_stack()


# ---- created, replayed, conflicting --------------------------------------------------------------


def test_a_parent_and_its_subtasks_are_created_once_parent_first(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    doc = new_intent()
    first = propose(stack, doc)
    assert (first["state"], first["recorded"], first["tasks_total"], first["tasks_created"]) == ("pending", True, 4, 0)
    assert first["retry_after_seconds"] == intents.STATUS_MIN_INTERVAL

    done = wait_state(stack, doc, {"created", "failed"})
    assert (done["state"], done["tasks_created"], done["error_code"], done["retry_after_seconds"]) == (
        "created",
        4,
        None,
        None,
    )
    posts = fresh_todoist.creates()
    assert len(posts) == 4
    parent, *children = (post.json() for post in posts)
    value = intents.intent(doc)
    assert parent == {
        "content": doc["parent"]["title"],
        "description": intents.task_text(value, 0)[1],
        "project_id": PROJECT_ID,
    }
    [parent_task] = [task for task in fresh_todoist.tasks if task.content == doc["parent"]["title"]]
    for n, child in enumerate(children, start=1):
        content, description = intents.task_text(value, n)
        assert child == {"content": content, "description": description, "parent_id": parent_task.id}
    assert all(task.project_id == PROJECT_ID for task in fresh_todoist.tasks)
    request_ids = fresh_todoist.request_ids()
    assert len(set(request_ids)) == 4 and all(len(rid) == 36 and set(rid) <= UUID_CHARS for rid in request_ids)

    intent_row, task_rows = rows(stack, doc)
    assert (intent_row["state"], intent_row["tasks_created"], intent_row["payload_json"]) == ("created", 4, None)
    assert [row["request_id"] for row in task_rows] == request_ids
    assert [row["todoist_id"] for row in task_rows] == [task.id for task in fresh_todoist.tasks]

    # A replay (the proposer lost the answer, or pressed send again) creates nothing.
    again = propose(stack, doc)
    assert (again["state"], again["recorded"], again["tasks_created"], again["updated_at"]) == (
        "duplicate",
        True,
        4,
        done["updated_at"],
    )
    assert status(stack, doc) == done
    time.sleep(1.5)
    assert len(fresh_todoist.creates()) == 4
    # Results never carry task text or Todoist IDs.
    dumped = json.dumps([first, done, again], ensure_ascii=False)
    assert doc["parent"]["title"] not in dumped and parent_task.id not in dumped


def test_separate_mode_creates_top_level_tasks_that_name_the_parent(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    doc = new_intent("separate-2.json")
    assert propose(stack, doc)["tasks_total"] == 2
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    value = intents.intent(doc)
    assert [post.json() for post in fresh_todoist.creates()] == [
        {"content": content, "description": description, "project_id": PROJECT_ID}
        for content, description in (intents.task_text(value, n) for n in (1, 2))
    ]
    assert all(f"— {doc['parent']['title']}" in post.json()["description"] for post in fresh_todoist.creates())


def test_a_watch_digest_is_created_like_any_intent_and_links_only_to_the_app(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    """SOURCE_WATCH (the watch app's daily digest): recorded under its own source, the parent first, every item a
    subtask whose description is its link to the watch app and the footer; the default project."""
    doc = new_intent("watch-digest.json")
    first = propose(stack, doc)
    assert (first["source"], first["state"], first["recorded"], first["tasks_total"]) == ("watch", "pending", True, 5)
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    value = intents.intent(doc)
    parent, *children = (post.json() for post in fresh_todoist.creates())
    assert parent == {
        "content": doc["parent"]["title"],
        "description": intents.task_text(value, 0)[1],
        "project_id": PROJECT_ID,
    }
    assert [child["content"] for child in children] == [item["title"] for item in doc["items"]]
    for n, child in enumerate(children, start=1):
        assert child["description"].startswith("https://watch.ziyixi.science/watches/")
        assert intents.has_footer(child["description"], footer(doc, n))
    assert rows(stack, doc)[0]["source"] == "watch"
    assert propose(stack, doc)["state"] == "duplicate"


def test_the_intents_entrypoint_takes_only_its_bindings_source(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    """The watch app binds ``Intents`` with ``props.source = "watch"``: its own intents go through; another
    source's (its allow-list and daily quota) and the ops-v1 methods are not reachable through it, and ``Ops`` has
    no task-intent methods."""
    doc = new_intent("watch-urgent.json")
    answer = stack.intents("proposeTasks", doc)
    assert "ok" in answer, answer
    assert schema_errors("TaskIntentResult", answer["ok"]) == []
    assert (answer["ok"]["source"], answer["ok"]["state"], answer["ok"]["recorded"]) == ("watch", "pending", True)
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    assert stack.intents("taskIntentStatus", ref(doc))["ok"]["state"] == "created"
    other = new_intent("minimal.json", source="other")
    assert stack.intents("proposeTasks", other) == {"error": "invalid_input", "name": "Error"}
    assert stack.intents("taskIntentStatus", ref(other)) == {"error": "invalid_input", "name": "Error"}
    assert stack.d1(f"SELECT count(*) AS n FROM task_intents WHERE intent_id = '{other['intent_id']}'") == [{"n": 0}]
    for method in ("status", "setGuard", "canaryResult", "reportOps"):
        assert "error" in stack.intents(method, {}), method
    for method, value in (("proposeTasks", doc), ("taskIntentStatus", ref(doc))):
        assert "error" in stack.ops(method, value), method
    assert len(fresh_todoist.creates()) == 1


def test_the_same_intent_id_with_other_content_is_a_conflict(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    doc = new_intent("minimal.json")
    propose(stack, doc)
    created = wait_state(stack, doc, {"created"})
    for other in (doc | {"mode": "separate"}, doc | {"items": [{"title": "Another synthetic title"}]}):
        refused = propose(stack, other)
        assert (refused["state"], refused["error_code"], refused["recorded"]) == ("rejected", "intent_conflict", True)
        assert (refused["tasks_total"], refused["tasks_created"]) == (2, 2)
    assert status(stack, doc) == created
    assert len(fresh_todoist.creates()) == 2


# ---- refusals ------------------------------------------------------------------------------------


def test_input_the_contract_refuses(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    doc = new_intent()
    invalid = [
        doc | {"items": [{"title": "t", "url": "http://watch.ziyixi.science/watches/w1"}]},
        doc | {"intent_id": "Upper-Case"},
        doc | {"items": []},
        doc | {"source": "other"},
        doc | {"extra": True},
        {k: v for k, v in doc.items() if k != "parent"},
        # Over 64 KiB of compact JSON: refused by the gateway before the core wakes.
        doc | {"items": [{"title": f"{n} " + "x" * 290, "description": "y" * 1000} for n in range(30)] * 2},
    ]
    for value in invalid:
        assert stack.intents("proposeTasks", value) == {"error": "invalid_input", "name": "Error"}
    for bad_ref in (ref(doc) | {"intent_id": ""}, {"source": "other", "intent_id": "x"}, "digest"):
        assert stack.intents("taskIntentStatus", bad_ref) == {"error": "invalid_input", "name": "Error"}
    assert stack.d1(f"SELECT count(*) AS n FROM task_intents WHERE intent_id = '{doc['intent_id']}'") == [{"n": 0}]


def test_a_url_off_the_sources_allow_list_is_rejected_and_nothing_recorded(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    for url in ("https://example.org/abs/2609.00001", "https://watch.ziyixi.science.example.org/watches/w1"):
        doc = new_intent("minimal.json", items=[{"title": "Synthetic", "url": url}])
        refused = propose(stack, doc)
        assert (refused["state"], refused["error_code"], refused["recorded"], refused["tasks_total"]) == (
            "rejected",
            "url_not_allowed",
            False,
            0,
        )
        assert status(stack, doc)["state"] == "not_found"
    # The list is exact: a watch task never links to another host, or to a watched page.
    for url in ("https://other.example.com/abs/2609.00001", "https://shop.example.com/kettle"):
        doc = new_intent("watch-urgent.json", items=[{"title": "Synthetic", "url": url}])
        refused = propose(stack, doc)
        assert (refused["state"], refused["error_code"], refused["recorded"]) == ("rejected", "url_not_allowed", False)
    assert fresh_todoist.creates() == []


# ---- retries, failures and unknown results -------------------------------------------------------


def test_retries_send_the_same_frozen_bytes_and_request_id(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    # Three 429s use up the in-call attempts; the durable retry a second later succeeds.
    for _ in range(3):
        fresh_todoist.queue("POST", TASKS_PATH, rate_limited(retry_after_seconds(1)))
    doc = new_intent("minimal.json")
    propose(stack, doc)
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    parent_posts = creates_of(fresh_todoist, doc, 0)
    assert len(parent_posts) == 4
    assert len({(post.body, post.headers["x-request-id"]) for post in parent_posts}) == 1
    assert len(creates_of(fresh_todoist, doc, 1)) == 1


def test_a_partial_failure_is_retried_by_the_proposer_without_duplicates(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    doc = new_intent("separate-2.json")
    doc["items"] = [
        *doc["items"],
        {"title": "Third synthetic watch", "url": "https://watch.ziyixi.science/watches/w2609-00003"},
    ]
    # Item 2 is refused (400); items 1 and 3 are created.
    for reply in (Reply(status=None), Reply(400, {"error": "synthetic refusal"}), Reply(status=None)):
        fresh_todoist.queue("POST", TASKS_PATH, reply)
    propose(stack, doc)
    failed = wait_state(stack, doc, {"created", "failed"})
    assert (failed["state"], failed["error_code"], failed["tasks_created"], failed["tasks_total"]) == (
        "failed",
        "todoist_rejected",
        2,
        3,
    )
    assert failed["recorded"] is True and failed["retry_after_seconds"] is None
    refused = creates_of(fresh_todoist, doc, 2)
    assert len(refused) == 1

    retried = propose(stack, doc)  # the owner's 重试: same intent, same content
    assert (retried["state"], retried["recorded"], retried["tasks_created"]) == ("pending", True, 2)
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    assert [len(creates_of(fresh_todoist, doc, n)) for n in (1, 2, 3)] == [1, 2, 1]
    resent = creates_of(fresh_todoist, doc, 2)
    assert resent[0].headers["x-request-id"] == resent[1].headers["x-request-id"] and resent[0].body == resent[1].body
    assert propose(stack, doc)["state"] == "duplicate"


def test_no_child_is_sent_while_the_parent_is_refused(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    doc = new_intent()
    fresh_todoist.queue("POST", TASKS_PATH, Reply(422, {"error": "synthetic refusal"}))
    propose(stack, doc)
    failed = wait_state(stack, doc, {"created", "failed"})
    assert (failed["state"], failed["error_code"], failed["tasks_created"]) == ("failed", "todoist_rejected", 0)
    assert len(fresh_todoist.creates()) == 1

    assert propose(stack, doc)["state"] == "pending"
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    [parent] = [task for task in fresh_todoist.tasks if task.parent_id is None]
    assert sorted(task.parent_id or "" for task in fresh_todoist.tasks) == ["", parent.id, parent.id, parent.id]


def test_an_unknown_create_is_found_by_the_lookup_and_never_resent(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    doc = new_intent()
    # Todoist creates the parent but the answer is a 500: the result is unknown.
    fresh_todoist.queue("POST", TASKS_PATH, Reply(500, {"error": "synthetic"}, applied=True))
    propose(stack, doc)
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    assert len(creates_of(fresh_todoist, doc, 0)) == 1
    assert fresh_todoist.lists(), "the footer lookup read the task list"
    [parent] = [task for task in fresh_todoist.tasks if task.content == doc["parent"]["title"]]
    assert {task.parent_id for task in fresh_todoist.tasks if task is not parent} == {parent.id}
    _, task_rows = rows(stack, doc)
    assert task_rows[0]["todoist_id"] == parent.id


def test_an_unknown_create_todoist_never_made_waits_for_the_proposer(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    doc = new_intent("separate-2.json")
    fresh_todoist.queue("POST", TASKS_PATH, Reply(500, {"error": "synthetic"}))  # not created
    propose(stack, doc)
    failed = wait_state(stack, doc, {"created", "failed"})
    assert (failed["state"], failed["error_code"], failed["tasks_created"]) == ("failed", "todoist_result_unknown", 1)
    assert len(creates_of(fresh_todoist, doc, 1)) == 1  # looked up, not resent

    lists_before = len(fresh_todoist.lists())
    assert propose(stack, doc)["state"] == "pending"
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    # Looked up again first; only then resent with its frozen request ID.
    assert len(fresh_todoist.lists()) > lists_before
    first, second = creates_of(fresh_todoist, doc, 1)
    assert (first.body, first.headers["x-request-id"]) == (second.body, second.headers["x-request-id"])


def test_an_interrupted_call_is_looked_up_before_anything_is_resent(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    now = int(time.time())
    doc = new_intent("separate-2.json")
    # A step was evicted mid-call on item 1, after Todoist had created it.
    fresh_todoist.add_task(doc["items"][0]["title"], f"synthetic\n\n{footer(doc, 1)}")
    seed(stack, doc, created_at=now - 86400, tasks={1: {"state": "sending"}})
    assert wait_state(stack, doc, {"created", "failed"})["state"] == "created"
    assert creates_of(fresh_todoist, doc, 1) == [] and len(creates_of(fresh_todoist, doc, 2)) == 1


def test_automatic_attempts_stop_after_48(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    now = int(time.time())
    doc = new_intent("minimal.json", mode="separate")
    for _ in range(3):
        fresh_todoist.queue("POST", TASKS_PATH, Reply(503, {"error": "synthetic"}))
    seed(stack, doc, created_at=now - 86400, tasks={1: {"attempts": 47, "started_at": now - 3600}})
    failed = wait_state(stack, doc, {"created", "failed"})
    assert (failed["state"], failed["error_code"], failed["tasks_created"]) == ("failed", "todoist_rejected", 0)
    assert len(creates_of(fresh_todoist, doc, 1)) == 3
    _, [task] = rows(stack, doc)
    assert (task["state"], task["attempts"]) == ("failed", 48)


def test_mail_keeps_its_cadence_while_a_large_intent_is_created(
    launch_stack: StackLaunch, fresh_todoist: TodoistFake, fresh_gemini: GeminiFake
) -> None:
    """Its own server: the module's earlier tests already use up most of the source's ten intents today."""
    stack = launch_stack()
    doc = new_intent("max-items.json", intent_id=f"test-{uuid.uuid4().hex[:12]}")
    propose(stack, doc)
    event_id, body = mail_event()
    assert stack.post_event(body).status_code == 204
    stack.wait_event(event_id, {"complete"}, timeout_s=60)
    done = wait_state(stack, doc, {"created", "failed"}, timeout_s=90)
    assert (done["state"], done["tasks_created"]) == ("created", 31)
    posts = fresh_todoist.creates()
    mail_at = next(i for i, post in enumerate(posts) if event_id in post.json()["description"])
    assert mail_at < len(posts) - 1, "mail was not held back until every intent task existed"
    assert len(posts) == 32


def test_status_counts_intents(stack: OpsStack) -> None:
    counters = stack.ok("status", definition="OpsStatus")["counters"]
    assert counters["intents_pending"] == 0
    assert counters["intents_failed_7d"] >= 0


def test_the_daily_limit_counts_new_intents_per_source(launch_stack: StackLaunch, fresh_todoist: TodoistFake) -> None:
    """Its own server, so the count starts at zero. The limit is per source: another source's full day (here rows of a
    source the contract no longer knows, as the ledger may still hold them) does not hold the watch app's intents."""
    stack = launch_stack()
    now = int(time.time())
    full_day = (ledger_row("other", f"other-{n}", created_at=now) for n in range(intents.INTENTS_PER_SOURCE_PER_DAY))
    stack.d1("; ".join(full_day))
    for _ in range(intents.INTENTS_PER_SOURCE_PER_DAY):
        doc = new_intent("minimal.json")
        assert propose(stack, doc)["state"] == "pending"
        wait_state(stack, doc, {"created"})
    over = new_intent("watch-urgent.json")
    refused = propose(stack, over)
    assert (refused["state"], refused["error_code"], refused["recorded"]) == ("rejected", "daily_limit", False)
    assert 0 < refused["retry_after_seconds"] <= 86400
    assert status(stack, over)["state"] == "not_found"
    assert len(fresh_todoist.creates()) == 2 * intents.INTENTS_PER_SOURCE_PER_DAY


def test_a_pending_row_of_a_source_the_contract_no_longer_knows_fails_and_sends_nothing(
    stack: OpsStack, fresh_todoist: TodoistFake
) -> None:
    """A row recorded under a source whose enum value is now reserved: its frozen text no longer reads as an intent, so
    the next step marks it failed (todoist_rejected) without a Todoist call. Nothing deletes the row; no proposer can
    ask for it (no binding names the source, and the core's strict read refuses it)."""
    now = int(time.time())
    key = {"source": "other", "intent_id": "other-pending"}
    payload = json.dumps(fixture("minimal.json") | key, separators=(",", ":"))
    stack.d1(
        ledger_row("other", "other-pending", created_at=now - 86400, state="pending", payload=payload)
        + "; INSERT INTO task_intent_tasks (source, intent_id, n, request_id, state, attempts, next_attempt_at,"
        f" error_code, started_at, updated_at) VALUES ('other', 'other-pending', 1, '{uuid.uuid4()}', 'pending', 0,"
        f" {now - 86400}, '', {now - 86400}, {now - 86400})"
    )
    wake(stack)

    def failed() -> dict[str, Any] | None:
        where = "source = 'other' AND intent_id = 'other-pending'"
        [row] = stack.d1(f"SELECT state, error_code FROM task_intents WHERE {where}")
        return row if row["state"] == "failed" else None

    settled = wait_until(failed, 40, "the row of an unknown source failed")
    assert settled == {"state": "failed", "error_code": "todoist_rejected"}
    assert fresh_todoist.creates() == []
    asked = stack.intents("taskIntentStatus", {"version": "task-intent-v1"} | key)
    assert asked == {"error": "invalid_input", "name": "Error"}


def test_an_auth_block_holds_recorded_intents_and_refuses_new_ones(stack: OpsStack, fresh_todoist: TodoistFake) -> None:
    """Last in this module: the 6 h Todoist block stays in this server's object."""
    now = int(time.time())
    doc = new_intent("minimal.json")
    fresh_todoist.queue("POST", TASKS_PATH, Reply(401, {"error": "synthetic"}))
    seed(stack, doc, created_at=now - 86400, tasks={})
    held = wait_state(stack, doc, {"paused"})
    assert (held["recorded"], held["error_code"], held["tasks_created"]) == (True, "todoist_blocked", 0)
    assert 21000 < held["retry_after_seconds"] <= 21600
    fresh = propose(stack, new_intent("minimal.json"))
    assert (fresh["state"], fresh["recorded"], fresh["error_code"]) == ("paused", False, "todoist_blocked")
    assert len(fresh_todoist.creates()) == 1


# ---- switches (their own servers) ----------------------------------------------------------------


def test_force_pause_refuses_new_intents_and_holds_recorded_ones(
    launch_stack: StackLaunch, fresh_todoist: TodoistFake
) -> None:
    held_stack = launch_stack(FORCE_PAUSE_TODOIST="true")
    doc = new_intent()
    paused = propose(held_stack, doc)
    assert (paused["state"], paused["recorded"], paused["error_code"], paused["tasks_total"]) == (
        "paused",
        False,
        "todoist_paused",
        0,
    )
    assert paused["retry_after_seconds"] == 3600
    assert status(held_stack, doc)["state"] == "not_found"
    assert held_stack.d1("SELECT count(*) AS n FROM task_intents") == [{"n": 0}]

    now = int(time.time())
    seed(held_stack, doc, created_at=now, tasks={})
    for answer in (status(held_stack, doc), propose(held_stack, doc)):
        assert (answer["state"], answer["recorded"], answer["error_code"]) == ("paused", True, "todoist_paused")

    # A failed intent proposed again (the proposer's retry) while the pause holds: answered paused, nothing re-queued,
    # and taskIntentStatus still reports the failure.
    failed_doc = new_intent("minimal.json")
    seed(
        held_stack,
        failed_doc,
        created_at=now,
        tasks={0: {"state": "created", "todoist_id": "6X0"}, 1: {"state": "failed", "error_code": "todoist_rejected"}},
    )
    key = f"source = '{failed_doc['source']}' AND intent_id = '{failed_doc['intent_id']}'"
    held_stack.d1(
        f"UPDATE task_intents SET state = 'failed', error_code = 'todoist_rejected', tasks_created = 1 WHERE {key}"
    )
    replayed = propose(held_stack, failed_doc)
    assert (replayed["state"], replayed["recorded"], replayed["error_code"]) == ("paused", True, "todoist_paused")
    assert (replayed["retry_after_seconds"], replayed["tasks_created"], replayed["tasks_total"]) == (3600, 1, 2)
    assert status(held_stack, failed_doc)["state"] == "failed"
    intent_row, task_rows = rows(held_stack, failed_doc)
    assert intent_row["state"] == "failed"
    assert [row["state"] for row in task_rows] == ["created", "failed"]
    time.sleep(2)
    assert fresh_todoist.creates() == []


def test_an_intake_without_accepted_sources_rejects_every_proposal(
    launch_stack: StackLaunch, fresh_todoist: TodoistFake
) -> None:
    closed = launch_stack(TASK_INTENT_SOURCES="")
    doc = new_intent("minimal.json")
    refused = propose(closed, doc)
    assert (refused["state"], refused["error_code"], refused["recorded"]) == ("rejected", "source_not_allowed", False)
    assert closed.d1("SELECT count(*) AS n FROM task_intents") == [{"n": 0}]
