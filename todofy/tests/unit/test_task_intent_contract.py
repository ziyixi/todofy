"""contracts/task-intent-v1 on Todofy's side: the reference JSON Schema validator, the generated types
of proto/todofy/taskintent/v1/task_intent.proto with the wire JSON profile, and core/intents.py.

Lab checks the same fixtures with ``contracts/ops-v1/validate.mjs``
(lab/worker/test/task-intent-contract.test.ts); here the standard validator must give the same
verdicts, the codec must agree with the schema on every fixture (it reads every valid one and keeps its
bytes; of the invalid ones, a strict read refuses the structure and Todofy's value rules the rest),
Todofy's own input checks (the strict read plus the value rules) must agree with the schema on every
fixture and on a set of edge cases, the generated enums and the constants must match the schema and
task-intent-v1.ts, and every result Todofy can build must pass the schema and read back unchanged.
"""

import copy
import json
import re
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire, wire_name

from tests import mail_contract
from todofy.core import intents
from todofy.core.intents import ErrorCode, IntentRow, IntentState, State
from todofy.core.ops import InvalidInput

ROOT = mail_contract.TODOFY.parent / "contracts" / "task-intent-v1"
SCHEMA = json.loads((ROOT / "task-intent-v1.schema.json").read_text())
TYPES = (ROOT / "task-intent-v1.ts").read_text()
NOW = 1_790_000_000


def _cases(folder: Path) -> list[tuple[str, Path]]:
    return sorted(
        (path.parent.name, path)
        for path in folder.glob("*/*.json")
        if path.parent.parent == folder and path.parent.name != "invalid"
    )


VALID = _cases(ROOT / "fixtures")
INVALID = _cases(ROOT / "fixtures" / "invalid")


def schema_errors(name: str, value: Any) -> list[str]:
    validator = jsonschema.Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{name}"})
    return [error.message for error in validator.iter_errors(value)]


def core_accepts(name: str, value: Any) -> bool:
    """Todofy's verdict on an input: through the same JSON text the gateway passes on."""
    parse = {"TaskIntent": intents.intent, "TaskIntentRef": intents.ref}[name]
    try:
        parse(intents.loads(json.dumps(value, ensure_ascii=False)))
    except InvalidInput:
        return False
    return True


def fixture(path: str) -> Any:
    return json.loads((ROOT / "fixtures" / path).read_text())


