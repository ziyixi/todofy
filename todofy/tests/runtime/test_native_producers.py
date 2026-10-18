"""Producers default to the Tasks Inbox, whatever TODOIST_DEFAULT_PROJECT_ID names."""

import json
import time
import uuid
from datetime import UTC, datetime

import pytest

from tests.runtime.harness import ROOT
from tests.runtime.test_clients_native_tasks import call, rpc
from tests.runtime.test_clients_native_tasks import native as native_fixture
from todofy.core import gtd, intents

NOW = int(time.time())
DAY = 86400
SUNDAY = int(datetime(2026, 10, 18, 17, tzinfo=UTC).timestamp())
VARS = {
    "TODOIST_DEFAULT_PROJECT_ID": "retired-mail-project",
    "TASKS_PUBLIC_URL": "https://tasks.example.test",
    "TODOFY_PUBLIC_HOST": "todofy.example.test",
}


@pytest.fixture(scope="module")
def producer(tmp_path_factory):
    yield from native_fixture.__wrapped__(tmp_path_factory)


def produce(worker, name, kind, **body):
    return call(worker, "/native/producer", {"name": name, "kind": kind, "now": NOW, "vars": VARS, **body})


def new_intent():
    value = json.loads((ROOT.parent / "contracts/task-intent-v1/fixtures/TaskIntent/minimal.json").read_text())
    return value | {"intent_id": f"native-{uuid.uuid4().hex[:12]}"}


def test_watch_intent_defaults_to_inbox_and_unknown_result_finds_it_without_resending(producer):
    native = producer
    document = new_intent()
    name = f"native-intent-{document['intent_id']}"
    assert produce(native, name, "intent_propose", intent=document)["state"] == "pending"
    produce(native, name, "intent_step")
    [created] = native.d1(f"SELECT todoist_id FROM task_intent_tasks WHERE n=0 AND intent_id='{document['intent_id']}'")
    task = rpc(native, "GetTask", {"name": f"tasks/{created['todoist_id']}"})
    assert task.get("project_id", "") == ""
    assert task["id"] in {row["id"] for row in rpc(native, "ListTasks", {"view": "inbox"})["tasks"]}

    # Simulate a persisted unknown response for that same already-created native task.
    native.d1(
        "UPDATE task_intents SET state='pending',tasks_created=1,payload_json="
        f"'{json.dumps(document).replace(chr(39), chr(39) * 2)}',next_attempt_at=0"
        f" WHERE intent_id='{document['intent_id']}';"
        "UPDATE task_intent_tasks SET state='unknown',todoist_id=NULL,next_attempt_at=1"
        f" WHERE n=0 AND intent_id='{document['intent_id']}'"
    )
    produce(native, name, "intent_step")
    [settled] = native.d1(
        f"SELECT state,todoist_id FROM task_intent_tasks WHERE n=0 AND intent_id='{document['intent_id']}'"
    )
    assert settled == {"state": "created", "todoist_id": task["id"]}
    rows = rpc(native, "ListTasks", {"view": "all", "include_description": True, "page_size": 100})["tasks"]
    footer = intents.footer(document["source"], document["intent_id"], 0)
    assert sum(intents.has_footer(row.get("description", ""), footer) for row in rows) == 1


