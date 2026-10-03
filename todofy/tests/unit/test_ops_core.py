"""core/ops.py: the ops-v1 rules (contracts/ops-v1), with every produced value validated
against the shared schema by the reference validator."""

import ast
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from tests import mail_contract
from todofy.core import ops

CONTRACT = mail_contract.TODOFY.parent / "contracts" / "ops-v1"
SCHEMA = json.loads((CONTRACT / "ops-v1.schema.json").read_text())
NOW = int(datetime(2026, 9, 29, 15, tzinfo=UTC).timestamp())
NOW_MS = NOW * 1000
HOUR = 3600


def errors(definition: str, value: Any) -> list[str]:
    validator = jsonschema.Draft202012Validator({**SCHEMA, "$ref": f"#/$defs/{definition}"})
    return [error.message for error in validator.iter_errors(value)]


def fixture(path: str) -> Any:
    return json.loads((CONTRACT / "fixtures" / path).read_text())


def stamp(seconds: int) -> str:
    return ops.timestamp(seconds)


# ---- inputs --------------------------------------------------------------------------------


def test_limits_equal_the_contract_constants():
    """The rules the IDL cannot hold are ops-v1.ts's OPS_LIMITS; the bounds it states come from the generated tables."""
    source = (CONTRACT / "ops-v1.ts").read_text()
    for name, value in {
        "guardMaxAheadSeconds: 36 * 3600": ops.GUARD_MAX_AHEAD,
        "digestWindowSeconds: 36 * 3600": ops.DIGEST_WINDOW,
        "reportFutureSkewSeconds: 300": ops.REPORT_FUTURE_SKEW,
        "reportMaxBytes: 8192": ops.REPORT_MAX_BYTES,
    }.items():
        assert name in source
        assert eval(name.split(": ")[1]) == value
    assert (ops.REPORT_MAX_ITEMS, ops.MAX_SIGNALS, ops.MAX_METRICS) == (20, 16, 12)


@pytest.mark.parametrize(
    "value",
    [
        {"level": "shed", "reason": "d1_reads_high", "until": stamp(NOW + 60)},
        {"level": "shed", "reason": "d1_reads_high", "until": stamp(NOW + 36 * HOUR)},
        {"level": "shed", "reason": "r", "until": "2026-09-29T15:00:00.001Z"},
        {"level": "normal", "reason": "quota_ok", "until": None},
    ],
)
def test_guard_input_accepts_what_the_schema_and_bounds_allow(value):
    assert errors("SetGuardInput", value) == []
    wanted = ops.guard_input(value, NOW_MS)
    assert (wanted.level, wanted.reason) == (value["level"], value["reason"])


@pytest.mark.parametrize(
    "value",
    [
        {"level": "shed", "reason": "d1_reads_high", "until": stamp(NOW)},  # not in the future
        {"level": "shed", "reason": "d1_reads_high", "until": stamp(NOW - 1)},
        {"level": "shed", "reason": "d1_reads_high", "until": stamp(NOW + 36 * HOUR + 1)},
        {"level": "shed", "reason": "d1_reads_high", "until": None},
        {"level": "normal", "reason": "ok", "until": stamp(NOW + 60)},
        {"level": "shed", "reason": "D1 reads high", "until": stamp(NOW + 60)},
        {"level": "shed", "reason": "ok\n", "until": stamp(NOW + 60)},
        {"level": "shed", "reason": "ok", "until": "2026-09-29T16:00:00+00:00"},
        {"level": "shed", "reason": "ok", "until": "2026-13-29T16:00:00Z"},
        {"level": "off", "reason": "ok", "until": None},
        {"level": "normal", "reason": "ok"},
        {"level": "normal", "reason": "ok", "until": None, "extra": 1},
        ["normal"],
        None,
    ],
)
def test_guard_input_refuses_everything_else(value):
    with pytest.raises(ops.InvalidInput):
        ops.guard_input(value, NOW_MS)


def test_loads_is_strict_json():
    assert ops.loads('{"a": 1}') == {"a": 1}
    for text in ("NaN", '{"a": Infinity}', "{", 7, "x" * (4 * 8192 + 1)):
        with pytest.raises(ops.InvalidInput):
            ops.loads(text)