def compact(value: Any) -> str:
    """The bytes the contract sends and Todofy hashes."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


MESSAGES = {"TaskIntent": pb.TaskIntent, "TaskIntentRef": pb.TaskIntentRef, "TaskIntentResult": pb.TaskIntentResult}
# The invalid fixtures the wire profile reads: each breaks only a value rule (a length, a pattern, a range,
# a count), which the schema and Todofy's own checks hold; a strict read refuses every other one.
VALUE_RULES_ONLY = {
    "description-too-long.json",
    "duplicate-items.json",
    "empty-title.json",
    "http-url.json",
    "intent-id-uppercase.json",
    "newline-in-title.json",
    "no-items.json",
    "parent-title-too-long.json",
    "tab-in-description.json",
    "too-many-items.json",
    "trailing-newline-in-title.json",
    "url-with-query.json",
    "wrong-version.json",
    "too-many-tasks.json",
    "zero-retry-after.json",
}


def test_the_schema_is_valid_draft_2020_12():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


def test_fixtures_exist_for_every_input_and_output():
    assert {name for name, _ in VALID} == {"TaskIntent", "TaskIntentRef", "TaskIntentResult"}
    assert {name for name, _ in INVALID} == {"TaskIntent", "TaskIntentRef", "TaskIntentResult"}


@pytest.mark.parametrize(("name", "path"), VALID, ids=lambda case: getattr(case, "stem", case))
def test_valid_fixtures_pass_the_reference_validator(name: str, path: Path):
    assert schema_errors(name, json.loads(path.read_text())) == []


@pytest.mark.parametrize(("name", "path"), INVALID, ids=lambda case: getattr(case, "stem", case))
def test_invalid_fixtures_fail_the_reference_validator(name: str, path: Path):
    assert schema_errors(name, json.loads(path.read_text())) != []


@pytest.mark.parametrize(("name", "path"), VALID, ids=lambda case: getattr(case, "stem", case))
def test_the_codec_reads_every_valid_fixture_and_keeps_its_bytes(name: str, path: Path):
    """Inputs strictly, outputs leniently with nothing unrecognized: the same compact bytes come back."""
    value = json.loads(path.read_text())
    read = from_wire(MESSAGES[name], value, strict=name != "TaskIntentResult")
    assert read.unrecognized == []
    assert compact(to_wire(read.message)) == compact(value)


@pytest.mark.parametrize(("name", "path"), INVALID, ids=lambda case: getattr(case, "stem", case))
def test_the_codec_refuses_the_structure_of_every_invalid_fixture(name: str, path: Path):
    """The codec sees what is wrong with every invalid fixture but those that break only a value rule: a
    strict read (an input) refuses it, a lenient read (an output, which may carry null) refuses it or lists
    what it skipped (an unknown field or enum name)."""
    try:
        read = from_wire(MESSAGES[name], json.loads(path.read_text()), strict=name != "TaskIntentResult")
    except WireJsonError:
        seen = True
    else:
        seen = read.unrecognized != []
    assert seen == (path.name not in VALUE_RULES_ONLY)


INPUTS = [(name, path) for name, path in VALID + INVALID if name != "TaskIntentResult"]


@pytest.mark.parametrize(("name", "path"), INPUTS, ids=lambda case: getattr(case, "stem", case))
def test_todofy_gives_the_schema_verdict_on_every_input_fixture(name: str, path: Path):
    value = json.loads(path.read_text())
    assert core_accepts(name, value) == (schema_errors(name, value) == [])


def _variant(change: str) -> Any:
    doc = copy.deepcopy(fixture("TaskIntent/subtasks-3.json"))
    item = doc["items"][0]
    match change:
        case "ok":
            pass
        case "item_title_300":
            item["title"] = "题" * 300
        case "item_title_301":
            item["title"] = "题" * 301
        case "parent_title_200":
            doc["parent"]["title"] = "p" * 200
        case "parent_title_201":
            doc["parent"]["title"] = "p" * 201
        case "title_line_separator":
            item["title"] = "a b"
        case "title_tab":
            item["title"] = "a\tb"
        case "title_space_only":
            item["title"] = " "
        case "description_1000":
            item["description"] = "d\n" * 500
        case "description_1001":
            item["description"] = "d" * 1001
        case "description_cr":
            item["description"] = "a\rb"
        case "description_del":
            item["description"] = "a\x7fb"
        case "description_trailing_newline":
            item["description"] = "a\n"
        case "description_empty":
            item["description"] = ""
        case "parent_no_description":
            del doc["parent"]["description"]
        case "parent_extra":
            doc["parent"]["url"] = "https://arxiv.org/abs/1"
        case "url_host_only":
            item["url"] = "https://arxiv.org"
        case "url_other_host":
            item["url"] = "https://example.com/abs/1"
        case "url_port":
            item["url"] = "https://arxiv.org:443/abs/1"
        case "url_upper_host":
            item["url"] = "https://ArXiv.org/abs/1"
        case "url_fragment":
            item["url"] = "https://arxiv.org/abs/1#v2"
        case "url_percent":
            item["url"] = "https://arxiv.org/abs/2609.00001%20x"
        case "url_trailing_newline":
            item["url"] = "https://arxiv.org/abs/1\n"
        case "url_501":
            item["url"] = "https://arxiv.org/" + "a" * 482
        case "items_30":
            doc["items"] = [{"title": f"t{n}"} for n in range(30)]
        case "items_31":
            doc["items"] = [{"title": f"t{n}"} for n in range(31)]
        case "items_not_list":
            doc["items"] = {"title": "t"}
        case "item_not_object":
            doc["items"] = ["t"]
        case "duplicate_items_other_key_order":
            doc["items"] = [
                {"url": "https://arxiv.org/abs/1", "title": "t"},
                {"title": "t", "url": "https://arxiv.org/abs/1"},
            ]
        case "same_title_other_url":
            doc["items"] = [{"title": "t", "url": "https://arxiv.org/abs/1"}, {"title": "t"}]
        case "intent_id_64":
            doc["intent_id"] = "a" * 64
        case "intent_id_65":
            doc["intent_id"] = "a" * 65
        case "intent_id_leading_dot":
            doc["intent_id"] = ".deck"
        case "intent_id_trailing_newline":
            doc["intent_id"] = "deck\n"
        case "mode_separate":
            doc["mode"] = "separate"
        case "title_number":
            item["title"] = 7
        case "title_null":
            item["title"] = None
        case "source_null":
            doc["source"] = None
        case "version_missing":
            del doc["version"]
    return doc


EDGE_CASES = [
    "ok",
    "item_title_300",
    "item_title_301",
    "parent_title_200",
    "parent_title_201",
    "title_line_separator",
    "title_tab",
    "title_space_only",
    "description_1000",
    "description_1001",
    "description_cr",
    "description_del",
    "description_trailing_newline",
    "description_empty",
    "parent_no_description",
    "parent_extra",
    "url_host_only",
    "url_other_host",
    "url_port",
    "url_upper_host",
    "url_fragment",
    "url_percent",
    "url_trailing_newline",
    "url_501",
    "items_30",
    "items_31",
    "items_not_list",
    "item_not_object",
    "duplicate_items_other_key_order",
    "same_title_other_url",
    "intent_id_64",
    "intent_id_65",
    "intent_id_leading_dot",
    "intent_id_trailing_newline",
    "mode_separate",
    "title_number",
    "title_null",
    "source_null",
    "version_missing",
]


@pytest.mark.parametrize("change", EDGE_CASES)
def test_todofy_agrees_with_the_schema_on_edge_cases(change: str):
    value = _variant(change)
    assert core_accepts("TaskIntent", value) == (schema_errors("TaskIntent", value) == []), change


def test_the_url_host_allow_list_is_todofys_own_check():
    """The schema accepts any https host; Todofy then refuses hosts off the source's list."""
    other = intents.intent(_variant("url_other_host"))
    assert intents.urls_allowed(intents.intent(_variant("ok")))
    assert not intents.urls_allowed(other)
    assert intents.urls_allowed(intents.intent(_variant("url_host_only")))
    subdomain = _variant("ok")
    subdomain["items"][0]["url"] = "https://export.arxiv.org/abs/1"
    assert not intents.urls_allowed(intents.intent(subdomain))  # exact hosts only


