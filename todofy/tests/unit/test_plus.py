"""Personal planning behavior, using synthetic tasks only."""

import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from todofy.core import plus
from todofy.core.sql import plus as sql

TODAY = "2026-10-13"
# The account timezone the gate reads fixed-timezone due dates in (UTC-7 on TODAY).
TIMEZONE = "America/Los_Angeles"
REQUEST = "f4438dda-dc8d-4732-aa59-bdb1a4dc21fa"
QUICK = "@quick&(nodate|3days)"


def task(**values):
    return {
        "id": "task1",
        "content": "Synthetic report",
        "labels": ["office", "deep"],
        "project_id": "project1",
        **values,
    }


def test_stage_change_retains_unrelated_labels_and_the_retired_bet_is_refused():
    source = task(labels=["committed", "focus", "office", "deep", "lead_2w", "bets"])
    assert plus.plan_labels(source, {"stage": "monthly"}) == ["bets", "candiate", "deep", "lead_2w", "office"]
    assert plus.plan_labels(source, {"area": "personal"}) == ["bets", "committed", "deep", "focus", "home", "lead_2w"]
    # The weekly Bets are text: Plus never adds or removes the Bets label again, with or without a binding.
    for request in ({"bet": True}, {"bet": False}, {"stage": "committed", "bet": True}):
        with pytest.raises(ValueError, match="BAD_REQUEST"):
            plus.plan_labels(source, request)
        with pytest.raises(ValueError, match="BAD_REQUEST"):
            plus.plan_labels(source, request, mapping())


def test_in_progress_adds_or_removes_only_the_literal_active_label():
    source = task(labels=["committed", "office", "lead_1w", "bets"], deadline={"date": TODAY})
    assert plus.plan_labels(source, {"active": True}) == ["active", "bets", "committed", "lead_1w", "office"]
    assert plus.plan_labels(task(labels=["active", "office"]), {"active": False}) == ["office"]
    # Configured names never rename it, and it is no planning mark.
    assert plus.plan_labels(task(labels=["custom-committed"]), {"active": True}, mapping()) == [
        "active",
        "custom-committed",
    ]
    view = plus.task_view(task(labels=["active", "lead_1w"], deadline={"date": TODAY}), TODAY)
    assert not view["must_start"] and not view["missing_lead"]


def test_in_progress_never_moves_a_kept_sunday_choice():
    week, sunday = "2026-10-12", "2026-10-18"
    assert plus.membership_week(sunday, week, {"active": True}) == week
    db = sqlite3.connect(":memory:")
    db.executescript((Path(__file__).resolve().parents[2] / "migrations/0006_todoist_plus.sql").read_text())
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-19", 1, 0))
    # Marking it in progress that Sunday records its marks under the ending week, which never moves it back.
    db.execute(sql.REMEMBER_WEEK, ("task1", plus.membership_week(sunday, week, {"active": True}), 1, 0))
    assert db.execute("SELECT week_start FROM plus_weeks WHERE task_id='task1'").fetchone() == ("2026-10-19",)


def test_parking_sets_a_task_aside_whatever_its_stage_and_unparking_removes_only_the_label():
    source = task(labels=["committed", "quarter", "focus", "active", "office", "deep", "lead_1w"])
    assert plus.plan_labels(source, {"parked": True}) == ["deep", "lead_1w", "office", "parked"]
    # A Quick task's focus or candiate gives no stage (label_stage), and parking still removes it.
    for planning in ("focus", "candiate"):
        assert plus.label_stage({"quick", planning}, plus.role_labels()) == "none"
        assert plus.plan_labels(task(labels=["quick", planning]), {"parked": True}) == ["parked", "quick"]
    # Parked wins over a stage sent with it, and goes by the configured names.
    assert plus.plan_labels(task(labels=["office"]), {"stage": "committed", "parked": True}) == ["office", "parked"]
    custom = task(labels=["custom-committed", "custom-candiate", "custom-office", "custom-bets"])
    assert plus.plan_labels(custom, {"parked": True}, mapping()) == ["custom-bets", "custom-office", "parked"]
    # Out of Parked into a stage lane: the stage, and parked goes; alone, only parked goes.
    assert plus.plan_labels(task(labels=["parked", "office"]), {"stage": "monthly", "parked": False}) == [
        "candiate",
        "office",
    ]
    assert plus.plan_labels(task(labels=["parked", "deep", "waiting"]), {"parked": False}) == ["deep", "waiting"]
    assert plus.plan_labels(task(labels=["deep"]), {"parked": False}) == ["deep"]


