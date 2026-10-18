"""The weekly Work and Personal Bets: core/plan.py's rules, and SetWeeklyBet and Plan.weekly_bets through
runtime/plus_api.handle on host CPython with an account clock in US/Pacific.

D1 is host SQLite with every migration (plus_support.py); Todoist is a fake that journals every call, so a test
can show that a Bet never reaches it. The real path in workerd is tests/runtime/test_plus.py. Synthetic text only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from tests.unit.plus_support import D1, Storage, confirm_plan, stubbed_pyodide
from todofy.core import plan

TIMEZONE = "America/Los_Angeles"
LAST, WEEK, NEXT = "2026-10-05", "2026-10-12", "2026-10-19"
LABELS = ("office", "home", "committed", "focus", "candiate", "quarter")
LABELS += ("lead_1d", "lead_3d", "lead_1w", "lead_2w", "lead_1m")


# ---- core/plan.py ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "stored"),
    [
        pytest.param("  Ship the draft  ", "Ship the draft", id="trimmed"),
        pytest.param("Ship\n the\t\tdraft\r\n", "Ship the draft", id="one_line"),
        pytest.param("Ship\x00the\x1bdraft\x7f", "Ship the draft", id="control_characters"),
        pytest.param("周末　去徒步", "周末 去徒步", id="ideographic_space"),
        pytest.param("Run 👩‍👩‍👧 5k", "Run 👩‍👩‍👧 5k", id="zwj_emoji_kept"),
        pytest.param(" \n\t ", "", id="blank_is_none"),
    ],
)
def test_a_bet_is_one_trimmed_line(text, stored):
    assert plan.bet_text(text) == stored


def test_a_bet_is_at_most_160_utf16_code_units():
    assert plan.bet_text("写" * 160) == "写" * 160
    assert plan.bet_text("😀" * 80) == "😀" * 80  # two code units each, as the extension's input counts them
    assert plan.bet_text("a" * 158 + "😀") == "a" * 158 + "😀"
    for text in ("写" * 161, "😀" * 80 + "a", "a" * 159 + "😀"):
        with pytest.raises(ValueError, match="BAD_REQUEST"):
            plan.bet_text(text)
    # Collapsed whitespace does not count against it.
    assert plan.bet_text("a" * 80 + " " * 200 + "b" * 79) == "a" * 80 + " " + "b" * 79
    with pytest.raises(ValueError):
        plan.bet_text("lone \ud800 surrogate")


def test_only_this_week_and_the_next_take_a_bet():
    assert plan.bet_weeks(WEEK) == (LAST, WEEK, NEXT)
    assert plan.bet_weeks("2026-12-28") == ("2026-12-21", "2026-12-28", "2027-01-04")
    assert [plan.bet_writable(week, WEEK) for week in (LAST, WEEK, NEXT, "2026-10-26")] == [False, True, True, False]
    # On Monday the week that ended Sunday is last week.
    assert not plan.bet_writable(WEEK, NEXT) and plan.bet_writable("2026-10-26", NEXT)


# ---- SetWeeklyBet and Plan.weekly_bets ------------------------------------------------------------------------


class Todoist:
    """Only what ReadPlan and setup read; every call is journalled."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        self.calls.append("metadata")
        return {"timezone": TIMEZONE, "labels": [{"id": "id-" + role, "name": role} for role in LABELS], "filters": []}

    async def tasks(self, _core: Any, limit: int = 200, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
        self.calls.append("list")
        return [], ""

    async def task(self, _core: Any, task_id: str) -> dict[str, Any]:
        self.calls.append("task")
        raise AssertionError("no task read")

    async def commands(self, _core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
        self.calls.append("sync")
        raise AssertionError("no Sync write")


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.d1 = D1()
        self.todoist = Todoist()
        for name in ("metadata", "tasks", "task", "commands"):
            monkeypatch.setattr(runtime.todoist, name, getattr(self.todoist, name))
        monkeypatch.setattr(runtime.plus_api, "account_day", self.account_day)
        self.lease = False
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: self.lease)
        storage = Storage([])
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.sql = storage.sql
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TODOIST_DEFAULT_PROJECT_ID="mail"),
            plus_lock=asyncio.Lock(),
            todoist_wait=lambda _now: None,
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )

    def at(self, local: str) -> None:
        self.clock["ms"] = int(datetime.fromisoformat(local).replace(tzinfo=ZoneInfo(TIMEZONE)).timestamp() * 1000)

    def account_day(self, timezone: str) -> str:
        return datetime.fromtimestamp(self.clock["ms"] / 1000, ZoneInfo(timezone)).date().isoformat()

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def bet(self, week: str, area: str, text: str, etag: str = "") -> dict[str, Any]:
        answer = self.call("SetWeeklyBet", week_start=week, area=area, text=text, etag=etag)
        return answer.get("weekly_bet", answer)

    def rows(self) -> list[tuple[Any, ...]]:
        return [
            tuple(row)
            for row in self.d1.db.execute("SELECT period, area, kind, body, rev FROM plan_notes ORDER BY 1, 2")
        ]

    def writes(self) -> int:
        return sum(statement.startswith("INSERT INTO plan_notes") for statement in self.d1.statements)


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts
        from todofy.runtime import plus_todoist as todoist

        runtime = types.SimpleNamespace(
            plus_api=plus_api, plus_receipts=plus_receipts, todoist=todoist, clock=stubs["clock"]
        )
        stack = Stack(runtime, monkeypatch)
        stack.at("2026-10-14T09:00:00")  # Wednesday of WEEK
        asyncio.run(confirm_plan(stack.core))
        stack.todoist.calls.clear()
        yield stack