def test_new_reminder_and_review_default_to_native_inbox_but_explicit_project_is_preserved(producer):
    native = producer
    native.d1(
        "INSERT INTO mail_events(source_id,event_id,payload_hash,state,created_at,updated_at)"
        f" VALUES('mail-hero-personal','producer-attention','{'0' * 64}','failed_summary',{NOW},{NOW})"
    )
    produce(native, "native-reminder", "reminder", vars=VARS | {"REMINDER_ENABLED": "true"})
    [reminder] = native.d1("SELECT task_id,project_id FROM mail_reminders ORDER BY day DESC LIMIT 1")
    assert reminder["project_id"] == ""
    assert rpc(native, "GetTask", {"name": f"tasks/{reminder['task_id']}"}).get("project_id", "") == ""
    produce(native, "native-review", "review", now=SUNDAY, vars=VARS | {"GTD_REVIEW_ENABLED": "true"})
    [review] = native.d1("SELECT task_id,project_id FROM gtd_reviews ORDER BY week DESC LIMIT 1")
    assert review["project_id"] == ""
    assert rpc(native, "GetTask", {"name": f"tasks/{review['task_id']}"}).get("project_id", "") == ""
    project = rpc(
        native, "CreateProject", {"project": {"title": "Synthetic explicit ops"}, "request_id": str(uuid.uuid4())}
    )
    produce(
        native,
        "native-explicit-reminder",
        "reminder",
        now=NOW + DAY,
        vars=VARS | {"REMINDER_ENABLED": "true", "TODOIST_OPS_PROJECT_ID": project["id"]},
    )
    [explicit] = native.d1("SELECT task_id,project_id FROM mail_reminders ORDER BY day DESC LIMIT 1")
    assert explicit["project_id"] == project["id"]
    assert rpc(native, "GetTask", {"name": f"tasks/{explicit['task_id']}"})["project_id"] == project["id"]
    retry_day = gtd.day_of(NOW + 2 * DAY)
    native.d1(
        "INSERT INTO mail_reminders(day,state,subject,body,attention_count,attempts,project_id,created_at,updated_at)"
        f" VALUES('{retry_day}','failed','Frozen reminder','Frozen body',1,1,'{project['id']}',{NOW},{NOW})"
    )
    produce(native, "native-frozen-reminder", "reminder", now=NOW + 2 * DAY, vars=VARS | {"REMINDER_ENABLED": "true"})
    [frozen] = native.d1(f"SELECT task_id,project_id FROM mail_reminders WHERE day='{retry_day}'")
    assert frozen["project_id"] == project["id"]
    assert rpc(native, "GetTask", {"name": f"tasks/{frozen['task_id']}"})["project_id"] == project["id"]


def test_native_gtd_uses_actual_inbox_and_untriaged_mail_instead_of_old_mail_project(producer):
    native = producer
    # An imported account can have a physical Inbox ID. Blank new task IDs and that ID are one Inbox.
    native.tasks_d1("INSERT INTO projects(id,title,inbox,created_at,updated_at) VALUES('physical-inbox','Inbox',1,1,1)")
    rpc(
        native,
        "CreateTask",
        {
            "task": {"title": "Synthetic physical Inbox", "project_id": "physical-inbox"},
            "request_id": str(uuid.uuid4()),
        },
    )
    completed = rpc(
        native, "CreateTask", {"task": {"title": "Synthetic completed Inbox"}, "request_id": str(uuid.uuid4())}
    )
    rpc(native, "CompleteTask", {"name": completed["name"], "etag": completed["etag"], "request_id": str(uuid.uuid4())})
    for event_id, age, task_id, triaged_at, imported in (
        ("pending-native-mail", 2 * DAY, "", "NULL", 0),
        ("converted-native-mail", 3 * DAY, completed["id"], str(NOW), 0),
        ("recent-native-mail", 3600, "", "NULL", 0),
        ("expired-native-mail", 15 * DAY, "", "NULL", 0),
        ("imported-native-mail", 4 * DAY, "", "NULL", 1),
    ):
        native.d1(
            "INSERT INTO summaries(event_id,created_at,subject,summary,model,task_id,triaged_at,imported)"
            f" VALUES('{event_id}',{NOW - age},'Synthetic','s','m','{task_id}',{triaged_at},{imported})"
        )
    collected_at = int(time.time()) + 1
    result = produce(
        native,
        "native-gtd",
        "collect",
        now=collected_at,
        vars=VARS | {"GTD_COLLECT_UTC": "00:00", "GTD_REVIEW_ENABLED": "false"},
    )
    day = gtd.day_of(collected_at)
    rows = {row["scope"]: row for row in native.d1(f"SELECT * FROM gtd_daily WHERE day='{day}'")}
    assert rows["all"]["mail_open"] == result["counters"]["carryover_open"] == 1
    actual = rpc(native, "ListTasks", {"view": "all", "page_size": 100})["tasks"]
    assert rows["inbox"]["open"] == sum(row.get("project_id", "") in {"", "physical-inbox"} for row in actual)
    assert rows["inbox"]["completed_7d"] == 1