def test_a_start_now_drag_writes_the_stage_and_in_progress_in_one_request():
    """The Review board's drag from Start now into Committed sends {stage, active} together."""
    source = task(labels=["lead_1w", "office", "focus"], deadline={"date": TODAY})
    assert plus.task_view(source, TODAY)["must_start"]
    labels = plus.plan_labels(source, {"stage": "committed", "active": True})
    assert labels == ["active", "committed", "lead_1w", "office"]
    view = plus.task_view({**source, "labels": labels}, TODAY)
    assert view["stage"] == "committed" and not view["must_start"]
    # On the week's last day it is a commitment for the next week, as without `active`.
    request = {"stage": "committed", "active": True}
    assert plus.membership_week("2026-10-18", "2026-10-12", request) == "2026-10-19"
    assert plus.membership_week("2026-10-15", "2026-10-12", request) == "2026-10-12"


def test_choosing_the_stage_a_task_already_shows_removes_no_label():
    """A Sunday keep resends the commitment; the owner's other horizon labels stay (no implicit removal)."""
    source = task(labels=["committed", "quarter", "candiate", "office", "waiting"])
    assert plus.plan_labels(source, {"stage": "committed"}) == ["candiate", "committed", "office", "quarter", "waiting"]
    assert plus.membership_week("2026-10-18", "2026-10-12", {"stage": "committed"}) == "2026-10-19"
    assert plus.plan_labels(task(labels=["quarter", "focus"]), {"stage": "quarterly"}) == ["focus", "quarter"]
    # A stage the labels do not already give still replaces every planning label.
    assert plus.plan_labels(task(labels=["committed", "quarter"]), {"stage": "weekly"}) == ["focus"]
    assert plus.plan_labels(task(labels=["quarter", "focus"]), {"stage": "weekly"}) == ["focus"]
    assert plus.plan_labels(task(labels=["focus", "quick"]), {"stage": "weekly"}) == ["focus", "quick"]
    # A date-driven weekly candidate has no planning label: choosing weekly pins it with one.
    assert plus.plan_labels(task(labels=[], due={"date": TODAY}), {"stage": "weekly"}) == ["focus"]


def test_display_preserves_candidate_date_rule_and_deduplicates_commitments():
    assert plus.task_view(task(labels=["focus", "committed"]), TODAY)["stage"] == "committed"
    assert plus.task_view(task(due={"date": "2026-10-12"}), TODAY)["stage"] == "weekly"
    assert plus.task_view(task(deadline={"date": TODAY}), TODAY)["stage"] == "weekly"
    assert plus.task_view(task(due={"date": "2027-01-01"}, deadline={"date": TODAY}), TODAY)["stage"] == "none"
    assert plus.task_view(task(labels=["routine"], due={"date": TODAY}), TODAY)["stage"] == "none"
    assert plus.task_view(task(labels=["candiate"]), TODAY)["stage"] == "monthly"
    assert plus.task_view(task(labels=["office", "home"]), TODAY)["area"] == "unassigned"