def test_event_ids_are_lowercase_uuids():
    assert ops.event_id("f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710016")
    for value in ("F8C1E9A0-1A98-4FB8-8CA1-4C0A3E710016", "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710016\n", 7, None):
        with pytest.raises(ops.InvalidInput):
            ops.event_id(value)


# ---- report --------------------------------------------------------------------------------

VALID_REPORTS = sorted((CONTRACT / "fixtures" / "OpsReport").glob("*.json"))
INVALID_REPORTS = sorted((CONTRACT / "fixtures" / "invalid" / "OpsReport").glob("*.json"))


@pytest.mark.parametrize("path", VALID_REPORTS, ids=lambda p: p.stem)
def test_every_valid_report_fixture_is_accepted(path: Path):
    value = json.loads(path.read_text())
    report = ops.report(value, NOW + 86400)
    assert json.loads(report.doc) == value
    assert len(report.doc.encode()) <= ops.REPORT_MAX_BYTES
    assert ops.stored_report(report.doc) == report


@pytest.mark.parametrize("path", INVALID_REPORTS, ids=lambda p: p.stem)
def test_every_invalid_report_fixture_is_refused(path: Path):
    with pytest.raises(ops.InvalidInput):
        ops.report(json.loads(path.read_text()), NOW + 86400)


def daily() -> dict[str, Any]:
    return fixture("OpsReport/daily.json")


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r | {"generated_at": stamp(NOW + 301)},  # beyond the 5-minute clock skew
        lambda r: r | {"items": r["items"] * 5},  # 25 items
        lambda r: r | {"dashboard_url": "http://home.example.com/"},
        lambda r: r | {"dashboard_url": "https://home.example.com/?q=1"},
        lambda r: r | {"note": "free text"},
        lambda r: r | {"items": [r["items"][0] | {"severity": "fatal"}]},
        lambda r: r | {"items": [r["items"][0] | {"source": "Mail Hero"}]},
        lambda r: r | {"items": [r["items"][0] | {"metrics": {"count": True}}]},
        lambda r: r | {"items": [r["items"][0] | {"metrics": {"subject": "Invoice"}}]},
        lambda r: r | {"items": [r["items"][0] | {"metrics": {f"m{i}": i for i in range(13)}}]},
        lambda r: r | {"items": [{k: v for k, v in r["items"][0].items() if k != "since"}]},
    ],
)
def test_report_rules(change):
    report = change(daily())
    with pytest.raises(ops.InvalidInput):
        ops.report(report, NOW)


def test_a_report_over_8_kib_is_refused_even_within_20_items():
    item = {"source": "dashboard", "code": "c" * 48, "severity": "warning", "since": stamp(NOW)}
    metrics = {f"m{i}_{'x' * 40}": 123456789.125 for i in range(12)}
    big = {"generated_at": stamp(NOW), "items": [item | {"metrics": metrics}] * 20}
    assert errors("OpsReport", big) == []
    with pytest.raises(ops.InvalidInput):
        ops.report(big, NOW)


def test_receipts_validate():
    report = ops.report(daily(), NOW + 86400)
    for stored in (True, False):
        receipt = ops.receipt(stored, report)
        assert errors("OpsReportReceipt", receipt) == []
        assert receipt == {"stored": stored, "generated_at": "2026-09-29T23:40:00Z", "item_count": 5}


# ---- guard ---------------------------------------------------------------------------------


def test_guard_state_expires_at_until():
    guard = ops.Guard("shed", "d1_reads_high", NOW_MS + 1000, NOW_MS - 5000)
    shed = ops.guard_state(guard, NOW_MS)
    assert shed == fixture("GuardState/shed-todofy.json") | {
        "until": "2026-09-29T15:00:01Z",
        "set_at": "2026-09-29T14:59:55Z",
    }
    for state in (shed, ops.guard_state(guard, NOW_MS + 1000), ops.guard_state(ops.NORMAL, NOW_MS)):
        assert errors("GuardState", state) == []
    assert ops.guard_state(guard, NOW_MS + 1000) == fixture("GuardState/normal.json")


def test_milliseconds_of_an_input_are_kept():
    guard = ops.Guard("shed", "r", NOW_MS + 1500, NOW_MS)
    assert ops.guard_state(guard, NOW_MS)["until"] == "2026-09-29T15:00:01.500Z"


