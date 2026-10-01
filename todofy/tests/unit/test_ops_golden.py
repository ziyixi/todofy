"""contracts/ops-v1: the exact values Todofy's Ops code answers for fixed synthetic state.

The dashboard reads these answers (a Python dict crosses the Durable Object RPC as a JavaScript object), so a
refactor of core/ops.py (its move onto the generated proto types, for one) must not change one byte of them.
Every case is compared as the compact JSON the dashboard would see (JSON.stringify of the JavaScript object:
key order kept, an integral float written as an integer) with golden/ops-v1.json, which the code before that
move wrote. The stored report (``Report.doc``) is text Todofy keeps in its object storage and is compared as
it is. ``UPDATE_GOLDEN=1 uv run pytest tests/unit/test_ops_golden.py`` rewrites the file; only for an intended
change of the contract, never to make a refactor pass.
"""

import json
import os
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from tests import mail_contract
from todofy.core import ops

GOLDEN = Path(__file__).parent / "golden" / "ops-v1.json"
FIXTURES = mail_contract.TODOFY.parent / "contracts" / "ops-v1" / "fixtures"
NOW = int(datetime(2026, 9, 29, 15, tzinfo=UTC).timestamp())
NOW_MS = NOW * 1000
HOUR = 3600

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
SHED = ops.Guard("shed", "d1_reads_high", NOW_MS + 9 * HOUR * 1000, NOW_MS - 3_300_000)


def js(value: Any) -> Any:
    """``value`` as JavaScript receives it: an integral float is an integer there."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: js(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [js(item) for item in value]
    return value


def compact(value: Any) -> str:
    return json.dumps(js(value), ensure_ascii=False, separators=(",", ":"))


def row(state: str, code: str = "", updated: int = NOW - 60) -> dict[str, Any]:
    return {"state": state, "last_error_code": code, "updated_at": updated, "canary_run_id": "canary-2026-09-29"}


def canary(state: str | None, code: str = "", **holds: bool) -> dict[str, Any]:
    flags = {"maintenance": False, "processing_paused": False, "backup_active": False} | holds
    return ops.canary_result(None if state is None else row(state, code), **flags)


def cases() -> dict[str, Any]:
    daily = json.loads((FIXTURES / "OpsReport" / "daily.json").read_text())
    report = ops.report(daily, NOW + 86400)
    empty = ops.report({"generated_at": ops.timestamp(NOW - 60), "items": []}, NOW)
    millis = ops.report({"generated_at": "2026-09-29T14:59:00.250Z", "items": []}, NOW)
    switches = ops.Switches(maintenance=False, processing_paused=True, force_pause_todoist=False, reminder_enabled=True)
    return {
        "status/ok": ops.status(FACTS),
        "status/degraded": ops.status(
            replace(
                FACTS,
                attention_events=2,
                oldest_due_at=NOW - 2 * HOUR,
                gemini_used=2_460_000,
                gemini_reserved=12_000,
                last_backup_at=NOW - 792_000,
                backup_status="failed",
                backup_active=True,
                reminder_state="failed",
                reminder_attempts=4,
                guard=SHED,
                gtd_stale_seconds=50 * HOUR,
                review_age_days=12,
                intents_pending=1,
                intents_failed_7d=2,
            )
        ),
        "status/every-switch": ops.status(
            replace(
                FACTS,
                maintenance=True,
                processing_paused=True,
                force_pause_todoist=True,
                reminder_enabled=False,
                todoist_blocked_until=NOW + 600,
                gemini_used=2_990_000,
                gemini_budget=3_000_000,
                backup_bound=False,
                last_backup_at=None,
                public_host="",
                gtd_counters={},
                review_age_days=None,
            )
        ),
        "status/no-backup-yet": ops.status(replace(FACTS, last_backup_at=None, gemini_budget=0)),
        "status/unavailable": ops.unavailable_status(NOW, switches, ops.NORMAL, "todofy.example.com"),
        "status/unavailable-shed": ops.unavailable_status(NOW, switches, SHED, "Bad Host"),
        "guard/normal": ops.guard_state(ops.NORMAL, NOW_MS),
        "guard/shed": ops.guard_state(SHED, NOW_MS),
        "guard/shed-millis": ops.guard_state(ops.Guard("shed", "r", NOW_MS + 1_001, NOW_MS + 250), NOW_MS),
        "guard/expired": ops.guard_state(SHED, NOW_MS + 10 * HOUR * 1000),
        "canary/not-seen": canary(None),
        "canary/real-mail": ops.canary_result(
            {**row("complete"), "canary_run_id": None}, maintenance=False, processing_paused=False, backup_active=False
        ),
        "canary/processing": canary("pending"),
        "canary/processing-maintenance": canary("summarizing", maintenance=True),
        "canary/processing-paused": canary("pending", processing_paused=True),
        "canary/processing-backup": canary("pending", backup_active=True),
        "canary/processing-retry": canary("pending", "llm_quota"),
        "canary/ok": canary("complete"),
        "canary/failed": canary("ignored", "llm_quota"),
        "canary/side-effect": canary("created"),
        "receipt/stored": ops.receipt(True, report),
        "receipt/kept-newer": ops.receipt(False, empty),
        "receipt/millis": ops.receipt(True, millis),
        "report/doc-daily": report.doc,
        "report/doc-empty": empty.doc,
    }


def test_every_ops_answer_for_the_synthetic_states_is_byte_for_byte_the_golden_one():
    actual = cases()
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN.write_text(json.dumps(js(actual), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert list(actual) == list(golden)
    for name, value in actual.items():
        if isinstance(value, str):
            assert value == golden[name], name
        else:
            assert compact(value) == compact(golden[name]), name