def test_deadline_is_not_scheduled_date_and_preserves_filter_boundaries():
    assert not plus.task_view(task(due={"date": TODAY}, labels=["lead_2w"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": "2026-10-26"}, labels=["lead_2w"]), TODAY)["must_start"]
    assert not plus.task_view(task(deadline={"date": "2026-10-27"}, labels=["lead_2w"]), TODAY)["must_start"]
    # The same edge for lead_3d: two days ahead it must start, three days ahead not yet.
    assert plus.task_view(task(deadline={"date": "2026-10-15"}, labels=["lead_3d"]), TODAY)["must_start"]
    assert not plus.task_view(task(deadline={"date": "2026-10-16"}, labels=["lead_3d"]), TODAY)["must_start"]
    assert not plus.task_view(task(deadline={"date": TODAY}, labels=["lead_2w", "waiting"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": "2026-10-12"}, labels=["waiting"]), TODAY)["must_start"]
    assert plus.task_view(task(deadline={"date": TODAY}), TODAY)["missing_lead"]
    assert plus.lead_args(task(labels=["lead_1m", "deep"]), TODAY, 7) == {
        "labels": ["deep", "lead_1w"],
        "deadline": {"date": TODAY},
    }


def test_estimates_are_optional_and_two_hours_is_not_rejected():
    assert "estimated_minutes" not in plus.task_view(task(), TODAY)
    assert plus.task_view(task(duration={"amount": 180, "unit": "minute"}), TODAY)["estimated_minutes"] == 180
    assert plus.task_view(task(duration={"amount": 1, "unit": "day"}), TODAY)["estimated_minutes"] == 480


def test_mapping_never_fuzzy_matches_or_adopts_duplicate_labels():
    labels = [{"id": f"id-{role}", "name": role} for role in plus.ROLES]
    assert not plus.discover(labels, "UTC")["missing_labels"]
    assert plus.discover([*labels, {"id": "other", "name": "home"}], "UTC")["missing_labels"] == ["home"]
    assert plus.discover(labels, "UTC")["etag"] != plus.discover(labels, "America/Los_Angeles")["etag"]


def test_reset_clears_only_ended_week_marks_and_moves_only_commitments():
    assert plus.reset_labels(task(labels=["bets", "committed", "office", "lead_1w"]), {"committed": 1, "bet": 1}) == [
        "focus",
        "lead_1w",
        "office",
    ]
    assert plus.reset_labels(task(labels=["bets", "candiate"]), {"committed": 0, "bet": 1}) == ["candiate"]
    assert plus.week_start("2026-10-18") == "2026-10-12"
    assert plus.week_start("2026-10-19") == "2026-10-19"
    db = sqlite3.connect(":memory:")
    migration = Path(__file__).resolve().parents[2] / "migrations/0006_todoist_plus.sql"
    db.executescript(migration.read_text())
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-12", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("task1", "2026-10-19", 1, 1))
    assert db.execute(sql.ENDED_WEEK, ("2026-10-19",)).fetchall() == []


def test_only_a_commitment_chosen_on_the_last_day_waits_for_the_next_week():
    week, sunday = "2026-10-12", "2026-10-18"
    assert plus.membership_week(sunday, week, {"stage": "committed", "task_id": "task1"}) == "2026-10-19"
    # Other stages, an area or a deadline change on Sunday stay in the ending week.
    for request in ({"stage": "weekly"}, {"area": "work"}, {"deadline": sunday, "lead_days": 7}):
        assert plus.membership_week(sunday, week, request) == week
    # A commitment made on any other day of the week ends with it.
    for today in ("2026-10-12", "2026-10-14", "2026-10-17"):
        assert plus.membership_week(today, week, {"stage": "committed"}) == week


def test_membership_never_moves_back_so_sunday_scans_cannot_undo_a_next_week_choice():
    db = sqlite3.connect(":memory:")
    db.executescript((Path(__file__).resolve().parents[2] / "migrations/0006_todoist_plus.sql").read_text())

    def week_of(task_id):
        return db.execute("SELECT week_start, committed, bet FROM plus_weeks WHERE task_id=?", (task_id,)).fetchone()

    db.execute(sql.REMEMBER_WEEK, ("sunday", "2026-10-19", 1, 0))
    db.execute(sql.REMEMBER_WEEK, ("weekday", "2026-10-12", 1, 1))
    # The ten-minute scan on Sunday remembers both under the ending week.
    db.execute(sql.REMEMBER_WEEK, ("sunday", "2026-10-12", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("weekday", "2026-10-12", 1, 0))
    # The week stays; the marks follow what the scan saw (a Bet added since in native Todoist).
    assert week_of("sunday") == ("2026-10-19", 1, 1)
    assert week_of("weekday") == ("2026-10-12", 1, 0)
    assert db.execute(sql.NEXT_WEEK, ("2026-10-12",)).fetchall() == [("sunday",)]
    # Monday's reset selects only the ending week's row, and the new week's scan may update the kept one.
    assert [row[0] for row in db.execute(sql.ENDED_WEEK, ("2026-10-19",))] == ["weekday"]
    db.execute(sql.REMEMBER_WEEK, ("sunday", "2026-10-19", 1, 1))
    assert week_of("sunday") == ("2026-10-19", 1, 1)
    assert db.execute(sql.NEXT_WEEK, ("2026-10-19",)).fetchall() == []
    plan = " ".join(row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql.NEXT_WEEK, ("2026-10-12",)))
    assert "plus_weeks_ended" in plan and "TEMP B-TREE" not in plan


def test_a_sunday_removal_updates_a_kept_choice_and_one_leaving_no_mark_forgets_it():
    db = sqlite3.connect(":memory:")
    db.executescript((Path(__file__).resolve().parents[2] / "migrations/0006_todoist_plus.sql").read_text())

    def week_of(task_id):
        return db.execute("SELECT week_start, committed, bet FROM plus_weeks WHERE task_id=?", (task_id,)).fetchone()

    # Kept on Sunday with both marks; removing the Bet keeps the commitment for next week.
    db.execute(sql.REMEMBER_WEEK, ("both", "2026-10-19", 1, 1))
    db.execute(sql.REMEMBER_WEEK, ("both", "2026-10-12", 1, 0))
    assert week_of("both") == ("2026-10-19", 1, 0)
    # A kept goal whose Bet is removed again is no longer a choice.
    db.execute(sql.REMEMBER_WEEK, ("goal", "2026-10-19", 0, 1))
    db.execute(sql.FORGET_TASK, ("goal",))
    assert week_of("goal") is None
    assert db.execute(sql.NEXT_WEEK, ("2026-10-12",)).fetchall() == [("both",)]
    # So a mark added again later that Sunday, here by a page scan, resets on Monday as usual.
    db.execute(sql.REMEMBER_WEEK, ("goal", "2026-10-12", 0, 1))
    assert week_of("goal") == ("2026-10-12", 0, 1)
    assert [row[0] for row in db.execute(sql.ENDED_WEEK, ("2026-10-19",))] == ["goal"]
    # An unchanged scan writes nothing.
    changes = db.total_changes
    db.execute(sql.REMEMBER_WEEK, ("both", "2026-10-12", 1, 0))
    db.execute(sql.REMEMBER_WEEK, ("goal", "2026-10-12", 0, 1))
    assert db.total_changes == changes


def test_update_time_is_whole_seconds_utc_and_absent_when_unknown():
    assert plus.task_view(task(updated_at="2026-10-14T09:30:05.123456Z"), TODAY)["update_time"] == (
        "2026-10-14T09:30:05Z"
    )
    assert plus.task_view(task(updated_at="2026-10-14T11:30:05+02:00"), TODAY)["update_time"] == (
        "2026-10-14T09:30:05Z"
    )
    for value in (None, "", "yesterday", "2026-10-14T09:30:05"):
        assert "update_time" not in plus.task_view(task(updated_at=value), TODAY)


def test_command_identity_is_stable_and_temporary_dom_ids_are_rejected():
    assert plus.command_id(REQUEST, 0) == plus.command_id(REQUEST, 0)
    assert plus.command_id(REQUEST, 0) != plus.command_id(REQUEST, 1)
    with pytest.raises(ValueError):
        plus.check_id("tmp-local-task")


def test_only_replaced_filter_queries_are_hidden():
    filters = [
        {"id": "matched-" + str(index), "query": query.replace("&", " & ").replace("@", "%")}
        for index, query in enumerate(plus.REPLACED_FILTER_QUERIES)
    ]
    assert len(plus.replaced_filters(filters, label_names={"parked"})) == len(plus.REPLACED_FILTER_QUERIES)
    assert plus.replaced_filters(
        [
            {"id": "waiting", "query": "@blocked"},
            {"id": "unfamiliar", "query": "@bets | @custom"},
        ]
    ) == ["waiting"]
    # Quick tasks are Week's Quick source and parked ones Review's Parked lane, which exists only while the account
    # has a label named parked: without one (a shared label, say) the parked view stays native.
    quick = {"id": "quick", "query": "@quick & (no date | 3 days)"}
    parked = {"id": "parked", "query": "@parked"}
    assert plus.replaced_filters([quick, parked], label_names={"quick", "parked"}) == ["quick", "parked"]
    assert plus.replaced_filters([quick, parked], label_names={"quick", "Parked"}) == ["quick"]
    assert plus.replaced_filters([{"id": "quick-4", "query": "@quick & (no date | 4 days)"}]) == []
    # The cache's name for this list changes with it (plus_todoist.metadata starts over in full).
    assert plus.fingerprint(sorted(plus.REPLACED_FILTER_QUERIES)) == plus.REPLACED_QUERIES_VERSION


def due_day(due: str, timezone: str) -> str:
    """The account-local day of a Todoist due date: a fixed-timezone date-time (ending in Z) in the account timezone,
    a date or a floating date-time as written."""
    if due.endswith("Z"):
        return datetime.fromisoformat(due).astimezone(ZoneInfo(timezone)).date().isoformat()
    return due[:10]


def todoist_filter(query: str, task: dict, today: str, timezone: str = TIMEZONE) -> bool:
    """The subset of Todoist's filter syntax the replaced deadline, waiting, quick and parked views use; `,` lists
    views. `N days` is read as inclusively as Todoist may mean it: a due day or a deadline on or before the N-th day
    from today, overdue included."""
    day = date.fromisoformat(today)
    deadline = (task.get("deadline") or {}).get("date")
    due = (task.get("due") or {}).get("date")
    labels = set(task.get("labels") or [])

    def term(word: str) -> bool:
        if word.startswith("@"):
            return word[1:] in labels
        if word == "nodeadline":
            return not deadline
        if word == "nodate":
            return not due
        if days := re.fullmatch(r"(\d+)days", word):
            last = (day + timedelta(days=int(days[1]) - 1)).isoformat()
            return (bool(due) and due_day(due, timezone) <= last) or (bool(deadline) and deadline <= last)
        before = re.fullmatch(r"deadlinebefore:(today|in(\d+)days?)", word)
        if before:
            bound = day + timedelta(days=int(before[2] or 0))
            return bool(deadline) and date.fromisoformat(deadline) < bound
        if word == "deadlineafter:yesterday":
            return bool(deadline) and date.fromisoformat(deadline) > day - timedelta(days=1)
        raise AssertionError("unsupported filter term " + word)

    tokens = re.findall(r"[()&|!]|[^()&|!]+", query)

    def either() -> bool:
        value = both()
        while tokens and tokens[0] == "|":
            tokens.pop(0)
            value = both() | value
        return value

    def both() -> bool:
        value = negated()
        while tokens and tokens[0] == "&":
            tokens.pop(0)
            value = negated() & value
        return value

    def negated() -> bool:
        token = tokens.pop(0)
        if token == "!":
            return not negated()
        if token == "(":
            value = either()
            assert tokens.pop(0) == ")"
            return value
        return term(token)

    results = []
    for view in query.split(","):
        tokens = re.findall(r"[()&|!]|[^()&|!]+", view)
        results.append(either())
        assert not tokens
    return any(results)


def on_review_board(view: dict) -> bool:
    """Where the extension's Review board shows a task (todoist-plus src/review-lanes.ts), from the API's fields.

    A `parked` task is in Parked while the account has that label (rule 0), else in its lane by the rules below. A
    `waiting` or `blocked` task is in Waiting and one that must start in Start now, or either in its own stage
    lane, saying so; the extension's test/review-lanes.test.ts checks those lanes from the same fields. An
    in-progress task (`active` without `blocked`) was acknowledged and may leave the board.
    """
    labels = set(view["labels"])
    in_progress = "active" in labels and "blocked" not in labels
    return bool(labels & {"waiting", "blocked", "parked"}) or view["must_start"] or in_progress


def in_parked_lane(view: dict) -> bool:
    """Review's Parked lane, which exists while the account has the label, the only time @parked is hidden."""
    return "parked" in view["labels"]


def quick_visible(view: dict, today: str, timezone: str) -> bool:
    """Week's Quick tasks (the extension's weekly-review.ts quickTasks), from the API's fields: the literal label
    `quick`, and no due date, or a due day or a deadline at most two days ahead, overdue included. The extension's
    test checks quickTasks over the same grid."""
    last = (date.fromisoformat(today) + timedelta(days=2)).isoformat()
    due, deadline = view["due"], view["deadline"]
    return "quick" in view["labels"] and (
        not due or due_day(due, timezone) <= last or (bool(deadline) and deadline <= last)
    )


def in_weekly_review(view: dict) -> bool:
    """A deadline without a lead is only the weekly review's start-ahead line (src/weekly-review.ts withoutLead)."""
    return view["missing_lead"]


def day_of(offset: int) -> str:
    return (date.fromisoformat(TODAY) + timedelta(days=offset)).isoformat()


def due_forms(offset: int) -> list[str]:
    """A due date ``offset`` days from TODAY as Todoist writes it: a date, a floating date-time, and fixed-timezone
    date-times half an hour after the day's local midnight and half an hour before the next one."""
    local = datetime.fromisoformat(day_of(offset)).replace(tzinfo=ZoneInfo(TIMEZONE))
    fixed = [local + timedelta(minutes=30), local + timedelta(hours=23, minutes=30)]
    return [day_of(offset), day_of(offset) + "T09:00:00"] + [
        moment.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ") for moment in fixed
    ]


def test_every_task_a_hidden_deadline_waiting_quick_or_parked_filter_shows_is_visible_in_plus():
    """Consistency gate: a replaced filter is hidden only while Plus shows every task the filter would."""
    queries = [
        query
        for query in plus.REPLACED_FILTER_QUERIES
        if "deadline" in query or "blocked" in query or query in ("@parked", QUICK)
    ]
    # Must start, missing lead, waiting with a deadline (two spellings), all waiting, in progress with a deadline,
    # parked and quick.
    assert len(queries) == 8
    missing_lead = next(query for query in queries if query.startswith("!nodeadline&!@lead_1d"))
    visible = {
        missing_lead: in_weekly_review,
        "@parked": in_parked_lane,
        QUICK: lambda view: quick_visible(view, TODAY, TIMEZONE),
    }
    marks = ["waiting", "blocked", "active", "parked", "quick"]

    def labelled(combination):
        return [mark for bit, mark in enumerate(marks) if combination >> bit & 1]

    def deadline(offset):
        return None if offset is None else {"date": day_of(offset)}

    tasks = [
        task(labels=labelled(combination) + leads, deadline=deadline(offset))
        for combination in range(1 << len(marks))
        for leads in ([], *[[role] for role in plus.LEADS], ["lead_1d", "lead_1m"])
        for offset in (None, -9, -1, 0, 1, 2, 3, 6, 7, 13, 14, 29, 30, 45)
    ]
    tasks += [
        task(labels=labelled(combination), due=due and {"date": due}, deadline=deadline(offset))
        for combination in range(1 << len(marks))
        for due in (None, *(form for days in (-2, 0, 2, 3, 8) for form in due_forms(days)))
        for offset in (None, 0)
    ]
    # Half an hour before the local midnight after the window's last day is still in it, though its UTC day is not.
    assert quick_visible({"labels": ["quick"], "due": due_forms(2)[3], "deadline": ""}, TODAY, TIMEZONE)
    assert due_forms(2)[3][:10] == day_of(3)
    assert not quick_visible({"labels": ["quick"], "due": due_forms(3)[2], "deadline": ""}, TODAY, TIMEZONE)
    for query in queries:
        shown = [source for source in tasks if todoist_filter(query, source, TODAY)]
        assert shown, query
        check = visible.get(query, on_review_board)
        missing = [source for source in shown if not check(plus.task_view(source, TODAY))]
        assert missing == [], query


def mapping():
    """A setup confirmed before the Bets became text: it still binds the retired bets role."""
    roles = (*plus.ROLES, *plus.LEGACY_ROLES, "quarter")
    return [{"role": role, "id": "id-" + role, "label": "custom-" + role} for role in roles]


def test_a_new_setup_needs_no_bets_label_and_a_saved_bets_binding_is_kept_as_saved():
    labels = [{"id": "id-" + role, "name": role} for role in plus.ROLES]
    fresh = plus.discover(labels, "UTC")
    assert not fresh["missing_labels"] and "bets" not in {binding["role"] for binding in fresh["labels"]}
    # A label named bets is not adopted by a new setup.
    assert plus.discover([*labels, {"id": "id-bets", "name": "bets"}], "UTC")["labels"] == fresh["labels"]
    saved = [*fresh["labels"], {"role": "bets", "id": "id-bets", "label": "bets"}]
    before = plus.discover([*labels, {"id": "id-bets", "name": "bets"}], "UTC", saved)
    # Renaming or deleting the retired label in Todoist changes neither the binding nor the etag.
    for current in ([*labels, {"id": "id-bets", "name": "old goals"}], labels):
        after = plus.discover(current, "UTC", saved)
        assert after["labels"] == before["labels"] == saved
        assert after["etag"] == before["etag"] and not after["missing_labels"]


def test_column_bindings_keep_the_retired_bets_binding_and_its_filter_stays_hidden():
    current = mapping()
    available = [{"id": label["id"], "label": label["label"]} for label in current]
    selected = [label for label in current if label["role"] in plus.PLANNING_ROLES]
    assert plus.replace_planning_labels(current, selected, available) == current
    assert {"role": "bets", "id": "id-bets", "label": "custom-bets"} in current
    # @bets was checked against the bets binding's name; with the role retired it is always replaced.
    bets = [{"id": "bets-filter", "query": "@bets"}]
    assert plus.replaced_filters(bets) == plus.replaced_filters(bets, current) == ["bets-filter"]
    assert plus.replaced_filters(bets, current[:2]) == ["bets-filter"]


def test_saved_legacy_mapping_keeps_its_identity_when_optional_quarter_appears():
    labels = [{"id": "id-" + role, "name": role} for role in plus.ROLES]
    old = plus.discover(labels, "UTC")
    actual = plus.discover([*labels, {"id": "quarter-id", "name": "quarter"}], "UTC", old["labels"])
    assert actual["etag"] == old["etag"]
    assert actual["labels"] == old["labels"]
    assert not actual["missing_labels"]
    assert {"id": "quarter-id", "label": "quarter"} in actual["available_labels"]


def test_saved_ids_detect_rename_and_do_not_adopt_a_new_same_name_label():
    labels = [{"id": "id-" + role, "name": role} for role in plus.ROLES]
    saved = plus.discover(labels, "UTC")
    renamed = [{**label, "name": "new-commit"} if label["name"] == "committed" else label for label in labels]
    actual = plus.discover([*renamed, {"id": "other-id", "name": "committed"}], "UTC", saved["labels"])
    assert actual["etag"] != saved["etag"]
    assert next(label for label in actual["labels"] if label["role"] == "committed") == {
        "role": "committed",
        "id": "id-committed",
        "label": "new-commit",
    }
    missing = plus.discover([label for label in renamed if label["id"] != "id-committed"], "UTC", saved["labels"])
    assert missing["missing_labels"] == ["committed"]


def test_configured_names_drive_stages_areas_bets_leads_and_preserve_other_labels():
    bindings = mapping()
    source = task(
        labels=["custom-quarter", "custom-office", "custom-bets", "custom-lead_1w", "deep"],
        due={"date": TODAY},
        deadline={"date": TODAY},
    )
    view = plus.task_view(source, TODAY, bindings)
    assert view["stage"] == "quarterly" and view["area"] == "work" and view["bet"]
    assert view["lead_days"] == 7 and view["must_start"]
    assert plus.plan_labels(source, {"stage": "weekly"}, bindings) == [
        "custom-bets",
        "custom-focus",
        "custom-lead_1w",
        "custom-office",
        "deep",
    ]
    assert plus.lead_args(source, TODAY, 14, bindings)["labels"] == [
        "custom-bets",
        "custom-lead_2w",
        "custom-office",
        "custom-quarter",
        "deep",
    ]
    assert source["due"] == {"date": TODAY}
    assert source["labels"] == ["custom-quarter", "custom-office", "custom-bets", "custom-lead_1w", "deep"]


def test_configured_week_reset_keeps_quarter_and_uses_the_bound_commitment_names():
    bindings = mapping()
    assert plus.reset_labels(
        task(labels=["custom-quarter", "custom-bets", "deep"]), {"committed": 0, "bet": 1}, bindings
    ) == [
        "custom-quarter",
        "deep",
    ]
    assert plus.reset_labels(
        task(labels=["custom-committed", "custom-candiate", "custom-bets", "deep"]),
        {"committed": 1, "bet": 1},
        bindings,
    ) == ["custom-focus", "deep"]


def test_column_binding_updates_keep_other_roles_and_reject_reused_or_unknown_id():
    current = mapping()
    available = [{"id": label["id"], "label": label["label"]} for label in current]
    selected = [label for label in current if label["role"] in plus.PLANNING_ROLES]
    updated = plus.replace_planning_labels(current, selected, available)
    assert updated == current
    assert (
        plus.replace_planning_labels(current, [label for label in selected if label["role"] != "quarter"], available)
        == current[:-1]
    )
    for replacement in (
        {"id": "id-office", "label": "custom-office"},
        {"id": "unknown", "label": "custom-quarter"},
        {"id": "id-quarter", "label": "wrong-name"},
    ):
        invalid = [{**label, **replacement} if label["role"] == "quarter" else label for label in selected]
        with pytest.raises(ValueError, match="BAD_REQUEST"):
            plus.replace_planning_labels(current, invalid, available)


def test_bets_do_not_enter_the_date_candidate_fallback_without_an_explicit_stage():
    assert plus.task_view(task(labels=["bets"], due={"date": TODAY}), TODAY)["stage"] == "none"
    assert plus.task_view(task(labels=["bets", "committed"], due={"date": TODAY}), TODAY)["stage"] == "committed"
    assert plus.task_view(task(labels=["custom-bets"], deadline={"date": TODAY}), TODAY, mapping())["stage"] == "none"
    assert plus.task_etag(task(), mapping()) != plus.task_etag(task(), mapping()[:-1])