@pytest.mark.parametrize(
    ("guard", "last_run", "expected"),
    [
        (ops.NORMAL, NOW - HOUR, None),  # no guard: run
        (ops.Guard("shed", "r", NOW_MS + 10 * HOUR * 1000, NOW_MS), None, None),  # never ran: run
        (ops.Guard("shed", "r", NOW_MS + 10 * HOUR * 1000, NOW_MS), NOW - HOUR, NOW + 10 * HOUR),
        (ops.Guard("shed", "r", NOW_MS + 36 * HOUR * 1000, NOW_MS), NOW - 70 * HOUR, NOW + 2 * HOUR),  # the bound
        (ops.Guard("shed", "r", NOW_MS + 10 * HOUR * 1000, NOW_MS), NOW - 72 * HOUR, None),  # bound reached
        (ops.Guard("shed", "r", NOW_MS - 1, NOW_MS - HOUR * 1000), NOW - HOUR, None),  # expired guard
    ],
)
def test_defer_until_holds_a_job_within_its_bound(guard, last_run, expected):
    assert ops.defer_until(guard, NOW, last_run, 72 * HOUR) == expected


def test_only_the_four_deferrable_jobs_are_listed():
    assert [str(job) for job in ops.DEFERRED] == ["weekly_backup", "retention", "metrics_rollup", "gtd_snapshot"]
    assert set(ops.JOB_BOUND) == {ops.Job.RETENTION, ops.Job.METRICS_ROLLUP, ops.Job.GTD_SNAPSHOT}
    # A held snapshot still runs within 48 h: carryover and the counters are then at most two days old.
    assert ops.JOB_BOUND[ops.Job.GTD_SNAPSHOT] == 48 * 3600
    assert ops.BACKUP_BOUND == 7 * 86400 + 12 * HOUR
    assert ops.BACKUP_STALE - ops.BACKUP_BOUND >= 12 * HOUR


@pytest.mark.parametrize(
    ("finished", "next_at", "expected"),
    [
        (True, NOW + 86400, True),  # caught up: next run tomorrow
        (True, NOW + 60, False),  # one batch of a backlog: continues in a minute
        (False, NOW + 600, False),  # failed: retried, not a run
    ],
)
def test_only_a_run_that_caught_up_restarts_the_bound(finished, next_at, expected):
    """F2 (Todofy side): the bound covers the whole job, not one batch of it."""
    assert ops.completed_run(finished, next_at, NOW, 60) is expected


def test_a_renewed_shed_guard_never_makes_the_weekly_backup_stale():
    """F3: a backup on schedule, held by a guard renewed every day, starts before backup_stale."""
    last = NOW - 7 * 86400  # the weekly slot is now
    guard = ops.Guard("shed", "d1_reads_high", (NOW + 36 * HOUR) * 1000, NOW * 1000)
    held_until = ops.defer_until(guard, NOW, last, ops.BACKUP_BOUND)
    assert held_until == last + ops.BACKUP_BOUND  # the bound comes before the guard's end
    renewed = ops.Guard("shed", "d1_reads_high", (held_until + 36 * HOUR) * 1000, held_until * 1000)
    assert ops.defer_until(renewed, held_until, last, ops.BACKUP_BOUND) is None
    # The job (about a minute; allow an hour) finishes while status() still reads the last one as fresh.
    for running_for in (0, 60, HOUR):
        facts = replace(FACTS, now=held_until + running_for, last_backup_at=last, guard=renewed, backup_active=True)
        assert "backup_stale" not in [code for code, _ in codes(ops.status(facts))]


# ---- canary result -------------------------------------------------------------------------


def canary_row(state: str, code: str = "", run: str | None = "canary-2026-09-29") -> dict[str, Any]:
    return {"state": state, "last_error_code": code, "updated_at": NOW, "canary_run_id": run}


