"""Personal planning behavior, using synthetic tasks only."""

import re
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import pytest

from todofy.core import plus
from todofy.core.sql import plus as sql

TODAY = "2026-10-13"
REQUEST = "f4438dda-dc8d-4732-aa59-bdb1a4dc21fa"


def task(**values):
    return {
        "id": "task1",
        "content": "Synthetic report",
        "labels": ["office", "deep"],
        "project_id": "project1",
        **values,
    }


def test_stage_change_retains_unrelated_labels_and_bet_does_not_promote():
    source = task(labels=["committed", "focus", "office", "deep", "lead_2w", "bets"])
    assert plus.plan_labels(source, {"stage": "monthly"}) == ["bets", "candiate", "deep", "lead_2w", "office"]
    assert plus.plan_labels(task(), {"bet": True}) == ["bets", "deep", "office"]
    assert plus.plan_labels(source, {"area": "personal"}) == ["bets", "committed", "deep", "focus", "home", "lead_2w"]


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


def test_only_a_commitment_or_bet_chosen_on_the_last_day_waits_for_the_next_week():
    week, sunday = "2026-10-12", "2026-10-18"
    assert plus.membership_week(sunday, week, {"stage": "committed"}) == "2026-10-19"
    assert plus.membership_week(sunday, week, {"bet": True, "task_id": "task1"}) == "2026-10-19"
    # Removing a mark, other stages, an area or a deadline change on Sunday stay in the ending week.
    for request in ({"bet": False}, {"stage": "weekly"}, {"area": "work"}, {"deadline": sunday, "lead_days": 7}):
        assert plus.membership_week(sunday, week, request) == week
    # A commitment made on any other day of the week ends with it.
    for today in ("2026-10-12", "2026-10-14", "2026-10-17"):
        assert plus.membership_week(today, week, {"stage": "committed", "bet": True}) == week


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
    assert len(plus.replaced_filters(filters)) == len(plus.REPLACED_FILTER_QUERIES)
    assert plus.replaced_filters(
        [
            {"id": "waiting", "query": "@blocked"},
            {"id": "unfamiliar", "query": "@bets | @custom"},
        ]
    ) == ["waiting"]
    # The quick-task and parked views stay native, in Other views.
    assert plus.replaced_filters([{"id": "quick", "query": "@quick & (no date | 3 days)"}]) == []
    assert plus.replaced_filters([{"id": "parked", "query": "@parked"}]) == []


def todoist_filter(query: str, task: dict, today: str) -> bool:
    """The subset of Todoist's filter syntax the replaced deadline and waiting views use; `,` lists views."""
    day = date.fromisoformat(today)
    deadline = (task.get("deadline") or {}).get("date")
    labels = set(task.get("labels") or [])

    def term(word: str) -> bool:
        if word.startswith("@"):
            return word[1:] in labels
        if word == "nodeadline":
            return not deadline
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


def listed_by_plus(view: dict) -> bool:
    """Where the extension lists a task (todoist-plus src/deadlines.ts and WaitingList), from the API's fields.

    Deadlines: a deadline, not parked, and in progress (`active` without `blocked`), must start or
    missing a lead. Waiting: any `waiting` or `blocked` label.
    """
    labels = set(view["labels"])
    in_progress = "active" in labels and "blocked" not in labels
    deadlines = bool(view["deadline"]) and "parked" not in labels
    deadlines = deadlines and (in_progress or view["must_start"] or view["missing_lead"])
    return deadlines or bool(labels & {"waiting", "blocked"})


def test_every_task_a_hidden_deadline_or_waiting_filter_shows_is_listed_in_plus():
    """Consistency gate: a replaced filter is hidden only while Plus lists every task it would show."""
    queries = [query for query in plus.REPLACED_FILTER_QUERIES if "deadline" in query or "blocked" in query]
    # Must start, missing lead, waiting with a deadline (two spellings), all waiting and in progress with a deadline.
    assert len(queries) == 6
    marks = ["waiting", "blocked", "active", "parked"]

    def deadline(offset):
        return None if offset is None else {"date": (date.fromisoformat(TODAY) + timedelta(days=offset)).isoformat()}

    tasks = [
        task(
            labels=[mark for bit, mark in enumerate(marks) if combination >> bit & 1] + leads,
            deadline=deadline(offset),
        )
        for combination in range(1 << len(marks))
        for leads in ([], *[[role] for role in plus.LEADS], ["lead_1d", "lead_1m"])
        for offset in (None, -9, -1, 0, 1, 2, 3, 6, 7, 13, 14, 29, 30, 45)
    ]
    for query in queries:
        shown = [source for source in tasks if todoist_filter(query, source, TODAY)]
        assert shown, query
        missing = [source for source in shown if not listed_by_plus(plus.task_view(source, TODAY))]
        assert missing == [], query


def mapping():
    return [{"role": role, "id": "id-" + role, "label": "custom-" + role} for role in (*plus.ROLES, "quarter")]


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