# ---- the generated enums and the constants of task-intent-v1.ts ----------------------------


def _ts_limits() -> dict[str, int]:
    body = re.search(r"export const TASK_INTENT_LIMITS = \{(.*?)\} as const;", TYPES, re.DOTALL)
    assert body
    return {name: int(value) for name, value in re.findall(r"(\w+): (\d+),", body.group(1))}


def _wire_names(cls: type) -> list[str]:
    return [wire_name(member) for member in cls if member != 0]


def test_the_generated_enums_and_the_constants_match_the_schema_and_the_typescript():
    defs = SCHEMA["$defs"]
    assert re.search(r"TASK_INTENT_VERSION = '([^']+)'", TYPES).group(1) == intents.VERSION == defs["Version"]["const"]
    assert _wire_names(pb.Source) == list(intents.SOURCES) == defs["Source"]["enum"]
    assert _wire_names(pb.Mode) == list(intents.MODES) == defs["Mode"]["enum"]
    assert _wire_names(State) == defs["State"]["enum"]
    assert _wire_names(ErrorCode) == defs["ErrorCode"]["enum"]
    hosts = re.search(r"TASK_INTENT_URL_HOSTS[^=]*= \{(.*?)\};", TYPES, re.DOTALL).group(1)
    assert {s: tuple(re.findall(r"'([^']*)'", h)) for s, h in re.findall(r"(\w+): \[([^\]]*)\]", hosts)} == dict(
        intents.URL_HOSTS
    )
    assert tuple(intents.URL_HOSTS) == intents.SOURCES
    assert _ts_limits() == {
        "itemsMax": intents.ITEMS_MAX,
        "tasksMax": intents.TASKS_MAX,
        "parentTitleMax": intents.PARENT_TITLE_MAX,
        "itemTitleMax": intents.ITEM_TITLE_MAX,
        "descriptionMax": intents.DESCRIPTION_MAX,
        "urlMax": intents.URL_MAX,
        "intentsPerSourcePerDay": intents.INTENTS_PER_SOURCE_PER_DAY,
        "intentMaxBytes": intents.INTENT_MAX_BYTES,
        "statusMinIntervalSeconds": intents.STATUS_MIN_INTERVAL,
        "retryAfterMaxSeconds": intents.RETRY_AFTER_MAX,
    }
    assert defs["TaskIntent"]["properties"]["items"]["maxItems"] == intents.ITEMS_MAX
    assert defs["TaskIntentResult"]["properties"]["tasks_total"]["maximum"] == intents.TASKS_MAX
    assert defs["ParentTitle"]["maxLength"] == intents.PARENT_TITLE_MAX
    assert defs["ItemTitle"]["maxLength"] == intents.ITEM_TITLE_MAX
    assert defs["BlockText"]["maxLength"] == intents.DESCRIPTION_MAX
    assert defs["HttpsUrl"]["maxLength"] == intents.URL_MAX
    retry = defs["TaskIntentResult"]["properties"]["retry_after_seconds"]["anyOf"][0]
    assert (retry["minimum"], retry["maximum"]) == (1, intents.RETRY_AFTER_MAX)