@pytest.mark.parametrize(
    ("row", "switches", "expected"),
    [
        (None, {}, {"state": "not_seen"}),
        (canary_row("complete", run=None), {}, {"state": "not_seen"}),  # a real mail's event ID
        (canary_row("pending"), {}, {"state": "processing"}),
        (canary_row("summarizing"), {}, {"state": "processing"}),
        (canary_row("pending", "llm_quota"), {}, {"state": "processing", "waiting_code": "retry_wait"}),
        (
            canary_row("pending"),
            {"processing_paused": True},
            {"state": "processing", "waiting_code": "processing_paused"},
        ),
        (canary_row("pending"), {"maintenance": True}, {"state": "processing", "waiting_code": "maintenance"}),
        (canary_row("pending"), {"backup_active": True}, {"state": "processing", "waiting_code": "backup_active"}),
        (canary_row("complete"), {}, {"state": "ok", "completed_at": "2026-09-29T15:00:00Z"}),
        (
            canary_row("ignored", "llm_quota"),
            {},
            {"state": "failed", "completed_at": "2026-09-29T15:00:00Z", "error_code": "llm_quota"},
        ),
        (
            canary_row("todo_unknown", "todo_result_unknown"),
            {},
            {"state": "failed", "completed_at": "2026-09-29T15:00:00Z", "error_code": "canary_side_effect_blocked"},
        ),
    ],
)
def test_canary_result(row, switches, expected):
    flags = {"maintenance": False, "processing_paused": False, "backup_active": False} | switches
    result = ops.canary_result(row, **flags)
    assert result == expected
    assert errors("CanaryResult", result) == []


# ---- status --------------------------------------------------------------------------------

FACTS = ops.Facts(
    now=NOW,
    maintenance=False,
    processing_paused=False,
    force_pause_todoist=False,
    reminder_enabled=True,
    active_events=2,
    attention_events=0,
    received_24h=63,
    oldest_due_at=None,
    reminder_state="created",
    reminder_attempts=1,
    reminder_retries_left=False,
    gemini_used=412_880,
    gemini_reserved=0,
    gemini_budget=3_000_000,
    gemini_calls=64,
    todoist_blocked_until=0,
    todoist_window_calls=3,
    todoist_window_limit=1000,
    backup_bound=True,
    backup_active=False,
    backup_status="ok",
    last_backup_at=NOW - 363_600,
    guard=ops.NORMAL,
    public_host="todofy.example.com",
    gtd_counters={"inbox_open": 23, "inbox_oldest_days": 41, "overdue": 3, "carryover_open": 9, "completed_7d": 42},
    review_enabled=True,
    review_age_days=2,
)


def codes(status: dict[str, Any]) -> list[tuple[str, str]]:
    return [(signal["code"], signal["severity"]) for signal in status["signals"]]


def test_a_healthy_status_matches_the_contract_fixture_shape():
    status = ops.status(FACTS)
    assert errors("OpsStatus", status) == []
    expected = fixture("OpsStatus/todofy-ok.json")
    # task-intent-v1 added two counters after the fixture was written (counters are an open map).
    counters = expected["counters"] | {"intents_pending": 0, "intents_failed_7d": 0}
    assert status == expected | {
        "generated_at": "2026-09-29T15:00:00Z",
        "last_backup_at": "2026-09-25T10:00:00Z",
        "counters": counters,
    }


def test_status_counts_task_intents():
    status = ops.status(replace(FACTS, intents_pending=2, intents_failed_7d=1))
    assert errors("OpsStatus", status) == []
    assert (status["counters"]["intents_pending"], status["counters"]["intents_failed_7d"]) == (2, 1)
    assert status["health"] == "ok"  # counters only: a failed intent is the proposer's to show


def test_signals_health_and_order():
    facts = replace(
        FACTS,
        attention_events=2,
        oldest_due_at=NOW - 2 * HOUR,
        gemini_used=2_460_000,
        gemini_reserved=12_000,
        last_backup_at=NOW - 792_000,
        guard=ops.Guard("shed", "d1_reads_high", NOW_MS + 32_400_000, NOW_MS - 3_300_000),
        todoist_blocked_until=NOW + 600,
        reminder_state="failed",
        reminder_attempts=5,
    )
    status = ops.status(facts)
    assert errors("OpsStatus", status) == []
    assert status["health"] == "degraded"
    assert codes(status) == [
        ("backup_stale", "critical"),
        ("todoist_blocked", "critical"),
        ("attention", "warning"),
        ("due_backlog", "warning"),
        ("gemini_budget_80", "warning"),
        ("reminder_failed", "warning"),
        ("guard_shed", "info"),
    ]
    by_code = {signal["code"]: signal["metrics"] for signal in status["signals"]}
    assert by_code["gemini_budget_80"] == {
        "percent": 82.4,
        "used_tokens": 2_460_000,
        "reserved_tokens": 12_000,
        "budget_tokens": 3_000_000,
    }
    assert by_code["backup_stale"] == {"age_seconds": 792_000, "has_backup": 1}
    assert by_code["guard_shed"] == {"seconds_left": 32_400}
    assert status["guard"]["deferred"] == ["weekly_backup", "retention", "metrics_rollup", "gtd_snapshot"]
    assert status["counters"]["oldest_due_age_seconds"] == 2 * HOUR