def test_a_bet_is_created_changed_and_cleared_by_compare_and_set_without_todoist(stack):
    created = stack.bet(WEEK, "work", "  Ship the\nquarterly draft ")
    assert created == {
        "week_start": WEEK,
        "area": "work",
        "text": "Ship the quarterly draft",
        "etag": "1",
        "update_time": "2026-10-14T16:00:00Z",
    }
    changed = stack.bet(WEEK, "work", "Ship the draft to review", created["etag"])
    assert changed["etag"] == "2" and changed["text"] == "Ship the draft to review"
    cleared = stack.bet(WEEK, "work", "", changed["etag"])
    # A cleared Bet keeps its row, at the next rev: an older etag can never overwrite it unseen.
    assert cleared["etag"] == "3" and "text" not in cleared  # the wire profile omits an empty string
    assert stack.rows() == [(WEEK, "work", "bets", "", 3)]
    assert stack.bet(WEEK, "work", "Back from an old tab", created["etag"]) == {"error": "ETAG_MISMATCH"}
    assert stack.rows() == [(WEEK, "work", "bets", "", 3)]
    assert stack.todoist.calls == []
    assert stack.sql.db.execute("SELECT count(*) FROM plus_receipts").fetchone()[0] == 0


def test_the_saved_text_answers_as_saved_whatever_the_etag(stack):
    saved = stack.bet(WEEK, "personal", "Run 10k")
    writes = stack.writes()
    # A request whose answer was lost, sent again with the etag it had: the stored text is the answer.
    assert stack.bet(WEEK, "personal", " Run  10k ", "") == saved
    assert stack.bet(WEEK, "personal", "Run 10k", "stale") == saved
    # Clearing a week that has none writes nothing either.
    assert stack.bet(NEXT, "work", "") == {"week_start": NEXT, "area": "work"}
    assert stack.writes() == writes and stack.rows() == [(WEEK, "personal", "bets", "Run 10k", 1)]


def test_a_new_bet_needs_the_empty_etag_and_a_saved_one_its_own(stack):
    assert stack.bet(WEEK, "work", "First", "1") == {"error": "ETAG_MISMATCH"}
    assert stack.rows() == []
    stack.bet(WEEK, "work", "First")
    assert stack.bet(WEEK, "work", "Second") == {"error": "ETAG_MISMATCH"}
    assert stack.bet(WEEK, "work", "Second", "1")["etag"] == "2"