# ---- every result Todofy builds passes the schema -----------------------------------------


def _row(state: str, **fields: Any) -> IntentRow:
    """A task_intents row as D1 returns it (error codes by wire name), read the way the runtime reads it."""
    base = {
        "source": "lab",
        "intent_id": "deck-2026-09-30-g1",
        "payload_sha256": "0" * 64,
        "mode": "subtasks",
        "tasks_total": 4,
        "tasks_created": 1,
        "state": state,
        "error_code": "",
        "next_attempt_at": NOW + 30,
        "created_at": NOW - 60,
        "updated_at": NOW - 5,
    }
    return IntentRow.from_row(base | {"state": state} | fields)


PAUSES = [
    intents.pause(
        maintenance=True, processing_paused=False, force_pause=False, blocked_until=0, backup_active=False, now=NOW
    ),
    intents.pause(
        maintenance=False, processing_paused=True, force_pause=False, blocked_until=0, backup_active=False, now=NOW
    ),
    intents.pause(
        maintenance=False, processing_paused=False, force_pause=True, blocked_until=0, backup_active=False, now=NOW
    ),
    intents.pause(
        maintenance=False,
        processing_paused=False,
        force_pause=False,
        blocked_until=NOW + 21600,
        backup_active=False,
        now=NOW,
    ),
    intents.pause(
        maintenance=False, processing_paused=False, force_pause=False, blocked_until=0, backup_active=True, now=NOW
    ),
]