def test_switches_and_backup_signals():
    status = ops.status(
        replace(
            FACTS,
            maintenance=True,
            processing_paused=True,
            force_pause_todoist=True,
            reminder_enabled=False,
            gemini_used=2_900_000,
            backup_status="failed",
            last_backup_at=None,
            reminder_state="unknown",
        )
    )
    assert errors("OpsStatus", status) == []
    assert status["health"] == "down"
    assert codes(status) == [
        ("backup_stale", "critical"),
        ("gemini_budget_95", "critical"),
        ("maintenance_mode", "critical"),
        ("backup_failed", "warning"),
        ("processing_paused", "warning"),
        ("reminder_failed", "warning"),
        ("todoist_paused", "warning"),
        ("reminder_disabled", "info"),
    ]
    assert status["modes"] == {
        "maintenance": True,
        "processing_paused": True,
        "force_pause_todoist": True,
        "reminder_enabled": False,
        "backup_active": False,
    }
    assert "backup_age_seconds" not in status["counters"]
    assert status["last_backup_at"] is None


def test_info_signals_keep_health_ok():
    status = ops.status(replace(FACTS, backup_bound=False, reminder_enabled=False))
    assert codes(status) == [("backup_disabled", "info"), ("reminder_disabled", "info")]
    assert status["health"] == "ok"
    running = ops.status(replace(FACTS, backup_active=True, backup_status="running"))
    assert (codes(running), running["modes"]["backup_active"]) == ([("backup_active", "info")], True)


def test_gtd_counters_and_signals():
    gtd = {"inbox_open": 23, "inbox_oldest_days": 41, "overdue": 3, "carryover_open": 9, "completed_7d": 42}
    status = ops.status(replace(FACTS, gtd_counters=gtd | {"stray": 1}, review_enabled=True, review_age_days=7))
    assert errors("OpsStatus", status) == []
    assert {name: status["counters"][name] for name in gtd} == gtd and "stray" not in status["counters"]
    assert status["counters"]["review_age_days"] == 7
    assert len(status["counters"]) <= 32 and codes(status) == [] and status["health"] == "ok"
    # review_overdue is info: after 10 days it is shown, and the app stays ok (never in the digest).
    assert codes(ops.status(replace(FACTS, review_enabled=True, review_age_days=10))) == []
    overdue = ops.status(replace(FACTS, review_enabled=True, review_age_days=11))
    assert (codes(overdue), overdue["health"]) == ([("review_overdue", "info")], "ok")
    assert overdue["signals"][0]["metrics"] == {"days": 11}
    assert codes(ops.status(replace(FACTS, review_enabled=False, review_age_days=30))) == []
    stale = ops.status(replace(FACTS, gtd_stale_seconds=50 * HOUR + 59))
    assert errors("OpsStatus", stale) == []
    assert (codes(stale), stale["health"]) == ([("gtd_snapshot_stale", "warning")], "degraded")
    assert stale["signals"][0]["metrics"] == {"age_hours": 50}


def test_a_failed_reminder_with_retries_left_is_not_a_signal():
    assert codes(ops.status(replace(FACTS, reminder_state="failed", reminder_retries_left=True))) == []


def test_unavailable_status_matches_the_contract_fixture():
    switches = ops.Switches(False, False, False, True)
    status = ops.unavailable_status(NOW, switches, ops.NORMAL, "todofy.example.com")
    assert errors("OpsStatus", status) == []
    assert status["health"] == "down"
    assert status["signals"] == [{"code": "status_unavailable", "severity": "critical", "metrics": {}}]
    assert status["counters"] == {}
    assert status == fixture("OpsStatus/status-unavailable.json") | {"generated_at": "2026-09-29T15:00:00Z"}