def test_only_this_week_and_the_next_take_a_write_across_the_sunday_midnight(stack):
    stack.at("2026-10-18T23:30:00")  # Sunday: the weekly review writes next week's
    assert stack.bet(NEXT, "work", "Next week's line")["etag"] == "1"
    this_week = stack.bet(WEEK, "work", "This week's line")
    assert stack.bet("2026-10-26", "work", "Too early") == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.bet(LAST, "work", "Too late") == {"error": "ACTION_NOT_ALLOWED"}
    stack.at("2026-10-19T00:00:00")  # Monday 00:00: that week has ended, its Bet stays as it was
    assert stack.bet(WEEK, "work", "Edited after the end", this_week["etag"]) == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.bet(WEEK, "work", "This week's line", this_week["etag"]) == this_week  # a late replay
    assert stack.bet("2026-10-26", "personal", "Planned a week ahead")["etag"] == "1"


@pytest.mark.parametrize(
    "request_body",
    [
        pytest.param({"week_start": WEEK, "area": "unassigned", "text": "x"}, id="area"),
        pytest.param({"week_start": WEEK, "area": "office", "text": "x"}, id="label_name_is_no_area"),
        pytest.param({"week_start": "2026-W42", "area": "work", "text": "x"}, id="iso_week"),
        pytest.param({"week_start": "20261012", "area": "work", "text": "x"}, id="basic_date"),
        pytest.param({"area": "work", "text": "x"}, id="no_week"),
        pytest.param({"week_start": WEEK, "area": "work", "text": "写" * 161}, id="too_long"),
        pytest.param({"week_start": WEEK, "area": "work", "text": "x", "request_id": str(uuid.uuid4())}, id="field"),
    ],
)
def test_a_bad_request_writes_nothing(stack, request_body):
    assert stack.call("SetWeeklyBet", **request_body) == {"error": "BAD_REQUEST"}
    assert stack.rows() == []


def test_maintenance_and_the_backup_lease_hold_bet_writes_but_not_their_reads(stack):
    stack.bet(WEEK, "work", "Kept")
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.bet(WEEK, "work", "Changed", "1") == {"error": "MAINTENANCE"}
    stack.core.env.MAINTENANCE_MODE = "false"
    stack.lease = True
    assert stack.bet(WEEK, "work", "Changed", "1") == {"error": "MAINTENANCE"}
    assert [bet["text"] for bet in stack.call("ReadPlan")["plan"]["weekly_bets"]] == ["Kept"]
    stack.lease = False
    assert stack.bet(WEEK, "work", "Changed", "1")["text"] == "Changed"


def test_a_bet_needs_a_confirmed_setup(stack):
    stack.d1.db.execute("DELETE FROM plus_settings")
    stack.d1.db.commit()
    assert stack.bet(WEEK, "work", "Before setup") == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.rows() == []


def test_the_plan_carries_last_this_and_next_weeks_bets_in_order(stack):
    stack.at("2026-10-07T09:00:00")  # in LAST
    stack.bet(LAST, "personal", "Last week personal")
    stack.bet(LAST, "work", "Last week work")
    stack.at("2026-10-14T09:00:00")
    stack.bet(NEXT, "work", "Next week work")
    stack.bet(WEEK, "personal", "This week personal")
    cleared = stack.bet(WEEK, "work", "Gone soon")
    stack.bet(WEEK, "work", "", cleared["etag"])
    # Two weeks back and two ahead are not part of this plan.
    stack.d1.db.execute(
        "INSERT INTO plan_notes (period, area, kind, body, updated_at) VALUES ('2026-09-28', 'work', 'bets', 'Old', 1),"
        " ('2026-10-26', 'work', 'bets', 'Later', 1), ('2026-10-12', '', 'review', '[]', 1)"
    )
    stack.d1.db.commit()
    stack.todoist.calls.clear()
    bets = stack.call("ReadPlan")["plan"]["weekly_bets"]
    assert [(bet["week_start"], bet["area"], bet.get("text", "")) for bet in bets] == [
        (LAST, "work", "Last week work"),
        (LAST, "personal", "Last week personal"),
        (WEEK, "work", ""),
        (WEEK, "personal", "This week personal"),
        (NEXT, "work", "Next week work"),
    ]
    assert all(bet["etag"] and bet["update_time"].endswith("Z") for bet in bets)
    assert stack.todoist.calls == ["metadata"]  # the plan's own metadata read; the Bets are D1 only
    # A native page's BASIC view carries none.
    assert "weekly_bets" not in stack.call("ReadPlan", view="basic")["plan"]