def _results() -> list[dict[str, Any]]:
    value = intents.intent(fixture("TaskIntent/max-items.json"))
    built = [
        intents.recorded_new(value, NOW),
        intents.not_found("lab", "x", NOW),
        intents.conflict(_row(IntentState.PENDING)),
        intents.rejected_new("lab", "x", ErrorCode.DAILY_LIMIT, NOW, intents.until_tomorrow(NOW)),
        intents.rejected_new("lab", "x", ErrorCode.URL_NOT_ALLOWED, NOW),
        intents.rejected_new("lab", "x", ErrorCode.SOURCE_NOT_ALLOWED, NOW),
    ]
    for held in [None, *PAUSES]:
        built.append(intents.describe(_row(IntentState.PENDING), held, NOW, proposing=False))
        built.append(intents.describe(_row(IntentState.PENDING, error_code="rate_limited"), held, NOW, proposing=True))
        built.append(
            intents.describe(_row(IntentState.PENDING, next_attempt_at=NOW + 10**6), held, NOW, proposing=False)
        )
        if held is not None:
            built.append(intents.paused_new("lab", "x", held, NOW))
        for proposing in (False, True):
            built.append(intents.describe(_row(IntentState.CREATED, tasks_created=4), held, NOW, proposing=proposing))
            built.append(
                intents.describe(
                    _row(IntentState.FAILED, error_code="todoist_rejected"), held, NOW, proposing=proposing
                )
            )
    return built


RESULTS = _results()


@pytest.mark.parametrize("index", range(len(RESULTS)))
def test_every_result_todofy_builds_passes_the_schema(index: int):
    assert schema_errors("TaskIntentResult", RESULTS[index]) == [], RESULTS[index]


@pytest.mark.parametrize("index", range(len(RESULTS)))
def test_every_result_todofy_builds_reads_back_unchanged(index: int):
    """What Lab reads (leniently): nothing unrecognized, the same bytes when written again."""
    read = from_wire(pb.TaskIntentResult, RESULTS[index])
    assert read.unrecognized == []
    assert compact(to_wire(read.message)) == compact(RESULTS[index])


def test_an_error_code_this_build_does_not_know_is_answered_as_none():
    """A ledger row written by a newer build (rolled back since): the default branch, never a crash."""
    for state in (IntentState.PENDING, IntentState.FAILED):
        row = _row(state, error_code="quota_exhausted")
        assert row.error_code == ErrorCode.UNSPECIFIED
        built = intents.describe(row, None, NOW, proposing=False)
        assert built["error_code"] is None
        assert schema_errors("TaskIntentResult", built) == []


def test_results_match_the_fixture_shapes():
    """Same answers as the fixtures for the same situations (timestamps aside)."""
    pending = intents.describe(_row(IntentState.PENDING, tasks_created=0), None, NOW, proposing=False)
    assert pending["retry_after_seconds"] == 30
    held = intents.describe(_row(IntentState.PENDING), PAUSES[3], NOW, proposing=False)
    expected = fixture("TaskIntentResult/paused-held.json")
    assert {k: v for k, v in held.items() if k != "updated_at"} == {
        k: v for k, v in expected.items() if k != "updated_at"
    }
    fresh = intents.paused_new("lab", "deck-2026-09-30-g1", PAUSES[0], NOW)
    expected = fixture("TaskIntentResult/paused-maintenance.json")
    assert {k: v for k, v in fresh.items() if k != "updated_at"} == {
        k: v for k, v in expected.items() if k != "updated_at"
    }
    for path, row in (
        ("created.json", _row(IntentState.CREATED, tasks_created=4)),
        ("failed-partial.json", _row(IntentState.FAILED, tasks_created=3, error_code="todoist_rejected")),
    ):
        built = intents.describe(row, None, NOW, proposing=False)
        expected = fixture(f"TaskIntentResult/{path}")
        assert {k: v for k, v in built.items() if k != "updated_at"} == {
            k: v for k, v in expected.items() if k != "updated_at"
        }


def test_results_never_carry_task_text():
    value = intents.intent(fixture("TaskIntent/subtasks-3.json"))
    texts = [value.parent_title, *(item.title for item in value.items)]
    for built in [*RESULTS, intents.recorded_new(value, NOW)]:
        dumped = json.dumps(built, ensure_ascii=False)
        assert not any(text in dumped for text in texts)