# The modes each app writes even on a status_unavailable status: its deployment variables (contracts/ops-v1 README
# "modes"); a mode read from storage is left out then, never guessed.
DEPLOYMENT_MODES = {
    "mail-hero": ["maintenance", "force_send_paused"],
    "todofy": ["maintenance", "processing_paused", "force_pause_todoist", "reminder_enabled"],
    "lab": ["maintenance"],
    "watch": ["maintenance", "notifications"],
    "fleet": ["maintenance"],
    "newsletter": ["maintenance"],
}


def test_every_deployment_mode_is_a_boolean_also_when_unavailable():
    required = DEPLOYMENT_MODES["todofy"]
    switches = ops.Switches(True, True, False, True)
    for status in (ops.status(FACTS), ops.unavailable_status(NOW, switches, ops.NORMAL, "todofy.example.com")):
        assert all(isinstance(status["modes"][key], bool) for key in required), status["modes"]
    for path in sorted((CONTRACT / "fixtures" / "OpsStatus").glob("*.json")):
        doc = json.loads(path.read_text())
        assert all(isinstance(doc["modes"].get(key), bool) for key in DEPLOYMENT_MODES[doc["app"]]), path.name


@pytest.mark.parametrize(
    ("host", "url"),
    [
        ("todofy.example.com", "https://todofy.example.com/"),
        (" Todofy.Example.com ", "https://todofy.example.com/"),
        ("", None),
        ("todofy.example.com:8443", None),
        ("-bad-", None),
        (".todofy.example.com", None),
        ("todofy.example.com/admin", None),
        ("todofy.example.com?x=1", None),
        ("a" * 300, None),
    ],
)
def test_ui_url(host, url):
    assert ops.ui_url(host) == url


# ---- digest --------------------------------------------------------------------------------


def test_digest_lists_warning_and_critical_items_critical_first():
    report = ops.report(daily(), NOW + 86400)
    digest = ops.digest(report, int(datetime(2026, 9, 30, 0, 5, tzinfo=UTC).timestamp()))
    assert digest is not None
    assert [(i.severity, i.source, i.code) for i in digest.items] == [
        ("critical", "mail-hero", "endpoint_blocked"),
        ("critical", "todofy", "backup_stale"),
        ("warning", "cloudflare", "d1_rows_read_high"),
        ("warning", "dashboard", "canary_not_delivered"),
    ]
    assert digest.items[0].metrics == (("current_blocked", 1), ("waiting_deliveries", 3))
    assert digest.dashboard_url == "https://home.example.com/"


def test_digest_window_and_empty_reports():
    report = ops.report(daily(), NOW + 86400)
    generated = report.generated_ms // 1000
    assert ops.digest(report, generated + ops.DIGEST_WINDOW) is not None
    assert ops.digest(report, generated + ops.DIGEST_WINDOW + 1) is None
    assert ops.digest(None, NOW) is None
    assert ops.digest(ops.report(fixture("OpsReport/empty.json"), NOW + 86400), generated) is None
    info_only = daily() | {"items": [daily()["items"][-1]]}
    assert ops.digest(ops.report(info_only, NOW + 86400), generated) is None


@pytest.mark.parametrize(
    ("value", "text"), [(3, "3"), (3.0, "3"), (81.5, "81.5"), (0.1234, "0.123"), (2.5e-7, "0"), (-1.25, "-1.25")]
)
def test_metric_text(value, text):
    assert ops.metric_text(value) == text


# ---- D1 budget of the runtime (the object runs it; its source is checked here) ---------------


def test_status_reads_d1_once_with_six_bounded_statements():
    """ops-v1 budget: status() is one D1 batch of six indexed reads (five of the mail ledger, one
    of task intents; test_schema_sql checks their plans); canaryResult one primary-key read;
    setGuard and reportOps none."""
    source = (mail_contract.TODOFY / "worker" / "todofy" / "runtime" / "ops.py").read_text()
    functions = {node.name: node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.AsyncFunctionDef)}
    status = ast.unparse(functions["status"])
    assert status.count("db.prepare(") == 6 == ops_runtime_statements(source)
    assert status.count("await db.batch(") == 1 and status.count("await ") == 1
    canary = ast.unparse(functions["canary"])
    assert canary.count("await ") == 1 and "ledger.get(" in canary
    for sync in ("set_guard", "store_report", "latest_report", "guard"):
        assert sync not in functions  # object storage only: no await, no D1


def ops_runtime_statements(source: str) -> int:
    return int(source.split("STATUS_STATEMENTS = ", 1)[1].split("\n", 1)[0])
